import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getProvider } from "@/ai";
import { dbKind, getDb } from "@/db";

export const dynamic = "force-dynamic";

/** Liveness + dependency check. Reports status only - never configuration values. */
export async function GET() {
  let database: "ok" | "error" = "ok";
  let kind: string | null = null;
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    kind = await dbKind();
  } catch {
    database = "error";
  }
  const provider = getProvider();
  const ok = database === "ok";
  return NextResponse.json(
    { ok, database, databaseKind: kind, aiProvider: provider ? provider.id : null },
    { status: ok ? 200 : 503 },
  );
}
