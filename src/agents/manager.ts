import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { meteredAI } from "@/ai";
import { getDb, schema } from "@/db";
import type { Goal, Task } from "@/db/schema";
import { compilePlan, persistPlan } from "@/engine/compiler";
import { emit } from "@/engine/events";
import { env } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { AGENTS } from "./definitions";

export { assignAgent } from "./assign";

const decisionSchema = z.object({
  decision: z.enum(["replace", "abandon"]),
  reasoning: z.string(),
  approach: z
    .string()
    .describe("If replacing: how the replacement should differ from the failed attempt (smaller scope, different agent type, no unavailable tools...)"),
});

/**
 * Failure recovery. Called when a task has exhausted its retries. The Manager decides
 * whether to replace the task with a different approach (replan) or abandon it; an
 * abandoned task is marked FAILED and only its dependents are blocked - the rest of the
 * goal keeps running.
 *
 * Returns true if replacement tasks were created.
 */
export async function recoverFailedTask(input: {
  goal: Goal;
  task: Task;
  reason: string;
  memory: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const { goal, task, reason } = input;
  const db = await getDb();
  const base = { workspaceId: goal.workspaceId, goalId: goal.id };

  const [fresh] = await db.select({ replanCount: schema.goals.replanCount }).from(schema.goals).where(eq(schema.goals.id, goal.id));
  if (!goal.interpretation || (fresh?.replanCount ?? 0) >= env().MAX_REPLANS_PER_GOAL) return false;

  try {
    const ai = meteredAI({ ...base, taskId: task.id, purpose: "manager:recover" });
    const dependents = await db
      .select({ title: schema.tasks.title })
      .from(schema.taskDependencies)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDependencies.taskId))
      .where(eq(schema.taskDependencies.dependsOnTaskId, task.id));

    const { object: decision } = await ai.structured({
      tier: "fast",
      system: AGENTS.manager.instructions,
      schema: decisionSchema,
      schemaName: "recovery_decision",
      maxTokens: 1000,
      signal: input.signal,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Goal: ${goal.objective ?? goal.prompt}\n\nFailed task: "${task.title}" (${task.type}, agent ${task.assignedAgent}, ${task.retryCount} retries)\nDescription: ${task.description}\nFailure: ${reason}\n\nTasks waiting on it: ${dependents.map((d) => d.title).join("; ") || "none"}\n\nDecide: "replace" if a different approach could plausibly succeed and the work matters to the goal; "abandon" if retrying differently would not help (e.g. missing credentials, impossible request) or the task is not essential.`,
            },
          ],
        },
      ],
    });
    if (decision.decision === "abandon") {
      await emit({ ...base, taskId: task.id, type: "goal.replanned", message: `Manager abandoned "${task.title}": ${decision.reasoning}`, data: { decision: "abandon" } });
      return false;
    }

    const replanNo = (fresh?.replanCount ?? 0) + 1;
    const existing = await db
      .select({ key: schema.tasks.key, title: schema.tasks.title, status: schema.tasks.status, type: schema.tasks.type })
      .from(schema.tasks)
      .where(eq(schema.tasks.goalId, goal.id));
    const plan = await compilePlan(ai, {
      goal,
      interpretation: goal.interpretation,
      memory: input.memory,
      existing,
      keyPrefix: `r${replanNo}-`,
      maxTasks: 3,
      signal: input.signal,
      directive: `The task "${task.title}" failed permanently (${reason}). Plan 1-3 replacement tasks that achieve the same purpose with a different approach: ${decision.approach}. Do not include any other work.`,
    });
    plan.requirements = [];
    const created = await persistPlan(goal, plan, { parentTaskId: task.id });

    // Rewire: tasks that waited on the failed task now wait on the replacement's terminal tasks.
    const createdIds = created.map((c) => c.id);
    const internal = await db
      .select({ dependsOnTaskId: schema.taskDependencies.dependsOnTaskId })
      .from(schema.taskDependencies)
      .where(and(inArray(schema.taskDependencies.taskId, createdIds), inArray(schema.taskDependencies.dependsOnTaskId, createdIds)));
    const nonTerminal = new Set(internal.map((e) => e.dependsOnTaskId));
    const terminals = createdIds.filter((id) => !nonTerminal.has(id));
    const waiting = await db
      .select({ taskId: schema.taskDependencies.taskId })
      .from(schema.taskDependencies)
      .where(eq(schema.taskDependencies.dependsOnTaskId, task.id));
    await db.transaction(async (tx) => {
      await tx.delete(schema.taskDependencies).where(eq(schema.taskDependencies.dependsOnTaskId, task.id));
      const edges = waiting.flatMap((w) => terminals.map((t) => ({ taskId: w.taskId, dependsOnTaskId: t })));
      if (edges.length) await tx.insert(schema.taskDependencies).values(edges).onConflictDoNothing();
      // The original is superseded, not merely failed: a later retry must run the
      // replacement, never both.
      await tx
        .update(schema.tasks)
        .set({ status: "CANCELLED", error: `Replaced by the Manager with a different approach. Original failure: ${reason}`.slice(0, 900) })
        .where(eq(schema.tasks.id, task.id));
      await tx
        .update(schema.goals)
        .set({ replanCount: sql`${schema.goals.replanCount} + 1` })
        .where(eq(schema.goals.id, goal.id));
    });

    await emit({
      ...base,
      taskId: task.id,
      type: "goal.replanned",
      level: "warn",
      message: `Manager replaced "${task.title}" with ${created.length} new task${created.length === 1 ? "" : "s"}: ${decision.reasoning}`,
      data: { decision: "replace", newTasks: created.map((c) => c.title) },
    });
    return true;
  } catch (err) {
    // Recovery is best-effort; if it fails the task simply stays failed.
    log.warn("manager.recover_failed", { goalId: goal.id, taskId: task.id, error: describeError(err) });
    return false;
  }
}
