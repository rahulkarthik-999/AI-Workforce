import "server-only";
import path from "node:path";
import fs from "node:fs";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type Handle = { db: Db; close: () => Promise<void>; kind: "postgres" | "pglite" };

const globalStore = globalThis as unknown as { __aiwDb?: Promise<Handle> };

const MIGRATIONS = path.join(process.cwd(), "drizzle");

async function connect(): Promise<Handle> {
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    // prepare:false keeps us compatible with transaction-mode poolers (Neon, Supabase, PgBouncer).
    const client = postgres(url, { prepare: false, max: 5, idle_timeout: 20, connect_timeout: 15 });
    return { db: drizzle(client, { schema }) as unknown as Db, close: () => client.end(), kind: "postgres" };
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_URL is not configured. Set it to a PostgreSQL connection string (e.g. Neon via the Vercel Marketplace).",
    );
  }

  // Local development / tests: embedded Postgres (PGlite). Same SQL dialect, zero setup.
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const inMemory = process.env.NODE_ENV === "test" || process.env.PGLITE_MEMORY === "1";
  let dataDir: string | undefined;
  if (!inMemory) {
    dataDir = path.join(process.cwd(), ".data", "pglite");
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { db: db as unknown as Db, close: () => client.close(), kind: "pglite" };
}

export async function getDb(): Promise<Db> {
  globalStore.__aiwDb ??= connect().catch((err) => {
    globalStore.__aiwDb = undefined;
    throw err;
  });
  return (await globalStore.__aiwDb).db;
}

export async function dbKind(): Promise<"postgres" | "pglite"> {
  await getDb();
  return (await globalStore.__aiwDb!).kind;
}

/** Test hook: drop the current connection so the next getDb() starts fresh. */
export async function resetDb() {
  const h = globalStore.__aiwDb;
  globalStore.__aiwDb = undefined;
  if (h) await (await h).close().catch(() => undefined);
}

export { schema };
