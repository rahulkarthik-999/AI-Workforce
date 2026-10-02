import { NextResponse } from "next/server";
import { goalSnapshot } from "@/engine/service";
import { requireAuth } from "@/lib/auth";
import { route } from "@/lib/http";

export const GET = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { actor } = await requireAuth();
  const { id } = await ctx.params;
  return NextResponse.json(await goalSnapshot(actor, id));
});
