import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  AIError,
  type AIMessage,
  type AIProvider,
  type AssistantMessage,
  type GenerateRequest,
  type GenerateResult,
  type ModelTier,
  type StructuredRequest,
  type StructuredResult,
  type ToolCallPart,
} from "../types";

const PROVIDER = "anthropic";

function toAnthropicMessages(messages: AIMessage[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (m.role === "assistant") {
      // Replay native content (keeps thinking blocks intact across tool loops).
      if (m.raw?.provider === PROVIDER) {
        return { role: "assistant", content: m.raw.content as Anthropic.ContentBlockParam[] };
      }
      return {
        role: "assistant",
        content: m.content.map((p): Anthropic.ContentBlockParam =>
          p.type === "text" ? { type: "text", text: p.text } : { type: "tool_use", id: p.id, name: p.name, input: p.input },
        ),
      };
    }
    return {
      role: "user",
      content: m.content.map((p): Anthropic.ContentBlockParam =>
        p.type === "text"
          ? { type: "text", text: p.text }
          : { type: "tool_result", tool_use_id: p.toolCallId, content: p.content, is_error: p.isError ?? false },
      ),
    };
  });
}

function mapError(err: unknown): never {
  if (err instanceof AIError) throw err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    throw new AIError("Anthropic rejected the API key. Check ANTHROPIC_API_KEY.", "config", PROVIDER);
  }
  if (err instanceof Anthropic.NotFoundError) {
    throw new AIError(`Anthropic model not found. Check AI_MODEL. (${err.message})`, "config", PROVIDER);
  }
  if (err instanceof Anthropic.RateLimitError) {
    throw new AIError("Anthropic rate limit reached.", "rate_limit", PROVIDER);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    throw new AIError("Could not reach Anthropic.", "transient", PROVIDER);
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    throw new AIError(`Anthropic API error ${status}: ${err.message}`, status >= 500 ? "transient" : "request", PROVIDER);
  }
  throw err;
}

export class AnthropicProvider implements AIProvider {
  readonly id = PROVIDER;
  private client: Anthropic;

  constructor(
    apiKey: string,
    readonly models: Record<ModelTier, string>,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2 });
  }

  generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.stream(req, () => undefined);
  }

  async stream(req: GenerateRequest, onText: (delta: string) => void): Promise<GenerateResult> {
    const model = this.models[req.tier ?? "main"];
    try {
      const stream = this.client.messages.stream(
        {
          model,
          max_tokens: req.maxTokens ?? 16_000,
          system: req.system,
          messages: toAnthropicMessages(req.messages),
          ...(req.tools?.length
            ? {
                tools: req.tools.map(
                  (t): Anthropic.Tool => ({
                    name: t.name,
                    description: t.description,
                    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
                  }),
                ),
              }
            : {}),
        },
        { signal: req.signal },
      );
      stream.on("text", onText);
      const message = await stream.finalMessage();

      if (message.stop_reason === "refusal") {
        throw new AIError("The model declined this request for safety reasons.", "refusal", PROVIDER);
      }

      const toolCalls: ToolCallPart[] = [];
      const content: AssistantMessage["content"] = [];
      let text = "";
      for (const block of message.content) {
        if (block.type === "text") {
          text += block.text;
          content.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          const call: ToolCallPart = { type: "tool_call", id: block.id, name: block.name, input: block.input };
          toolCalls.push(call);
          content.push(call);
        }
      }
      const u = message.usage;
      return {
        text,
        toolCalls,
        message: { role: "assistant", content, raw: { provider: PROVIDER, content: message.content } },
        usage: {
          inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens,
        },
        model: message.model,
        stopReason: message.stop_reason === "tool_use" ? "tool_use" : message.stop_reason === "max_tokens" ? "max_tokens" : "end",
      };
    } catch (err) {
      mapError(err);
    }
  }

  async structuredOutput<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const model = this.models[req.tier ?? "main"];
    try {
      const response = await this.client.messages.parse(
        {
          model,
          max_tokens: req.maxTokens ?? 16_000,
          system: req.system,
          messages: toAnthropicMessages(req.messages),
          output_config: { format: zodOutputFormat(req.schema) },
        },
        { signal: req.signal },
      );
      if (response.stop_reason === "refusal") {
        throw new AIError("The model declined this request for safety reasons.", "refusal", PROVIDER);
      }
      if (response.parsed_output == null) {
        throw new AIError(`Model returned output that did not match the ${req.schemaName} schema.`, "invalid", PROVIDER);
      }
      const u = response.usage;
      return {
        object: response.parsed_output as T,
        usage: {
          inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens,
        },
        model: response.model,
      };
    } catch (err) {
      mapError(err);
    }
  }
}
