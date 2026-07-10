import type { AgentCli } from '../../shared/electron-api'
import type { SprintEngineModelTokenUsage } from '../../shared/sprintengine-token-usage'

// Cumulative token usage for one model within a single agent CLI session.
// `split:false` marks a CLI that only exposes a cumulative total (Grok): the
// component fields are unknown-zero, not real, and only `total` is meaningful.
export type ModelTokenUsage = SprintEngineModelTokenUsage

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

// Minimal structural shape of the global `fetch` used by the OpenCode adapter,
// so tests can inject a stub without pulling in DOM lib types. The real
// `globalThis.fetch` is assignable to it.
export type FetchResponseLike = {
  ok: boolean
  status: number
  json(): Promise<unknown>
}
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; redirect?: 'error' | 'follow' | 'manual' },
) => Promise<FetchResponseLike>

// Injectable environment for the adapters. Production callers omit it and get
// the real home directory, process environment, wall clock, and global fetch;
// tests point `homeDir`/`env` at fixtures, pin `now` for deterministic
// timestamps, and stub `fetchImpl` for the OpenCode HTTP reader.
export type TokenUsageDeps = {
  homeDir?: string
  env?: NodeJS.ProcessEnv
  now?: () => string
  fetchImpl?: FetchLike
  // Manifest probe for CLIs not in the built-in adapter map: returns true when
  // the CLI runs the Claude Code harness (manifest binary "claude"), so future
  // Anthropic-compatible runtimes read their ~/.claude transcripts without a
  // hardcoded id list. Production wiring supplies a plugin-registry-backed
  // implementation; tests and bare calls may omit it.
  isClaudeHarnessCli?: (cli: string) => boolean
}

export function emptyModelUsage(model: string): ModelTokenUsage {
  return { model, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, split: true }
}

// Coerce an unknown JSON value to a non-negative finite token count.
export function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

// Derive each split row's total from its components so a row is never handed
// out half-built. Adapters call this on their return value; total-only rows
// (split:false, e.g. Grok) pass through with their explicit total.
export function withDerivedTotals(rows: ModelTokenUsage[]): ModelTokenUsage[] {
  return rows.map((row) =>
    row.split
      ? { ...row, total: row.input + row.output + row.cacheRead + row.cacheCreation }
      : row,
  )
}
