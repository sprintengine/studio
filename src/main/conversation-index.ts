import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { workspaceSidecarPath } from './workspace-sidecar'
import type { ConversationEvent, ConversationKey } from '../shared/conversation-runtime'
import type {
  ConversationSearchHit,
  ConversationSearchInput,
  ConversationThread,
  ConversationWorkspaceKey,
} from '../shared/conversation-index'

type Fingerprint = { file: string; size: number; mtime: number }
type Index = { version: 2; threads: ConversationThread[]; files: Fingerprint[] }
const segment = (value: string) => {
  const encoded = encodeURIComponent(value.trim().replace(/[\\/]/g, '-'))
  return encoded === '.' || encoded === '..' ? encoded.replace(/\./g, '%2E') : encoded
}
const directory = (key: ConversationWorkspaceKey) =>
  workspaceSidecarPath(key.workspaceRoot, 'conversations', segment(key.workspaceId))
export const conversationIndexTranscriptPath = (key: ConversationKey) =>
  join(directory(key), `${segment(key.agentId)}.jsonl`)
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const text = (value: unknown) => (typeof value === 'string' ? value : '')
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** Cache only. Titles, including explicit renames, are recovered from transcript events. */
export class ConversationIndex {
  private queues = new Map<string, Promise<unknown>>()
  constructor(
    private readonly hooks: { flush?: (path: string) => Promise<void>; close?: (path: string) => Promise<void> } = {},
  ) {}
  private async serialized<T>(key: ConversationWorkspaceKey, work: () => Promise<T>): Promise<T> {
    const path = directory(key),
      previous = this.queues.get(path) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(work)
    this.queues.set(path, next)
    try {
      return await next
    } finally {
      if (this.queues.get(path) === next) this.queues.delete(path)
    }
  }
  async list(key: ConversationWorkspaceKey): Promise<ConversationThread[]> {
    return this.serialized(key, async () => {
      if (!(await safeDirectory(key))) return []
      const files = await this.files(key)
      const cached = await readIndex(directory(key))
      if (cached && JSON.stringify(cached.files) === JSON.stringify(files)) return sorted(cached.threads)
      const threads: ConversationThread[] = []
      for (const file of files) {
        const thread = await readThread(join(directory(key), file.file))
        if (thread) threads.push(thread)
      }
      await saveIndex(directory(key), { version: 2, threads, files })
      return sorted(threads)
    })
  }
  /** Refresh one completed turn without rescanning every other transcript. */
  async refresh(key: ConversationKey): Promise<ConversationThread | null> {
    if (!key.agentId.trim()) throw new Error('Conversation identity is required.')
    return this.serialized(key, async () => {
      if (!(await safeDirectory(key))) return null
      const path = conversationIndexTranscriptPath(key)
      await this.hooks.flush?.(path)
      const thread = await readThread(path)
      const cache = await readIndex(directory(key))
      if (cache) {
        const current = await fingerprint(path, `${segment(key.agentId)}.jsonl`)
        const files = cache.files.filter((file) => file.file !== `${segment(key.agentId)}.jsonl`)
        if (current) files.push(current)
        files.sort((a, b) => a.file.localeCompare(b.file))
        const threads = cache.threads.filter((entry) => entry.agentId !== key.agentId)
        if (thread) threads.push(thread)
        await saveIndex(directory(key), { version: 2, threads, files })
      } else {
        const files = await this.files(key)
        const threads: ConversationThread[] = []
        for (const file of files) {
          const entry = await readThread(join(directory(key), file.file))
          if (entry) threads.push(entry)
        }
        await saveIndex(directory(key), { version: 2, threads, files })
      }
      return thread
    })
  }
  /** Incremental batches let IPC and remote consumers surface hits before scanning finishes. */
  async search(
    input: ConversationSearchInput,
    options: { signal?: AbortSignal; onBatch?: (hits: ConversationSearchHit[]) => void } = {},
  ): Promise<ConversationSearchHit[]> {
    const query = input.query.trim().toLowerCase().slice(0, 500)
    if (!query || !(await safeDirectory(input))) return []
    const hits: ConversationSearchHit[] = [],
      pending: ConversationSearchHit[] = []
    for (const file of await this.files(input)) {
      options.signal?.throwIfAborted()
      const path = join(directory(input), file.file)
      const seen = new Set<string>(),
        tails = new Map<string, string>(),
        turnSeq = new Map<string, number>()
      let ordinal = 0
      for await (const event of readEvents(path, options.signal)) {
        ordinal = event.seq ?? ordinal + 1
        const turnId = text(event.payload?.turnId)
        if (event.type === 'user_message') turnSeq.set(turnId, ordinal)
        if (event.type !== 'user_message' && event.type !== 'content_delta') continue
        const key = `${event.type}:${turnId}`
        if (seen.has(key)) continue
        const value = `${tails.get(key) ?? ''}${text(event.payload?.text)}`
        const offset = value.toLowerCase().indexOf(query)
        tails.set(key, value.slice(-Math.max(160, query.length)))
        if (offset < 0) continue
        seen.add(key)
        const snippet = `${offset > 80 ? '…' : ''}${value.slice(Math.max(0, offset - 80), offset + query.length + 100)}${value.length > offset + query.length + 100 ? '…' : ''}`
        const hit = {
          agentId: event.agentId,
          seq: turnSeq.get(turnId) ?? ordinal,
          ...(turnId ? { turnId } : {}),
          snippet,
        }
        hits.push(hit)
        pending.push(hit)
        if (pending.length >= 20) options.onBatch?.(pending.splice(0))
        if (hits.length >= 200) {
          if (pending.length) options.onBatch?.(pending.splice(0))
          return hits
        }
      }
    }
    if (pending.length) options.onBatch?.(pending)
    return hits
  }
  /** Caller must reject active sessions and obtain explicit confirmation before deleting. */
  async delete(key: ConversationKey): Promise<void> {
    if (!key.agentId.trim()) throw new Error('Conversation identity is required.')
    await this.serialized(key, async () => {
      if (!(await safeDirectory(key))) return
      const path = conversationIndexTranscriptPath(key)
      await this.hooks.close?.(path)
      const file = await lstat(path).catch((error) => {
        if (isMissing(error)) return null
        throw error
      })
      if (file?.isSymbolicLink()) throw new Error('A conversation transcript cannot be a symbolic link.')
      if (file) await unlink(path)
      const tools = join(directory(key), `${segment(key.agentId)}.tools`)
      const detail = await lstat(tools).catch((error) => {
        if (isMissing(error)) return null
        throw error
      })
      if (detail?.isSymbolicLink()) await unlink(tools)
      else if (detail?.isDirectory()) await rm(tools, { recursive: true })
      const cache = await readIndex(directory(key))
      if (cache)
        await saveIndex(directory(key), {
          ...cache,
          threads: cache.threads.filter((entry) => entry.agentId !== key.agentId),
          files: cache.files.filter((entry) => entry.file !== `${segment(key.agentId)}.jsonl`),
        })
    })
  }
  private async files(key: ConversationWorkspaceKey): Promise<Fingerprint[]> {
    const entries = await readdir(directory(key), { withFileTypes: true })
    const files: Fingerprint[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const path = join(directory(key), entry.name)
      await this.hooks.flush?.(path)
      const value = await fingerprint(path, entry.name)
      if (value) files.push(value)
    }
    return files.sort((a, b) => a.file.localeCompare(b.file))
  }
}

async function safeDirectory(key: ConversationWorkspaceKey): Promise<boolean> {
  if (!key.workspaceRoot.trim() || !key.workspaceId.trim()) throw new Error('Workspace identity is required.')
  let path = await realpath(key.workspaceRoot)
  for (const part of ['.sprintengine', 'conversations', segment(key.workspaceId)]) {
    path = join(path, part)
    let value
    try {
      value = await lstat(path)
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
    if (value.isSymbolicLink() || !value.isDirectory())
      throw new Error('Conversation storage must be a real directory within the workspace.')
  }
  return true
}
async function fingerprint(path: string, file: string): Promise<Fingerprint | null> {
  try {
    const value = await lstat(path)
    return value.isFile() && !value.isSymbolicLink() ? { file, size: value.size, mtime: value.mtimeMs } : null
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}
async function* readEvents(path: string, signal?: AbortSignal): AsyncIterable<ConversationEvent> {
  const info = await fingerprint(path, '')
  if (!info) return
  const stream = createReadStream(path, { encoding: 'utf8', signal })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      signal?.throwIfAborted()
      try {
        const value = record(JSON.parse(line))
        if (typeof value.type === 'string' && typeof value.agentId === 'string' && typeof value.createdAt === 'number')
          yield value as ConversationEvent
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error
      }
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}
async function readThread(path: string): Promise<ConversationThread | null> {
  let thread: ConversationThread | null = null
  const turns = new Set<string>()
  const costs = new Map<string, number>()
  for await (const event of readEvents(path)) {
    thread ??= {
      agentId: event.agentId,
      title: 'New conversation',
      titleSource: 'first-message',
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
      turnCount: 0,
      model: event.modelId ?? '',
      providerId: event.providerId ?? '',
      lastSeq: 0,
      firstUserText: '',
    }
    thread.updatedAt = Math.max(thread.updatedAt, event.createdAt)
    thread.model = event.modelId || thread.model
    thread.providerId = event.providerId || thread.providerId
    const parts = record(event).parts
    const partSeqs = Array.isArray(parts)
      ? parts.flatMap((part) => (Array.isArray(part) && typeof part[3] === 'number' ? [part[3]] : []))
      : []
    thread.lastSeq = Math.max(thread.lastSeq, event.seq ?? thread.lastSeq + 1, ...partSeqs)
    if (event.type === 'turn_completed') {
      const cost = event.payload?.costUsd
      if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)
        costs.set(text(event.payload?.turnId) || event.id, cost)
    }
    if (event.type === 'user_message') {
      turns.add(text(event.payload?.turnId) || event.id)
      if (!thread.firstUserText) {
        thread.firstUserText = text(event.payload?.text)
        if (thread.titleSource === 'first-message') thread.title = firstMessageTitle(thread.firstUserText)
      }
    }
    if (event.type === 'session_updated' && typeof event.payload?.conversationTitle === 'string') {
      const source = event.payload.titleSource
      if (source === 'user' || (source === 'generated' && thread.titleSource !== 'user')) {
        thread.title = event.payload.conversationTitle.slice(0, 200)
        thread.titleSource = source
      }
    }
  }
  if (thread) {
    thread.turnCount = turns.size
    if (costs.size) thread.totalCostUsd = [...costs.values()].reduce((sum, cost) => sum + cost, 0)
  }
  return thread
}
/** A generated-title service can replace this ladder rung without changing index ownership. */
export function firstMessageTitle(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').slice(0, 60) || 'New conversation'
}
const sorted = (threads: ConversationThread[]) => [...threads].sort((a, b) => b.updatedAt - a.updatedAt)
async function readIndex(path: string): Promise<Index | null> {
  try {
    const file = join(path, 'index.json')
    if ((await lstat(file)).isSymbolicLink()) return null
    const value = record(JSON.parse(await readFile(file, 'utf8')))
    if (value.version !== 2 || !Array.isArray(value.threads) || !Array.isArray(value.files)) return null
    if (
      !value.threads.every((thread) => {
        const item = record(thread)
        return (
          typeof item.agentId === 'string' &&
          typeof item.title === 'string' &&
          typeof item.model === 'string' &&
          typeof item.providerId === 'string' &&
          typeof item.firstUserText === 'string' &&
          Number.isFinite(item.createdAt) &&
          Number.isFinite(item.updatedAt) &&
          Number.isSafeInteger(item.turnCount) &&
          Number.isSafeInteger(item.lastSeq) &&
          (item.totalCostUsd === undefined ||
            (typeof item.totalCostUsd === 'number' && Number.isFinite(item.totalCostUsd) && item.totalCostUsd >= 0)) &&
          ['first-message', 'user', 'generated'].includes(text(item.titleSource))
        )
      })
    )
      return null
    if (
      !value.files.every((file) => {
        const item = record(file)
        return (
          typeof item.file === 'string' &&
          item.file.endsWith('.jsonl') &&
          !/[\\/]/u.test(item.file) &&
          Number.isFinite(item.size) &&
          Number.isFinite(item.mtime)
        )
      })
    )
      return null
    return value as Index
  } catch {
    return null
  }
}
async function saveIndex(path: string, value: Index): Promise<void> {
  await mkdir(path, { recursive: true })
  const temp = join(path, `index.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    await rename(temp, join(path, 'index.json'))
  } finally {
    await unlink(temp).catch((error) => {
      if (!isMissing(error)) throw error
    })
  }
}
