import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { meteredAI } from "@/ai";
import type { AIMessage, ToolCallPart, ToolResultPart, ToolSpec } from "@/ai/types";
import { getDb, schema } from "@/db";
import type { AgentRun, Goal, Task } from "@/db/schema";
import { emit } from "@/engine/events";
import { classifyToolCall, requiresApproval } from "@/engine/risk";
import { env } from "@/lib/env";
import { describeError, withTimeout } from "@/lib/errors";
import { toolRegistry } from "@/tools/registry";
import type { Tool } from "@/tools/types";
import type { AgentDefinition } from "./definitions";

type RunState = {
  messages: AIMessage[];
  /** Results collected so far for the tool calls in the last assistant message. */
  partialResults: ToolResultPart[];
};

export type AgentOutcome =
  | { status: "completed"; text: string; truncated: boolean; runId: string }
  | { status: "waiting_approval"; runId: string };

export type AgentTaskContext = {
  goal: Goal;
  task: Task;
  agent: AgentDefinition;
  goalBrief: string;
  upstream: { title: string; agent: string | null; text: string }[];
  memory: string;
  userId: string;
  signal: AbortSignal;
};

const COMMON_RULES = `Operating rules:
- Your final message IS the deliverable for this task. Write it as a complete, well-structured markdown document. Do not add meta commentary about your process.
- Work only from your inputs, your tools and well-established knowledge. State assumptions explicitly in an "Assumptions" section when you make them.
- Do not ask the user questions; make the most reasonable assumption and continue.
- Never claim an external action happened (sent, published, purchased, deployed) unless a tool call returned success for it.
- Never fabricate sources, quotes, metrics or URLs. Never call a tool against a guessed, hypothetical or example endpoint or recipient; if the real system is not connected, deliver the ready-to-use asset and exact hand-off steps instead.
- If a tool returns an error, adapt: try a different approach or continue without it and say what could not be done.`;

const MAX_TOOL_RESULT_CHARS = 12_000;
const MAX_UPSTREAM_CHARS = 14_000;
const TOOL_TIMEOUT_MS = 60_000;

function toolsFor(agent: AgentDefinition, task: Task): { usable: Tool[]; unavailable: string[] } {
  const names = new Set([...agent.tools, ...task.requiredTools]);
  const usable: Tool[] = [];
  const unavailable: string[] = [];
  for (const name of names) {
    const tool = toolRegistry.get(name);
    if (!tool) continue;
    const a = tool.available();
    if (a.ok) usable.push(tool);
    else unavailable.push(`${name} (${a.reason} Set ${a.envVars.join(", ")}.)`);
  }
  return { usable, unavailable };
}

function toSpec(tool: Tool): ToolSpec {
  const json = z.toJSONSchema(tool.inputSchema, { io: "input", target: "draft-7" }) as Record<string, unknown>;
  delete json.$schema;
  return { name: tool.name, description: tool.description, inputSchema: json };
}

function initialPrompt(ctx: AgentTaskContext, unavailable: string[]): string {
  const { task } = ctx;
  const parts = [
    `# Goal\n${ctx.goalBrief}`,
    `# Your task\n**${task.title}**\n${task.description}\n\n**Acceptance criteria:** ${task.input.acceptanceCriteria}`,
  ];
  if (ctx.upstream.length) {
    parts.push(
      `# Outputs of the tasks you depend on\n${ctx.upstream
        .map((u) => `## ${u.title}${u.agent ? ` (${u.agent} agent)` : ""}\n${u.text.slice(0, MAX_UPSTREAM_CHARS)}`)
        .join("\n\n")}`,
    );
  }
  if (ctx.memory) parts.push(`# Workspace memory\n${ctx.memory}`);
  if (unavailable.length) {
    parts.push(`# Tools that are NOT available\n${unavailable.map((u) => `- ${u}`).join("\n")}\nWork without them and be explicit about the resulting limitation.`);
  }
  if (task.input.repairFeedback?.length) {
    parts.push(
      `# Your previous attempt was rejected by verification\nFix every issue below in this attempt:\n${task.input.repairFeedback.map((f) => `- ${f}`).join("\n")}${
        task.output?.text ? `\n\n## Your rejected output (revise it rather than starting over)\n${task.output.text.slice(0, 20_000)}` : ""
      }`,
    );
  }
  return parts.join("\n\n");
}

async function loadOrCreateRun(ctx: AgentTaskContext, unavailable: string[]): Promise<{ run: AgentRun; state: RunState }> {
  const db = await getDb();
  const attempt = ctx.task.retryCount + 1;
  const [existing] = await db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.taskId, ctx.task.id), eq(schema.agentRuns.attempt, attempt)))
    .orderBy(desc(schema.agentRuns.startedAt))
    .limit(1);

  // Resume a paused (approval) or interrupted (crash / time slice) run of the same attempt.
  if (existing && (existing.status === "WAITING_APPROVAL" || existing.status === "INTERRUPTED" || existing.status === "RUNNING") && existing.state) {
    await db.update(schema.agentRuns).set({ status: "RUNNING" }).where(eq(schema.agentRuns.id, existing.id));
    return { run: existing, state: existing.state as RunState };
  }

  const state: RunState = {
    messages: [{ role: "user", content: [{ type: "text", text: initialPrompt(ctx, unavailable) }] }],
    partialResults: [],
  };
  const [run] = await db
    .insert(schema.agentRuns)
    .values({ goalId: ctx.goal.id, taskId: ctx.task.id, agent: ctx.agent.id, attempt, state })
    .returning();
  return { run: run!, state };
}

async function saveState(runId: string, state: RunState, extra: Partial<AgentRun> = {}) {
  const db = await getDb();
  await db
    .update(schema.agentRuns)
    .set({ state, ...extra })
    .where(eq(schema.agentRuns.id, runId));
}

function stringifyResult(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > MAX_TOOL_RESULT_CHARS ? `${s.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated]` : s;
}

type ToolStep = { kind: "result"; result: ToolResultPart } | { kind: "pause" };

/**
 * Executes (or resumes) one tool call with full bookkeeping. Idempotent across resumes:
 * a call that already succeeded is never executed twice, and an external action whose
 * outcome is unknown after a crash is reported as such instead of being blindly repeated.
 */
async function handleToolCall(ctx: AgentTaskContext, run: AgentRun, call: ToolCallPart, allowed: Tool[]): Promise<ToolStep> {
  const db = await getDb();
  const base = { workspaceId: ctx.goal.workspaceId, goalId: ctx.goal.id, taskId: ctx.task.id };
  const fail = (content: string): ToolStep => ({ kind: "result", result: { type: "tool_result", toolCallId: call.id, content, isError: true } });

  const tool = allowed.find((t) => t.name === call.name);
  if (!tool) return fail(`Tool "${call.name}" is not available to you.`);

  const parsed = tool.inputSchema.safeParse(call.input);
  if (!parsed.success) {
    const message = `Invalid input for ${call.name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
    // If this call was recorded earlier (e.g. validation rules tightened while it awaited
    // approval), close the record and its approval so nothing is left dangling.
    const [stale] = await db
      .update(schema.toolCalls)
      .set({ status: "FAILED", error: message, completedAt: new Date() })
      .where(and(eq(schema.toolCalls.agentRunId, run.id), eq(schema.toolCalls.providerCallId, call.id), eq(schema.toolCalls.status, "PENDING_APPROVAL")))
      .returning({ id: schema.toolCalls.id });
    if (stale) {
      await db.update(schema.approvals).set({ status: "EXPIRED" }).where(and(eq(schema.approvals.toolCallId, stale.id), eq(schema.approvals.status, "PENDING")));
    }
    return fail(message);
  }
  const input = parsed.data;
  const risk = classifyToolCall(tool, input);

  const [existing] = await db
    .select()
    .from(schema.toolCalls)
    .where(and(eq(schema.toolCalls.agentRunId, run.id), eq(schema.toolCalls.providerCallId, call.id)));

  let row = existing;
  if (row?.status === "SUCCEEDED") {
    return { kind: "result", result: { type: "tool_result", toolCallId: call.id, content: stringifyResult(row.output) } };
  }
  if (row?.status === "FAILED") return fail(row.error ?? "Tool failed.");
  if (row?.status === "REJECTED") {
    return fail(`A human reviewer REJECTED this action${row.error ? `: ${row.error}` : ""}. Do not retry it. Continue without it and state clearly that it was not performed.`);
  }
  if (row?.status === "RUNNING" && tool.externalEffect && risk !== "LOW") {
    await db
      .update(schema.toolCalls)
      .set({ status: "FAILED", error: "Interrupted mid-execution; outcome unknown.", completedAt: new Date() })
      .where(eq(schema.toolCalls.id, row.id));
    return fail("This action was interrupted mid-execution and its outcome is unknown. Do NOT repeat it. Report that it needs manual confirmation.");
  }

  if (!row) {
    const needsApproval = requiresApproval(risk);
    [row] = await db
      .insert(schema.toolCalls)
      .values({
        ...base,
        agentRunId: run.id,
        providerCallId: call.id,
        toolName: tool.name,
        input,
        riskLevel: risk,
        status: needsApproval ? "PENDING_APPROVAL" : "RUNNING",
      })
      .returning();
    if (needsApproval) {
      await db.insert(schema.approvals).values({
        ...base,
        toolCallId: row!.id,
        kind: "TOOL_CALL",
        title: tool.summarize(input),
        summary: `${ctx.agent.name} wants to run "${tool.name}" for task "${ctx.task.title}".`,
        payload: input,
        riskLevel: risk,
      });
      await emit({ ...base, type: "approval.requested", level: "warn", message: `Approval required: ${tool.summarize(input)}`, data: { risk, tool: tool.name } });
      return { kind: "pause" };
    }
  } else if (row.status === "PENDING_APPROVAL") {
    const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.toolCallId, row.id));
    if (!approval || approval.status === "PENDING") return { kind: "pause" };
    if (approval.status !== "APPROVED") {
      await db.update(schema.toolCalls).set({ status: "REJECTED", error: approval.decisionNote, completedAt: new Date() }).where(eq(schema.toolCalls.id, row.id));
      return fail(`A human reviewer REJECTED this action${approval.decisionNote ? `: ${approval.decisionNote}` : ""}. Do not retry it. Continue without it and state clearly that it was not performed.`);
    }
    await db.update(schema.toolCalls).set({ status: "RUNNING" }).where(eq(schema.toolCalls.id, row.id));
  }

  await emit({ ...base, type: "tool.started", message: `${ctx.agent.name}: ${tool.summarize(input)}`, data: { tool: tool.name, risk } });
  const started = Date.now();
  try {
    const output = await withTimeout(
      TOOL_TIMEOUT_MS,
      `Tool ${tool.name}`,
      (signal) => tool.execute(input, { ...base, userId: ctx.userId, signal }),
      ctx.signal,
    );
    const durationMs = Date.now() - started;
    await db.update(schema.toolCalls).set({ status: "SUCCEEDED", output, durationMs, completedAt: new Date() }).where(eq(schema.toolCalls.id, row!.id));
    await emit({ ...base, type: "tool.succeeded", message: `${tool.name} succeeded (${durationMs} ms)`, data: { tool: tool.name, durationMs } });
    return { kind: "result", result: { type: "tool_result", toolCallId: call.id, content: stringifyResult(output) } };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    const message = describeError(err);
    await db
      .update(schema.toolCalls)
      .set({ status: "FAILED", error: message, durationMs: Date.now() - started, completedAt: new Date() })
      .where(eq(schema.toolCalls.id, row!.id));
    await emit({ ...base, type: "tool.failed", level: "warn", message: `${tool.name} failed: ${message}`, data: { tool: tool.name } });
    return fail(message);
  }
}

/** Batches streamed text into persisted events so every viewer (on any server instance) sees live output. */
function deltaEmitter(ctx: AgentTaskContext, iteration: number) {
  let buffer = "";
  let last = Date.now();
  let chain = Promise.resolve();
  const flush = () => {
    if (!buffer) return;
    const delta = buffer;
    buffer = "";
    last = Date.now();
    chain = chain.then(() =>
      emit({
        workspaceId: ctx.goal.workspaceId,
        goalId: ctx.goal.id,
        taskId: ctx.task.id,
        type: "task.output_delta",
        message: "",
        data: { delta, iteration },
      }),
    );
  };
  return {
    push(text: string) {
      buffer += text;
      if (buffer.length >= 500 || Date.now() - last >= 700) flush();
    },
    async done() {
      flush();
      await chain;
    },
  };
}

/**
 * The shared agent runtime: one loop for every specialist. The model proposes tool calls,
 * the runtime validates, risk-checks, (pauses for approval,) executes and feeds results
 * back, until the model produces its final deliverable. State is persisted after every
 * step so the run survives approvals, crashes and serverless time slices.
 */
export async function runAgentTask(ctx: AgentTaskContext): Promise<AgentOutcome> {
  const { usable, unavailable } = toolsFor(ctx.agent, ctx.task);
  const { run, state } = await loadOrCreateRun(ctx, unavailable);
  const ai = meteredAI({
    workspaceId: ctx.goal.workspaceId,
    goalId: ctx.goal.id,
    taskId: ctx.task.id,
    agentRunId: run.id,
    purpose: `agent:${ctx.agent.id}`,
  });
  const system = `${ctx.agent.instructions}\n\n${COMMON_RULES}`;
  const specs = usable.map(toSpec);
  const maxIterations = env().MAX_AGENT_ITERATIONS;
  let iterations = run.iterations;

  try {
    for (;;) {
      const last = state.messages[state.messages.length - 1];

      // Pending tool calls from the last assistant turn (fresh, or resumed after a pause).
      if (last?.role === "assistant") {
        const calls = last.content.filter((p): p is ToolCallPart => p.type === "tool_call");
        if (calls.length === 0) {
          // Resumed after the final answer was saved but before the run was closed.
          const text = last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
          const db = await getDb();
          await db.update(schema.agentRuns).set({ status: "SUCCEEDED", completedAt: new Date() }).where(eq(schema.agentRuns.id, run.id));
          return { status: "completed", text: text.trim(), truncated: false, runId: run.id };
        }
        for (const call of calls) {
          if (state.partialResults.some((r) => r.toolCallId === call.id)) continue;
          const step = await handleToolCall(ctx, run, call, usable);
          if (step.kind === "pause") {
            await saveState(run.id, state, { status: "WAITING_APPROVAL", iterations });
            return { status: "waiting_approval", runId: run.id };
          }
          state.partialResults.push(step.result);
          await saveState(run.id, state);
        }
        state.messages.push({ role: "user", content: state.partialResults });
        state.partialResults = [];
        await saveState(run.id, state);
      }

      if (iterations >= maxIterations) {
        throw new Error(`Agent stopped after ${maxIterations} iterations without finishing (loop protection).`);
      }
      iterations++;

      const out = deltaEmitter(ctx, iterations);
      // On the final allowed iteration, withhold tools so the model must conclude.
      const result = await ai.stream(
        { system, messages: state.messages, tools: iterations >= maxIterations ? undefined : specs, signal: ctx.signal },
        (d) => out.push(d),
      );
      await out.done();

      state.messages.push(result.message);
      await saveState(run.id, state, { iterations });

      if (result.toolCalls.length === 0) {
        const db = await getDb();
        await db
          .update(schema.agentRuns)
          .set({ status: "SUCCEEDED", completedAt: new Date(), iterations })
          .where(eq(schema.agentRuns.id, run.id));
        return { status: "completed", text: result.text.trim(), truncated: result.stopReason === "max_tokens", runId: run.id };
      }
    }
  } catch (err) {
    const db = await getDb();
    // A deadline abort is a pause, not a failure: the run stays resumable.
    const interrupted = ctx.signal.aborted;
    await db
      .update(schema.agentRuns)
      .set({ status: interrupted ? "INTERRUPTED" : "FAILED", error: describeError(err), iterations, completedAt: interrupted ? null : new Date() })
      .where(eq(schema.agentRuns.id, run.id));
    throw err;
  }
}
