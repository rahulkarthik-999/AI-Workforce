/**
 * USD per 1M tokens. These are list-price estimates used for budgeting; override or
 * extend with AI_PRICING_JSON, e.g. {"my-model":{"input":1,"output":4}}.
 */
export type Price = { input: number; output: number };

const DEFAULT_PRICES: Record<string, Price> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5": { input: 1.25, output: 10 },
  "deepseek-chat": { input: 0.28, output: 0.42 },
  "deepseek-reasoner": { input: 0.28, output: 0.42 },
};

/** Used when a model has no known price, so budgets still bite. Deliberately conservative. */
export const FALLBACK_PRICE: Price = { input: 5, output: 25 };

export function parsePricingOverrides(json: string | undefined): Record<string, Price> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as Record<string, Partial<Price>>;
    const out: Record<string, Price> = {};
    for (const [model, p] of Object.entries(parsed)) {
      if (typeof p?.input === "number" && typeof p?.output === "number") out[model] = { input: p.input, output: p.output };
    }
    return out;
  } catch {
    return {};
  }
}

export function priceFor(model: string, overrides: Record<string, Price> = {}): { price: Price; priced: boolean } {
  const table = { ...DEFAULT_PRICES, ...overrides };
  // Longest matching prefix wins, so "gpt-4.1-mini-2025-04-14" resolves to "gpt-4.1-mini".
  const match = Object.keys(table)
    .filter((k) => model === k || model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return match ? { price: table[match]!, priced: true } : { price: FALLBACK_PRICE, priced: false };
}

export function estimateCost(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
  overrides: Record<string, Price> = {},
): { costUsd: number; priced: boolean } {
  const { price, priced } = priceFor(model, overrides);
  const costUsd = (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
  return { costUsd: Math.round(costUsd * 1e6) / 1e6, priced };
}
