import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'

// The usage scan: find every agent session log on this machine, decide which
// changed since the last scan (by each file's size and modified time), and
// fold each changed one into a small aggregate — tokens per hour per model.
// Nothing here keeps a transcript: a 50 MB session folds to a few hundred
// bytes.
//
// Three sources:
//
// - Claude Code's logs, `<config>/projects/<folder>/<session>.jsonl` and the
//   subagent logs in `<folder>/<session>/**`. Studio's own Claude chats run
//   through the Agent SDK and write here too.
// - Codex's rollouts, `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl`, Studio's
//   Codex chats among them.
// - Studio's chat transcripts, `<root>/.sprintengine/conversations/<ws>/<agent>.jsonl`.
//   Their `turn_completed` events carry the turn's usage when the runtime
//   reported it, the cost when it reported that, and the agent CLI session the
//   turn ran (`providerCursor.sessionId`), which is the only link between a
//   Studio chat and its CLI's log. The aggregation (usage-aggregate.ts) counts
//   a linked session from the CLI's own log, per request, and the transcript's
//   usage only for turns whose CLI log this machine does not have.
//
// It is pure Node and imports nothing of Electron, so it runs in the scan's
// worker thread (usage-scan-worker.ts), or inline, yielding between chunks,
// where no worker can start.

export type UsageSourceId = 'studio' | 'claude-code' | 'codex'

/**
 * One hour of one model's usage in one session:
 * `[hourStartMs, model, link, input, output, cacheRead, cacheWrite, requests, costUsd]`.
 * `link` is the agent CLI session a Studio turn ran, '' elsewhere. `input` is
 * fresh input only; cache reads and writes are apart from it.
 */
export type UsageBucket = [
  hour: number,
  model: string,
  link: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  requests: number,
  costUsd: number,
]

/** One session's aggregate, as the cache keeps it per group of files. */
export type UsageCacheEntry = {
  key: string
  src: UsageSourceId
  /** Fingerprint of the files the entry was read from: their sizes and modified times. */
  fp: string
  /** The agent CLI's session id; for a Studio transcript, the chat's agent id. */
  sessionId: string
  cwd: string | null
  /** The repository `cwd` belongs to, a linked worktree followed back to its main checkout. */
  repoRoot: string | null
  title: string | null
  providerId: string
  /** Studio transcripts: the chat, and every CLI session its turns ran. */
  studio?: { workspaceId: string; agentId: string; root: string; links: string[] }
  buckets: UsageBucket[]
}

/** A Studio transcript folder: one workspace's chats under one root. */
export type UsageStudioDir = { dir: string; workspaceId: string; root: string }

export type UsageScanRoots = {
  claudeProjects: string
  codexHome: string
  studioDirs: UsageStudioDir[]
}

export type UsageSourceStatus = { id: UsageSourceId; found: number; error: string | null }

export type UsageScanResult = {
  sources: UsageSourceStatus[]
  groups: number
  changed: number
  removed: string[]
}

type Group = { key: string; src: UsageSourceId; files: string[]; main: string; fp: string; newest: number }

const HOUR_MS = 3_600_000
const CLAUDE_PROVIDER = 'claude-agent'
const CODEX_PROVIDER = 'codex-agent'

// ── Reading lines ────────────────────────────────────────────────────────────

/**
 * Stream a file's lines without holding the file. `keep` is a cheap substring
 * test run before a line is handed on, so the many lines a reader does not care
 * about (tool output, attachments) are never JSON-parsed.
 */
export async function forEachLine(
  path: string,
  keep: (line: string) => boolean,
  onLine: (line: string) => void,
  options: { yieldEveryBytes?: number } = {},
): Promise<void> {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 })
  let carry = ''
  let sinceYield = 0
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      sinceYield += chunk.length
      const text = carry + chunk
      let from = 0
      for (let at = text.indexOf('\n', from); at >= 0; at = text.indexOf('\n', from)) {
        const line = text.slice(from, at)
        from = at + 1
        if (line && keep(line)) onLine(line)
      }
      carry = text.slice(from)
      // A single line longer than 64 MB is not one any reader here wants.
      if (carry.length > 64 << 20) carry = ''
      if (options.yieldEveryBytes && sinceYield >= options.yieldEveryBytes) {
        sinceYield = 0
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
    if (carry && keep(carry)) onLine(carry)
  } finally {
    stream.destroy()
  }
}

function parseJson(line: string): Record<string, unknown> | null {
  try {
    return rec(JSON.parse(line))
  } catch {
    return null
  }
}

const rec = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

function timeOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

const hourOf = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS

// ── Discovery ────────────────────────────────────────────────────────────────

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

async function listDir(path: string): Promise<Array<{ name: string; dir: boolean }>> {
  const entries = await readdir(path, { withFileTypes: true })
  return entries.map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
}

async function jsonlUnder(root: string, depth: number, out: string[]): Promise<void> {
  if (depth > 4) return
  let entries: Array<{ name: string; dir: boolean }>
  try {
    entries = await listDir(root)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.dir) await jsonlUnder(path, depth + 1, out)
    else if (entry.name.endsWith('.jsonl')) out.push(path)
  }
}

/** Each file's size and modified time, so an unchanged session is never read again. */
async function fingerprint(files: string[]): Promise<{ fp: string; newest: number }> {
  const parts: string[] = []
  let newest = 0
  for (const file of [...files].sort()) {
    try {
      const info = await stat(file)
      parts.push(`${info.size}:${Math.floor(info.mtimeMs)}`)
      newest = Math.max(newest, info.mtimeMs)
    } catch {
      // Gone between listing and stat: left out of the fingerprint.
    }
  }
  return { fp: `${parts.length}|${parts.join(',')}`, newest }
}

async function discoverClaude(projects: string, status: UsageSourceStatus): Promise<Group[]> {
  let folders: Array<{ name: string; dir: boolean }>
  try {
    folders = await listDir(projects)
  } catch (error) {
    if (!isMissing(error)) status.error = `Could not read ${projects}: ${(error as Error).message}`
    return []
  }
  const groups: Group[] = []
  for (const folder of folders) {
    if (!folder.dir) continue
    const dir = join(projects, folder.name)
    let entries: Array<{ name: string; dir: boolean }>
    try {
      entries = await listDir(dir)
    } catch {
      continue
    }
    const sessions = new Map<string, { main: string | null; extra: string[] }>()
    for (const entry of entries) {
      if (!entry.dir && entry.name.endsWith('.jsonl')) {
        const id = entry.name.slice(0, -'.jsonl'.length)
        const session = sessions.get(id) ?? { main: null, extra: [] }
        session.main = join(dir, entry.name)
        sessions.set(id, session)
      } else if (entry.dir && /^[0-9a-f-]{36}$/i.test(entry.name)) {
        // A session's own folder holds its subagents' logs.
        const extra: string[] = []
        await jsonlUnder(join(dir, entry.name), 0, extra)
        if (extra.length === 0) continue
        const session = sessions.get(entry.name) ?? { main: null, extra: [] }
        session.extra = extra
        sessions.set(entry.name, session)
      }
    }
    for (const [id, session] of sessions) {
      const files = [...(session.main ? [session.main] : []), ...session.extra]
      if (files.length === 0) continue
      const { fp, newest } = await fingerprint(files)
      groups.push({
        key: `claude-code:${folder.name}/${id}`,
        src: 'claude-code',
        files,
        main: session.main ?? files[0]!,
        fp,
        newest,
      })
    }
  }
  status.found = groups.length
  return groups
}

async function discoverCodex(codexHome: string, status: UsageSourceStatus): Promise<Group[]> {
  const root = join(codexHome, 'sessions')
  try {
    await stat(root)
  } catch (error) {
    if (!isMissing(error)) status.error = `Could not read ${root}: ${(error as Error).message}`
    return []
  }
  const files: string[] = []
  await jsonlUnder(root, 0, files)
  const groups: Group[] = []
  for (const file of files) {
    if (!basename(file).startsWith('rollout-')) continue
    const { fp, newest } = await fingerprint([file])
    groups.push({ key: `codex:${file.slice(root.length + 1)}`, src: 'codex', files: [file], main: file, fp, newest })
  }
  status.found = groups.length
  return groups
}

async function discoverStudio(dirs: UsageStudioDir[], status: UsageSourceStatus): Promise<Group[]> {
  const groups: Group[] = []
  const seen = new Set<string>()
  for (const { dir } of dirs) {
    let entries: Array<{ name: string; dir: boolean }>
    try {
      entries = await listDir(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.dir || !entry.name.endsWith('.jsonl')) continue
      const file = join(dir, entry.name)
      if (seen.has(file)) continue
      seen.add(file)
      const { fp, newest } = await fingerprint([file])
      groups.push({ key: `studio:${file}`, src: 'studio', files: [file], main: file, fp, newest })
    }
  }
  status.found = groups.length
  return groups
}

// ── Claude Code ──────────────────────────────────────────────────────────────

function blankEntry(group: Group, providerId: string): UsageCacheEntry {
  return {
    key: group.key,
    src: group.src,
    fp: group.fp,
    sessionId: '',
    cwd: null,
    repoRoot: null,
    title: null,
    providerId,
    buckets: [],
  }
}

/** Add one request (or one turn) to the entry's hour bucket for its model and link. */
function addUsage(
  buckets: Map<string, UsageBucket>,
  at: number,
  model: string,
  link: string,
  counts: [input: number, output: number, cacheRead: number, cacheWrite: number, requests: number, costUsd: number],
): void {
  const hour = hourOf(at)
  const key = `${hour}|${model}|${link}`
  const bucket = buckets.get(key) ?? [hour, model, link, 0, 0, 0, 0, 0, 0]
  for (let index = 0; index < 6; index += 1) bucket[3 + index] = (bucket[3 + index] as number) + counts[index]!
  buckets.set(key, bucket)
}

/**
 * Fold one Claude Code session: its log and its subagents' logs.
 *
 * - One reply streams as several records (one per content block) that share
 *   `message.id` + `requestId`, and only the last carries the final usage; the
 *   earlier ones show partial counts. Each reply is counted once, keeping the
 *   largest value of each field. (Keeping the first undercounts output about
 *   fourfold on subagent-heavy sessions.)
 * - A resumed or forked session copies its parent's records, marked by a
 *   `session_id` other than its own `sessionId`; those are counted where they
 *   were first written, so they are skipped here.
 * - Subagent logs repeat some of the parent's replies; the per-session key
 *   dedupes those too.
 */
export async function foldClaude(group: Group, yieldEveryBytes?: number): Promise<UsageCacheEntry> {
  const entry = blankEntry(group, CLAUDE_PROVIDER)
  const sessionId = basename(group.main, '.jsonl')
  const requests = new Map<string, { at: number; model: string; counts: number[] }>()
  let anonymous = 0
  for (const file of group.files) {
    const isMain = file === group.main && file.endsWith(`${sep}${sessionId}.jsonl`)
    await forEachLine(
      file,
      (line) =>
        line.includes('"type":"assistant"') ||
        (isMain && (line.includes('"type":"ai-title"') || line.includes('"type":"summary"') || !entry.cwd)),
      (line) => {
        const record = parseJson(line)
        if (!record) return
        entry.cwd ??= str(record.cwd)
        if (isMain && record.type === 'ai-title') entry.title = str(record.aiTitle) ?? entry.title
        if (isMain && record.type === 'summary' && !entry.title) entry.title = str(record.summary)
        if (record.type !== 'assistant') return
        const copiedFrom = str(record.session_id)
        if (copiedFrom && copiedFrom !== str(record.sessionId)) return
        const message = rec(record.message)
        const usage = rec(message?.usage)
        if (!message || !usage) return
        const model = str(message.model) ?? 'unknown'
        if (model === '<synthetic>') return
        const at = timeOf(record.timestamp)
        if (at === null) return
        const counts = [
          num(usage.input_tokens),
          num(usage.output_tokens),
          num(usage.cache_read_input_tokens),
          num(usage.cache_creation_input_tokens),
        ]
        const messageId = str(message.id)
        const requestId = str(record.requestId)
        const key = messageId || requestId ? `${messageId ?? ''}|${requestId ?? ''}` : `anon:${anonymous++}`
        const known = requests.get(key)
        if (known) {
          // A later block of the same reply: its usage is the more complete one.
          for (let index = 0; index < 4; index += 1)
            known.counts[index] = Math.max(known.counts[index]!, counts[index]!)
        } else requests.set(key, { at, model, counts })
      },
      { yieldEveryBytes },
    )
  }
  const buckets = new Map<string, UsageBucket>()
  for (const { at, model, counts } of requests.values()) {
    addUsage(buckets, at, model, '', [counts[0]!, counts[1]!, counts[2]!, counts[3]!, 1, 0])
  }
  entry.sessionId = sessionId
  entry.buckets = [...buckets.values()]
  return entry
}

// ── Codex ────────────────────────────────────────────────────────────────────

/**
 * Fold one Codex rollout. Each model response is a `token_usage_record` with
 * its own `response_id`, counted once. An older rollout without them has only
 * `token_count` events, whose running `total_token_usage` is differenced
 * (a total that went down means the count restarted). Codex's `input_tokens`
 * includes the cached part, which is taken out.
 */
export async function foldCodex(group: Group, yieldEveryBytes?: number): Promise<UsageCacheEntry> {
  const entry = blankEntry(group, CODEX_PROVIDER)
  let model = 'unknown'
  const responses = new Set<string>()
  const buckets = new Map<string, UsageBucket>()
  let hasRecords = false
  const fallback: Array<{ at: number; model: string; counts: [number, number, number, number, number, number] }> = []
  let previousTotal: number[] | null = null
  await forEachLine(
    group.main,
    (line) =>
      line.includes('"session_meta"') ||
      line.includes('"turn_context"') ||
      line.includes('"token_usage_record"') ||
      line.includes('"token_count"') ||
      (!entry.title && line.includes('"user_message"')),
    (line) => {
      const record = parseJson(line)
      if (!record) return
      const payload = rec(record.payload)
      if (record.type === 'session_meta' && payload) {
        entry.sessionId = str(payload.id) ?? str(payload.session_id) ?? entry.sessionId
        entry.cwd = str(payload.cwd) ?? entry.cwd
        return
      }
      if (record.type === 'turn_context' && payload) {
        model = str(payload.model) ?? model
        entry.cwd ??= str(payload.cwd)
        return
      }
      const at = timeOf(record.timestamp)
      if (at === null) return
      if (record.type === 'token_usage_record' && payload) {
        const usage = rec(payload.usage)
        const id = str(payload.response_id)
        if (!usage || (id && responses.has(id))) return
        if (id) responses.add(id)
        hasRecords = true
        const input = num(usage.input_tokens)
        const cached = Math.min(input, num(usage.cached_input_tokens))
        const written = Math.min(input - cached, num(usage.cache_write_input_tokens))
        addUsage(buckets, at, str(payload.model) ?? model, '', [
          input - cached - written,
          num(usage.output_tokens),
          cached,
          written,
          1,
          0,
        ])
        return
      }
      if (payload?.type === 'token_count') {
        const total = rec(rec(payload.info)?.total_token_usage)
        if (!total) return
        const now = [
          num(total.input_tokens),
          num(total.cached_input_tokens),
          num(total.cache_write_input_tokens),
          num(total.output_tokens),
        ]
        const previous: number[] = previousTotal && now[0]! >= previousTotal[0]! ? previousTotal : [0, 0, 0, 0]
        previousTotal = now
        const delta = now.map((value, index) => Math.max(0, value - (previous[index] ?? 0)))
        if (delta.every((value) => value === 0)) return
        const cached = Math.min(delta[0]!, delta[1]!)
        const written = Math.min(delta[0]! - cached, delta[2]!)
        fallback.push({ at, model, counts: [delta[0]! - cached - written, delta[3]!, cached, written, 1, 0] })
        return
      }
      if (record.type === 'event_msg' && payload?.type === 'user_message' && !entry.title) {
        entry.title = str(payload.message)?.split('\n')[0]?.slice(0, 120) ?? null
      }
    },
    { yieldEveryBytes },
  )
  if (!hasRecords) for (const item of fallback) addUsage(buckets, item.at, item.model, '', item.counts)
  if (!entry.sessionId) entry.sessionId = basename(group.main, '.jsonl')
  entry.buckets = [...buckets.values()]
  return entry
}

// ── Studio transcripts ───────────────────────────────────────────────────────

/**
 * Fold one Studio chat transcript: each `turn_completed`'s usage (when the
 * runtime reported it: `payload.usage` with `inputTokens`, `outputTokens`,
 * `cacheReadTokens`, `cacheWriteTokens`, any of which may be absent, and
 * older transcripts carry none), its reported `costUsd`, and the CLI session it
 * ran, kept as the bucket's link so the aggregation can prefer that CLI's own
 * log.
 */
export async function foldStudio(
  group: Group,
  dir: UsageStudioDir,
  titles: Map<string, string>,
): Promise<UsageCacheEntry> {
  const entry = blankEntry(group, '')
  const agentId = decodeSegment(basename(group.main, '.jsonl'))
  const links = new Set<string>()
  const buckets = new Map<string, UsageBucket>()
  entry.sessionId = agentId
  entry.cwd = dir.root
  entry.title = titles.get(agentId) ?? null
  await forEachLine(
    group.main,
    (line) => line.includes('"turn_completed"'),
    (line) => {
      const record = parseJson(line)
      if (!record || record.type !== 'turn_completed') return
      entry.providerId = str(record.providerId) ?? entry.providerId
      const payload = rec(record.payload)
      const at = typeof record.createdAt === 'number' ? record.createdAt : timeOf(record.createdAt)
      if (!payload || at === null) return
      const link = str(rec(payload.providerCursor)?.sessionId) ?? ''
      if (link) links.add(link)
      const usage = rec(payload.usage)
      const counts: [number, number, number, number, number, number] = [
        num(usage?.inputTokens),
        num(usage?.outputTokens),
        num(usage?.cacheReadTokens),
        num(usage?.cacheWriteTokens),
        usage ? 1 : 0,
        num(payload.costUsd),
      ]
      if (!usage && counts[5] === 0) return
      addUsage(buckets, at, str(record.modelId) ?? 'default', link, counts)
    },
  )
  entry.studio = { workspaceId: dir.workspaceId, agentId, root: dir.root, links: [...links].slice(0, 500) }
  entry.buckets = [...buckets.values()]
  return entry
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

async function studioTitles(dir: string, cache: Map<string, Map<string, string>>): Promise<Map<string, string>> {
  const known = cache.get(dir)
  if (known) return known
  const titles = new Map<string, string>()
  try {
    const index = rec(JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')))
    for (const thread of Array.isArray(index?.threads) ? index.threads : []) {
      const row = rec(thread)
      const id = str(row?.agentId)
      const title = str(row?.title)
      if (id && title) titles.set(id, title.slice(0, 160))
    }
  } catch {
    // No index yet: the chat's own record names it at query time.
  }
  cache.set(dir, titles)
  return titles
}

async function codexTitles(codexHome: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  try {
    await forEachLine(
      join(codexHome, 'session_index.jsonl'),
      (line) => line.includes('thread_name'),
      (line) => {
        const record = parseJson(line)
        const id = str(record?.id)
        const name = str(record?.thread_name)
        if (id && name) titles.set(id, name.slice(0, 160))
      },
    )
  } catch {
    // No index: a session is titled by its first message.
  }
  return titles
}

// ── Which repository a folder belongs to ─────────────────────────────────────

/**
 * The git root of `start`, with a linked worktree (`.git` is a file naming
 * `<repo>/.git/worktrees/<name>`) followed back to the repository it belongs
 * to, so a session in a worktree is attributed to the project. Null when no
 * repository contains it (or the folder is gone).
 */
export async function repositoryRoot(start: string): Promise<string | null> {
  let dir = start
  for (let depth = 0; depth < 16 && dir; depth += 1) {
    let git: 'dir' | string | null = null
    try {
      const info = await stat(join(dir, '.git'))
      git = info.isDirectory() ? 'dir' : (await readFile(join(dir, '.git'), 'utf8')).slice(0, 1000)
    } catch {
      git = null
    }
    if (git === 'dir') return dir
    if (typeof git === 'string') {
      const gitdir = /gitdir:\s*(.+)/.exec(git)?.[1]?.trim()
      const main = gitdir ? /^(.*)[\\/]\.git[\\/](?:worktrees|modules)[\\/]/.exec(gitdir)?.[1] : undefined
      return main ?? dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// ── The scan ─────────────────────────────────────────────────────────────────

/**
 * Scan everything. `previous` maps each group key to the fingerprint the cache
 * holds; groups whose fingerprint still matches are not read. Changed entries
 * go to `onEntry` as they are folded, newest work first, so the caller keeps
 * its memory flat.
 */
export async function runUsageScan(
  roots: UsageScanRoots,
  previous: Readonly<Record<string, string>>,
  hooks: { onEntry: (entry: UsageCacheEntry) => void; yieldEveryBytes?: number; shouldStop?: () => boolean },
): Promise<UsageScanResult> {
  const status: Record<UsageSourceId, UsageSourceStatus> = {
    studio: { id: 'studio', found: 0, error: null },
    'claude-code': { id: 'claude-code', found: 0, error: null },
    codex: { id: 'codex', found: 0, error: null },
  }
  const groups = [
    ...(await discoverClaude(roots.claudeProjects, status['claude-code'])),
    ...(await discoverCodex(roots.codexHome, status.codex)),
    ...(await discoverStudio(roots.studioDirs, status.studio)),
  ]
  const present = new Set(groups.map((group) => group.key))
  const removed = Object.keys(previous).filter((key) => !present.has(key))
  const changed = groups.filter((group) => previous[group.key] !== group.fp).sort((a, b) => b.newest - a.newest)
  const dirsByPath = new Map(roots.studioDirs.map((dir) => [dir.dir, dir]))
  const titleCache = new Map<string, Map<string, string>>()
  const codexNames = changed.some((group) => group.src === 'codex')
    ? await codexTitles(roots.codexHome)
    : new Map<string, string>()
  const repoRoots = new Map<string, Promise<string | null>>()
  let folded = 0
  for (const group of changed) {
    if (hooks.shouldStop?.()) break
    try {
      let entry: UsageCacheEntry
      if (group.src === 'claude-code') entry = await foldClaude(group, hooks.yieldEveryBytes)
      else if (group.src === 'codex') {
        entry = await foldCodex(group, hooks.yieldEveryBytes)
        entry.title = codexNames.get(entry.sessionId) ?? entry.title
      } else {
        const dir = dirsByPath.get(dirname(group.main))
        if (!dir) continue
        entry = await foldStudio(group, dir, await studioTitles(dir.dir, titleCache))
      }
      if (entry.cwd && entry.src !== 'studio') {
        let root = repoRoots.get(entry.cwd)
        if (!root) {
          root = repositoryRoot(entry.cwd)
          repoRoots.set(entry.cwd, root)
        }
        entry.repoRoot = await root
      }
      hooks.onEntry(entry)
      folded += 1
    } catch {
      // A file that vanished or could not be read mid-scan is retried next time.
    }
  }
  return { sources: Object.values(status), groups: groups.length, changed: folded, removed }
}
