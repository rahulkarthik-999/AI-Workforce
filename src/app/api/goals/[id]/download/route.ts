import { asc, eq } from "drizzle-orm";
import { strToU8, zipSync, type Zippable } from "fflate";
import { getDb, schema } from "@/db";
import { getGoal } from "@/engine/service";
import { requireAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { extensionFor, safeFileName, uniqueNames } from "@/lib/files";
import { route } from "@/lib/http";

export const maxDuration = 60;

/** Every deliverable of a goal as one .zip (markdown documents and generated images). */
export const GET = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { actor } = await requireAuth();
  const { id } = await ctx.params;
  const goal = await getGoal(actor, id); // enforces workspace isolation
  const db = await getDb();
  const docs = await db
    .select({ title: schema.documents.title, mimeType: schema.documents.mimeType, content: schema.documents.content, createdAt: schema.documents.createdAt })
    .from(schema.documents)
    .where(eq(schema.documents.goalId, goal.id))
    .orderBy(asc(schema.documents.createdAt));
  if (docs.length === 0) throw new AppError("This goal has no deliverables yet.", 404, "not_found");

  const names = uniqueNames(docs.map((d, i) => `${String(i + 1).padStart(2, "0")}-${safeFileName(d.title, extensionFor(d.mimeType))}`));
  const files: Zippable = {};
  docs.forEach((d, i) => {
    const bytes = d.mimeType.startsWith("image/") ? new Uint8Array(Buffer.from(d.content, "base64")) : strToU8(d.content);
    files[names[i]!] = [bytes, { mtime: d.createdAt }];
  });
  const zip = zipSync(files, { level: 6 });

  const archiveName = safeFileName(goal.objective ?? goal.prompt, "zip", "deliverables");
  return new Response(Buffer.from(zip), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${archiveName}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
