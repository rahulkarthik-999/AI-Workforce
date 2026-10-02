import "server-only";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { User, Workspace } from "@/db/schema";
import { AppError } from "./errors";

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const SESSION_COOKIE = "aiw_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Creates a session and sets the cookie. Only a hash of the token is stored server-side. */
export async function startSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const db = await getDb();
  await db.insert(schema.sessions).values({ id: tokenHash(token), userId, expiresAt });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const db = await getDb();
    await db.delete(schema.sessions).where(eq(schema.sessions.id, tokenHash(token)));
  }
  jar.delete(SESSION_COOKIE);
}

export type AuthContext = {
  user: Pick<User, "id" | "email" | "name">;
  workspace: Pick<Workspace, "id" | "name">;
  actor: { userId: string; workspaceId: string };
};

/** Resolves the signed-in user and their workspace, or null. */
export async function getAuth(): Promise<AuthContext | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = await getDb();
  const [row] = await db
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      workspaceId: schema.workspaces.id,
      workspaceName: schema.workspaces.name,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .innerJoin(schema.workspaceMembers, eq(schema.workspaceMembers.userId, schema.users.id))
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
    .where(and(eq(schema.sessions.id, tokenHash(token)), gt(schema.sessions.expiresAt, new Date())))
    .orderBy(schema.workspaceMembers.createdAt)
    .limit(1);
  if (!row) return null;
  return {
    user: { id: row.userId, email: row.email, name: row.name },
    workspace: { id: row.workspaceId, name: row.workspaceName },
    actor: { userId: row.userId, workspaceId: row.workspaceId },
  };
}

export async function requireAuth(): Promise<AuthContext> {
  const auth = await getAuth();
  if (!auth) throw new AppError("Sign in to continue.", 401, "unauthorized");
  return auth;
}

/** For pages: send signed-out visitors to the login screen instead of raising an error. */
export async function pageAuth(): Promise<AuthContext> {
  const auth = await getAuth();
  if (!auth) redirect("/login");
  return auth;
}

/** Signups can be closed with ALLOW_SIGNUPS=false; the very first account is always allowed. */
export async function signupsOpen(): Promise<boolean> {
  if (process.env.ALLOW_SIGNUPS?.toLowerCase() !== "false") return true;
  const db = await getDb();
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users);
  return n === 0;
}

export async function registerUser(input: { email: string; name: string; password: string }): Promise<User> {
  const db = await getDb();
  const email = input.email.trim().toLowerCase();
  const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (existing) throw new AppError("An account with this email already exists.", 409, "conflict");
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const [user] = await tx.insert(schema.users).values({ email, name: input.name.trim(), passwordHash }).returning();
    const [workspace] = await tx
      .insert(schema.workspaces)
      .values({ name: `${input.name.trim()}'s workspace`, ownerId: user!.id })
      .returning();
    await tx.insert(schema.workspaceMembers).values({ workspaceId: workspace!.id, userId: user!.id, role: "owner" });
    await tx.insert(schema.auditLogs).values({ workspaceId: workspace!.id, userId: user!.id, action: "user.signup", targetType: "user", targetId: user!.id });
    return user!;
  });
}

// Compared against when the email is unknown, so response time does not reveal which emails exist.
let dummyHash: Promise<string> | undefined;

export async function authenticate(email: string, password: string): Promise<User | null> {
  const db = await getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email.trim().toLowerCase()));
  if (!user) {
    dummyHash ??= hashPassword("not-a-real-password");
    await verifyPassword(password, await dummyHash);
    return null;
  }
  return (await verifyPassword(password, user.passwordHash)) ? user : null;
}
