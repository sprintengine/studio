import assert from 'node:assert/strict'

import { computeSprintEngineTokenCost, mergeModelPricing, resolveModelPricing } from './index'
import type { SprintEngineModelTokenUsage, SprintEngineTokenUsage } from '../../renderer/src/types/workspace'

const NOW = '2026-06-28T00:00:00.000Z'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function model(name: string, input: number, output: number, cacheRead: number, cacheCreation: number): SprintEngineModelTokenUsage {
  return { model: name, input, output, cacheRead, cacheCreation }
}

function usageOf(perModel: SprintEngineModelTokenUsage[]): SprintEngineTokenUsage {
  return {
    perModel,
    total: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    coverage: { measuredAgents: 0, unmeasuredAgents: 0, unmeasured: [] },
    computedAt: NOW,
  }
}

// claude-opus-4-8 default rates ($/1M): input 5, output 25, cacheRead 0.5, cacheCreation 6.25.
run('known-model cost = usage x rates, with each category at its own rate', () => {
  const cost = computeSprintEngineTokenCost(
    usageOf([model('claude-opus-4-8', 2_000_000, 1_000_000, 4_000_000, 1_000_000)]),
    { now: () => NOW },
  )
  const entry = cost.perModel[0]
  assert.equal(entry.priced, true)
  // 2M*5 input, 1M*25 output, 4M*0.5 cacheRead, 1M*6.25 cacheCreation.
  assert.deepEqual(entry.cost, { input: 10, output: 25, cacheRead: 2, cacheCreation: 6.25, total: 43.25 })
  assert.deepEqual(cost.total, { input: 10, output: 25, cacheRead: 2, cacheCreation: 6.25, total: 43.25 })
  assert.deepEqual(cost.unpricedModels, [])
  assert.equal(cost.currency, 'USD')
  assert.equal(cost.computedAt, NOW)
})

run('cache savings = cacheRead tokens x (input rate - cacheRead rate)', () => {
  const cost = computeSprintEngineTokenCost(
    usageOf([model('claude-opus-4-8', 0, 0, 4_000_000, 0)]),
    { now: () => NOW },
  )
  // 4M cached reads saved (5 - 0.5) = 4.5 $/1M each => $18.
  assert.equal(cost.perModel[0].cacheSavings, 18)
  assert.equal(cost.cacheSavings, 18)
  // The cached reads still cost 4M * 0.5 = $2 at the cache rate.
  assert.equal(cost.total.cacheRead, 2)
})

run('unknown model is flagged no-price, never zeroed or summed', () => {
  const cost = computeSprintEngineTokenCost(
    usageOf([
      model('claude-opus-4-8', 1_000_000, 0, 0, 0),
      model('big-pickle', 9_000_000, 9_000_000, 0, 0),
    ]),
    { now: () => NOW },
  )
  const unknown = cost.perModel.find((m) => m.model === 'big-pickle')
  assert.ok(unknown)
  assert.equal(unknown.priced, false)
  assert.equal(unknown.cost, null)
  assert.deepEqual(cost.unpricedModels, ['big-pickle'])
  // Total reflects only the priced opus usage (1M * 5 input), not a fabricated
  // zero for the unpriced model.
  assert.equal(cost.total.total, 5)
})

run('pricing is overridable: a config override prices a previously-unknown model', () => {
  const pricing = mergeModelPricing({ 'big-pickle': { input: 2, output: 8, cacheRead: 0.2, cacheCreation: 2 } })
  const cost = computeSprintEngineTokenCost(
    usageOf([model('big-pickle', 1_000_000, 1_000_000, 0, 0)]),
    { pricing, now: () => NOW },
  )
  assert.equal(cost.perModel[0].priced, true)
  assert.equal(cost.total.total, 2 + 8)
  assert.deepEqual(cost.unpricedModels, [])
})

run('overriding a default rate recomputes cost without re-collecting usage', () => {
  const usage = usageOf([model('claude-opus-4-8', 1_000_000, 0, 0, 0)])
  const base = computeSprintEngineTokenCost(usage, { now: () => NOW })
  const cheaper = computeSprintEngineTokenCost(usage, {
    pricing: mergeModelPricing({ 'claude-opus-4-8': { input: 1, output: 25, cacheRead: 0.5, cacheCreation: 6.25 } }),
    now: () => NOW,
  })
  assert.equal(base.total.total, 5)
  assert.equal(cheaper.total.total, 1)
})

run('empty usage yields zero cost and no unpriced models', () => {
  const cost = computeSprintEngineTokenCost(usageOf([]), { now: () => NOW })
  assert.deepEqual(cost.total, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 })
  assert.equal(cost.cacheSavings, 0)
  assert.deepEqual(cost.unpricedModels, [])
})

// claude-haiku-4-5 default rates ($/1M): input 1, output 5, cacheRead 0.1, cacheCreation 1.25.
run('dated/suffixed model id resolves to its canonical table pricing', () => {
  // Claude Code emits this dated id; the table keys the undated canonical id.
  assert.deepEqual(
    resolveModelPricing('claude-haiku-4-5-20251001'),
    { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 },
  )
  // Sonnet/opus dated ids price too.
  assert.deepEqual(resolveModelPricing('claude-sonnet-4-6-20250101'), resolveModelPricing('claude-sonnet-4-6'))
  assert.deepEqual(resolveModelPricing('claude-opus-4-8-20260101'), resolveModelPricing('claude-opus-4-8'))
})

run('genuinely unknown model resolves to null, no fabricated price', () => {
  assert.equal(resolveModelPricing('big-pickle'), null)
  // A date suffix on an unknown base is still unknown after stripping.
  assert.equal(resolveModelPricing('big-pickle-20251001'), null)
})

run('normalization keeps distinct models distinct', () => {
  const haiku = resolveModelPricing('claude-haiku-4-5-20251001')
  const opus = resolveModelPricing('claude-opus-4-8-20260101')
  assert.ok(haiku && opus)
  assert.notDeepEqual(haiku, opus)
  // The version segment (-4-5) is not a date suffix, so it is never stripped
  // down to a shorter, wrong bucket.
  assert.equal(resolveModelPricing('claude-haiku-4-5'), resolveModelPricing('claude-haiku-4-5'))
})

run('override layered on a canonical id prices its dated id too', () => {
  const pricing = mergeModelPricing({ 'claude-haiku-4-5': { input: 9, output: 9, cacheRead: 9, cacheCreation: 9 } })
  assert.deepEqual(
    resolveModelPricing('claude-haiku-4-5-20251001', pricing),
    { input: 9, output: 9, cacheRead: 9, cacheCreation: 9 },
  )
  // And an override added for a previously-unknown model still resolves exactly.
  const added = mergeModelPricing({ 'big-pickle': { input: 2, output: 8, cacheRead: 0.2, cacheCreation: 2 } })
  assert.deepEqual(resolveModelPricing('big-pickle', added), { input: 2, output: 8, cacheRead: 0.2, cacheCreation: 2 })
})

console.log('sprintengine token-cost tests passed')
