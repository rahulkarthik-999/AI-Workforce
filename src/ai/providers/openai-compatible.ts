import OpenAI from "openai";
import { z } from "zod";
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

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export type OpenAICompatibleOptions = {
  id: string;
  apiKey: string;
  baseURL?: string;
  models: Record<ModelTier, string>;
  /** OpenAI supports strict JSON-schema responses; DeepSeek only supports JSON-object mode. */
  jsonSchema: boolean;
  /** Newer OpenAI models require max_completion_tokens; other vendors still expect max_tokens. */
  tokenParam: "max_completion_tokens" | "max_tokens";
};

function toChatMessages(system: string, messages: AIMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      const calls = m.content.filter((p) => p.type === "tool_call");
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
      continue;
    }
    // Tool results must directly follow the assistant turn, before any user text.
    for (const p of m.content) {
      if (p.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: p.toolCallId, content: p.isError ? `ERROR: ${p.content}` : p.content });
      }
    }
    const text = m.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly id: string;
  readonly models: Record<ModelTier, string>;
  private client: OpenAI;
  private toolsNeedReasoningOff = new Set<string>();

  constructor(private opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.models = opts.models;
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 2 });
  }

  private mapError(err: unknown): never {
    if (err instanceof AIError) throw err;
    const keyVar = this.id === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY";
    if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
      // A key that is valid for one endpoint is rejected by another; name the override so it is findable.
      const hint = this.opts.baseURL && this.id === "openai" ? ` Requests are going to OPENAI_BASE_URL (${new URL(this.opts.baseURL).host}); the key must be valid for that endpoint, or unset OPENAI_BASE_URL.` : "";
      throw new AIError(`${this.id} rejected the API key. Check ${keyVar}.${hint}`, "config", this.id);
    }
    if (err instanceof OpenAI.NotFoundError) {
      throw new AIError(`${this.id} model not found. Check AI_MODEL. (${err.message})`, "config", this.id);
    }
    if (err instanceof OpenAI.RateLimitError) {
      // Exhausted quota is a 429 too, but retrying will never help.
      const quota = err.code === "insufficient_quota";
      throw new AIError(
        quota ? `${this.id} account has no remaining quota. Check billing.` : `${this.id} rate limit reached.`,
        quota ? "config" : "rate_limit",
        this.id,
      );
    }
    if (err instanceof OpenAI.APIConnectionError) {
      throw new AIError(`Could not reach ${this.id}.`, "transient", this.id);
    }
    if (err instanceof OpenAI.APIError) {
      const status = err.status ?? 0;
      throw new AIError(`${this.id} API error ${status}: ${err.message}`, status >= 500 ? "transient" : "request", this.id);
    }
    throw err;
  }

  private tokenLimit(req: { maxTokens?: number }) {
    return { [this.opts.tokenParam]: req.maxTokens ?? 8_000 };
  }

  generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.stream(req, () => undefined);
  }

  async stream(req: GenerateRequest, onText: (delta: string) => void): Promise<GenerateResult> {
    const model = this.models[req.tier ?? "main"];
    try {
      const hasTools = Boolean(req.tools?.length);
      const open = (noReasoning: boolean) =>
        this.client.chat.completions.create(
          {
            model,
            messages: toChatMessages(req.system, req.messages),
            stream: true,
            stream_options: { include_usage: true },
            ...this.tokenLimit(req),
            ...(hasTools
              ? {
                  tools: req.tools!.map((t) => ({
                    type: "function" as const,
                    function: { name: t.name, description: t.description, parameters: t.inputSchema },
                  })),
                }
              : {}),
            ...(noReasoning ? { reasoning_effort: "none" } : {}),
          } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
          { signal: req.signal },
        );

      // Some reasoning models refuse function tools on this endpoint unless reasoning is
      // switched off, while non-reasoning models reject the parameter outright. So we learn
      // it per model: on that specific refusal, retry once with reasoning off and remember.
      let stream;
      try {
        stream = await open(hasTools && this.toolsNeedReasoningOff.has(model));
      } catch (err) {
        const refused = hasTools && !this.toolsNeedReasoningOff.has(model) && err instanceof OpenAI.BadRequestError && /reasoning_effort/i.test(err.message);
        if (!refused) throw err;
        this.toolsNeedReasoningOff.add(model);
        stream = await open(true);
      }

      let text = "";
      let finish: string | null = null;
      let usage = { inputTokens: 0, outputTokens: 0 };
      let servedModel = model;
      const partial = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
        if (chunk.model) servedModel = chunk.model;
        if (chunk.usage) {
          usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const delta = choice.delta;
        if (delta?.content) {
          text += delta.content;
          onText(delta.content);
        }
        for (const tc of delta?.tool_calls ?? []) {
          const cur = partial.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          partial.set(tc.index, cur);
        }
      }

      if (finish === "content_filter") {
        throw new AIError("The model declined this request for safety reasons.", "refusal", this.id);
      }

      const toolCalls: ToolCallPart[] = [];
      if (finish !== "length") {
        for (const [, p] of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
          let input: unknown;
          try {
            input = p.args ? JSON.parse(p.args) : {};
          } catch {
            // Surface malformed arguments to the tool layer, which rejects them with a clear error.
            input = { __invalid_json: p.args };
          }
          toolCalls.push({ type: "tool_call", id: p.id || `call_${toolCalls.length}`, name: p.name, input });
        }
      }

      const content: AssistantMessage["content"] = [];
      if (text) content.push({ type: "text", text });
      content.push(...toolCalls);
      return {
        text,
        toolCalls,
        message: { role: "assistant", content },
        usage,
        model: servedModel,
        stopReason: finish === "length" ? "max_tokens" : toolCalls.length ? "tool_use" : "end",
      };
    } catch (err) {
      this.mapError(err);
    }
  }

  async structuredOutput<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const model = this.models[req.tier ?? "main"];
    const jsonSchema = z.toJSONSchema(req.schema, { target: "draft-7" });
    const messages = toChatMessages(req.system, req.messages);
    if (!this.opts.jsonSchema) {
      messages.push({
        role: "system",
        content: `Respond with a single JSON object (no prose) that validates against this JSON Schema:\n${JSON.stringify(jsonSchema)}`,
      });
    }
    try {
      const response = await this.client.chat.completions.create(
        {
          model,
          messages,
          ...this.tokenLimit(req),
          response_format: this.opts.jsonSchema
            ? { type: "json_schema", json_schema: { name: req.schemaName, schema: jsonSchema, strict: true } }
            : { type: "json_object" },
        },
        { signal: req.signal },
      );
      const choice = response.choices[0];
      const usage = {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      };
      if (choice?.message.refusal || choice?.finish_reason === "content_filter") {
        throw new AIError("The model declined this request for safety reasons.", "refusal", this.id);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(choice?.message.content ?? "");
      } catch {
        throw new AIError(
          choice?.finish_reason === "length"
            ? `Model output for ${req.schemaName} was cut off before completing.`
            : `Model returned invalid JSON for ${req.schemaName}.`,
          "invalid",
          this.id,
        );
      }
      const parsed = req.schema.safeParse(raw);
      if (!parsed.success) {
        throw new AIError(
          `Model output did not match the ${req.schemaName} schema: ${parsed.error.issues[0]?.message ?? "invalid"}`,
          "invalid",
          this.id,
        );
      }
      return { object: parsed.data, usage, model: response.model };
    } catch (err) {
      this.mapError(err);
    }
  }
}
