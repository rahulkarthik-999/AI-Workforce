import { timingSafeEqual } from "node:crypto";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { driveGoal, engineSecret } from "@/engine/drive";
import { requestOrigin } from "@/lib/http";

export const maxDuration = 300;

const schema = z.object({ goalId: z.string().uuid() });

function authorized(req: Request): boolean {
  const given = Buffer.from(req.headers.get("x-engine-secret") ?? "");
  const expected = Buffer.from(engineSecret());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Engine self-invocation: continues a goal in a fresh time slice. Not callable without the engine secret. */
export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: { code: "forbidden", message: "Forbidden" } }, { status: 403 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "invalid_input", message: "Invalid body" } }, { status: 400 });
  const origin = requestOrigin(req);
  after(() => driveGoal(parsed.data.goalId, origin));
  return NextResponse.json({ ok: true }, { status: 202 });
}
