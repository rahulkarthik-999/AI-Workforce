import "server-only";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { log } from "@/lib/logger";

export type EventType =
  | "goal.created"
  | "goal.interpreted"
  | "goal.needs_input"
  | "goal.planned"
  | "goal.replanned"
  | "goal.waiting_approval"
  | "goal.completed"
  | "goal.failed"
  | "goal.cancelled"
  | "goal.resumed"
  | "task.ready"
  | "task.started"
  | "task.output_delta"
  | "task.retry"
  | "task.completed"
  | "task.failed"
  | "task.blocked"
  | "task.cancelled"
  | "agent.assigned"
  | "tool.started"
  | "tool.succeeded"
  | "tool.failed"
  | "verification.started"
  | "verification.passed"
  | "verification.failed"
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  | "result.created"
  | "recommendation.created"
  | "recommendation.approved"
  | "recommendation.dismissed"
  | "budget.exceeded";

export type EmitInput = {
  workspaceId: string;
  goalId: string;
  taskId?: string | null;
  type: EventType;
  message: string;
  level?: "info" | "warn" | "error";
  data?: Record<string, unknown>;
};

/**
 * The execution event log is the single source of truth for "what happened".
 * It feeds the live UI stream, the activity feed and debugging - nothing is
 * shown to users that was not recorded here by code that actually ran.
 */
export async function emit(e: EmitInput): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(schema.executionEvents).values({
      workspaceId: e.workspaceId,
      goalId: e.goalId,
      taskId: e.taskId ?? null,
      type: e.type,
      level: e.level ?? "info",
      message: e.message,
      data: e.data,
    });
  } catch (err) {
    // Never let logging break execution.
    log.error("event.emit_failed", { type: e.type, goalId: e.goalId, error: String(err) });
  }
  if (e.type !== "task.output_delta") {
    log.info("event", { type: e.type, goalId: e.goalId, taskId: e.taskId ?? undefined, message: e.message });
  }
}

export async function eventsAfter(goalId: string, afterId: number, limit = 200) {
  const db = await getDb();
  return db
    .select()
    .from(schema.executionEvents)
    .where(and(eq(schema.executionEvents.goalId, goalId), gt(schema.executionEvents.id, afterId)))
    .orderBy(asc(schema.executionEvents.id))
    .limit(limit);
}

export async function recentEvents(goalId: string, limit = 150) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(schema.executionEvents)
    .where(eq(schema.executionEvents.goalId, goalId))
    .orderBy(desc(schema.executionEvents.id))
    .limit(limit);
  return rows.reverse();
}
