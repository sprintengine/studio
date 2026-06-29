import os from 'node:os'

import type { AgentCli } from '../../shared/electron-api'
import { readClaudeCodeUsage } from './claude-code-adapter'
import { readCodexUsage } from './codex-adapter'
import { readOpenCodeUsage } from './opencode-adapter'
import type { FetchLike, ModelTokenUsage, SessionTokenUsage, TokenUsageDeps } from './types'

export type { FetchLike, ModelTokenUsage, SessionTokenUsage, TokenUsageDeps } from './types'
export {
  computeSprintEngineTokenUsage,
  computeSprintEngineRunTokenUsage,
  type SprintEngineTokenAggregateDeps,
} from './aggregate'
export { computeSprintEngineTokenCost, type SprintEngineTokenCostOptions } from './cost'
export {
  DEFAULT_MODEL_PRICING,
  SPRINT_ENGINE_PRICING_UNIT,
  resolveModelPricing,
  mergeModelPricing,
  type SprintEngineModelPricing,
} from './pricing'

// Shared "meter reader" for Sprint Engine token accounting. Reads cumulative
// per-model token usage for one agent CLI session from that CLI's own on-disk
// transcripts. Pure reads — never mutates CLI state. Knows nothing about
// sprints, tasks, or aggregation; that join lives in higher layers (T3/T4).
//
// The contract is total honesty about coverage: a missing, unreadable, or
// unsupported source yields measured:false with an empty perModel and a
// sampledAt timestamp. It never throws and never fabricates a measured zero,
// so callers can show unmeasured agents truthfully instead of as $0/0 tokens.
//
// `cli` is the runtime plugin id ('claude-code', 'codex', 'opencode'); every
// other CLI is reported unmeasured.
export async function readSessionTokenUsage(
  cli: AgentCli,
  cliSessionId: string,
  deps: TokenUsageDeps = {},
): Promise<SessionTokenUsage> {
  const sampledAt = (deps.now ?? defaultNow)()
  const unmeasured: SessionTokenUsage = {
    cli,
    cliSessionId,
    measured: false,
    perModel: [],
    sampledAt,
  }
  if (!cliSessionId) return unmeasured

  const homeDir = deps.homeDir ?? os.homedir()
  const env = deps.env ?? process.env

  try {
    let perModel: ModelTokenUsage[] | null
    switch (cli) {
      case 'claude-code':
        perModel = await readClaudeCodeUsage(cliSessionId, homeDir, env)
        break
      case 'codex':
        perModel = await readCodexUsage(cliSessionId, homeDir, env)
        break
      case 'opencode':
        perModel = await readOpenCodeUsage(cliSessionId, env, deps.fetchImpl ?? defaultFetch)
        break
      default:
        return unmeasured
    }
    if (!perModel) return unmeasured
    return { cli, cliSessionId, measured: true, perModel, sampledAt }
  } catch {
    // Contract: any unexpected read failure degrades to unmeasured, never a throw.
    return unmeasured
  }
}

function defaultNow(): string {
  return new Date().toISOString()
}

const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init)
