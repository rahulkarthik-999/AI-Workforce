import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { AIError, meteredAI } from "@/ai";
import { agentById } from "@/agents/assign";
import { AGENTS } from "@/agents/definitions";
import { recoverFailedTask } from "@/agents/manager";
import { runAgentTask } from "@/agents/runtime";
import { getDb, schema } from "@/db";
import type { Goal, GoalStatus, Task, TaskOutput } from "@/db/schema";
import { env } from "@/lib/env";
import { BudgetExceededError, ConfigError, TimeoutError, describeError, withTimeout } from "@/lib/errors";
import { log } from "@/lib/logger";
import { memoryContext } from "@/memory/service";
import { compilePlan, goalBrief, persistPlan } from "./compiler";
import { emit } from "./events";
import { pickBatch, resolveTransitions } from "./graph";
import { blockingQuestions, interpretGoal } from "./interpreter";
import { createResult } from "./result";
import { verifyTask } from "./verification";

export const ACTIVE_STATUSES: GoalStatus[] = ["INTERPRETING", "PLANNING", "RUNNING"];

const LEASE_MS = 60_000;
const HEARTBEAT_MS = 15_000;
/** Do not start new work after this much of the invocation has elapsed. */
const DEFAULT_SLICE_MS = 100_000;
const PHASE_TIMEOUT_MS = 150_000;
const MAX_RATE_LIMIT_WAITS = 4;
const RATE_LIMIT_BASE_MS = process.env.NODE_ENV === "test" ? 5 : 8_000;

type Halt = { halt: true; error: string };

/** Errors that no retry can fix: stop the goal with an actionable message instead of burning attempts. */
function fatal(err: unknown): string | null {
  if (err instanceof BudgetExceededError || err instanceof ConfigError) return err.message;
  if (err instanceof AIError && err.kind === "config") return err.message;
  // The provider rejected the request shape itself. Retrying or replanning would send the
  // same request again, so stop once with the provider's own explanation.
  if (err instanceof AIError && err.kind === "request") {
    return `The AI provider rejected the request and retrying cannot fix it: ${err.message} Check AI_MODEL / provider settings, then retry.`;
  }
  return null;
}

async function acquireLease(goalId: string, owner: string): Promise<Goal | undefined> {
  const db = await getDb();
  const now = new Date();
  const [goal] = await db
    .update(schema.goals)
    .set({ leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) })
    .where(
      and(
        eq(schema.goals.id, goalId),
        inArray(schema.goals.status, ACTIVE_STATUSES),
        or(isNull(schema.goals.leaseExpiresAt), lt(schema.goals.leaseExpiresAt, now)),
      ),
    )
    .returning();
  return goal;
}

async function releaseLease(goalId: string, owner: string) {
  const db = await getDb();
  await db
    .update(schema.goals)
    .set({ leaseOwner: null, leaseExpiresAt: null })
    .where(and(eq(schema.goals.id, goalId), eq(schema.goals.leaseOwner, owner)));
}

async function setGoal(goalId: string, patch: Partial<typeof schema.goals.$inferInsert>) {
  const db = await getDb();
  // A cancelled goal is never revived by a late-finishing runner.
  await db
    .update(schema.goals)
    .set(patch)
    .where(and(eq(schema.goals.id, goalId), sql`${schema.goals.status} <> 'CANCELLED'`));
}

async function haltGoal(goal: Goal, error: string) {
  const db = await getDb();
  // Work in flight goes back to READY (no retry penalty) so the goal can be resumed once fixed.
  await db
    .update(schema.tasks)
    .set({ status: "READY" })
    .where(and(eq(schema.tasks.goalId, goal.id), eq(schema.tasks.status, "RUNNING")));
  await setGoal(goal.id, { status: "FAILED", error });
  await emit({
    workspaceId: goal.workspaceId,
    goalId: goal.id,
    type: /budget/i.test(error) ? "budget.exceeded" : "goal.failed",
    level: "error",
    message: error,
  });
}

/* ------------------------------------------------------------------ phases */

async function interpretPhase(goal: Goal, signal: AbortSignal): Promise<void> {
  const base = { workspaceId: goal.workspaceId, goalId: goal.id };
  const ai = meteredAI({ ...base, purpose: "interpret" });
  const memory = await memoryContext(goal.workspaceId, goal.createdById);
  const interpretation = await interpretGoal(ai, { prompt: goal.prompt, clarifications: goal.clarifications, memory, signal });
  const questions = blockingQuestions(interpretation, goal.clarifications);
  await emit({ ...base, type: "goal.interpreted", message: `Understood: ${interpretation.objective}` });
  if (questions.length) {
    await setGoal(goal.id, { interpretation, objective: interpretation.objective, status: "NEEDS_INPUT" });
    await emit({ ...base, type: "goal.needs_input", level: "warn", message: `Waiting for ${questions.length} answer${questions.length === 1 ? "" : "s"} before planning` });
  } else {
    await setGoal(goal.id, { interpretation, objective: interpretation.objective, status: "PLANNING" });
  }
}

async function planPhase(goal: Goal, signal: AbortSignal): Promise<void> {
  const db = await getDb();
  const base = { workspaceId: goal.workspaceId, goalId: goal.id };
  if (!goal.interpretation) {
    await setGoal(goal.id, { status: "INTERPRETING" });
    return;
  }
  const ai = meteredAI({ ...base, purpose: "plan" });
  const memory = await memoryContext(goal.workspaceId, goal.createdById);
  const existing = await db
    .select({ key: schema.tasks.key, title: schema.tasks.title, status: schema.tasks.status, type: schema.tasks.type })
    .from(schema.tasks)
    .where(eq(schema.tasks.goalId, goal.id));

  if (existing.length === 0) {
    const plan = await compilePlan(ai, { goal, interpretation: goal.interpretation, memory, signal });
    const created = await persistPlan(goal, plan);
    await setGoal(goal.id, { status: "RUNNING", startedAt: goal.startedAt ?? new Date() });
    await emit({ ...base, type: "goal.planned", message: `Compiled a plan with ${created.length} tasks`, data: { tasks: created.length } });
    return;
  }

  // Follow-up planning: an approved Next Best Action becomes new tasks on the same goal.
  const [rec] = await db
    .select()
    .from(schema.recommendations)
    .where(and(eq(schema.recommendations.goalId, goal.id), eq(schema.recommendations.status, "APPROVED"), isNull(schema.recommendations.appliedAt)))
    .orderBy(asc(schema.recommendations.createdAt))
    .limit(1);
  if (!rec) {
    await setGoal(goal.id, { status: "RUNNING" });
    return;
  }
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.recommendations)
    .where(and(eq(schema.recommendations.goalId, goal.id), sql`${schema.recommendations.appliedAt} is not null`));
  const plan = await compilePlan(ai, {
    goal,
    interpretation: goal.interpretation,
    memory,
    existing,
    keyPrefix: `f${n + 1}-`,
    maxTasks: 6,
    signal,
    directive: `The user approved this next action. Plan only the tasks needed to carry it out, building on completed work:\n${rec.title}\n${rec.actionPrompt}${
      rec.userInput
        ? `\n\nThe user provided this input${rec.inputRequest ? ` in answer to "${rec.inputRequest}"` : ""}. It is authoritative and overrides earlier assumptions; make sure every task uses it:\n${rec.userInput}`
        : ""
    }`,
  });
  plan.requirements = [];
  const created = await persistPlan(goal, plan);
  await db.update(schema.recommendations).set({ appliedAt: new Date() }).where(eq(schema.recommendations.id, rec.id));
  await setGoal(goal.id, { status: "RUNNING" });
  await emit({ ...base, type: "goal.planned", message: `Planned ${created.length} follow-up task${created.length === 1 ? "" : "s"} for "${rec.title}"`, data: { tasks: created.length } });
}

/* ------------------------------------------------------------- task runner */

async function upstreamOutputs(taskId: string) {
  const db = await getDb();
  const rows = await db
    .select({ title: schema.tasks.title, agent: schema.tasks.assignedAgent, output: schema.tasks.output })
    .from(schema.taskDependencies)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDependencies.dependsOnTaskId))
    .where(eq(schema.taskDependencies.taskId, taskId));
  return rows.filter((r) => r.output?.text).map((r) => ({ title: r.title, agent: r.agent, text: r.output!.text }));
}

async function failOrRetry(goal: Goal, task: Task, reason: string, feedback: string[] | null, memory: string): Promise<void> {
  const db = await getDb();
  const base = { workspaceId: goal.workspaceId, goalId: goal.id, taskId: task.id };
  const maxRetries = env().MAX_TASK_RETRIES;

  if (task.retryCount < maxRetries) {
    await db
      .update(schema.tasks)
      .set({
        status: "READY",
        retryCount: task.retryCount + 1,
        error: reason,
        input: feedback ? { ...task.input, repairFeedback: feedback } : task.input,
      })
      .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, "RUNNING")));
    await emit({ ...base, type: "task.retry", level: "warn", message: `Retrying "${task.title}" (attempt ${task.retryCount + 2} of ${maxRetries + 1}): ${reason}` });
    return;
  }

  await db
    .update(schema.tasks)
    .set({ status: "FAILED", error: reason, completedAt: new Date() })
    .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, "RUNNING")));
  await emit({ ...base, type: "task.failed", level: "error", message: `"${task.title}" failed after ${task.retryCount + 1} attempts: ${reason}` });
  await recoverFailedTask({ goal, task, reason, memory });
}

async function executeTask(goal: Goal, task: Task, brief: string, memory: string, signal: AbortSignal): Promise<void | Halt> {
  const db = await getDb();
  const base = { workspaceId: goal.workspaceId, goalId: goal.id, taskId: task.id };
  const agent = agentById(task.assignedAgent) ?? AGENTS.strategy;

  // HIGH-risk tasks are gated before any work begins.
  if (task.approvalRequired && !task.input.approved) {
    await db.transaction(async (tx) => {
      await tx.insert(schema.approvals).values({
        ...base,
        kind: "TASK",
        title: task.title,
        summary: task.description,
        payload: { acceptanceCriteria: task.input.acceptanceCriteria, agent: agent.id, tools: task.requiredTools },
        riskLevel: task.riskLevel,
      });
      await tx.update(schema.tasks).set({ status: "WAITING_APPROVAL" }).where(eq(schema.tasks.id, task.id));
    });
    await emit({ ...base, type: "approval.requested", level: "warn", message: `Approval required before starting "${task.title}" (${task.riskLevel} risk)`, data: { risk: task.riskLevel } });
    return;
  }

  await db
    .update(schema.tasks)
    .set({ status: "RUNNING", startedAt: task.startedAt ?? new Date(), error: null })
    .where(eq(schema.tasks.id, task.id));
  await emit({ ...base, type: "task.started", message: `${agent.name} started "${task.title}"`, data: { agent: agent.id, attempt: task.retryCount + 1 } });

  try {
    const outcome = await withTimeout(
      env().TASK_TIMEOUT_MS,
      `Task "${task.title}"`,
      async (taskSignal) => {
        const upstream = await upstreamOutputs(task.id);
        const result = await runAgentTask({
          goal,
          task,
          agent,
          goalBrief: brief,
          upstream,
          memory,
          userId: goal.createdById,
          signal: taskSignal,
        });
        if (result.status === "waiting_approval") return result;

        await emit({ ...base, type: "verification.started", message: `Verifying "${task.title}"` });
        const report = await verifyTask({ goal, task, output: result.text, truncated: result.truncated, runId: result.runId, goalBrief: brief, upstream, signal: taskSignal });
        return { ...result, report };
      },
      signal,
    );

    if (outcome.status === "waiting_approval") {
      await db.update(schema.tasks).set({ status: "WAITING_APPROVAL" }).where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, "RUNNING")));
      return;
    }

    const { report, text } = outcome;
    if (report.verdict === "FAIL") {
      await db.update(schema.tasks).set({ verificationStatus: "FAILED", verification: report, output: { text } }).where(eq(schema.tasks.id, task.id));
      await emit({ ...base, type: "verification.failed", level: "warn", message: `Verification failed for "${task.title}": ${report.issues[0] ?? "see report"}`, data: { issues: report.issues } });
      await failOrRetry(goal, task, `Verification failed: ${report.issues.join("; ").slice(0, 500)}`, report.issues, memory);
      return;
    }

    let output: TaskOutput = { text };
    if (task.input.deliverable) {
      const [doc] = await db
        .insert(schema.documents)
        .values({ workspaceId: goal.workspaceId, goalId: goal.id, taskId: task.id, title: task.title, content: text })
        .returning({ id: schema.documents.id });
      output = { text, documentId: doc!.id };
    }
    const [done] = await db
      .update(schema.tasks)
      .set({ status: "COMPLETED", output, verificationStatus: "PASSED", verification: report, error: null, completedAt: new Date() })
      .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, "RUNNING")))
      .returning({ id: schema.tasks.id });
    if (!done) return; // goal was cancelled while this task ran
    // Live output chunks are transient; the final text now lives on the task.
    await db.delete(schema.executionEvents).where(and(eq(schema.executionEvents.taskId, task.id), eq(schema.executionEvents.type, "task.output_delta")));
    await emit({ ...base, type: "verification.passed", message: `Verification passed for "${task.title}" (score ${report.score.toFixed(2)})`, data: { score: report.score } });
    await emit({ ...base, type: "task.completed", message: `${agent.name} completed "${task.title}"`, data: { agent: agent.id } });
  } catch (err) {
    const fatalMessage = fatal(err);
    if (fatalMessage) return { halt: true, error: fatalMessage };
    // The invocation's time slice ended (or the goal was cancelled): leave the task resumable.
    if (signal.aborted && !(err instanceof TimeoutError)) {
      await db.update(schema.tasks).set({ status: "READY" }).where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, "RUNNING")));
      return;
    }
    // A rate limit says nothing about the task: wait it out instead of spending a retry.
    const waits = task.input.rateLimitWaits ?? 0;
    if (err instanceof AIError && err.kind === "rate_limit" && waits < MAX_RATE_LIMIT_WAITS) {
      const delayMs = Math.min(40_000, RATE_LIMIT_BASE_MS * 2 ** waits);
      await emit({ workspaceId: goal.workspaceId, goalId: goal.id, taskId: task.id, type: "task.retry", level: "warn", message: `Provider rate limit reached; "${task.title}" will resume in ${Math.round(delayMs / 1000)}s` });
      await new Promise((r) => setTimeout(r, delayMs));
      await db
        .update(schema.tasks)
        .set({ status: "READY", input: { ...task.input, rateLimitWaits: waits + 1 } })
        .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, "RUNNING")));
      return;
    }
    log.warn("task.error", { goalId: goal.id, taskId: task.id, error: describeError(err) });
    await failOrRetry(goal, task, describeError(err), null, memory);
  }
}

/* -------------------------------------------------------------- scheduling */

/**
 * One scheduling pass over the task graph.
 * Returns "continue" if more work may be runnable, "stop" if the goal is now waiting on a
 * human or finished.
 */
async function runPhase(goal: Goal, signal: AbortSignal): Promise<"continue" | "stop" | Halt> {
  const db = await getDb();
  const base = { workspaceId: goal.workspaceId, goalId: goal.id };

  const tasks = await db.select().from(schema.tasks).where(eq(schema.tasks.goalId, goal.id));
  const edges = await db
    .select({ taskId: schema.taskDependencies.taskId, dependsOnTaskId: schema.taskDependencies.dependsOnTaskId })
    .from(schema.taskDependencies)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDependencies.taskId))
    .where(eq(schema.tasks.goalId, goal.id));

  const { ready, blocked } = resolveTransitions(tasks, edges);
  if (ready.length) await db.update(schema.tasks).set({ status: "READY" }).where(inArray(schema.tasks.id, ready));
  if (blocked.length) {
    await db
      .update(schema.tasks)
      .set({ status: "BLOCKED", error: "A task this depends on did not complete." })
      .where(inArray(schema.tasks.id, blocked));
    for (const id of blocked) {
      const t = tasks.find((x) => x.id === id)!;
      await emit({ ...base, taskId: id, type: "task.blocked", level: "warn", message: `"${t.title}" is blocked because a dependency did not complete` });
    }
  }

  const readySet = new Set(ready);
  const runnable = tasks.filter((t) => t.status === "READY" || readySet.has(t.id));
  if (runnable.length > 0) {
    const batch = pickBatch(runnable, env().MAX_PARALLEL_TASKS);
    const brief = goalBrief(goal, goal.interpretation!);
    const memory = await memoryContext(goal.workspaceId, goal.createdById);
    // Independent tasks run in parallel; one task failing never rejects the batch.
    const outcomes = await Promise.all(batch.map((t) => executeTask(goal, t, brief, memory, signal)));
    const halt = outcomes.find((o): o is Halt => Boolean(o));
    return halt ?? "continue";
  }

  const blockedSet = new Set(blocked);
  const waiting = tasks.filter((t) => t.status === "WAITING_APPROVAL");
  const pending = tasks.filter((t) => t.status === "PENDING" && !blockedSet.has(t.id));
  if (waiting.length > 0) {
    await setGoal(goal.id, { status: "WAITING_APPROVAL" });
    await emit({ ...base, type: "goal.waiting_approval", level: "warn", message: `Paused: ${waiting.length} action${waiting.length === 1 ? "" : "s"} awaiting your approval` });
    return "stop";
  }
  if (pending.length > 0) {
    // Unreachable for a valid DAG; guard against a stuck graph rather than spinning.
    return { halt: true, error: "Execution stalled: tasks remain pending with unsatisfiable dependencies." };
  }

  const { status } = await createResult(goal, goalBrief(goal, goal.interpretation!));
  await setGoal(goal.id, { status, completedAt: new Date(), error: status === "FAILED" ? "No task could be completed. See the task list for details." : null });
  await emit({
    ...base,
    type: status === "FAILED" ? "goal.failed" : "goal.completed",
    level: status === "COMPLETED" ? "info" : "warn",
    message: status === "COMPLETED" ? "Goal completed" : status === "PARTIAL" ? "Goal finished with some tasks incomplete" : "Goal failed",
  });
  return "stop";
}

/* -------------------------------------------------------------- entrypoint */

/**
 * Advance a goal as far as possible within one time slice.
 *
 * Safe to call from anywhere, any number of times: a database lease guarantees a single
 * runner per goal, all state lives in the database, and whatever is not finished when the
 * slice ends is picked up by the next call. Returns { more: true } when another slice is
 * needed.
 */
export async function runGoal(goalId: string, opts: { sliceMs?: number } = {}): Promise<{ more: boolean }> {
  const owner = randomUUID();
  const started = Date.now();
  const sliceMs = opts.sliceMs ?? DEFAULT_SLICE_MS;
  const db = await getDb();

  const leased = await acquireLease(goalId, owner);
  if (!leased) return { more: false };

  const abort = new AbortController();
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const [g] = await db
          .update(schema.goals)
          .set({ leaseExpiresAt: new Date(Date.now() + LEASE_MS) })
          .where(and(eq(schema.goals.id, goalId), eq(schema.goals.leaseOwner, owner)))
          .returning({ status: schema.goals.status });
        // Lost the lease or the goal was cancelled: stop in-flight work promptly.
        if (!g || g.status === "CANCELLED") abort.abort(new Error("Goal cancelled"));
      } catch (err) {
        log.warn("lease.heartbeat_failed", { goalId, error: describeError(err) });
      }
    })();
  }, HEARTBEAT_MS);

  try {
    // Anything still marked RUNNING belonged to a runner that died; make it resumable.
    const orphaned = await db
      .update(schema.tasks)
      .set({ status: "READY" })
      .where(and(eq(schema.tasks.goalId, goalId), eq(schema.tasks.status, "RUNNING")))
      .returning({ id: schema.tasks.id });
    if (orphaned.length) {
      await db
        .update(schema.agentRuns)
        .set({ status: "INTERRUPTED" })
        .where(and(eq(schema.agentRuns.goalId, goalId), eq(schema.agentRuns.status, "RUNNING")));
      await emit({ workspaceId: leased.workspaceId, goalId, type: "goal.resumed", message: `Resumed ${orphaned.length} interrupted task${orphaned.length === 1 ? "" : "s"}` });
    }

    for (;;) {
      const [goal] = await db.select().from(schema.goals).where(eq(schema.goals.id, goalId));
      if (!goal || !ACTIVE_STATUSES.includes(goal.status) || abort.signal.aborted) return { more: false };
      if (Date.now() - started > sliceMs) return { more: true };

      try {
        if (goal.status === "INTERPRETING") await withTimeout(PHASE_TIMEOUT_MS, "Goal interpretation", (s) => interpretPhase(goal, s), abort.signal);
        else if (goal.status === "PLANNING") await withTimeout(PHASE_TIMEOUT_MS, "Planning", (s) => planPhase(goal, s), abort.signal);
        else {
          const r = await runPhase(goal, abort.signal);
          if (r === "stop") return { more: false };
          if (r !== "continue") {
            await haltGoal(goal, r.error);
            return { more: false };
          }
        }
      } catch (err) {
        if (abort.signal.aborted) return { more: false };
        const message = fatal(err) ?? `${goal.status === "RUNNING" ? "Execution" : goal.status === "PLANNING" ? "Planning" : "Goal interpretation"} failed: ${describeError(err)}`;
        log.error("goal.phase_failed", { goalId, status: goal.status, error: describeError(err) });
        await haltGoal(goal, message);
        return { more: false };
      }
    }
  } finally {
    clearInterval(heartbeat);
    await releaseLease(goalId, owner).catch(() => undefined);
  }
}
