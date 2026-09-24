/**
 * The prompts a person sent each agent, kept across app restarts for the
 * conversation peek.
 *
 * The peek shows only what this app captured from the CLI's `UserPromptSubmit`
 * hook (owner ruling 2026-09-24): it never reads a CLI's own transcript, which
 * for a long session is tens of megabytes to re-parse on every hover. That makes
 * this store the only history the card has, so it has to outlive both the
 * session object and the snapshot sidecar, which is swept after 30 days while
 * the agent it belongs to lives on in the workspace registry.
 *
 * `<userData>/agent-prompts/<key>.json`, one small file per agent, next to the
 * registry that holds the agent's record. One file per agent rather than one
 * for all of them: a prompt rewrites only its own agent's file, and nothing is
 * ever read in bulk on a hot path. The directory is 0700 and every file 0600 —
 * this is a person's verbatim typing.
 *
 * Bounded twice: each file keeps at most {@link MAX_LIVE_PEEK_PROMPTS} prompts
 * of at most {@link MAX_AGENT_PROMPT_LENGTH} characters (the same trim the live
 * list applies, first prompt kept), and the directory keeps the
 * {@link MAX_AGENT_PROMPT_FILES} most recently written agents.
 *
 * Every read is of untrusted input and goes through `parseSessionPrompts`.
 * Every failure is a diagnostic, never a throw: a card with no history is the
 * worst this can cause.
 */
import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SessionPrompt } from '../shared/ipc/terminal'
import { appendLivePeekPrompt } from './conversation-peek/service'
import { parseSessionPrompts } from './terminal-session'

export const AGENT_PROMPTS_DIR_NAME = 'agent-prompts'

/** Agents whose prompts are kept. Past this the least recently written go. */
export const MAX_AGENT_PROMPT_FILES = 256

/** Session ids remembered per agent, newest last, for finding it by session. */
const MAX_SESSION_IDS_PER_AGENT = 8

/** Longest id accepted into a file. Workspace, agent and session ids are short. */
const MAX_ID_LENGTH = 256

export type AgentPromptOwner = {
  workspaceId: string
  agentId: string
  /** The CLI the agent runs, so a parked agent can still say whether it reports prompts. */
  cli?: string
  /** The terminal session the prompt arrived on. */
  sessionId?: string
}

export type StoredAgentPrompts = {
  workspaceId: string
  agentId: string
  cli?: string
  prompts: SessionPrompt[]
}

export type AgentPromptStore = {
  /** Append one prompt to the agent's stored list and write it. Resolves with the stored list. */
  append(owner: AgentPromptOwner, prompt: SessionPrompt): Promise<SessionPrompt[]>
  /**
   * Fold `prompts` (a session's live list) into what is stored, oldest first
   * and without duplicates, and write the result if it grew. Resolves with the
   * merged list — what the session should hold from now on.
   */
  merge(owner: AgentPromptOwner, prompts: readonly SessionPrompt[]): Promise<SessionPrompt[]>
  /** The stored prompts for an agent, or null when none are stored. */
  read(owner: Pick<AgentPromptOwner, 'workspaceId' | 'agentId'>): Promise<SessionPrompt[] | null>
  /** The agent a terminal session belonged to, with its prompts, or null. */
  findBySessionId(sessionId: string): Promise<StoredAgentPrompts | null>
  /** Settles once every queued write has landed. */
  flush(): Promise<void>
}

type AgentPromptFile = {
  version: 1
  workspaceId: string
  agentId: string
  cli?: string
  sessionIds: string[]
  updatedAt: number
  prompts: SessionPrompt[]
}

type IndexEntry = { workspaceId: string; agentId: string; sessionIds: string[]; updatedAt: number }

export function createAgentPromptStore(options: {
  resolveUserDataDir: () => string
  now?: () => number
  maxFiles?: number
  logDiagnostic?: (diagnostic: { level: 'warning'; title: string; message: string; details?: string }) => void
}): AgentPromptStore {
  const now = options.now ?? Date.now
  const maxFiles = Math.max(1, options.maxFiles ?? MAX_AGENT_PROMPT_FILES)
  const directory = () => join(options.resolveUserDataDir(), AGENT_PROMPTS_DIR_NAME)
  const filePath = (key: string) => join(directory(), `${key}.json`)

  // One chain per agent, so a read that follows a write sees it and two appends
  // for one agent land in order.
  const chains = new Map<string, Promise<unknown>>()
  // Built by one scan of the directory the first time something needs to find
  // an agent by session, or to decide which agent to evict. Kept current by
  // every write after that.
  let index: Promise<Map<string, IndexEntry>> | null = null

  const warn = (title: string, error: unknown): void => {
    options.logDiagnostic?.({
      level: 'warning',
      title,
      message: 'Agent prompt store operation failed.',
      details: error instanceof Error ? error.message : String(error),
    })
  }

  function run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    const settled = next.catch(() => undefined)
    chains.set(key, settled)
    void settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key)
    })
    return next
  }

  async function readFileAt(key: string): Promise<AgentPromptFile | null> {
    let raw: string
    try {
      raw = await readFile(filePath(key), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') warn('Agent prompt read failed', error)
      return null
    }
    try {
      return parseAgentPromptFile(JSON.parse(raw))
    } catch (error) {
      warn('Agent prompt parse failed', error)
      return null
    }
  }

  async function loadIndex(): Promise<Map<string, IndexEntry>> {
    const entries = new Map<string, IndexEntry>()
    let names: string[]
    try {
      names = await readdir(directory())
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') warn('Agent prompt scan failed', error)
      return entries
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const key = name.slice(0, -'.json'.length)
      const file = await readFileAt(key)
      if (!file) continue
      entries.set(key, {
        workspaceId: file.workspaceId,
        agentId: file.agentId,
        sessionIds: file.sessionIds,
        updatedAt: file.updatedAt,
      })
    }
    return entries
  }

  function ensureIndex(): Promise<Map<string, IndexEntry>> {
    index ??= loadIndex()
    return index
  }

  async function writeAgentFile(key: string, file: AgentPromptFile): Promise<void> {
    const target = filePath(key)
    const tmp = `${target}.${process.pid}.tmp`
    await mkdir(directory(), { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(directory(), 0o700)
    await writeFile(tmp, JSON.stringify(file), { mode: 0o600 })
    await rename(tmp, target)
    const entries = await ensureIndex()
    entries.set(key, {
      workspaceId: file.workspaceId,
      agentId: file.agentId,
      sessionIds: file.sessionIds,
      updatedAt: file.updatedAt,
    })
    await evictBeyondLimit(entries, key)
  }

  async function evictBeyondLimit(entries: Map<string, IndexEntry>, keep: string): Promise<void> {
    if (entries.size <= maxFiles) return
    const oldestFirst = [...entries.entries()]
      .filter(([key]) => key !== keep)
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    for (const [key] of oldestFirst.slice(0, entries.size - maxFiles)) {
      entries.delete(key)
      await rm(filePath(key), { force: true }).catch((error: unknown) => warn('Agent prompt eviction failed', error))
    }
  }

  function nextFile(
    owner: AgentPromptOwner,
    existing: AgentPromptFile | null,
    prompts: SessionPrompt[],
  ): AgentPromptFile {
    const sessionIds = [...(existing?.sessionIds ?? [])]
    const sessionId = safeId(owner.sessionId)
    if (sessionId && sessionIds[sessionIds.length - 1] !== sessionId) {
      const without = sessionIds.filter((id) => id !== sessionId)
      sessionIds.length = 0
      sessionIds.push(...without.slice(-(MAX_SESSION_IDS_PER_AGENT - 1)), sessionId)
    }
    const cli = safeId(owner.cli) ?? existing?.cli
    return {
      version: 1,
      workspaceId: owner.workspaceId,
      agentId: owner.agentId,
      ...(cli ? { cli } : {}),
      sessionIds,
      updatedAt: now(),
      prompts,
    }
  }

  return {
    append(owner, prompt) {
      const key = ownerKey(owner)
      if (!key) return Promise.resolve([])
      return run(key, async () => {
        const existing = await readFileAt(key)
        const text = capPrompt(prompt.text)
        if (!text) return existing?.prompts ?? []
        const prompts = appendLivePeekPrompt(existing?.prompts, text, prompt.at)
        try {
          await writeAgentFile(key, nextFile(owner, existing, prompts))
        } catch (error) {
          warn('Agent prompt write failed', error)
        }
        return prompts
      })
    },

    merge(owner, prompts) {
      const key = ownerKey(owner)
      if (!key) return Promise.resolve([...prompts])
      return run(key, async () => {
        const existing = await readFileAt(key)
        const stored = existing?.prompts ?? []
        const seen = new Set(stored.map(promptIdentity))
        let merged = stored
        for (const prompt of [...prompts].sort((a, b) => a.at - b.at)) {
          const text = capPrompt(prompt.text)
          if (!text || seen.has(promptIdentity({ text, at: prompt.at }))) continue
          seen.add(promptIdentity({ text, at: prompt.at }))
          merged = appendLivePeekPrompt(merged, text, prompt.at)
        }
        if (merged !== stored) {
          try {
            await writeAgentFile(key, nextFile(owner, existing, merged))
          } catch (error) {
            warn('Agent prompt write failed', error)
          }
        }
        return merged
      })
    },

    read(owner) {
      const key = ownerKey(owner)
      if (!key) return Promise.resolve(null)
      return run(key, async () => {
        const file = await readFileAt(key)
        return file && file.prompts.length > 0 ? file.prompts : null
      })
    },

    async findBySessionId(sessionId) {
      if (!safeId(sessionId)) return null
      const entries = await ensureIndex()
      let found: string | null = null
      let foundAt = -1
      for (const [key, entry] of entries) {
        if (entry.updatedAt > foundAt && entry.sessionIds.includes(sessionId)) {
          found = key
          foundAt = entry.updatedAt
        }
      }
      if (!found) return null
      const key = found
      return run(key, async () => {
        const file = await readFileAt(key)
        if (!file) return null
        return {
          workspaceId: file.workspaceId,
          agentId: file.agentId,
          ...(file.cli ? { cli: file.cli } : {}),
          prompts: file.prompts,
        }
      })
    },

    async flush() {
      await Promise.all([...chains.values()])
    },
  }
}

/**
 * The file name for an agent: a hash of its two ids, because both are
 * caller-supplied strings and neither may choose a path.
 */
function ownerKey(owner: Pick<AgentPromptOwner, 'workspaceId' | 'agentId'>): string | null {
  const workspaceId = safeId(owner.workspaceId)
  const agentId = safeId(owner.agentId)
  if (!workspaceId || !agentId) return null
  return createHash('sha256').update(`${workspaceId}\0${agentId}`).digest('hex').slice(0, 32)
}

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && !value.includes('\0')
    ? value
    : undefined
}

function promptIdentity(prompt: SessionPrompt): string {
  return `${prompt.at}\0${prompt.text}`
}

function capPrompt(text: string): string {
  // `parseSessionPrompts` applies the same cap on the way back in.
  return parseSessionPrompts([{ text, at: 0 }])?.[0]?.text ?? ''
}

function parseAgentPromptFile(raw: unknown): AgentPromptFile | null {
  if (!raw || typeof raw !== 'object') return null
  const file = raw as Partial<AgentPromptFile>
  if (file.version !== 1) return null
  const workspaceId = safeId(file.workspaceId)
  const agentId = safeId(file.agentId)
  if (!workspaceId || !agentId) return null
  const cli = safeId(file.cli)
  const sessionIds = Array.isArray(file.sessionIds)
    ? file.sessionIds
        .slice(-MAX_SESSION_IDS_PER_AGENT)
        .map(safeId)
        .filter((id): id is string => id !== undefined)
    : []
  return {
    version: 1,
    workspaceId,
    agentId,
    ...(cli ? { cli } : {}),
    sessionIds,
    updatedAt: typeof file.updatedAt === 'number' && Number.isFinite(file.updatedAt) ? file.updatedAt : 0,
    prompts: parseSessionPrompts(file.prompts) ?? [],
  }
}
