import "server-only";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { env } from "@/lib/env";
import { BudgetExceededError, ConfigError, describeError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { estimateCost, parsePricingOverrides } from "./pricing";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import {
  AIError,
  type AIProvider,
  type GenerateRequest,
  type GenerateResult,
  type StructuredRequest,
  type StructuredResult,
  type Usage,
} from "./types";

export const PROVIDER_ENV = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
} as const;
export type ProviderId = keyof typeof PROVIDER_ENV;

const DEFAULT_MODELS: Record<ProviderId, { main: string; fast: string }> = {
  anthropic: { main: "claude-opus-5-5", fast: "claude-opus-5-5" },
  openai: { main: "gpt-4.1", fast: "gpt-4.1-mini" },
  deepseek: { main: "deepseek-chat", fast: "deepseek-chat" },
};

const store = globalThis as unknown as { __aiwProvider?: AIProvider | null; __aiwProviderOverride?: AIProvider | null };

export function configuredProviders(): ProviderId[] {
  const e = env();
  return (Object.keys(PROVIDER_ENV) as ProviderId[]).filter((p) => Boolean(e[PROVIDER_ENV[p]]));
}

function build(): AIProvider | null {
  const e = env();
  const available = configuredProviders();
  const chosen = e.AI_PROVIDER ?? available[0];
  if (!chosen || !available.includes(chosen)) return null;
  const models = {
    main: e.AI_MODEL ?? DEFAULT_MODELS[chosen].main,
    fast: e.AI_FAST_MODEL ?? e.AI_MODEL ?? DEFAULT_MODELS[chosen].fast,
  };
  if (chosen === "anthropic") return new AnthropicProvider(e.ANTHROPIC_API_KEY!, models);
  if (chosen === "openai") {
    return new OpenAICompatibleProvider({
      id: "openai",
      apiKey: e.OPENAI_API_KEY!,
      baseURL: e.OPENAI_BASE_URL,
      models,
      jsonSchema: true,
      tokenParam: "max_completion_tokens",
    });
  }
  return new OpenAICompatibleProvider({
    id: "deepseek",
    apiKey: e.DEEPSEEK_API_KEY!,
    baseURL: "https://api.deepseek.com",
    models,
    jsonSchema: false,
    tokenParam: "max_tokens",
  });
}

/** The active provider, or null when no API key is configured. */
export function getProvider(): AIProvider | null {
  if (store.__aiwProviderOverride !== undefined) return store.__aiwProviderOverride;
  if (store.__aiwProvider === undefined) store.__aiwProvider = build();
  return store.__aiwProvider;
}

export function requireProvider(): AIProvider {
  const p = getProvider();
  if (!p) {
    const e = env();
    throw new ConfigError(
      e.AI_PROVIDER
        ? `AI_PROVIDER is "${e.AI_PROVIDER}" but ${PROVIDER_ENV[e.AI_PROVIDER]} is not set.`
        : "No AI provider is configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY or DEEPSEEK_API_KEY on the server.",
    );
  }
  return p;
}

/** Test hook: inject a provider (or null for "unconfigured"); undefined restores env-based resolution. */
export function setProviderOverride(p: AIProvider | null | undefined) {
  store.__aiwProviderOverride = p;
  store.__aiwProvider = undefined;
}

export type MeterContext = {
  workspaceId: string;
  goalId: string;
  taskId?: string;
  agentRunId?: string;
  purpose: string;
};

export type MeteredAI = {
  provider: AIProvider;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  stream(req: GenerateRequest, onText: (delta: string) => void): Promise<GenerateResult>;
  structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
};

async function assertBudget(goalId: string) {
  const db = await getDb();
  const [g] = await db
    .select({ cost: schema.goals.costUsd, budget: schema.goals.budgetUsd })
    .from(schema.goals)
    .where(eq(schema.goals.id, goalId));
  if (g && g.cost >= g.budget) {
    throw new BudgetExceededError(
      `Goal budget of $${g.budget.toFixed(2)} reached (spent $${g.cost.toFixed(4)}). Raise the budget to continue.`,
    );
  }
}

async function record(
  ctx: MeterContext,
  provider: AIProvider,
  model: string,
  usage: Usage,
  durationMs: number,
  error?: string,
): Promise<number> {
  const { costUsd, priced } = estimateCost(model, usage, parsePricingOverrides(env().AI_PRICING_JSON));
  const db = await getDb();
  await db.insert(schema.usageRecords).values({
    workspaceId: ctx.workspaceId,
    goalId: ctx.goalId,
    taskId: ctx.taskId,
    agentRunId: ctx.agentRunId,
    purpose: ctx.purpose,
    provider: provider.id,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd,
    priced,
    durationMs,
    success: !error,
    error,
  });
  if (costUsd > 0) {
    await db
      .update(schema.goals)
      .set({ costUsd: sql`${schema.goals.costUsd} + ${costUsd}` })
      .where(eq(schema.goals.id, ctx.goalId));
    if (ctx.taskId) {
      await db
        .update(schema.tasks)
        .set({ costUsd: sql`${schema.tasks.costUsd} + ${costUsd}` })
        .where(eq(schema.tasks.id, ctx.taskId));
    }
    if (ctx.agentRunId) {
      await db
        .update(schema.agentRuns)
        .set({
          costUsd: sql`${schema.agentRuns.costUsd} + ${costUsd}`,
          inputTokens: sql`${schema.agentRuns.inputTokens} + ${usage.inputTokens}`,
          outputTokens: sql`${schema.agentRuns.outputTokens} + ${usage.outputTokens}`,
        })
        .where(eq(schema.agentRuns.id, ctx.agentRunId));
    }
  }
  log.info("ai.call", { ...ctx, provider: provider.id, model, ...usage, costUsd, durationMs, ok: !error });
  return costUsd;
}

/**
 * Every model call in the platform goes through here: the goal budget is checked first,
 * and tokens, cost, duration and outcome are persisted afterwards.
 */
export function meteredAI(ctx: MeterContext): MeteredAI {
  const provider = requireProvider();

  async function run<R extends { usage: Usage; model: string }>(tier: "main" | "fast", fn: () => Promise<R>): Promise<R> {
    await assertBudget(ctx.goalId);
    const started = Date.now();
    try {
      const res = await fn();
      await record(ctx, provider, res.model, res.usage, Date.now() - started);
      return res;
    } catch (err) {
      await record(ctx, provider, provider.models[tier], { inputTokens: 0, outputTokens: 0 }, Date.now() - started, describeError(err)).catch(
        () => undefined,
      );
      throw err;
    }
  }

  return {
    provider,
    generate: (req) => run(req.tier ?? "main", () => provider.generate(req)),
    stream: (req, onText) => run(req.tier ?? "main", () => provider.stream(req, onText)),
    async structured(req) {
      try {
        return await run(req.tier ?? "main", () => provider.structuredOutput(req));
      } catch (err) {
        // One repair attempt when the model produced output that failed schema validation.
        if (err instanceof AIError && err.kind === "invalid") {
          return run(req.tier ?? "main", () => provider.structuredOutput(req));
        }
        throw err;
      }
    },
  };
}

export { AIError } from "./types";
export type { AIProvider } from "./types";
