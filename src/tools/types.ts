import type { z } from "zod";
import type { RiskLevel } from "@/db/schema";

export type ToolContext = {
  workspaceId: string;
  goalId: string;
  taskId: string;
  userId: string;
  signal?: AbortSignal;
};

export type ToolAvailability = { ok: true } | { ok: false; reason: string; envVars: string[] };

export type ToolCategory =
  | "web"
  | "http"
  | "files"
  | "database"
  | "email"
  | "content"
  | "image"
  | "analytics"
  | "compute";

export interface Tool<I = unknown> {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: z.ZodType<I>;
  /** Baseline risk. LOW runs automatically; MEDIUM and HIGH pause for human approval. */
  riskLevel: RiskLevel;
  /** Optional input-dependent risk (e.g. GET vs DELETE). Never lower than is safe for the input. */
  risk?(input: I): RiskLevel;
  /** True when the tool changes something outside this platform. */
  externalEffect: boolean;
  /** Whether credentials / environment needed by this tool are present. */
  available(): ToolAvailability;
  /** One-line human description of exactly what this call will do (shown on approval cards). */
  summarize(input: I): string;
  /** Performs the action for real. Must throw on failure - never return a pretend success. */
  execute(input: I, ctx: ToolContext): Promise<unknown>;
}

export function defineTool<I>(tool: Tool<I>): Tool<I> {
  return tool;
}
