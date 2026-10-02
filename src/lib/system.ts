import "server-only";
import { configuredProviders, getProvider, PROVIDER_ENV } from "@/ai";
import { toolRegistry } from "@/tools/registry";
import { env } from "./env";

/** What is actually configured on this deployment. Reports names and status only - never secret values. */
export function systemStatus() {
  const e = env();
  const provider = getProvider();
  return {
    ai: {
      configured: Boolean(provider),
      provider: provider?.id ?? null,
      models: provider?.models ?? null,
      available: configuredProviders(),
      envVars: Object.values(PROVIDER_ENV),
    },
    tools: toolRegistry.all().map((t) => {
      const a = t.available();
      return {
        name: t.name,
        category: t.category,
        description: t.description,
        riskLevel: t.riskLevel,
        externalEffect: t.externalEffect,
        available: a.ok,
        reason: a.ok ? null : a.reason,
        envVars: a.ok ? [] : a.envVars,
      };
    }),
    limits: {
      goalBudgetUsd: e.GOAL_BUDGET_USD,
      maxTasksPerGoal: e.MAX_TASKS_PER_GOAL,
      maxTaskRetries: e.MAX_TASK_RETRIES,
      maxAgentIterations: e.MAX_AGENT_ITERATIONS,
      maxReplansPerGoal: e.MAX_REPLANS_PER_GOAL,
      maxParallelTasks: e.MAX_PARALLEL_TASKS,
      taskTimeoutSeconds: Math.round(e.TASK_TIMEOUT_MS / 1000),
      goalsPerHour: e.GOALS_PER_HOUR,
    },
    database: e.DATABASE_URL ? "postgres" : "embedded (development only)",
  };
}
