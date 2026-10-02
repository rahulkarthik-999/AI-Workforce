import { after, NextResponse } from "next/server";
import { z } from "zod";
import { driveGoal } from "@/engine/drive";
import { decideApproval } from "@/engine/service";
import { requireAuth } from "@/lib/auth";
import { parseBody, requestOrigin, route } from "@/lib/http";

export const maxDuration = 300;

const schema = z.object({ decision: z.enum(["APPROVED", "REJECTED"]), note: z.string().max(500).optional() });

export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { actor } = await requireAuth();
  const { id } = await ctx.params;
  const { decision, note } = await parseBody(req, schema);
  const { goalId } = await decideApproval(actor, id, decision, note);
  const origin = requestOrigin(req);
  // Execution resumes from persisted state as soon as the decision is recorded.
  after(() => driveGoal(goalId, origin));
  return NextResponse.json({ ok: true, goalId });
});
