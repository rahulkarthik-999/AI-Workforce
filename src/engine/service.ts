import "server-only";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { requireProvider } from "@/ai";
import { getDb, schema } from "@/db";
import type { Clarification, Goal } from "@/db/schema";
import { env } from "@/lib/env";
import { AppError, assertUuid } from "@/lib/errors";
import { emit } from "./events";
import { blockingQuestions } from "./interpreter";

export type Actor = { userId: string; workspaceId: string };

export async function audit(actor: Actor, action: string, targetType: string, targetId: string, data?: Record<string, unknown>) {
  const db = await getDb();
  await db.insert(schema.auditLogs).values({ workspaceId: actor.workspaceId, userId: actor.userId, action, targetType, targetId, data });
}

/** Loads a goal only if it belongs to the actor's workspace (workspace isolation). */
export async function getGoal(actor: Actor, goalId: string): Promise<Goal> {
  assertUuid(goalId, "Goal");
  const db = await getDb();
  const [goal] = await db
    .select()
    .from(schema.goals)
    .where(and(eq(schema.goals.id, goalId), eq(schema.goals.workspaceId, actor.workspaceId)));
  if (!goal) throw new AppError("Goal not found.", 404, "not_found");
  return goal;
}

export async function createGoal(actor: Actor, input: { prompt: string; budgetUsd?: number }): Promise<Goal> {
  // Fail fast with a configuration message instead of creating a goal that cannot run.
  requireProvider();
  const db = await getDb();
  const [goal] = await db
    .insert(schema.goals)
    .values({
      workspaceId: actor.workspaceId,
      createdById: actor.userId,
      prompt: input.prompt.trim(),
      budgetUsd: input.budgetUsd ?? env().GOAL_BUDGET_USD,
    })
    .returning();
  await emit({ workspaceId: actor.workspaceId, goalId: goal!.id, type: "goal.created", message: "Goal received" });
  await audit(actor, "goal.create", "goal", goal!.id);
  return goal!;
}

export async function answerQuestions(actor: Actor, goalId: string, answers: Clarification[]): Promise<void> {
  const goal = await getGoal(actor, goalId);
  if (goal.status !== "NEEDS_INPUT") throw new AppError("This goal is not waiting for input.", 409, "conflict");
  const db = await getDb();
  await db
    .update(schema.goals)
    .set({ clarifications: [...goal.clarifications, ...answers], status: "INTERPRETING" })
    .where(eq(schema.goals.id, goalId));
  await emit({ workspaceId: goal.workspaceId, goalId, type: "goal.resumed", message: "Answers received - continuing" });
}

export async function cancelGoal(actor: Actor, goalId: string): Promise<void> {
  const goal = await getGoal(actor, goalId);
  if (["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(goal.status)) {
    throw new AppError("This goal has already finished.", 409, "conflict");
  }
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.update(schema.goals).set({ status: "CANCELLED", completedAt: new Date() }).where(eq(schema.goals.id, goalId));
    await tx
      .update(schema.tasks)
      .set({ status: "CANCELLED", completedAt: new Date() })
      .where(and(eq(schema.tasks.goalId, goalId), inArray(schema.tasks.status, ["PENDING", "READY", "RUNNING", "WAITING_APPROVAL"])));
    await tx
      .update(schema.approvals)
      .set({ status: "EXPIRED" })
      .where(and(eq(schema.approvals.goalId, goalId), eq(schema.approvals.status, "PENDING")));
  });
  await emit({ workspaceId: goal.workspaceId, goalId, type: "goal.cancelled", level: "warn", message: "Goal cancelled by user" });
  await audit(actor, "goal.cancel", "goal", goalId);
}

/** Retry a failed / partial goal: failed work is re-queued, completed work is kept. */
export async function resumeGoal(actor: Actor, goalId: string, opts: { addBudgetUsd?: number } = {}): Promise<void> {
  const goal = await getGoal(actor, goalId);
  if (goal.status !== "FAILED" && goal.status !== "PARTIAL") {
    throw new AppError("Only failed or partially completed goals can be retried.", 409, "conflict");
  }
  requireProvider();
  const db = await getDb();
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.tasks)
    .where(eq(schema.tasks.goalId, goalId));
  const next = !goal.interpretation ? "INTERPRETING" : n === 0 ? "PLANNING" : "RUNNING";
  await db.transaction(async (tx) => {
    await tx
      .update(schema.tasks)
      .set({ status: "PENDING", retryCount: 0, error: null, completedAt: null })
      .where(and(eq(schema.tasks.goalId, goalId), inArray(schema.tasks.status, ["FAILED", "BLOCKED"])));
    await tx
      .update(schema.goals)
      .set({
        status: next,
        error: null,
        completedAt: null,
        budgetUsd: sql`${schema.goals.budgetUsd} + ${opts.addBudgetUsd ?? 0}`,
      })
      .where(eq(schema.goals.id, goalId));
  });
  await emit({
    workspaceId: goal.workspaceId,
    goalId,
    type: "goal.resumed",
    message: opts.addBudgetUsd ? `Retrying with $${opts.addBudgetUsd.toFixed(2)} additional budget` : "Retrying failed work",
  });
  await audit(actor, "goal.resume", "goal", goalId, { addBudgetUsd: opts.addBudgetUsd ?? 0 });
}

/**
 * Record an approval decision and un-pause the work it gates. The decision is persisted
 * atomically; a second decision on the same approval is rejected.
 */
export async function decideApproval(
  actor: Actor,
  approvalId: string,
  decision: "APPROVED" | "REJECTED",
  note?: string,
): Promise<{ goalId: string }> {
  assertUuid(approvalId, "Approval");
  const db = await getDb();
  const [approval] = await db
    .update(schema.approvals)
    .set({ status: decision, decidedById: actor.userId, decisionNote: note?.trim() || null, decidedAt: new Date() })
    .where(and(eq(schema.approvals.id, approvalId), eq(schema.approvals.workspaceId, actor.workspaceId), eq(schema.approvals.status, "PENDING")))
    .returning();
  if (!approval) throw new AppError("Approval not found or already decided.", 409, "conflict");

  const base = { workspaceId: approval.workspaceId, goalId: approval.goalId, taskId: approval.taskId };
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, approval.taskId));

  if (task?.status === "WAITING_APPROVAL") {
    if (approval.kind === "TASK" && decision === "REJECTED") {
      await db
        .update(schema.tasks)
        .set({ status: "CANCELLED", error: `Rejected by reviewer${note ? `: ${note}` : ""}`, completedAt: new Date() })
        .where(eq(schema.tasks.id, task.id));
      await emit({ ...base, type: "task.cancelled", level: "warn", message: `"${task.title}" was rejected and will not run` });
    } else {
      // TASK approved -> start it. TOOL_CALL approved or rejected -> the agent resumes and
      // either executes the tool or is told it was refused and adapts.
      await db
        .update(schema.tasks)
        .set({ status: "READY", input: approval.kind === "TASK" ? { ...task.input, approved: true } : task.input })
        .where(eq(schema.tasks.id, task.id));
    }
  }

  await db
    .update(schema.goals)
    .set({ status: "RUNNING" })
    .where(and(eq(schema.goals.id, approval.goalId), eq(schema.goals.status, "WAITING_APPROVAL")));
  await emit({
    ...base,
    type: decision === "APPROVED" ? "approval.approved" : "approval.rejected",
    level: decision === "APPROVED" ? "info" : "warn",
    message: `${decision === "APPROVED" ? "Approved" : "Rejected"}: ${approval.title}`,
    data: { approvalId, note: note ?? null },
  });
  await audit(actor, `approval.${decision.toLowerCase()}`, "approval", approvalId, { goalId: approval.goalId, risk: approval.riskLevel });
  return { goalId: approval.goalId };
}

/** Approve or dismiss a Next Best Action. Approval re-opens the goal for follow-up planning. */
export async function decideRecommendation(
  actor: Actor,
  recommendationId: string,
  decision: "APPROVED" | "DISMISSED",
): Promise<{ goalId: string; resumed: boolean }> {
  assertUuid(recommendationId, "Recommendation");
  const db = await getDb();
  if (decision === "APPROVED") requireProvider();
  const [rec] = await db
    .update(schema.recommendations)
    .set({ status: decision, decidedById: actor.userId, decidedAt: new Date() })
    .where(
      and(
        eq(schema.recommendations.id, recommendationId),
        eq(schema.recommendations.workspaceId, actor.workspaceId),
        eq(schema.recommendations.status, "PENDING"),
      ),
    )
    .returning();
  if (!rec) throw new AppError("Recommendation not found or already decided.", 409, "conflict");
  const base = { workspaceId: rec.workspaceId, goalId: rec.goalId };

  if (decision === "DISMISSED") {
    await emit({ ...base, type: "recommendation.dismissed", message: `Dismissed: ${rec.title}` });
    await audit(actor, "recommendation.dismissed", "recommendation", rec.id);
    return { goalId: rec.goalId, resumed: false };
  }

  const [reopened] = await db
    .update(schema.goals)
    .set({ status: "PLANNING", completedAt: null, error: null })
    .where(and(eq(schema.goals.id, rec.goalId), inArray(schema.goals.status, ["COMPLETED", "PARTIAL", "FAILED"])))
    .returning({ id: schema.goals.id });
  await emit({ ...base, type: "recommendation.approved", message: `Approved next action: ${rec.title}` });
  await audit(actor, "recommendation.approved", "recommendation", rec.id);
  return { goalId: rec.goalId, resumed: Boolean(reopened) };
}

export async function listGoals(actor: Actor, limit = 50) {
  const db = await getDb();
  const goals = await db
    .select()
    .from(schema.goals)
    .where(eq(schema.goals.workspaceId, actor.workspaceId))
    .orderBy(desc(schema.goals.createdAt))
    .limit(limit);
  if (goals.length === 0) return [];
  const counts = await db
    .select({ goalId: schema.tasks.goalId, status: schema.tasks.status, n: sql<number>`count(*)::int` })
    .from(schema.tasks)
    .where(
      and(
        inArray(schema.tasks.goalId, goals.map((g) => g.id)),
        // Replaced tasks are not part of the plan any more.
        sql`not (${schema.tasks.status} = 'CANCELLED' and coalesce(${schema.tasks.error}, '') like 'Replaced by the Manager%')`,
      ),
    )
    .groupBy(schema.tasks.goalId, schema.tasks.status);
  return goals.map((g) => {
    const mine = counts.filter((c) => c.goalId === g.id);
    const total = mine.reduce((a, c) => a + c.n, 0);
    const completed = mine.find((c) => c.status === "COMPLETED")?.n ?? 0;
    return { ...g, tasksTotal: total, tasksCompleted: completed };
  });
}

export async function pendingApprovals(actor: Actor) {
  const db = await getDb();
  return db
    .select({
      approval: schema.approvals,
      goalPrompt: schema.goals.prompt,
      goalObjective: schema.goals.objective,
      taskTitle: schema.tasks.title,
      agent: schema.tasks.assignedAgent,
    })
    .from(schema.approvals)
    .innerJoin(schema.goals, eq(schema.goals.id, schema.approvals.goalId))
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.approvals.taskId))
    .where(and(eq(schema.approvals.workspaceId, actor.workspaceId), eq(schema.approvals.status, "PENDING")))
    .orderBy(asc(schema.approvals.createdAt));
}

/** Everything the Command Center needs to render one goal - all read from persisted state. */
export async function goalSnapshot(actor: Actor, goalId: string) {
  const goal = await getGoal(actor, goalId);
  const db = await getDb();
  const [tasks, dependencies, approvals, documents, results, recommendations, requirements, events, toolCalls, usage, runs] = await Promise.all([
    db.select().from(schema.tasks).where(eq(schema.tasks.goalId, goalId)).orderBy(asc(schema.tasks.createdAt), asc(schema.tasks.priority)),
    db
      .select({ taskId: schema.taskDependencies.taskId, dependsOnTaskId: schema.taskDependencies.dependsOnTaskId })
      .from(schema.taskDependencies)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDependencies.taskId))
      .where(eq(schema.tasks.goalId, goalId)),
    db.select().from(schema.approvals).where(eq(schema.approvals.goalId, goalId)).orderBy(desc(schema.approvals.createdAt)),
    db
      .select({
        id: schema.documents.id,
        title: schema.documents.title,
        kind: schema.documents.kind,
        mimeType: schema.documents.mimeType,
        taskId: schema.documents.taskId,
        createdAt: schema.documents.createdAt,
        size: sql<number>`length(${schema.documents.content})::int`,
      })
      .from(schema.documents)
      .where(eq(schema.documents.goalId, goalId))
      .orderBy(asc(schema.documents.createdAt)),
    db.select().from(schema.results).where(eq(schema.results.goalId, goalId)).orderBy(desc(schema.results.createdAt)).limit(1),
    db.select().from(schema.recommendations).where(eq(schema.recommendations.goalId, goalId)).orderBy(desc(schema.recommendations.createdAt)).limit(5),
    db.select().from(schema.goalRequirements).where(eq(schema.goalRequirements.goalId, goalId)).orderBy(asc(schema.goalRequirements.position)),
    db
      .select()
      .from(schema.executionEvents)
      .where(and(eq(schema.executionEvents.goalId, goalId), ne(schema.executionEvents.type, "task.output_delta")))
      .orderBy(desc(schema.executionEvents.id))
      .limit(200),
    db
      .select({
        id: schema.toolCalls.id,
        taskId: schema.toolCalls.taskId,
        toolName: schema.toolCalls.toolName,
        status: schema.toolCalls.status,
        riskLevel: schema.toolCalls.riskLevel,
        input: schema.toolCalls.input,
        error: schema.toolCalls.error,
        durationMs: schema.toolCalls.durationMs,
        createdAt: schema.toolCalls.createdAt,
      })
      .from(schema.toolCalls)
      .where(eq(schema.toolCalls.goalId, goalId))
      .orderBy(asc(schema.toolCalls.createdAt)),
    db
      .select({
        calls: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${schema.usageRecords.inputTokens}),0)::int`,
        outputTokens: sql<number>`coalesce(sum(${schema.usageRecords.outputTokens}),0)::int`,
        unpriced: sql<number>`coalesce(sum(case when ${schema.usageRecords.priced} then 0 else 1 end),0)::int`,
      })
      .from(schema.usageRecords)
      .where(eq(schema.usageRecords.goalId, goalId)),
    db
      .select({
        id: schema.agentRuns.id,
        taskId: schema.agentRuns.taskId,
        agent: schema.agentRuns.agent,
        attempt: schema.agentRuns.attempt,
        status: schema.agentRuns.status,
        iterations: schema.agentRuns.iterations,
        inputTokens: schema.agentRuns.inputTokens,
        outputTokens: schema.agentRuns.outputTokens,
        costUsd: schema.agentRuns.costUsd,
        error: schema.agentRuns.error,
        startedAt: schema.agentRuns.startedAt,
        completedAt: schema.agentRuns.completedAt,
      })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.goalId, goalId))
      .orderBy(asc(schema.agentRuns.startedAt)),
  ]);

  const { leaseOwner: _owner, leaseExpiresAt, ...publicGoal } = goal;
  void _owner;
  return {
    goal: {
      ...publicGoal,
      executing: Boolean(leaseExpiresAt && leaseExpiresAt > new Date()),
      questions: goal.status === "NEEDS_INPUT" && goal.interpretation ? blockingQuestions(goal.interpretation, goal.clarifications) : [],
    },
    tasks,
    dependencies,
    approvals,
    documents,
    result: results[0] ?? null,
    recommendations,
    requirements,
    events: events.reverse(),
    toolCalls,
    runs,
    usage: usage[0] ?? { calls: 0, inputTokens: 0, outputTokens: 0, unpriced: 0 },
  };
}

export type GoalSnapshot = Awaited<ReturnType<typeof goalSnapshot>>;
