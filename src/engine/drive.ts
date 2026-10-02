import "server-only";
import { createHash } from "node:crypto";
import { and, inArray, isNull, lt, or } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { appUrl, env } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { ACTIVE_STATUSES, runGoal } from "./executor";

/** Shared secret for engine self-invocation. Falls back to a value derived from server-only config. */
export function engineSecret(): string {
  const e = env();
  if (e.ENGINE_SECRET) return e.ENGINE_SECRET;
  const seed = e.DATABASE_URL ?? "local-development";
  return createHash("sha256").update(`aiw-engine:${seed}`).digest("hex");
}

/**
 * Hand the goal to a fresh invocation. On serverless platforms each invocation has a
 * hard time limit, so long goals are executed as a chain of time slices.
 */
async function requestContinuation(goalId: string, origin?: string): Promise<boolean> {
  const base = appUrl() ?? origin;
  if (!base) return false;
  try {
    const res = await fetch(`${base}/api/internal/engine`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-engine-secret": engineSecret() },
      body: JSON.stringify({ goalId }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch (err) {
    log.warn("engine.continuation_failed", { goalId, error: describeError(err) });
    return false;
  }
}

/**
 * Run one slice of a goal and, if work remains, chain the next slice.
 * If chaining is impossible the goal is still safe: its lease expires and the next
 * trigger (an open Command Center, a user action, or the sweep cron) resumes it.
 */
export async function driveGoal(goalId: string, origin?: string): Promise<void> {
  try {
    const { more } = await runGoal(goalId);
    if (more) {
      const chained = await requestContinuation(goalId, origin);
      if (!chained) log.warn("engine.unchained", { goalId });
    }
  } catch (err) {
    log.error("engine.drive_failed", { goalId, error: describeError(err) });
  }
}

/** Goals that should be executing but have no live runner. */
export async function stalledGoalIds(limit = 20): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ id: schema.goals.id })
    .from(schema.goals)
    .where(and(inArray(schema.goals.status, ACTIVE_STATUSES), or(isNull(schema.goals.leaseExpiresAt), lt(schema.goals.leaseExpiresAt, new Date()))))
    .limit(limit);
  return rows.map((r) => r.id);
}
