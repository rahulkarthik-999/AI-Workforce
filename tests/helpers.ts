import { eq } from "drizzle-orm";
import { setProviderOverride } from "@/ai";
import type {
  AIMessage,
  AIProvider,
  GenerateRequest,
  GenerateResult,
  StructuredRequest,
  StructuredResult,
  ToolCallPart,
} from "@/ai/types";
import { getDb, resetDb, schema } from "@/db";
import { runGoal } from "@/engine/executor";
import type { Plan } from "@/engine/plan";
import { createGoal, type Actor } from "@/engine/service";
import { registerUser } from "@/lib/auth";

export type AgentReply = { text?: string; toolCalls?: { name: string; input: unknown }[] };

/** The first user message of an agent conversation contains the task brief. */
export function taskPrompt(req: GenerateRequest): string {
  const first = req.messages[0] as AIMessage;
  return first.content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

export function lastToolResults(req: GenerateRequest) {
  const last = req.messages[req.messages.length - 1]!;
  return last.role === "user" ? last.content.filter((p) => p.type === "tool_result") : [];
}

/**
 * A deterministic stand-in for a model provider, used ONLY in tests. It lets the real
 * engine (compiler, executor, runtime, verification, result) run end-to-end against
 * scripted model behaviour.
 */
export class ScriptedProvider implements AIProvider {
  readonly id = "scripted";
  readonly models = { main: "test-model", fast: "test-model" };
  calls: { kind: "generate" | "structured"; name: string; req: GenerateRequest | StructuredRequest<unknown> }[] = [];
  usage = { inputTokens: 1000, outputTokens: 500 };

  structured: Record<string, (req: StructuredRequest<unknown>, n: number) => unknown> = {
    goal_interpretation: () => interpretation(),
    verification_verdict: () => verdict(true),
    goal_result: () => synthesis(),
    recovery_decision: () => ({ decision: "abandon", reasoning: "not recoverable", approach: "" }),
  };
  agent: (req: GenerateRequest, n: number) => AgentReply = () => ({ text: LONG_OUTPUT });

  private counts = new Map<string, number>();
  private bump(name: string) {
    const n = (this.counts.get(name) ?? 0) + 1;
    this.counts.set(name, n);
    return n;
  }
  count(name: string) {
    return this.counts.get(name) ?? 0;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.stream(req, () => undefined);
  }

  async stream(req: GenerateRequest, onText: (d: string) => void): Promise<GenerateResult> {
    const n = this.bump("agent");
    this.calls.push({ kind: "generate", name: "agent", req });
    const reply = this.agent(req, n);
    // Mirror real providers: tools can only be called when they were offered.
    const offered = new Set((req.tools ?? []).map((t) => t.name));
    const toolCalls: ToolCallPart[] = (reply.toolCalls ?? [])
      .filter((c) => offered.has(c.name))
      .map((c, i) => ({ type: "tool_call", id: `call_${n}_${i}`, name: c.name, input: c.input }));
    const text = reply.text ?? (toolCalls.length ? "" : LONG_OUTPUT);
    if (text) onText(text);
    return {
      text,
      toolCalls,
      message: { role: "assistant", content: [...(text ? [{ type: "text" as const, text }] : []), ...toolCalls] },
      usage: this.usage,
      model: "test-model",
      stopReason: toolCalls.length ? "tool_use" : "end",
    };
  }

  async structuredOutput<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const n = this.bump(req.schemaName);
    this.calls.push({ kind: "structured", name: req.schemaName, req: req as StructuredRequest<unknown> });
    const handler = this.structured[req.schemaName];
    if (!handler) throw new Error(`ScriptedProvider: no handler for ${req.schemaName}`);
    return { object: req.schema.parse(handler(req as StructuredRequest<unknown>, n)), usage: this.usage, model: "test-model" };
  }
}

export const LONG_OUTPUT = `# Deliverable\n\n${"This section contains substantive, specific content for the task. ".repeat(8)}\n\n## Assumptions\n- Early-stage B2B SaaS.`;

export function interpretation(over: Record<string, unknown> = {}) {
  return {
    objective: "Create a launch plan for a SaaS product",
    constraints: [],
    target: null,
    deadline: null,
    knownContext: [],
    missingInformation: [],
    ...over,
  };
}

export function verdict(pass: boolean, issues: string[] = ["Missing pricing section"]) {
  return {
    verdict: pass ? "PASS" : "FAIL",
    score: pass ? 0.9 : 0.3,
    requirementsSatisfied: pass,
    consistent: true,
    unsupportedClaims: [],
    issues: pass ? [] : issues,
  };
}

export function synthesis(over: Record<string, unknown> = {}) {
  return {
    statusLabel: "Ready for launch",
    headline: "Launch plan produced and verified.",
    summary: "Research, strategy and the launch plan were completed and verified.",
    nextBestAction: {
      title: "Draft the launch announcement email",
      rationale: "The plan is ready; the announcement is the first execution step.",
      actionPrompt: "Write the launch announcement email based on the launch plan.",
    },
    learnings: [
      {
        observation: "All tasks passed verification on the first attempt.",
        pattern: "Research-then-strategy sequencing produced consistent outputs.",
        confidence: 0.4,
        context: "Launch planning goals",
        recommendation: "Keep research ahead of strategy for similar goals.",
      },
    ],
    ...over,
  };
}

type TaskSpec = Partial<Plan["tasks"][number]> & { key: string };

export function task(spec: TaskSpec): Plan["tasks"][number] {
  return {
    title: spec.key,
    description: `Do ${spec.key}`,
    type: "writing",
    dependsOn: [],
    requiredTools: [],
    acceptanceCriteria: "Complete and specific.",
    priority: 3,
    deliverable: true,
    riskLevel: "LOW",
    ...spec,
  };
}

export function plan(tasks: TaskSpec[]): Plan {
  return { requirements: [{ title: "A usable launch plan", description: "Covers research, strategy and plan." }], tasks: tasks.map(task) };
}

let seq = 0;

export async function freshWorld(): Promise<{ provider: ScriptedProvider; actor: Actor }> {
  await resetDb();
  const provider = new ScriptedProvider();
  setProviderOverride(provider);
  return { provider, actor: await newActor() };
}

export async function newActor(): Promise<Actor> {
  const user = await registerUser({ email: `user${++seq}@example.com`, name: `User ${seq}`, password: "correct-horse-battery" });
  const db = await getDb();
  const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, user.id));
  return { userId: user.id, workspaceId: m!.workspaceId };
}

/** Drive a goal until it stops needing the engine (finished or waiting on a human). */
export async function drive(goalId: string, maxSlices = 10) {
  for (let i = 0; i < maxSlices; i++) {
    const { more } = await runGoal(goalId);
    if (!more) break;
  }
  return state(goalId);
}

export async function state(goalId: string) {
  const db = await getDb();
  const [goal] = await db.select().from(schema.goals).where(eq(schema.goals.id, goalId));
  const tasks = await db.select().from(schema.tasks).where(eq(schema.tasks.goalId, goalId));
  const approvals = await db.select().from(schema.approvals).where(eq(schema.approvals.goalId, goalId));
  const events = await db.select().from(schema.executionEvents).where(eq(schema.executionEvents.goalId, goalId));
  const byKey = Object.fromEntries(tasks.map((t) => [t.key, t]));
  return { goal: goal!, tasks, byKey, approvals, events, types: events.map((e) => e.type) };
}

export async function startGoal(actor: Actor, prompt = "Create a launch plan for my SaaS.", budgetUsd?: number) {
  return createGoal(actor, { prompt, budgetUsd });
}
