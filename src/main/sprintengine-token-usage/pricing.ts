import type { SprintEngineModelPricing } from '../../renderer/src/types/workspace'

export type { SprintEngineModelPricing } from '../../renderer/src/types/workspace'

// Rates are quoted per this many tokens (providers publish $/1M-tokens).
export const SPRINT_ENGINE_PRICING_UNIT = 1_000_000

// Default per-model rates in USD per 1M tokens. This is the overridable pricing
// table (not magic numbers buried in the cost math): callers merge their own
// rates over it with `mergeModelPricing`, and any model missing here is reported
// as unpriced rather than mis-priced. Rates change and self-hosted/enterprise
// deployments differ, so treat this as a default to keep current, not a constant
// to trust forever.
//
// Sources / as-of 2026-06: Anthropic models from the bundled claude-api skill
// pricing table; OpenAI/Codex models from developers.openai.com pricing. Cache
// columns: Anthropic cache reads ~0.1x input and 5-minute cache writes ~1.25x
// input (per Anthropic prompt-caching docs); OpenAI bills cached input at the
// published cached rate and has no separate cache-write token charge, so
// cacheCreation mirrors input there (Codex never reports cache-creation tokens).
export const DEFAULT_MODEL_PRICING: Record<string, SprintEngineModelPricing> = {
  // Anthropic (Claude Code)
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1.0, cacheCreation: 12.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 },
  // OpenAI (Codex)
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, cacheCreation: 5 },
  'gpt-5.1': { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 1.25 },
}

// Look up a model's rate, tolerating case/whitespace. Returns null when the
// model is not in the table so the caller can flag it unpriced.
export function resolveModelPricing(
  model: string,
  table: Record<string, SprintEngineModelPricing> = DEFAULT_MODEL_PRICING,
): SprintEngineModelPricing | null {
  const key = model.trim()
  if (table[key]) return table[key]
  const lowered = key.toLowerCase()
  for (const [name, pricing] of Object.entries(table)) {
    if (name.toLowerCase() === lowered) return pricing
  }
  return null
}

// Build a pricing table from the defaults with per-model overrides layered on
// top (override a rate, or add a model the defaults don't know). This is the
// override mechanism: a config change here recomputes cost from stored usage.
export function mergeModelPricing(
  overrides: Record<string, SprintEngineModelPricing> | undefined,
  base: Record<string, SprintEngineModelPricing> = DEFAULT_MODEL_PRICING,
): Record<string, SprintEngineModelPricing> {
  if (!overrides) return base
  return { ...base, ...overrides }
}
