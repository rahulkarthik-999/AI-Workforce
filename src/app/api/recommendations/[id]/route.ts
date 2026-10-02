import { after, NextResponse } from "next/server";
import { z } from "zod";
import { driveGoal } from "@/engine/drive";
import { decideRecommendation } from "@/engine/service";
import { requireAuth } from "@/lib/auth";
import { parseBody, requestOrigin, route } from "@/lib/http";

export const maxDuration = 300;

const schema = z.object({ decision: z.enum(["APPROVED", "DISMISSED"]) });

export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { actor } = await requireAuth();
  const { id } = await ctx.params;
  const { decision } = await parseBody(req, schema);
  const { goalId, resumed } = await decideRecommendation(actor, id, decision);
  const origin = requestOrigin(req);
  if (resumed) after(() => driveGoal(goalId, origin));
  return NextResponse.json({ ok: true, goalId, resumed });
});
