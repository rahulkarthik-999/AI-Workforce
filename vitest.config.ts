import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "tests/stubs/server-only.ts"),
    } },
  test: {
    environment: "node",
    env: { NODE_ENV: "test", MAX_TASK_RETRIES: "1", MAX_AGENT_ITERATIONS: "4", MAX_REPLANS_PER_GOAL: "1", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", DEEPSEEK_API_KEY: "", DATABASE_URL: "" },
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
