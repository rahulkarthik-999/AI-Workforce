import { after, NextResponse } from "next/server";
import { lt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { driveGoal, stalledGoalIds } from "@/engine/drive";
import { env } from "@/lib/env";
import { requestOrigin } from "@/lib/http";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Safety net (Vercel Cron): restarts goals whose runner died without a successor, and
 * prunes expired sessions and old rate-limit windows.
 */
export async function GET(req: Request) {
  const secret = env().CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: { code: "forbidden", message: "Forbidden" } }, { status: 403 });
  }
  const db = await getDb();
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
  await db.delete(schema.rateLimits).where(lt(schema.rateLimits.windowStart, new Date(Date.now() - 86_400_000)));

  const ids = await stalledGoalIds();
  const origin = requestOrigin(req);
  after(async () => {
    for (const id of ids) await driveGoal(id, origin);
  });
  return NextResponse.json({ ok: true, restarted: ids.length });
}
