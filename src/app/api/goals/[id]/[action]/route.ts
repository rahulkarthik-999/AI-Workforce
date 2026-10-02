import { after, NextResponse } from "next/server";
import { z } from "zod";
import { driveGoal } from "@/engine/drive";
import { ACTIVE_STATUSES } from "@/engine/executor";
import { answerQuestions, cancelGoal, getGoal, resumeGoal } from "@/engine/service";
import { requireAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { parseBody, requestOrigin, route } from "@/lib/http";

export const maxDuration = 300;

const answersSchema = z.object({
  answers: z.array(z.object({ question: z.string().min(1).max(500), answer: z.string().trim().min(1).max(2000) })).min(1).max(5),
});
const resumeSchema = z.object({ addBudgetUsd: z.number().positive().max(100).optional() });

export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string; action: string }> }) => {
  const { actor } = await requireAuth();
  const { id, action } = await ctx.params;
  const origin = requestOrigin(req);

  switch (action) {
    case "answers": {
      const { answers } = await parseBody(req, answersSchema);
      await answerQuestions(actor, id, answers);
      after(() => driveGoal(id, origin));
      return NextResponse.json({ ok: true });
    }
    case "cancel":
      await cancelGoal(actor, id);
      return NextResponse.json({ ok: true });
    case "resume": {
      const body = await parseBody(req, resumeSchema);
      await resumeGoal(actor, id, body);
      after(() => driveGoal(id, origin));
      return NextResponse.json({ ok: true });
    }
    case "kick": {
      // Idempotent nudge from an open Command Center: restarts execution if no runner is alive.
      const goal = await getGoal(actor, id);
      const stalled = ACTIVE_STATUSES.includes(goal.status) && (!goal.leaseExpiresAt || goal.leaseExpiresAt < new Date());
      if (stalled) after(() => driveGoal(id, origin));
      return NextResponse.json({ ok: true, restarted: stalled });
    }
    default:
      throw new AppError("Not found.", 404, "not_found");
  }
});
