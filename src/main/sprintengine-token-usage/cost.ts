import type {
  SprintEngineModelCost,
  SprintEngineModelPricing,
  SprintEngineTokenCost,
  SprintEngineTokenUsage,
} from '../../renderer/src/types/workspace'
import { DEFAULT_MODEL_PRICING, resolveModelPricing, SPRINT_ENGINE_PRICING_UNIT } from './pricing'

// Pricing layer (Phase 3 backend): turns stored per-model token usage (T4) into
// dollar cost. Pure — cost(usage, rates) — so changing the rates recomputes the
// displayed cost with no usage re-collection. Cache reads/writes are priced with
// their own rates (never folded into input/output), and the cache saving is
// reported distinctly. An unpriced model is named, never zeroed or dropped. No
// per-task cost here (that composes with Phase 2 later); sprint-level only.
// See knowledge/multicode/sprint-engine.md.

export type SprintEngineTokenCostOptions = {
  // Full pricing table to price against; defaults to DEFAULT_MODEL_PRICING.
  // Use mergeModelPricing(overrides) to layer user/enterprise rates on the
  // defaults before passing it here.
  pricing?: Record<string, SprintEngineModelPricing>
  now?: () => string
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 }

function priceModel(
  usage: { model: string; input: number; output: number; cacheRead: number; cacheCreation: number },
  rates: SprintEngineModelPricing,
): SprintEngineModelCost {
  const input = (usage.input / SPRINT_ENGINE_PRICING_UNIT) * rates.input
  const output = (usage.output / SPRINT_ENGINE_PRICING_UNIT) * rates.output
  const cacheRead = (usage.cacheRead / SPRINT_ENGINE_PRICING_UNIT) * rates.cacheRead
  const cacheCreation = (usage.cacheCreation / SPRINT_ENGINE_PRICING_UNIT) * rates.cacheCreation
  // Saving from serving cached reads at the cache rate vs the full input rate.
  const cacheSavings = (usage.cacheRead / SPRINT_ENGINE_PRICING_UNIT) * Math.max(0, rates.input - rates.cacheRead)
  return {
    model: usage.model,
    priced: true,
    cost: { input, output, cacheRead, cacheCreation, total: input + output + cacheRead + cacheCreation },
    cacheSavings,
  }
}

export function computeSprintEngineTokenCost(
  usage: SprintEngineTokenUsage,
  options: SprintEngineTokenCostOptions = {},
): SprintEngineTokenCost {
  const pricing = options.pricing ?? DEFAULT_MODEL_PRICING
  const computedAt = (options.now ?? defaultNow)()

  const perModel: SprintEngineModelCost[] = []
  const total = { ...ZERO_COST }
  let cacheSavings = 0
  const unpricedModels: string[] = []

  for (const model of usage.perModel) {
    const rates = resolveModelPricing(model.model, pricing)
    if (!rates) {
      perModel.push({ model: model.model, priced: false, cost: null, cacheSavings: 0 })
      unpricedModels.push(model.model)
      continue
    }
    const priced = priceModel(model, rates)
    perModel.push(priced)
    if (priced.cost) {
      total.input += priced.cost.input
      total.output += priced.cost.output
      total.cacheRead += priced.cost.cacheRead
      total.cacheCreation += priced.cost.cacheCreation
      total.total += priced.cost.total
    }
    cacheSavings += priced.cacheSavings
  }

  return { currency: 'USD', perModel, total, cacheSavings, unpricedModels, computedAt }
}

function defaultNow(): string {
  return new Date().toISOString()
}
