import "server-only";
import { z } from "zod";

const num = (def: number) => z.coerce.number().positive().default(def);
const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: optional,
  APP_URL: optional,
  VERCEL_URL: optional,
  VERCEL_PROJECT_PRODUCTION_URL: optional,
  ENGINE_SECRET: optional,
  CRON_SECRET: optional,

  AI_PROVIDER: z.enum(["anthropic", "openai", "deepseek"]).optional(),
  AI_MODEL: optional,
  AI_FAST_MODEL: optional,
  AI_PRICING_JSON: optional,
  ANTHROPIC_API_KEY: optional,
  OPENAI_API_KEY: optional,
  OPENAI_BASE_URL: optional,
  DEEPSEEK_API_KEY: optional,

  TAVILY_API_KEY: optional,
  RESEND_API_KEY: optional,
  EMAIL_FROM: optional,
  OPENAI_IMAGE_MODEL: optional,

  GOAL_BUDGET_USD: num(2),
  MAX_TASKS_PER_GOAL: num(16),
  MAX_TASK_RETRIES: num(2),
  MAX_AGENT_ITERATIONS: num(12),
  MAX_REPLANS_PER_GOAL: num(2),
  MAX_PARALLEL_TASKS: num(3),
  TASK_TIMEOUT_MS: num(170_000),
  GOALS_PER_HOUR: num(20),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid environment configuration: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Test hook: re-read process.env. */
export function resetEnvCache() {
  cached = undefined;
}

export function appUrl(): string | undefined {
  const e = env();
  if (e.APP_URL) return e.APP_URL.replace(/\/$/, "");
  if (e.VERCEL_URL) return `https://${e.VERCEL_URL}`;
  return undefined;
}
