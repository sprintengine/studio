import type { AgentCli } from '../../shared/electron-api'

// Cumulative token usage for one model within a single agent CLI session.
export type ModelTokenUsage = {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

// Result of reading one CLI session's on-disk token accounting. `measured`
// distinguishes a real reading (even a legitimately empty one) from an
// unreadable/unsupported source: an unmeasured session reports `measured:false`
// with an empty `perModel`, never a fabricated zero total.
export type SessionTokenUsage = {
  cli: AgentCli
  cliSessionId: string
  measured: boolean
  perModel: ModelTokenUsage[]
  sampledAt: string
}

// Injectable environment for the adapters. Production callers omit it and get
// the real home directory, process environment, and wall clock; tests point
// `homeDir`/`env` at fixtures and pin `now` for deterministic timestamps.
export type TokenUsageDeps = {
  homeDir?: string
  env?: NodeJS.ProcessEnv
  now?: () => string
}

export function emptyModelUsage(model: string): ModelTokenUsage {
  return { model, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
}

// Coerce an unknown JSON value to a non-negative finite token count.
export function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
