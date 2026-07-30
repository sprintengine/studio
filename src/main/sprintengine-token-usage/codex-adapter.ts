import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { pathExists } from '../filesystem-workspace'
import { forEachJsonlRow } from './jsonl'
import { tokenCount, withDerivedTotals, type ModelTokenUsage } from './types'

// Codex writes one rollout JSONL per session under
// <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl. Each
// `token_count` event carries an already-cumulative `total_token_usage`, so we
// take the LAST such event rather than summing across events. Codex reports a
// single session-wide total (no per-model split), and its `input_tokens`
// already includes `cached_input_tokens` — unlike Claude Code, where input and
// cache reads are disjoint. The adapter normalizes at this boundary
// (`input − cached → input`) so `input` means non-cached input for every CLI
// and cross-CLI sums never double-count Codex cache reads. See
// knowledge/multicode/sprint-engine.md (Token Accounting).
//
// Reads are memoized: the rollout path never changes once found (location
// memo), and the parsed usage is keyed on the file's mtime+size (content
// memo) so finished sessions are parsed once, not per report.

type CodexTotal = {
  input_tokens?: unknown
  output_tokens?: unknown
  cached_input_tokens?: unknown
  total_tokens?: unknown
}

type CodexRow = {
  type?: unknown
  payload?: {
    type?: unknown
    model?: unknown
    info?: { total_token_usage?: CodexTotal } | null
    total_token_usage?: CodexTotal
  } | null
}

// sessionsDir-scoped so CODEX_HOME overrides (and tests) never cross-hit.
const rolloutPathBySession = new Map<string, string>()
const parsedByRollout = new Map<string, { statKey: string; rows: ModelTokenUsage[] }>()

function resolveSessionsDir(homeDir: string, env: NodeJS.ProcessEnv): string {
  const override = env.CODEX_HOME?.trim()
  const codexHome = override || path.join(homeDir, '.codex')
  return path.join(codexHome, 'sessions')
}

// Depth-first search for the rollout whose filename ends with the session id.
// The session id is embedded in the filename, but the YYYY/MM/DD path is not
// derivable from the id alone, so the date tree is walked until the file is hit.
async function findRolloutFile(dir: string, cliSessionId: string): Promise<string | null> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const suffix = `-${cliSessionId}.jsonl`
  const subdirs: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      subdirs.push(path.join(dir, entry.name))
    } else if (
      entry.isFile() &&
      entry.name.startsWith('rollout-') &&
      entry.name.endsWith(suffix)
    ) {
      return path.join(dir, entry.name)
    }
  }
  // Walk newest-first: sprint sessions are recent, so the target date dir is
  // near the end of the lexicographic YYYY/MM/DD order.
  subdirs.sort().reverse()
  for (const subdir of subdirs) {
    const found = await findRolloutFile(subdir, cliSessionId)
    if (found) return found
  }
  return null
}

async function locateRollout(sessionsDir: string, cliSessionId: string): Promise<string | null> {
  const memoKey = `${sessionsDir} ${cliSessionId}`
  const memoized = rolloutPathBySession.get(memoKey)
  if (memoized && (await pathExists(memoized))) return memoized
  const found = await findRolloutFile(sessionsDir, cliSessionId)
  if (found) rolloutPathBySession.set(memoKey, found)
  return found
}

function readTotal(payload: NonNullable<CodexRow['payload']>): CodexTotal | null {
  return payload.info?.total_token_usage ?? payload.total_token_usage ?? null
}

// Returns null when no rollout file or no token_count event exists for the
// session (caller reports measured:false); otherwise a single-model entry built
// from the last cumulative reading.
export async function readCodexUsage(
  cliSessionId: string,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): Promise<ModelTokenUsage[] | null> {
  const rolloutFile = await locateRollout(resolveSessionsDir(homeDir, env), cliSessionId)
  if (!rolloutFile) return null

  let statKey: string
  try {
    const info = await stat(rolloutFile)
    statKey = `${info.mtimeMs}:${info.size}`
  } catch {
    return null
  }
  const memoized = parsedByRollout.get(rolloutFile)
  if (memoized && memoized.statKey === statKey) {
    return memoized.rows.map((row) => ({ ...row }))
  }

  let lastTotal: CodexTotal | null = null
  let lastModel = 'unknown'
  await forEachJsonlRow(rolloutFile, (parsed) => {
    const row = parsed as CodexRow
    const payload = row.payload
    if (!payload || typeof payload !== 'object') return
    if (row.type === 'turn_context' && typeof payload.model === 'string') {
      lastModel = payload.model
    }
    if (payload.type === 'token_count') {
      const total = readTotal(payload)
      if (total) lastTotal = total
    }
  })

  // A located, parseable rollout with no populated token_count yet is a REAL
  // zero reading (a session that has done no work), not an unreadable source —
  // report it measured-with-no-rows so coverage stays truthful.
  if (!lastTotal) {
    const rows: ModelTokenUsage[] = []
    parsedByRollout.set(rolloutFile, { statKey, rows })
    return rows
  }
  const found: CodexTotal = lastTotal
  const rawInput = tokenCount(found.input_tokens)
  const cacheRead = tokenCount(found.cached_input_tokens)
  const derived = withDerivedTotals([
    {
      model: lastModel,
      // Codex input includes cached input; store the non-cached remainder so
      // `input` has the same meaning as Claude Code's disjoint fields.
      input: Math.max(0, rawInput - cacheRead),
      output: tokenCount(found.output_tokens),
      cacheRead,
      cacheCreation: 0,
      total: 0,
      split: true,
    },
  ])
  // Cross-check against the rollout's own session total: if a Codex release
  // ever changes the cache-inclusion semantics the derived components would
  // skew, but the headline total stays pinned to Codex's own accounting —
  // minus the cached re-reads it folds in, which sit outside `total` here the
  // same way they do for every other CLI (see withDerivedTotals).
  const reportedTotal = tokenCount(found.total_tokens)
  const rows =
    reportedTotal > 0
      ? derived.map((row) => ({ ...row, total: Math.max(0, reportedTotal - cacheRead) }))
      : derived
  parsedByRollout.set(rolloutFile, { statKey, rows })
  return rows.map((row) => ({ ...row }))
}
