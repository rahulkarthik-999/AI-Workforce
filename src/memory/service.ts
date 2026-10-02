import "server-only";
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { MemoryCategory } from "@/db/schema";
import { AppError, assertUuid } from "@/lib/errors";

/** Categories that belong to one person rather than the whole workspace. */
export const PRIVATE_CATEGORIES: MemoryCategory[] = ["USER", "PREFERENCE"];

export const MEMORY_CATEGORY_INFO: Record<MemoryCategory, string> = {
  USER: "Who you are: role, company, background",
  PROJECT: "Facts about the product, market and project",
  PREFERENCE: "How you like work done: tone, formats, constraints",
  DECISION: "Decisions made and why",
  DOCUMENT: "Reference material the workforce should know",
  ACTION: "External actions the workforce has executed",
  RESULT: "Outcomes of completed goals",
};

/** A memory is visible when it is workspace-shared or owned by the requesting user. */
function visibleTo(workspaceId: string, userId: string) {
  return and(
    eq(schema.memories.workspaceId, workspaceId),
    or(isNull(schema.memories.userId), eq(schema.memories.userId, userId)),
  );
}

export async function listMemories(
  workspaceId: string,
  userId: string,
  filter: { category?: MemoryCategory; q?: string } = {},
) {
  const db = await getDb();
  const q = filter.q?.trim();
  return db
    .select()
    .from(schema.memories)
    .where(
      and(
        visibleTo(workspaceId, userId),
        filter.category ? eq(schema.memories.category, filter.category) : undefined,
        q ? or(ilike(schema.memories.title, `%${q}%`), ilike(schema.memories.content, `%${q}%`)) : undefined,
      ),
    )
    .orderBy(desc(schema.memories.updatedAt))
    .limit(200);
}

export async function createMemory(
  workspaceId: string,
  userId: string,
  input: { category: MemoryCategory; title: string; content: string },
) {
  const db = await getDb();
  const [row] = await db
    .insert(schema.memories)
    .values({
      workspaceId,
      userId: PRIVATE_CATEGORIES.includes(input.category) ? userId : null,
      category: input.category,
      title: input.title,
      content: input.content,
      source: "user",
    })
    .returning();
  return row!;
}

async function loadEditable(workspaceId: string, userId: string, id: string) {
  assertUuid(id, "Memory");
  const db = await getDb();
  const [row] = await db
    .select()
    .from(schema.memories)
    .where(and(eq(schema.memories.id, id), visibleTo(workspaceId, userId)));
  // Not visible and not existing are indistinguishable to the caller by design.
  if (!row) throw new AppError("Memory not found.", 404, "not_found");
  return row;
}

export async function updateMemory(
  workspaceId: string,
  userId: string,
  id: string,
  patch: { title?: string; content?: string; category?: MemoryCategory },
) {
  const existing = await loadEditable(workspaceId, userId, id);
  const category = patch.category ?? existing.category;
  const db = await getDb();
  const [row] = await db
    .update(schema.memories)
    .set({
      title: patch.title ?? existing.title,
      content: patch.content ?? existing.content,
      category,
      userId: PRIVATE_CATEGORIES.includes(category) ? userId : null,
    })
    .where(eq(schema.memories.id, id))
    .returning();
  return row!;
}

export async function deleteMemory(workspaceId: string, userId: string, id: string) {
  await loadEditable(workspaceId, userId, id);
  const db = await getDb();
  await db.delete(schema.memories).where(eq(schema.memories.id, id));
}

export async function recordSystemMemory(input: {
  workspaceId: string;
  category: MemoryCategory;
  title: string;
  content: string;
  goalId?: string;
  taskId?: string;
}) {
  const db = await getDb();
  await db.insert(schema.memories).values({
    workspaceId: input.workspaceId,
    category: input.category,
    title: input.title.slice(0, 160),
    content: input.content.slice(0, 6000),
    source: "system",
    sourceGoalId: input.goalId,
    sourceTaskId: input.taskId,
  });
}

const CONTEXT_LIMITS: Record<MemoryCategory, number> = {
  USER: 6,
  PREFERENCE: 10,
  PROJECT: 10,
  DECISION: 8,
  DOCUMENT: 4,
  ACTION: 5,
  RESULT: 5,
};

/**
 * Structured memory + learnings rendered for prompts. Memory is retrieved by category and
 * recency rather than dumped wholesale, so the most durable context always fits.
 */
export async function memoryContext(workspaceId: string, userId: string): Promise<string> {
  const db = await getDb();
  const sections: string[] = [];
  for (const category of Object.keys(CONTEXT_LIMITS) as MemoryCategory[]) {
    const rows = await db
      .select({ title: schema.memories.title, content: schema.memories.content })
      .from(schema.memories)
      .where(and(visibleTo(workspaceId, userId), eq(schema.memories.category, category)))
      .orderBy(desc(schema.memories.updatedAt))
      .limit(CONTEXT_LIMITS[category]);
    if (rows.length) {
      sections.push(`## ${category}\n${rows.map((r) => `- ${r.title}: ${r.content.slice(0, 600)}`).join("\n")}`);
    }
  }
  const learned = await db
    .select()
    .from(schema.learnings)
    .where(eq(schema.learnings.workspaceId, workspaceId))
    .orderBy(desc(schema.learnings.confidence), desc(schema.learnings.createdAt))
    .limit(8);
  if (learned.length) {
    sections.push(
      `## LEARNINGS FROM PAST RESULTS\n${learned
        .map((l) => `- (${l.confidence.toFixed(2)}) ${l.pattern} -> ${l.recommendation}`)
        .join("\n")}`,
    );
  }
  return sections.join("\n\n");
}
