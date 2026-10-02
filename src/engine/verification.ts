import "server-only";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { meteredAI } from "@/ai";
import { AGENTS } from "@/agents/definitions";
import { getDb, schema } from "@/db";
import type { Goal, Task, VerificationReport } from "@/db/schema";
import { toolRegistry } from "@/tools/registry";
import { deterministicChecks, failedChecks } from "./checks";

const verdictSchema = z.object({
  verdict: z.enum(["PASS", "FAIL"]),
  score: z.number().describe("0.0-1.0 overall quality against the acceptance criteria"),
  requirementsSatisfied: z.boolean(),
  consistent: z.boolean().describe("False if the output contradicts itself or its inputs"),
  unsupportedClaims: z
    .array(z.string())
    .describe("ONLY statements in the output that are fabricated or contradicted by the logs/inputs. Leave EMPTY if there are none - never put comments, praise or observations here"),
  issues: z.array(z.string()).describe("Specific, actionable problems. Empty when verdict is PASS"),
});

/**
 * Verification is a separate stage from generation: an agent returning text never makes a
 * task complete. Deterministic checks run first; only if they pass does the independent
 * Verification Agent judge the output against the task's acceptance criteria and tool log.
 */
export async function verifyTask(input: {
  goal: Goal;
  task: Task;
  output: string;
  truncated: boolean;
  runId: string;
  goalBrief: string;
  /** Verified outputs of the tasks this one depends on - the material the agent was given. */
  upstream: { title: string; text: string }[];
  signal?: AbortSignal;
}): Promise<VerificationReport> {
  const { goal, task, output } = input;
  const db = await getDb();
  const calls = await db
    .select({ toolName: schema.toolCalls.toolName, status: schema.toolCalls.status, input: schema.toolCalls.input, error: schema.toolCalls.error })
    .from(schema.toolCalls)
    .where(eq(schema.toolCalls.agentRunId, input.runId));

  const checks = deterministicChecks({
    output,
    truncated: input.truncated,
    deliverable: task.input.deliverable,
    requiredTools: task.requiredTools.flatMap((name) => {
      const t = toolRegistry.get(name);
      return t ? [{ name, externalEffect: t.externalEffect, riskLevel: t.riskLevel }] : [];
    }),
    toolCalls: calls,
  });
  const failed = failedChecks(checks);
  if (failed.length) {
    return { verdict: "FAIL", score: 0, checks, issues: failed, verifiedBy: "deterministic" };
  }

  const toolLog = calls.length
    ? calls.map((c) => `- ${c.toolName} [${c.status}] ${JSON.stringify(c.input).slice(0, 300)}${c.error ? ` error: ${c.error}` : ""}`).join("\n")
    : "(the agent made no tool calls)";

  // Evidence beyond this task's own calls: what upstream tasks produced, and every external
  // action the goal has actually executed. Without it, a task that correctly reports on
  // upstream work would look like it was making unsupported claims.
  const elsewhere = await db
    .select({ toolName: schema.toolCalls.toolName, status: schema.toolCalls.status, input: schema.toolCalls.input, task: schema.tasks.title })
    .from(schema.toolCalls)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.toolCalls.taskId))
    .where(and(eq(schema.toolCalls.goalId, goal.id), ne(schema.toolCalls.taskId, task.id), ne(schema.toolCalls.riskLevel, "LOW")));
  const goalLog = elsewhere.length
    ? elsewhere.map((c) => `- [${c.status}] ${c.toolName} ${JSON.stringify(c.input).slice(0, 200)} (task: ${c.task})`).join("\n")
    : "(none)";
  const inputs = input.upstream.length
    ? input.upstream.map((u) => `## ${u.title}\n${u.text.slice(0, 8000)}`).join("\n\n")
    : "(this task has no upstream inputs)";

  const ai = meteredAI({ workspaceId: goal.workspaceId, goalId: goal.id, taskId: task.id, purpose: "verification" });
  const { object } = await ai.structured({
    tier: "fast",
    system: AGENTS.verification.instructions,
    schema: verdictSchema,
    schemaName: "verification_verdict",
    maxTokens: 2000,
    signal: input.signal,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `# Goal\n${input.goalBrief}\n\n# Task\n${task.title}\n${task.description}\n\n# Acceptance criteria\n${task.input.acceptanceCriteria}\n\n# Tool log for THIS task (ground truth for what this agent executed)\n${toolLog}\n\n# External actions executed by OTHER tasks in this goal (ground truth)\n${goalLog}\n\n# Verified inputs this task was given (outputs of the tasks it depends on; treat as established facts)\n${inputs}\n\n# Output to verify\n${output.slice(0, 60_000)}`,
          },
        ],
      },
    ],
  });

  // The verdict is the decision. The claims list is evidence for a FAIL; verifiers sometimes
  // use it for remarks, so on a PASS its entries are recorded as notes instead of vetoing.
  const pass = object.verdict === "PASS" && object.requirementsSatisfied && object.consistent;
  const claimsFail = !pass && object.unsupportedClaims.length > 0;
  checks.push(
    { name: "requirements_satisfied", passed: object.requirementsSatisfied, detail: object.requirementsSatisfied ? "Acceptance criteria met" : "Acceptance criteria not met" },
    { name: "internally_consistent", passed: object.consistent, detail: object.consistent ? "No contradictions found" : "Output is inconsistent" },
    {
      name: "claims_supported",
      passed: !claimsFail,
      detail: claimsFail
        ? object.unsupportedClaims.join("; ").slice(0, 600)
        : object.unsupportedClaims.length
          ? `Verifier notes (not blocking): ${object.unsupportedClaims.join("; ").slice(0, 500)}`
          : "No unsupported claims found",
    },
  );
  const issues = pass ? [] : [...object.issues, ...object.unsupportedClaims.map((c) => `Unsupported claim: ${c}`)];
  return {
    verdict: pass ? "PASS" : "FAIL",
    score: Math.min(1, Math.max(0, object.score)),
    checks,
    issues: issues.length || pass ? issues : ["Verification agent rejected the output without listing issues."],
    verifiedBy: "deterministic+agent",
  };
}
