import type { z } from "zod";

export type TextPart = { type: "text"; text: string };
export type ToolCallPart = { type: "tool_call"; id: string; name: string; input: unknown };
export type ToolResultPart = { type: "tool_result"; toolCallId: string; content: string; isError?: boolean };

export type UserMessage = { role: "user"; content: (TextPart | ToolResultPart)[] };
export type AssistantMessage = {
  role: "assistant";
  content: (TextPart | ToolCallPart)[];
  /**
   * Provider-native content, replayed verbatim to the same provider so that
   * provider-specific blocks (e.g. Claude thinking blocks) survive tool loops.
   */
  raw?: { provider: string; content: unknown };
};
export type AIMessage = UserMessage | AssistantMessage;

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };

export type ModelTier = "main" | "fast";

export type GenerateRequest = {
  system: string;
  messages: AIMessage[];
  tools?: ToolSpec[];
  tier?: ModelTier;
  maxTokens?: number;
  signal?: AbortSignal;
};

export type Usage = { inputTokens: number; outputTokens: number };

export type GenerateResult = {
  text: string;
  toolCalls: ToolCallPart[];
  message: AssistantMessage;
  usage: Usage;
  model: string;
  stopReason: "end" | "tool_use" | "max_tokens";
};

export type StructuredRequest<T> = Omit<GenerateRequest, "tools"> & {
  schema: z.ZodType<T>;
  schemaName: string;
};

export type StructuredResult<T> = { object: T; usage: Usage; model: string };

export interface AIProvider {
  readonly id: string;
  readonly models: Record<ModelTier, string>;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  /** Like generate, but reports text as it is produced. */
  stream(req: GenerateRequest, onText: (delta: string) => void): Promise<GenerateResult>;
  structuredOutput<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

/**
 * config    - credentials / model / endpoint are wrong; nothing will work until fixed
 * request   - the provider rejected the request itself (HTTP 4xx); repeating it cannot help
 * invalid   - the model's output failed validation; a fresh attempt may succeed
 */
export type AIErrorKind = "config" | "request" | "rate_limit" | "transient" | "invalid" | "refusal";

export class AIError extends Error {
  constructor(
    message: string,
    readonly kind: AIErrorKind,
    readonly provider: string,
  ) {
    super(message);
    this.name = "AIError";
  }
  get retryable() {
    return this.kind === "rate_limit" || this.kind === "transient" || this.kind === "invalid";
  }
}
