import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { withDerivedTotals, type ModelTokenUsage } from './types'

// Durable per-run token ledger: <teamDir>/metrics/token-usage.jsonl, appended
// beside agent-feedback.jsonl (the established metrics sidecar). Append-only;
// readers fold it. Two record kinds:
//
// - `session`: identity — this agent used this CLI session. Appended by
//   terminal-runtime the moment a sprint session's cliSessionId is captured
//   (and again on SessionStart, covering resume-seeded ids). This is what
//   preserves EVERY session an agent used: a resumed CLI session restarts its
//   cumulative counter at zero, so per-agent usage is the sum across its
//   sessions and no id may be lost to an overwrite.
// - `sample`: a cumulative usage snapshot for one session, written at terminal
//   disposal (owner teardown, run completion, app shutdown) and on SessionEnd
//   hook frames. Last sample wins. Samples make the numbers durable past CLI
//   transcript pruning and independent of live processes; the report layer
//   still uses whichever of live-read/sample carries more.
//
// Every field is optional-tolerant on read: unknown kinds and malformed lines
// are skipped, never fatal — an old or damaged ledger degrades to unmeasured
// coverage, not a broken run summary.

export type SprintTokenLedgerSessionRecord = {
  kind: 'session'
  agentId: string
  role?: string
  cli: string
  cliSessionId: string
  at: string
}

export type SprintTokenLedgerSampleRecord = {
  kind: 'sample'
  agentId: string
  cli: string
  cliSessionId: string
  measured: boolean
  perModel: ModelTokenUsage[]
  sampledAt: string
  reason: 'teardown' | 'session-end'
}

export type SprintTokenLedgerRecord = SprintTokenLedgerSessionRecord | SprintTokenLedgerSampleRecord

// One folded session: identity plus its latest sample (if any).
export type SprintTokenLedgerSession = {
  agentId: string
  role?: string
  cli: string
  cliSessionId: string
  lastSample?: Pick<SprintTokenLedgerSampleRecord, 'measured' | 'perModel' | 'sampledAt'>
}

export function tokenLedgerPath(statePath: string): string {
  return path.join(path.dirname(statePath), 'metrics', 'token-usage.jsonl')
}

// Monotonic per-run write counter, bumped on every append in this process.
// Report caches key their entries on it so a teardown/session-end sample
// invalidates any cached report immediately instead of waiting out a TTL.
const ledgerVersions = new Map<string, number>()

export function tokenLedgerVersion(statePath: string): number {
  return ledgerVersions.get(tokenLedgerPath(statePath)) ?? 0
}

export async function appendTokenLedgerRecord(
  statePath: string,
  record: SprintTokenLedgerRecord,
): Promise<void> {
  const ledgerPath = tokenLedgerPath(statePath)
  await mkdir(path.dirname(ledgerPath), { recursive: true })
  await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8')
  ledgerVersions.set(ledgerPath, (ledgerVersions.get(ledgerPath) ?? 0) + 1)
}

// Fold the append-only ledger into one entry per (agentId, cliSessionId),
// keeping the latest sample. Missing file -> empty (old runs never break).
export async function readTokenLedger(statePath: string): Promise<SprintTokenLedgerSession[]> {
  let raw: string
  try {
    raw = await readFile(tokenLedgerPath(statePath), 'utf8')
  } catch {
    return []
  }

  const sessions = new Map<string, SprintTokenLedgerSession>()
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue // tolerate a truncated trailing line
    }
    const parsed = parseRecord(record)
    if (!parsed) continue

    const key = `${parsed.agentId} ${parsed.cliSessionId}`
    const existing = sessions.get(key)
    const session: SprintTokenLedgerSession = existing ?? {
      agentId: parsed.agentId,
      cli: parsed.cli,
      cliSessionId: parsed.cliSessionId,
    }
    if (parsed.kind === 'session') {
      if (parsed.role) session.role = parsed.role
      if (parsed.cli) session.cli = parsed.cli
    } else {
      session.lastSample = {
        measured: parsed.measured,
        perModel: parsed.perModel,
        sampledAt: parsed.sampledAt,
      }
      if (parsed.cli && !existing) session.cli = parsed.cli
    }
    sessions.set(key, session)
  }
  return [...sessions.values()]
}

function parseRecord(value: unknown): SprintTokenLedgerRecord | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const agentId = typeof record.agentId === 'string' ? record.agentId : ''
  const cliSessionId = typeof record.cliSessionId === 'string' ? record.cliSessionId : ''
  const cli = typeof record.cli === 'string' ? record.cli : ''
  if (!agentId || !cliSessionId) return null

  if (record.kind === 'session') {
    return {
      kind: 'session',
      agentId,
      cli,
      cliSessionId,
      role: typeof record.role === 'string' && record.role ? record.role : undefined,
      at: typeof record.at === 'string' ? record.at : '',
    }
  }
  if (record.kind === 'sample') {
    return {
      kind: 'sample',
      agentId,
      cli,
      cliSessionId,
      measured: record.measured === true,
      // Split rows have their total RE-derived from the components rather than
      // trusted as written: samples appended before cache reads left the total
      // carry the old inflated figure, and re-deriving on read fixes every run
      // already on disk without rewriting an append-only file.
      perModel: Array.isArray(record.perModel)
        ? withDerivedTotals(record.perModel.filter(isModelUsageRow))
        : [],
      sampledAt: typeof record.sampledAt === 'string' ? record.sampledAt : '',
      reason: record.reason === 'session-end' ? 'session-end' : 'teardown',
    }
  }
  return null
}

function isModelUsageRow(value: unknown): value is ModelTokenUsage {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    typeof row.model === 'string'
    && typeof row.input === 'number'
    && typeof row.output === 'number'
    && typeof row.cacheRead === 'number'
    && typeof row.cacheCreation === 'number'
    && typeof row.total === 'number'
    && typeof row.split === 'boolean'
  )
}
