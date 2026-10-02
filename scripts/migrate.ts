/**
 * Applies SQL migrations to the configured PostgreSQL database.
 * Used by `pnpm db:migrate` and by the Vercel build (`pnpm vercel-build`).
 */
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const url = process.env.DATABASE_URL?.trim();

if (!url) {
  if (process.env.VERCEL) {
    console.error("DATABASE_URL is not set. Add a PostgreSQL database to this Vercel project before deploying.");
    process.exit(1);
  }
  console.log("DATABASE_URL not set - skipping (local dev uses embedded PGlite, which migrates itself).");
  process.exit(0);
}

const client = postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
try {
  await migrate(drizzle(client), { migrationsFolder: path.join(process.cwd(), "drizzle") });
  console.log("Migrations applied.");
} catch (err) {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await client.end();
}
