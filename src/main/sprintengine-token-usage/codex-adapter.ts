import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import path from 'node:path'

import { tokenCount, type ModelTokenUsage } from './types'

// Codex writes one rollout JSONL per session under
// <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl. Each
// `token_count` event carries an already-cumulative `total_token_usage`, so we
// take the LAST such event rather than summing across events. Codex reports a
// single session-wide total (no per-model split), and its `input_tokens`
// already includes `cached_input_tokens` — unlike Claude Code, where input and
// cache reads are disjoint. Per the adapter contract these values are recorded
// as-is (cached_input_tokens -> cacheRead, no cache-creation); the cross-CLI
// difference is documented in knowledge/multicode/sprint-engine.md.

type CodexTotal = {
  input_tokens?: unknown
  output_tokens?: unknown
  cached_input_tokens?: unknown
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
  for (const subdir of subdirs) {
    const found = await findRolloutFile(subdir, cliSessionId)
    if (found) return found
  }
  return null
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
  const rolloutFile = await findRolloutFile(resolveSessionsDir(homeDir, env), cliSessionId)
  if (!rolloutFile) return null

  let lastTotal: CodexTotal | null = null
  let lastModel = 'unknown'

  const reader = createInterface({
    input: createReadStream(rolloutFile, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of reader) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let row: CodexRow
      try {
        row = JSON.parse(trimmed) as CodexRow
      } catch {
        continue
      }
      const payload = row.payload
      if (!payload || typeof payload !== 'object') continue
      if (row.type === 'turn_context' && typeof payload.model === 'string') {
        lastModel = payload.model
      }
      if (payload.type === 'token_count') {
        const total = readTotal(payload)
        if (total) lastTotal = total
      }
    }
  } finally {
    reader.close()
  }

  if (!lastTotal) return null
  return [
    {
      model: lastModel,
      input: tokenCount(lastTotal.input_tokens),
      output: tokenCount(lastTotal.output_tokens),
      cacheRead: tokenCount(lastTotal.cached_input_tokens),
      cacheCreation: 0,
    },
  ]
}
