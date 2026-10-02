import { after, NextResponse } from "next/server";
import { z } from "zod";
import { driveGoal } from "@/engine/drive";
import { createGoal, listGoals } from "@/engine/service";
import { requireAuth } from "@/lib/auth";
import { env } from "@/lib/env";
import { parseBody, rateLimit, requestOrigin, route } from "@/lib/http";

export const maxDuration = 300;

const createSchema = z.object({
  prompt: z.string().trim().min(8, "Describe your goal in a little more detail").max(4000),
  budgetUsd: z.number().positive().max(100).optional(),
});

export const GET = route(async () => {
  const { actor } = await requireAuth();
  return NextResponse.json({ goals: await listGoals(actor) });
});

export const POST = route(async (req: Request) => {
  const { actor } = await requireAuth();
  await rateLimit(`goals:${actor.workspaceId}`, env().GOALS_PER_HOUR, 3600);
  const input = await parseBody(req, createSchema);
  const goal = await createGoal(actor, input);
  const origin = requestOrigin(req);
  // Execution continues after the response is sent; the UI follows it over the event stream.
  after(() => driveGoal(goal.id, origin));
  return NextResponse.json({ goal: { id: goal.id } }, { status: 201 });
});
