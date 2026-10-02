import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { requireAuth } from "@/lib/auth";
import { AppError, assertUuid } from "@/lib/errors";
import { extensionFor, safeFileName } from "@/lib/files";
import { route } from "@/lib/http";

export const GET = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { actor } = await requireAuth();
  const { id } = await ctx.params;
  assertUuid(id, "Document");
  const db = await getDb();
  const [doc] = await db
    .select()
    .from(schema.documents)
    .where(and(eq(schema.documents.id, id), eq(schema.documents.workspaceId, actor.workspaceId)));
  if (!doc) throw new AppError("Document not found.", 404, "not_found");

  const isImage = doc.mimeType.startsWith("image/");
  const url = new URL(req.url);
  if (url.searchParams.has("raw")) {
    const body = isImage ? Buffer.from(doc.content, "base64") : doc.content;
    return new Response(body, {
      headers: {
        "content-type": isImage ? doc.mimeType : "text/markdown; charset=utf-8",
        "content-disposition": `${url.searchParams.has("download") ? "attachment" : "inline"}; filename="${safeFileName(doc.title, extensionFor(doc.mimeType))}"`,
        "cache-control": "private, max-age=60",
        // Stored content is model-generated; never let a browser interpret it as active content.
        "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
      },
    });
  }
  return NextResponse.json({
    document: { id: doc.id, title: doc.title, kind: doc.kind, mimeType: doc.mimeType, createdAt: doc.createdAt, content: isImage ? null : doc.content },
  });
});
