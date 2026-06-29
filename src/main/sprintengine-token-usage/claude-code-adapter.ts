import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import path from 'node:path'

import { emptyModelUsage, tokenCount, type ModelTokenUsage } from './types'

// Claude Code writes one JSONL transcript per session at
// <configDir>/projects/<encoded-cwd>/<sessionId>.jsonl. Task-tool subagent
// usage is NOT inlined there: in current Claude Code it lives in sibling files
// <encoded-cwd>/<sessionId>/subagents/agent-*.jsonl carrying isSidechain rows
// with the same sessionId. To reconcile with the CLI's own /cost total we sum
// the main transcript and those subagent files. Older versions that inlined
// sidechain rows in the main file are still handled — every assistant row with
// usage is summed and rows are de-duplicated by uuid, so the two layouts never
// double-count. See knowledge/multicode/sprint-engine.md (Token Accounting).

// Claude Code session ids are uuid-shaped; the adapter only ever joins them
// into transcript paths. Restrict to this charset so a malformed id (e.g. one
// carrying `..` or a path separator) can never be interpolated into path.join —
// it reports unmeasured (null) instead, preserving fail-closed semantics.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

type ClaudeUsage = {
  input_tokens?: unknown
  output_tokens?: unknown
  cache_read_input_tokens?: unknown
  cache_creation_input_tokens?: unknown
}

type ClaudeRow = {
  type?: unknown
  uuid?: unknown
  message?: { model?: unknown; usage?: ClaudeUsage } | null
}

function resolveConfigDir(homeDir: string, env: NodeJS.ProcessEnv): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim()
  if (override) {
    // Some installs accept a comma-separated list; the session transcript lives
    // under the first configured directory.
    const first = override.split(',')[0]?.trim()
    if (first) return first
  }
  return path.join(homeDir, '.claude')
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

// Locate the project directory holding this session by scanning the encoded-cwd
// folders for either the main transcript or the subagents directory. The
// session id is globally unique, so the first match owns the session.
async function findProjectDir(
  projectsDir: string,
  sessionId: string,
): Promise<{ projectDir: string; hasMainFile: boolean } | null> {
  let entries
  try {
    entries = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const projectDir = path.join(projectsDir, entry.name)
    const mainFile = path.join(projectDir, `${sessionId}.jsonl`)
    if (await pathExists(mainFile)) return { projectDir, hasMainFile: true }
    if (await pathExists(path.join(projectDir, sessionId, 'subagents'))) {
      return { projectDir, hasMainFile: false }
    }
  }
  return null
}

function accumulateRow(
  row: ClaudeRow,
  perModel: Map<string, ModelTokenUsage>,
  seenUuids: Set<string>,
): void {
  if (row.type !== 'assistant') return
  const message = row.message
  if (!message || typeof message !== 'object') return
  const usage = message.usage
  if (!usage || typeof usage !== 'object') return
  const model = typeof message.model === 'string' ? message.model : 'unknown'
  const uuid = typeof row.uuid === 'string' ? row.uuid : null
  if (uuid) {
    if (seenUuids.has(uuid)) return
    seenUuids.add(uuid)
  }
  const bucket = perModel.get(model) ?? emptyModelUsage(model)
  bucket.input += tokenCount(usage.input_tokens)
  bucket.output += tokenCount(usage.output_tokens)
  bucket.cacheRead += tokenCount(usage.cache_read_input_tokens)
  bucket.cacheCreation += tokenCount(usage.cache_creation_input_tokens)
  perModel.set(model, bucket)
}

async function accumulateFromFile(
  filePath: string,
  perModel: Map<string, ModelTokenUsage>,
  seenUuids: Set<string>,
): Promise<void> {
  const reader = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of reader) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let row: ClaudeRow
      try {
        row = JSON.parse(trimmed) as ClaudeRow
      } catch {
        continue // tolerate truncated/partial trailing lines
      }
      accumulateRow(row, perModel, seenUuids)
    }
  } finally {
    reader.close()
  }
}

// Returns null when no transcript or subagent directory exists for the session
// (caller reports measured:false); otherwise the summed per-model usage.
export async function readClaudeCodeUsage(
  cliSessionId: string,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): Promise<ModelTokenUsage[] | null> {
  if (!SESSION_ID_PATTERN.test(cliSessionId)) return null
  const projectsDir = path.join(resolveConfigDir(homeDir, env), 'projects')
  const located = await findProjectDir(projectsDir, cliSessionId)
  if (!located) return null

  const perModel = new Map<string, ModelTokenUsage>()
  const seenUuids = new Set<string>()

  const mainFile = path.join(located.projectDir, `${cliSessionId}.jsonl`)
  if (located.hasMainFile) {
    await accumulateFromFile(mainFile, perModel, seenUuids)
  }

  const subagentsDir = path.join(located.projectDir, cliSessionId, 'subagents')
  let subagentFiles: string[] = []
  try {
    subagentFiles = (await readdir(subagentsDir)).filter((name) => name.endsWith('.jsonl'))
  } catch {
    subagentFiles = []
  }
  for (const name of subagentFiles) {
    await accumulateFromFile(path.join(subagentsDir, name), perModel, seenUuids)
  }

  return [...perModel.values()]
}
