import "server-only";
import { NextResponse } from "next/server";
import { ZodError, type z } from "zod";
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { AIError } from "@/ai/types";
import { AppError } from "./errors";
import { log } from "./logger";

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof AppError) {
    return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status });
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    return NextResponse.json({ error: { code: "invalid_input", message: `${where}${first?.message ?? "Invalid input"}` } }, { status: 400 });
  }
  if (err instanceof AIError && err.kind === "config") {
    return NextResponse.json({ error: { code: "not_configured", message: err.message } }, { status: 503 });
  }
  // Unknown errors: log the detail server-side, return nothing sensitive.
  log.error("http.unhandled", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  return NextResponse.json({ error: { code: "internal", message: "Something went wrong on our side. Please try again." } }, { status: 500 });
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/** Wraps a route handler with uniform error handling and CSRF protection for mutations. */
export function route<C>(handler: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req);
      return await handler(req, ctx);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/**
 * CSRF defence for cookie-authenticated mutations: the Origin header must match the host
 * the request was sent to. Combined with SameSite=Lax cookies and JSON-only bodies.
 */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || !host) throw new AppError("Cross-origin request rejected.", 403, "forbidden");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AppError("Cross-origin request rejected.", 403, "forbidden");
  }
  if (originHost !== host) throw new AppError("Cross-origin request rejected.", 403, "forbidden");
}

export async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError("Request body must be valid JSON.", 400, "invalid_input");
  }
  return schema.parse(raw);
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

export function requestOrigin(req: Request): string {
  return new URL(req.url).origin;
}

/**
 * Fixed-window rate limiter backed by the database, so limits hold across serverless
 * instances. Throws a 429 AppError when the limit is exceeded.
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  const db = await getDb();
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const [row] = await db
    .insert(schema.rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [schema.rateLimits.key, schema.rateLimits.windowStart],
      set: { count: sql`${schema.rateLimits.count} + 1` },
    })
    .returning({ count: schema.rateLimits.count });
  if ((row?.count ?? 0) > limit) {
    throw new AppError("Too many requests. Please wait a moment and try again.", 429, "rate_limited");
  }
}
