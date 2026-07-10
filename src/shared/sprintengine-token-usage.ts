// Wire types for Sprint Engine token accounting (v2, single-owner engine).
//
// Shared between the main-process reader/aggregator
// (src/main/sprintengine-token-usage/) and the renderer surfaces (run summary
// panel, task inspector). Token counts only — dollar conversion was rejected
// (prices churn too fast to store truthfully).
//
// Coverage is the load-bearing contract: an agent whose CLI usage cannot be
// read is reported as unmeasured, never as a fabricated zero, and every total
// states how many agents it actually covers.

// Cumulative token usage for one model within one or more CLI sessions.
// `split:false` marks a CLI that only exposes a cumulative total (Grok): the
// component fields are unknown-zero, not real, and only `total` is meaningful.
export type SprintEngineModelTokenUsage = {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  total: number
  split: boolean
}

// Reduced totals across models. `split:false` when any contributing row was
// total-only, meaning the component fields undercount (they exclude the
// total-only rows) and only `total` is safe to headline.
export type SprintEngineTokenTotals = {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  total: number
  split: boolean
}

export type SprintEngineTokenCoverage = {
  measuredAgents: number
  unmeasuredAgents: number
  unmeasured: Array<{ agentId: string; cli: string }>
}

// One roster agent's summed usage across every CLI session it used during the
// run (a resume mints a new session whose counter restarts at zero, so
// sessions sum). Under the single-owner model an agent owns at most one task
// for life, so `taskIds` is normally 0 or 1 entries.
export type SprintEngineAgentTokenUsage = {
  agentId: string
  role?: string
  cli: string
  taskIds: string[]
  measured: boolean
  perModel: SprintEngineModelTokenUsage[]
  total: SprintEngineTokenTotals
}

// Per-task attribution: the task owner's session total. Truthful only because
// one agent owns each task start → finish; `measured:false` (with `agentId`
// null or an unmeasured CLI) is rendered as "not measured", never zero.
// `ownerOwnsMultipleTasks` marks the rare record where the owning agent id
// owns more than one task — its sessions cannot be split without boundary
// deltas, so the task is left unmeasured rather than double-counted.
export type SprintEngineTaskTokenUsage = {
  taskId: string
  agentId: string | null
  measured: boolean
  perModel: SprintEngineModelTokenUsage[]
  total: SprintEngineTokenTotals
  ownerOwnsMultipleTasks?: boolean
}

export type SprintEngineRunTokenUsage = {
  perModel: SprintEngineModelTokenUsage[]
  total: SprintEngineTokenTotals
  coverage: SprintEngineTokenCoverage
}

export type SprintEngineTokenUsageReport = {
  run: SprintEngineRunTokenUsage
  perAgent: SprintEngineAgentTokenUsage[]
  perTask: Record<string, SprintEngineTaskTokenUsage>
  computedAt: string
}

export function emptySprintEngineTokenTotals(): SprintEngineTokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, split: true }
}

export function addModelUsageIntoTotals(
  totals: SprintEngineTokenTotals,
  usage: SprintEngineModelTokenUsage,
): void {
  totals.input += usage.input
  totals.output += usage.output
  totals.cacheRead += usage.cacheRead
  totals.cacheCreation += usage.cacheCreation
  totals.total += usage.total
  totals.split = totals.split && usage.split
}

// Merge per-model rows from several sessions into one map keyed by model id.
export function mergeModelUsageInto(
  target: Map<string, SprintEngineModelTokenUsage>,
  rows: ReadonlyArray<SprintEngineModelTokenUsage>,
): void {
  for (const row of rows) {
    const bucket = target.get(row.model)
    if (!bucket) {
      target.set(row.model, { ...row })
      continue
    }
    bucket.input += row.input
    bucket.output += row.output
    bucket.cacheRead += row.cacheRead
    bucket.cacheCreation += row.cacheCreation
    bucket.total += row.total
    bucket.split = bucket.split && row.split
  }
}

export function reduceModelUsageTotals(
  rows: ReadonlyArray<SprintEngineModelTokenUsage>,
): SprintEngineTokenTotals {
  const totals = emptySprintEngineTokenTotals()
  for (const row of rows) addModelUsageIntoTotals(totals, row)
  return totals
}
