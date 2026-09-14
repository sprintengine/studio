import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { pathExists } from '../filesystem-workspace'
import { forEachJsonlRow } from './jsonl'
import { tokenCount, type ModelTokenUsage } from './types'

// Grok Build writes JSON-RPC session updates under
// <GROK_HOME>/sessions/<urlencoded-workspace>/<sessionId>/updates.jsonl, with a
// sibling signals.json rollup. The studio mints Grok's session id and passes it
// via --session-id (sessionIdFromCaller:true in the manifest), so the session
// directory name is the cliSessionId and lookup is a scan of the workspace
// folders for a matching directory.
//
// Grok's update stream exposes a cumulative `totalTokens` counter (streamed
// under several `_meta` paths) with NO stable input/output split, and the
// counter can rewind while tool updates stream — we track the monotonic max.
// Compaction resets the visible counter; signals.json carries the rollup
// (`totalTokensBeforeCompaction` + `contextTokensUsed`, plus `totalTokens`),
// so the effective session total is the larger of the two sources. The row is
// reported total-only (`split:false`, component fields unknown-zero) — never a
// fabricated input/output split. Format pinned by fixtures; verified against
// tokscale's fixture-tested Grok parser (grok.rs) as of 2026-07; any layout
// surprise degrades to unmeasured per the fail-closed contract.
//
// Reads are memoized like the other file adapters: session-dir location memo
// plus a parse memo keyed on updates.jsonl + signals.json mtime+size.

// Grok session ids are minted by the studio (uuid-shaped); restrict the charset
// so a malformed id can never be interpolated into path.join.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

const UNKNOWN_MODEL = 'grok-unknown'

const sessionDirBySession = new Map<string, string>()
const parsedBySessionDir = new Map<string, { statKey: string; rows: ModelTokenUsage[] }>()

function resolveSessionsDir(homeDir: string, env: NodeJS.ProcessEnv): string {
  const override = env.GROK_HOME?.trim()
  const grokHome = override || path.join(homeDir, '.grok')
  return path.join(grokHome, 'sessions')
}

// Scan the urlencoded-workspace folders for the one holding this session id.
// Session ids are globally unique, so the first match owns the session.
async function findSessionDir(sessionsDir: string, sessionId: string): Promise<string | null> {
  const memoKey = `${sessionsDir} ${sessionId}`
  const memoized = sessionDirBySession.get(memoKey)
  if (memoized && (await pathExists(path.join(memoized, 'updates.jsonl')))) return memoized

  let entries
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sessionDir = path.join(sessionsDir, entry.name, sessionId)
    if (await pathExists(path.join(sessionDir, 'updates.jsonl'))) {
      sessionDirBySession.set(memoKey, sessionDir)
      return sessionDir
    }
  }
  return null
}

function getPath(value: unknown, keys: readonly string[]): unknown {
  let current: unknown = value
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

const TOTAL_TOKEN_PATHS: ReadonlyArray<readonly string[]> = [
  ['params', '_meta', 'totalTokens'],
  ['params', 'update', '_meta', 'totalTokens'],
  ['params', 'update', 'totalTokens'],
  ['params', 'totalTokens'],
  ['usage', 'totalTokens'],
  ['totalTokens'],
]

const MODEL_ID_PATHS: ReadonlyArray<readonly string[]> = [
  ['params', 'update', '_meta', 'modelId'],
  ['params', '_meta', 'modelId'],
  ['params', 'modelId'],
  ['model_id'],
  ['modelId'],
  ['model'],
]

function extractTotalTokens(row: unknown): number | null {
  for (const keys of TOTAL_TOKEN_PATHS) {
    const value = getPath(row, keys)
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function extractModelId(row: unknown): string | null {
  for (const keys of MODEL_ID_PATHS) {
    const value = getPath(row, keys)
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

async function readUpdatesTotals(
  updatesFile: string,
): Promise<{ maxTotal: number; model: string | null }> {
  let maxTotal = 0
  let model: string | null = null
  await forEachJsonlRow(updatesFile, (row) => {
    const rowModel = extractModelId(row)
    if (rowModel) model = rowModel
    const total = extractTotalTokens(row)
    // Cumulative but occasionally rewound while tool updates stream: keep the max.
    if (total !== null && total > maxTotal) maxTotal = total
  })
  return { maxTotal, model }
}

type GrokSignals = {
  totalTokens?: unknown
  totalTokensBeforeCompaction?: unknown
  contextTokensUsed?: unknown
  primaryModelId?: unknown
  modelsUsed?: unknown
}

// The rollup's effective total: compaction moves the pre-compaction spend into
// `totalTokensBeforeCompaction`, with `contextTokensUsed` the live context —
// their sum is the true session total once `totalTokens` alone undercounts.
// When contextTokensUsed is absent we cannot tell whether `totalTokens` is the
// post-compaction remainder or already the full cumulative figure, so take the
// max of the candidates rather than their sum — undercounting the live context
// beats double-counting the whole pre-compaction spend.
function effectiveTotalFromSignals(signals: GrokSignals): number {
  const before = tokenCount(signals.totalTokensBeforeCompaction)
  const total = tokenCount(signals.totalTokens)
  return Math.max(total, before + tokenCount(signals.contextTokensUsed))
}

function modelFromSignals(signals: GrokSignals): string | null {
  if (typeof signals.primaryModelId === 'string' && signals.primaryModelId.trim()) {
    return signals.primaryModelId
  }
  if (Array.isArray(signals.modelsUsed)) {
    const first = signals.modelsUsed[0]
    if (typeof first === 'string' && first.trim()) return first
  }
  return null
}

async function readSignals(sessionDir: string): Promise<GrokSignals | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(sessionDir, 'signals.json'), 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as GrokSignals) : null
  } catch {
    return null
  }
}

async function statKeyFor(files: string[]): Promise<string> {
  const parts: string[] = []
  for (const file of files) {
    try {
      const info = await stat(file)
      parts.push(`${file}:${info.mtimeMs}:${info.size}`)
    } catch {
      parts.push(`${file}:absent`)
    }
  }
  return parts.join('|')
}

// Returns null when no session directory exists or no positive total was seen
// (caller reports measured:false); otherwise a single total-only entry.
export async function readGrokUsage(
  cliSessionId: string,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): Promise<ModelTokenUsage[] | null> {
  if (!SESSION_ID_PATTERN.test(cliSessionId)) return null
  const sessionDir = await findSessionDir(resolveSessionsDir(homeDir, env), cliSessionId)
  if (!sessionDir) return null

  const updatesFile = path.join(sessionDir, 'updates.jsonl')
  const signalsFile = path.join(sessionDir, 'signals.json')
  const statKey = await statKeyFor([updatesFile, signalsFile])
  const memoized = parsedBySessionDir.get(sessionDir)
  if (memoized && memoized.statKey === statKey) {
    return memoized.rows.map((row) => ({ ...row }))
  }

  const updates = await readUpdatesTotals(updatesFile)
  const signals = await readSignals(sessionDir)
  const total = Math.max(updates.maxTotal, signals ? effectiveTotalFromSignals(signals) : 0)
  // A located, parseable session with no positive counter yet is a REAL zero
  // reading (no turns run), not an unreadable source — measured, no rows.
  if (total <= 0) {
    const rows: ModelTokenUsage[] = []
    parsedBySessionDir.set(sessionDir, { statKey, rows })
    return rows
  }

  const model = (signals ? modelFromSignals(signals) : null) ?? updates.model ?? UNKNOWN_MODEL
  const rows: ModelTokenUsage[] = [
    {
      model,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      total,
      split: false,
    },
  ]
  parsedBySessionDir.set(sessionDir, { statKey, rows })
  return rows.map((row) => ({ ...row }))
}
