import { NextResponse } from "next/server";
import { z } from "zod";
import { schema as dbSchema } from "@/db";
import { audit } from "@/engine/service";
import { requireAuth } from "@/lib/auth";
import { parseBody, route } from "@/lib/http";
import { deleteMemory, updateMemory } from "@/memory/service";

const patchSchema = z.object({
  category: z.enum(dbSchema.memoryCategory.enumValues).optional(),
  title: z.string().trim().min(2).max(140).optional(),
  content: z.string().trim().min(2).max(6000).optional(),
});

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const { actor } = await requireAuth();
  const { id } = await ctx.params;
  const patch = await parseBody(req, patchSchema);
  const memory = await updateMemory(actor.workspaceId, actor.userId, id, patch);
  await audit(actor, "memory.update", "memory", id);
  return NextResponse.json({ memory });
});

export const DELETE = route(async (_req: Request, ctx: Ctx) => {
  const { actor } = await requireAuth();
  const { id } = await ctx.params;
  await deleteMemory(actor.workspaceId, actor.userId, id);
  await audit(actor, "memory.delete", "memory", id);
  return NextResponse.json({ ok: true });
});
