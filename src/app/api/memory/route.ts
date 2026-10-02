import { NextResponse } from "next/server";
import { z } from "zod";
import { schema as dbSchema } from "@/db";
import { audit } from "@/engine/service";
import { requireAuth } from "@/lib/auth";
import { parseBody, route } from "@/lib/http";
import { createMemory, listMemories } from "@/memory/service";

const category = z.enum(dbSchema.memoryCategory.enumValues);
const createSchema = z.object({
  category,
  title: z.string().trim().min(2).max(140),
  content: z.string().trim().min(2).max(6000),
});

export const GET = route(async (req: Request) => {
  const { actor } = await requireAuth();
  const url = new URL(req.url);
  const cat = category.safeParse(url.searchParams.get("category"));
  const memories = await listMemories(actor.workspaceId, actor.userId, {
    category: cat.success ? cat.data : undefined,
    q: url.searchParams.get("q")?.slice(0, 100) ?? undefined,
  });
  return NextResponse.json({ memories });
});

export const POST = route(async (req: Request) => {
  const { actor } = await requireAuth();
  const input = await parseBody(req, createSchema);
  const memory = await createMemory(actor.workspaceId, actor.userId, input);
  await audit(actor, "memory.create", "memory", memory.id, { category: memory.category });
  return NextResponse.json({ memory }, { status: 201 });
});
