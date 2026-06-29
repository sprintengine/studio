import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { AgentCli } from '../../shared/electron-api'
import type {
  SprintEngineLedgerEntry,
  SprintEngineModelTokenUsage,
  SprintEngineTokenUsage,
} from '../../renderer/src/types/workspace'
import { readSessionTokenUsage } from './index'
import { emptyModelUsage, type SessionTokenUsage, type TokenUsageDeps } from './types'

// Aggregation layer (Phase 1 backend): turns the durable session ledger (T3)
// into the sprint's headline token total. For each ledger entry it reads every
// recorded CLI session's cumulative usage via the adapters (T1/T2) and sums
// per model, keeping cache reads/writes distinct from input/output. Coverage is
// explicit: an agent counts as measured only if at least one of its sessions
// read successfully; otherwise it is named in `unmeasured` rather than zeroed.
// No per-task attribution (Phase 2) and no dollars (Phase 3). See
// knowledge/multicode/sprint-engine.md.

type LedgerInput = Pick<SprintEngineLedgerEntry, 'agentId' | 'cli' | 'cliSessionIds'>

export type SprintEngineTokenAggregateDeps = TokenUsageDeps & {
  // Injectable for tests; defaults to the real adapter dispatcher.
  readUsage?: (cli: AgentCli, cliSessionId: string, deps?: TokenUsageDeps) => Promise<SessionTokenUsage>
}

export async function computeSprintEngineTokenUsage(
  ledger: ReadonlyArray<LedgerInput>,
  deps: SprintEngineTokenAggregateDeps = {},
): Promise<SprintEngineTokenUsage> {
  const read = deps.readUsage ?? readSessionTokenUsage
  const computedAt = (deps.now ?? defaultNow)()
  const perModel = new Map<string, SprintEngineModelTokenUsage>()
  let measuredAgents = 0
  const unmeasured: Array<{ agentId: string; cli: string }> = []

  for (const entry of ledger) {
    // A resumed agent has multiple cliSessionIds; each session's reading is its
    // own cumulative total, so summing across them is the agent's full usage.
    let agentMeasured = false
    for (const cliSessionId of entry.cliSessionIds) {
      const usage = await read(entry.cli, cliSessionId, deps)
      if (!usage.measured) continue
      agentMeasured = true
      for (const model of usage.perModel) {
        const bucket = perModel.get(model.model) ?? emptyModelUsage(model.model)
        bucket.input += model.input
        bucket.output += model.output
        bucket.cacheRead += model.cacheRead
        bucket.cacheCreation += model.cacheCreation
        perModel.set(model.model, bucket)
      }
    }
    if (agentMeasured) measuredAgents += 1
    else unmeasured.push({ agentId: entry.agentId, cli: entry.cli })
  }

  const models = [...perModel.values()]
  const total = models.reduce(
    (acc, model) => ({
      input: acc.input + model.input,
      output: acc.output + model.output,
      cacheRead: acc.cacheRead + model.cacheRead,
      cacheCreation: acc.cacheCreation + model.cacheCreation,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  )

  return {
    perModel: models,
    total,
    coverage: { measuredAgents, unmeasuredAgents: unmeasured.length, unmeasured },
    computedAt,
  }
}

// Recompute path: reads the durable ledger from the run's projection.json
// (written by the python core, T3) and aggregates it. Reproducible after an app
// restart with no live terminals, since it reads persisted state, not runtime.
export async function computeSprintEngineRunTokenUsage(
  statePath: string,
  deps: SprintEngineTokenAggregateDeps = {},
): Promise<SprintEngineTokenUsage> {
  const ledger = await readLedgerFromProjection(statePath)
  return computeSprintEngineTokenUsage(ledger, deps)
}

async function readLedgerFromProjection(statePath: string): Promise<LedgerInput[]> {
  const projectionPath = path.join(path.dirname(statePath), 'projection.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(projectionPath, 'utf8'))
  } catch {
    return [] // no projection / unreadable -> empty ledger -> zero, fully-covered total
  }
  const rawLedger = (parsed as { ledger?: unknown } | null)?.ledger
  if (!Array.isArray(rawLedger)) return []
  return rawLedger.flatMap((entry): LedgerInput[] => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const agentId = typeof record.agentId === 'string' ? record.agentId : ''
    if (!agentId) return []
    const cli = typeof record.cli === 'string' ? record.cli : ''
    const cliSessionIds = Array.isArray(record.cliSessionIds)
      ? record.cliSessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
    return [{ agentId, cli, cliSessionIds }]
  })
}

function defaultNow(): string {
  return new Date().toISOString()
}
