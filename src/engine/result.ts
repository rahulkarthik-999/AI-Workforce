import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { meteredAI } from "@/ai";
import { getDb, schema } from "@/db";
import type { Goal, ResultStats, Task } from "@/db/schema";
import { describeError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { recordSystemMemory } from "@/memory/service";
import { emit } from "./events";

/** Measured facts about a goal's execution. Nothing here is model-generated. */
export function computeStats(
  goal: Pick<Goal, "startedAt" | "createdAt" | "costUsd">,
  tasks: Pick<Task, "status" | "retryCount">[],
  usage: { inputTokens: number; outputTokens: number },
  now = new Date(),
): ResultStats {
  const by = (s: Task["status"]) => tasks.filter((t) => t.status === s).length;
  return {
    tasksTotal: tasks.length,
    tasksCompleted: by("COMPLETED"),
    tasksFailed: by("FAILED"),
    tasksBlocked: by("BLOCKED"),
    tasksCancelled: by("CANCELLED"),
    executionMs: now.getTime() - (goal.startedAt ?? goal.createdAt).getTime(),
    costUsd: goal.costUsd,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    retries: tasks.reduce((n, t) => n + t.retryCount, 0),
  };
}

export function outcomeStatus(stats: ResultStats): "COMPLETED" | "PARTIAL" | "FAILED" {
  if (stats.tasksTotal > 0 && stats.tasksCompleted === stats.tasksTotal) return "COMPLETED";
  return stats.tasksCompleted > 0 ? "PARTIAL" : "FAILED";
}

const synthesisSchema = z.object({
  statusLabel: z.string().describe("2-4 words in caps describing where the goal stands, e.g. READY FOR LAUNCH"),
  headline: z.string().describe("One sentence stating what was achieved"),
  summary: z.string().describe("3-6 sentences: what was produced, key decisions/findings, and any gaps. Markdown allowed."),
  nextBestAction: z
    .object({
      title: z.string().describe("Imperative, specific, under 12 words"),
      rationale: z.string().describe("Why this is the most valuable next step, grounded in the results"),
      actionPrompt: z.string().describe("Self-contained instruction for the workforce to carry out this step"),
      inputRequest: z
        .string()
        .nullable()
        .describe(
          "If this step cannot be done well without information or a decision only the user has, the exact question(s) to ask them, written to the user. Otherwise null.",
        ),
    })
    .nullable()
    .describe("The single most valuable next step, or null if nothing useful remains"),
  learnings: z
    .array(
      z.object({
        observation: z.string().describe("What was concretely observed in this execution"),
        pattern: z.string().describe("The generalizable pattern it suggests"),
        confidence: z.number().describe("0.0-1.0. Be conservative: one execution is weak evidence"),
        context: z.string().describe("When this pattern applies"),
        recommendation: z.string().describe("What to do differently or keep doing in similar future goals"),
      }),
    )
    .describe("0-3 learnings supported by evidence from this execution (verification failures, retries, rejections, what worked). Empty if none."),
});

const SYSTEM = `You are the Result Engine of an AI workforce platform. Given the measured execution record of a goal, write an honest result summary, recommend the single next best action, and extract evidence-based learnings.

Rules:
- Report only what the record shows. Failed, blocked or rejected work must be stated plainly.
- Never say something was launched, sent or published unless the tool log shows it succeeded.
- The next best action must follow from the results (e.g. approving/executing the prepared launch, fixing what failed, or the logical next phase).
- Learnings must cite evidence from this run; do not write generic advice. Keep confidence modest.
- The workforce cannot talk to the user. When progress depends on the user's information or decisions, the next best action must ask for it through inputRequest - never recommend drafting, sending or collecting a questionnaire.`;

/**
 * Produces the persisted Result for a finished goal, plus the Next Best Action and
 * Learnings derived from it. If narrative synthesis fails, the measured result is still
 * saved (flagged as not synthesized) so the user never loses the outcome.
 */
export async function createResult(goal: Goal, goalBrief: string): Promise<{ status: "COMPLETED" | "PARTIAL" | "FAILED" }> {
  const db = await getDb();
  const allTasks = await db.select().from(schema.tasks).where(eq(schema.tasks.goalId, goal.id));
  // Tasks the Manager replaced are bookkeeping, not outcomes: their replacements are what count.
  const replaced = new Set(allTasks.map((t) => t.parentTaskId).filter(Boolean));
  const tasks = allTasks.filter((t) => !(t.status === "CANCELLED" && replaced.has(t.id)));
  const docs = await db
    .select({ id: schema.documents.id, title: schema.documents.title })
    .from(schema.documents)
    .where(eq(schema.documents.goalId, goal.id));
  const [usage] = await db
    .select({
      inputTokens: sql<number>`coalesce(sum(${schema.usageRecords.inputTokens}),0)::int`,
      outputTokens: sql<number>`coalesce(sum(${schema.usageRecords.outputTokens}),0)::int`,
    })
    .from(schema.usageRecords)
    .where(eq(schema.usageRecords.goalId, goal.id));
  const externalCalls = await db
    .select({ toolName: schema.toolCalls.toolName, status: schema.toolCalls.status, input: schema.toolCalls.input, riskLevel: schema.toolCalls.riskLevel })
    .from(schema.toolCalls)
    .where(and(eq(schema.toolCalls.goalId, goal.id), sql`${schema.toolCalls.riskLevel} <> 'LOW'`));

  const [fresh] = await db.select().from(schema.goals).where(eq(schema.goals.id, goal.id));
  const stats = computeStats(fresh ?? goal, tasks, usage ?? { inputTokens: 0, outputTokens: 0 });
  const status = outcomeStatus(stats);
  const deliverables = docs.map((d) => ({ documentId: d.id, title: d.title }));
  const base = { workspaceId: goal.workspaceId, goalId: goal.id };

  const record = [
    `# Goal\n${goalBrief}`,
    `# Measured outcome\n${stats.tasksCompleted}/${stats.tasksTotal} tasks completed, ${stats.tasksFailed} failed, ${stats.tasksBlocked} blocked, ${stats.tasksCancelled} cancelled, ${stats.retries} retries.`,
    `# Tasks\n${tasks
      .map((t) => {
        const issues = t.verification?.issues?.length ? ` | verification issues: ${t.verification.issues.join("; ").slice(0, 300)}` : "";
        const out = t.output?.text ? `\n  Output excerpt: ${t.output.text.slice(0, 900).replace(/\n+/g, " ")}` : "";
        return `- [${t.status}] ${t.title} (${t.assignedAgent}, retries ${t.retryCount})${t.error ? ` | error: ${t.error}` : ""}${issues}${out}`;
      })
      .join("\n")}`,
    `# External actions (tool log)\n${externalCalls.length ? externalCalls.map((c) => `- ${c.toolName} [${c.status}] ${JSON.stringify(c.input).slice(0, 200)}`).join("\n") : "(none executed)"}`,
    `# Deliverables\n${deliverables.map((d) => `- ${d.title}`).join("\n") || "(none)"}`,
  ].join("\n\n");

  let synthesis: z.infer<typeof synthesisSchema> | null = null;
  try {
    const ai = meteredAI({ ...base, purpose: "result" });
    synthesis = (
      await ai.structured({
        system: SYSTEM,
        schema: synthesisSchema,
        schemaName: "goal_result",
        maxTokens: 3000,
        messages: [{ role: "user", content: [{ type: "text", text: record }] }],
      })
    ).object;
  } catch (err) {
    log.warn("result.synthesis_failed", { goalId: goal.id, error: describeError(err) });
  }

  const fallbackLabel = status === "COMPLETED" ? "COMPLETED" : status === "PARTIAL" ? "PARTIALLY COMPLETED" : "FAILED";
  const [result] = await db
    .insert(schema.results)
    .values({
      ...base,
      // The label is narrative; success/failure itself always comes from measured task states.
      statusLabel: status === "FAILED" ? "FAILED" : (synthesis?.statusLabel.toUpperCase().slice(0, 40) ?? fallbackLabel),
      headline: synthesis?.headline ?? `${stats.tasksCompleted} of ${stats.tasksTotal} tasks completed.`,
      summary:
        synthesis?.summary ??
        "A narrative summary could not be generated for this run. The task list and deliverables below reflect exactly what was executed.",
      stats,
      deliverables,
      synthesized: Boolean(synthesis),
    })
    .returning();
  await emit({ ...base, type: "result.created", message: `Result: ${result!.headline}`, data: { status } });

  if (synthesis?.learnings.length) {
    await db.insert(schema.learnings).values(
      synthesis.learnings.slice(0, 3).map((l) => ({
        ...base,
        resultId: result!.id,
        observation: l.observation,
        pattern: l.pattern,
        confidence: Math.min(1, Math.max(0, l.confidence)),
        context: l.context,
        recommendation: l.recommendation,
      })),
    );
  }

  if (synthesis?.nextBestAction) {
    const nba = synthesis.nextBestAction;
    await db.insert(schema.recommendations).values({
      ...base,
      resultId: result!.id,
      title: nba.title.slice(0, 200),
      rationale: nba.rationale,
      actionPrompt: nba.actionPrompt,
      inputRequest: nba.inputRequest?.trim() || null,
    });
    await emit({ ...base, type: "recommendation.created", message: `Next best action: ${nba.title}` });
  }

  await recordSystemMemory({
    ...base,
    category: "RESULT",
    title: `${goal.objective ?? goal.prompt}`.slice(0, 150),
    content: `${result!.statusLabel}: ${result!.headline} (${stats.tasksCompleted}/${stats.tasksTotal} tasks). Deliverables: ${deliverables.map((d) => d.title).join(", ") || "none"}.`,
  });
  const done = externalCalls.filter((c) => c.status === "SUCCEEDED");
  if (done.length) {
    await recordSystemMemory({
      ...base,
      category: "ACTION",
      title: `External actions for: ${goal.objective ?? goal.prompt}`.slice(0, 150),
      content: done.map((c) => `${c.toolName} ${JSON.stringify(c.input).slice(0, 300)}`).join("\n"),
    });
  }

  return { status };
}
