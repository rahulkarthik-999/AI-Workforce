import "server-only";
import { and, count, desc, eq, gte, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { env } from "@/lib/env";
import { evaluate } from "./calculator";
import { safeFetch } from "./ssrf";
import { defineTool, type Tool, type ToolAvailability } from "./types";

const OK: ToolAvailability = { ok: true };
const needs = (reason: string, ...envVars: string[]): ToolAvailability => ({ ok: false, reason, envVars });

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      chunks.push(value.subarray(0, value.byteLength - (size - maxBytes)));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

/** Reserved documentation / placeholder hosts (RFC 2606, RFC 6761). A call to one is always a made-up endpoint. */
export function isPlaceholderHost(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return /(^|.)example.(com|org|net|edu)$/.test(host) || /.(example|test|invalid)$/.test(host) || /^(your|my)[-.]?(domain|api|site|company)/.test(host);
  } catch {
    return false;
  }
}

const webSearch = defineTool({
  name: "web_search",
  description:
    "Search the live web. Returns titles, URLs and content snippets. Use for current facts, competitors, market data. Cite the returned URLs.",
  category: "web",
  inputSchema: z.object({
    query: z.string().min(2).max(300),
    maxResults: z.number().int().min(1).max(8).default(5),
  }),
  riskLevel: "LOW",
  externalEffect: false,
  available: () => (env().TAVILY_API_KEY ? OK : needs("Web search needs a Tavily API key.", "TAVILY_API_KEY")),
  summarize: (i) => `Search the web for "${i.query}"`,
  async execute(input, ctx) {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env().TAVILY_API_KEY}` },
      body: JSON.stringify({ query: input.query, max_results: input.maxResults, search_depth: "basic" }),
      signal: ctx.signal ?? AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Web search failed with HTTP ${res.status}.`);
    const json = (await res.json()) as { results?: { title: string; url: string; content: string }[] };
    return {
      query: input.query,
      results: (json.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content?.slice(0, 1200) })),
    };
  },
});

const httpRequest = defineTool({
  name: "http_request",
  description:
    "Fetch a public URL or call a public HTTP API. GET is read-only. POST/PUT/PATCH/DELETE modify external systems and require human approval. Only use real URLs that the user provided or that a tool returned - never guess or invent an API endpoint. Private/internal addresses are blocked.",
  category: "http",
  inputSchema: z.object({
    url: z
      .string()
      .url()
      .max(2000)
      .refine((u) => !isPlaceholderHost(u), "This is a placeholder/example host, not a real endpoint. Only call URLs the user provided or that a tool returned."),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().max(50_000).optional(),
  }),
  riskLevel: "LOW",
  risk: (i) => (i.method === "GET" ? "LOW" : i.method === "DELETE" ? "HIGH" : "MEDIUM"),
  externalEffect: true,
  available: () => OK,
  summarize: (i) => `${i.method} ${i.url}`,
  async execute(input, ctx) {
    const res = await safeFetch(input.url, {
      method: input.method,
      headers: { "user-agent": "AI-Workforce/1.0", accept: "text/html,application/json,text/plain,*/*", ...input.headers },
      body: input.method === "GET" ? undefined : input.body,
      signal: ctx.signal ?? AbortSignal.timeout(20_000),
    });
    const contentType = res.headers.get("content-type") ?? "";
    const { text, truncated } = await readCapped(res, 400_000);
    const body = contentType.includes("html") ? htmlToText(text) : text;
    if (input.method !== "GET" && !res.ok) {
      throw new Error(`${input.method} ${input.url} failed with HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    return { status: res.status, ok: res.ok, contentType, truncated, body: body.slice(0, 20_000) };
  },
});

const saveDocument = defineTool({
  name: "save_document",
  description:
    "Save an additional named document (markdown) to the project's deliverables. Your final answer is saved automatically - use this only for extra standalone assets.",
  category: "files",
  inputSchema: z.object({
    title: z.string().min(2).max(160),
    content: z.string().min(1).max(200_000),
  }),
  riskLevel: "LOW",
  externalEffect: false,
  available: () => OK,
  summarize: (i) => `Save document "${i.title}"`,
  async execute(input, ctx) {
    const db = await getDb();
    const [doc] = await db
      .insert(schema.documents)
      .values({
        workspaceId: ctx.workspaceId,
        goalId: ctx.goalId,
        taskId: ctx.taskId,
        title: input.title,
        kind: "asset",
        content: input.content,
      })
      .returning({ id: schema.documents.id });
    return { saved: true, documentId: doc!.id, title: input.title };
  },
});

const readDocuments = defineTool({
  name: "read_documents",
  description:
    "List or read documents already produced in this workspace (deliverables from this and earlier goals). Call without documentId to list, with documentId to read one.",
  category: "files",
  inputSchema: z.object({
    documentId: z.string().uuid().optional(),
    search: z.string().max(100).optional(),
  }),
  riskLevel: "LOW",
  externalEffect: false,
  available: () => OK,
  summarize: (i) => (i.documentId ? `Read document ${i.documentId}` : "List workspace documents"),
  async execute(input, ctx) {
    const db = await getDb();
    if (input.documentId) {
      const [doc] = await db
        .select()
        .from(schema.documents)
        .where(and(eq(schema.documents.id, input.documentId), eq(schema.documents.workspaceId, ctx.workspaceId)));
      if (!doc) throw new Error("Document not found in this workspace.");
      if (!doc.mimeType.startsWith("text/")) return { id: doc.id, title: doc.title, mimeType: doc.mimeType, note: "Binary asset; content not shown." };
      return { id: doc.id, title: doc.title, content: doc.content.slice(0, 30_000) };
    }
    const rows = await db
      .select({ id: schema.documents.id, title: schema.documents.title, kind: schema.documents.kind, createdAt: schema.documents.createdAt })
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.workspaceId, ctx.workspaceId),
          input.search ? ilike(schema.documents.title, `%${input.search}%`) : undefined,
        ),
      )
      .orderBy(desc(schema.documents.createdAt))
      .limit(25);
    return { documents: rows };
  },
});

const memorySearch = defineTool({
  name: "memory_search",
  description:
    "Search the workspace's persistent memory: user preferences, project context, past decisions, completed actions and results.",
  category: "database",
  inputSchema: z.object({
    query: z.string().max(200).optional(),
    category: z.enum(schema.memoryCategory.enumValues).optional(),
  }),
  riskLevel: "LOW",
  externalEffect: false,
  available: () => OK,
  summarize: (i) => `Search memory${i.query ? ` for "${i.query}"` : ""}`,
  async execute(input, ctx) {
    const db = await getDb();
    const q = input.query?.trim();
    const rows = await db
      .select({
        category: schema.memories.category,
        title: schema.memories.title,
        content: schema.memories.content,
        updatedAt: schema.memories.updatedAt,
      })
      .from(schema.memories)
      .where(
        and(
          eq(schema.memories.workspaceId, ctx.workspaceId),
          // Private (user-scoped) memories are only visible to their owner.
          or(sql`${schema.memories.userId} is null`, eq(schema.memories.userId, ctx.userId)),
          input.category ? eq(schema.memories.category, input.category) : undefined,
          q ? or(ilike(schema.memories.title, `%${q}%`), ilike(schema.memories.content, `%${q}%`)) : undefined,
        ),
      )
      .orderBy(desc(schema.memories.updatedAt))
      .limit(15);
    return { memories: rows.map((r) => ({ ...r, content: r.content.slice(0, 1500) })) };
  },
});

const memorySave = defineTool({
  name: "memory_save",
  description:
    "Record a durable project fact or decision in workspace memory so future goals can use it. Only save things that will matter later.",
  category: "database",
  inputSchema: z.object({
    category: z.enum(["PROJECT", "DECISION"]),
    title: z.string().min(3).max(140),
    content: z.string().min(3).max(4000),
  }),
  riskLevel: "LOW",
  externalEffect: false,
  available: () => OK,
  summarize: (i) => `Remember ${i.category.toLowerCase()}: "${i.title}"`,
  async execute(input, ctx) {
    const db = await getDb();
    const [row] = await db
      .insert(schema.memories)
      .values({
        workspaceId: ctx.workspaceId,
        category: input.category,
        title: input.title,
        content: input.content,
        source: "agent",
        sourceGoalId: ctx.goalId,
        sourceTaskId: ctx.taskId,
      })
      .returning({ id: schema.memories.id });
    return { saved: true, memoryId: row!.id };
  },
});

const sendEmail = defineTool({
  name: "send_email",
  description:
    "Send a real email to one or more recipients. This is an external communication and always pauses for human approval before sending.",
  category: "email",
  inputSchema: z.object({
    to: z.array(z.string().email()).min(1).max(50),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(50_000).describe("Plain-text email body"),
  }),
  riskLevel: "MEDIUM",
  risk: (i) => (i.to.length > 10 ? "HIGH" : "MEDIUM"),
  externalEffect: true,
  available: () => {
    const e = env();
    const missing = [!e.RESEND_API_KEY && "RESEND_API_KEY", !e.EMAIL_FROM && "EMAIL_FROM"].filter(Boolean) as string[];
    return missing.length ? needs("Email sending needs a Resend API key and a verified sender address.", ...missing) : OK;
  },
  summarize: (i) => `Send email "${i.subject}" to ${i.to.length} recipient${i.to.length === 1 ? "" : "s"} (${i.to.slice(0, 3).join(", ")}${i.to.length > 3 ? ", ..." : ""})`,
  async execute(input, ctx) {
    const e = env();
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${e.RESEND_API_KEY}` },
      body: JSON.stringify({ from: e.EMAIL_FROM, to: input.to, subject: input.subject, text: input.body }),
      signal: ctx.signal ?? AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok || !json.id) throw new Error(`Email provider rejected the message (HTTP ${res.status}): ${json.message ?? "unknown error"}`);
    return { sent: true, providerMessageId: json.id, recipients: input.to.length };
  },
});

const calculator = defineTool({
  name: "calculator",
  description:
    "Evaluate an arithmetic expression exactly. Supports + - * / % ^, parentheses and sqrt, abs, round(x, digits), floor, ceil, min, max, ln, log10, exp, pow. Use it for every business calculation instead of mental math.",
  category: "compute",
  inputSchema: z.object({
    expression: z.string().min(1).max(500),
    label: z.string().max(120).optional().describe("What this number represents"),
  }),
  riskLevel: "LOW",
  externalEffect: false,
  available: () => OK,
  summarize: (i) => `Calculate ${i.expression}`,
  async execute(input) {
    return { expression: input.expression, label: input.label, result: evaluate(input.expression) };
  },
});

const generateImage = defineTool({
  name: "generate_image",
  description:
    "Generate an image from a text prompt and save it to the project's deliverables. Returns the saved document id.",
  category: "image",
  inputSchema: z.object({
    title: z.string().min(2).max(120),
    prompt: z.string().min(10).max(4000),
    size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).default("1024x1024"),
  }),
  riskLevel: "LOW",
  externalEffect: false,
  available: () => (env().OPENAI_API_KEY ? OK : needs("Image generation uses the OpenAI Images API.", "OPENAI_API_KEY")),
  summarize: (i) => `Generate image "${i.title}"`,
  async execute(input, ctx) {
    const e = env();
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${e.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: e.OPENAI_IMAGE_MODEL ?? "gpt-image-1", prompt: input.prompt, size: input.size, quality: "low", n: 1 }),
      signal: ctx.signal ?? AbortSignal.timeout(120_000),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: { b64_json?: string }[]; error?: { message?: string } };
    const b64 = json.data?.[0]?.b64_json;
    if (!res.ok || !b64) throw new Error(`Image generation failed (HTTP ${res.status}): ${json.error?.message ?? "no image returned"}`);
    const db = await getDb();
    const [doc] = await db
      .insert(schema.documents)
      .values({
        workspaceId: ctx.workspaceId,
        goalId: ctx.goalId,
        taskId: ctx.taskId,
        title: input.title,
        kind: "image",
        mimeType: "image/png",
        content: b64,
      })
      .returning({ id: schema.documents.id });
    return { generated: true, documentId: doc!.id, title: input.title };
  },
});

const workspaceAnalytics = defineTool({
  name: "workspace_analytics",
  description:
    "Query real execution metrics recorded by this platform: goals and tasks by status, verification pass rate, retries, AI spend and token usage over a time window. It has no access to external analytics (web traffic, ad platforms, revenue).",
  category: "analytics",
  inputSchema: z.object({ days: z.number().int().min(1).max(365).default(30) }),
  riskLevel: "LOW",
  externalEffect: false,
  available: () => OK,
  summarize: (i) => `Read workspace metrics for the last ${i.days} days`,
  async execute(input, ctx) {
    const db = await getDb();
    const since = new Date(Date.now() - input.days * 86_400_000);
    const goalsByStatus = await db
      .select({ status: schema.goals.status, n: count() })
      .from(schema.goals)
      .where(and(eq(schema.goals.workspaceId, ctx.workspaceId), gte(schema.goals.createdAt, since)))
      .groupBy(schema.goals.status);
    const tasksByStatus = await db
      .select({ status: schema.tasks.status, verification: schema.tasks.verificationStatus, n: count(), retries: sql<number>`coalesce(sum(${schema.tasks.retryCount}),0)::int` })
      .from(schema.tasks)
      .innerJoin(schema.goals, eq(schema.tasks.goalId, schema.goals.id))
      .where(and(eq(schema.goals.workspaceId, ctx.workspaceId), gte(schema.tasks.createdAt, since)))
      .groupBy(schema.tasks.status, schema.tasks.verificationStatus);
    const [usage] = await db
      .select({
        calls: count(),
        costUsd: sql<number>`coalesce(sum(${schema.usageRecords.costUsd}),0)::float`,
        inputTokens: sql<number>`coalesce(sum(${schema.usageRecords.inputTokens}),0)::int`,
        outputTokens: sql<number>`coalesce(sum(${schema.usageRecords.outputTokens}),0)::int`,
      })
      .from(schema.usageRecords)
      .where(and(eq(schema.usageRecords.workspaceId, ctx.workspaceId), gte(schema.usageRecords.createdAt, since)));
    return { windowDays: input.days, goalsByStatus, tasksByStatus, aiUsage: usage };
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous tool inputs are validated by each tool's zod schema
const ALL: Tool<any>[] = [
  webSearch,
  httpRequest,
  saveDocument,
  readDocuments,
  memorySearch,
  memorySave,
  sendEmail,
  calculator,
  generateImage,
  workspaceAnalytics,
];

const byName = new Map(ALL.map((t) => [t.name, t]));

export const toolRegistry = {
  all: () => ALL,
  get: (name: string) => byName.get(name),
  names: () => ALL.map((t) => t.name),
  /** Tools whose credentials are present and can therefore really run. */
  available: () => ALL.filter((t) => t.available().ok),
  /** Test / extension hook. */
  register(tool: Tool<unknown>) {
    if (!byName.has(tool.name)) ALL.push(tool);
    else ALL[ALL.findIndex((t) => t.name === tool.name)] = tool;
    byName.set(tool.name, tool);
  },
  unregister(name: string) {
    const i = ALL.findIndex((t) => t.name === name);
    if (i >= 0) ALL.splice(i, 1);
    byName.delete(name);
  },
};
