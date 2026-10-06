// Scheduled agents on disk: one JSON file in the app's own data. Never in a
// project folder — what is scheduled on this computer is decided on this
// computer, so a commit pulled into a project can never schedule anything.
//
// The file is small (a person has a handful of these), so the store holds the
// whole list in memory, reads it once, and rewrites it whole on every change,
// serialized so two writes never interleave.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { writeFileAtomically } from '../config-file-write'
import {
  validateScheduledAgentDraft,
  type ScheduledAgent,
  type ScheduledAgentDraft,
  type ScheduledAgentLastRun,
} from '../../shared/scheduled-agents'
import { isRecord } from '../../shared/records'

const FILE_VERSION = 1

type StoreFile = { version: typeof FILE_VERSION; agents: ScheduledAgent[] }

export function scheduledAgentsFilePath(userDataDir: string): string {
  return join(userDataDir, 'scheduled-agents.json')
}

export type ScheduledAgentsStoreOptions = {
  filePath: string
  now?: () => number
  newId?: () => string
  warn?: (message: string) => void
}

export type ScheduledAgentsStore = {
  load(): Promise<void>
  list(): ScheduledAgent[]
  get(id: string): ScheduledAgent | null
  create(draft: ScheduledAgentDraft, ownerModuleId?: string | null): Promise<ScheduledAgent>
  update(id: string, draft: ScheduledAgentDraft): Promise<ScheduledAgent | null>
  remove(id: string): Promise<boolean>
  recordRun(id: string, run: ScheduledAgentLastRun): Promise<void>
  /**
   * The run recorded as started in `workspaceId` failed after all: its last
   * run becomes that failure. False when the last run is another one (or none).
   */
  failRun(id: string, workspaceId: string, message: string): Promise<boolean>
  markFailureSeen(id: string): Promise<void>
}

export function createScheduledAgentsStore(options: ScheduledAgentsStoreOptions): ScheduledAgentsStore {
  const now = options.now ?? Date.now
  const newId = options.newId ?? (() => `sa-${randomUUID().replace(/-/g, '').slice(0, 12)}`)
  let agents: ScheduledAgent[] = []
  let writing: Promise<void> = Promise.resolve()

  const persist = (): Promise<void> => {
    const snapshot: StoreFile = { version: FILE_VERSION, agents }
    writing = writing
      .catch(() => undefined)
      .then(() => writeFileAtomically(options.filePath, `${JSON.stringify(snapshot, null, 2)}\n`))
    return writing
  }

  const replace = (id: string, next: ScheduledAgent): void => {
    agents = agents.map((agent) => (agent.id === id ? next : agent))
  }

  return {
    async load() {
      let raw: string
      try {
        raw = await readFile(options.filePath, 'utf8')
      } catch {
        agents = []
        return
      }
      try {
        agents = parseStoreFile(JSON.parse(raw), now(), options.warn)
      } catch (error) {
        options.warn?.(
          `Scheduled agents could not be read from ${options.filePath}: ${error instanceof Error ? error.message : String(error)}`,
        )
        agents = []
      }
    },
    list: () => agents,
    get: (id) => agents.find((agent) => agent.id === id) ?? null,
    async create(draft, ownerModuleId = null) {
      const at = now()
      const agent: ScheduledAgent = {
        ...draft,
        id: newId(),
        ownerModuleId: ownerModuleId?.trim() || null,
        createdAt: at,
        updatedAt: at,
        lastRun: null,
        lastFailureSeenAt: null,
      }
      agents = [...agents, agent]
      await persist()
      return agent
    },
    async update(id, draft) {
      const current = agents.find((agent) => agent.id === id)
      if (!current) return null
      const next: ScheduledAgent = { ...current, ...draft, updatedAt: now() }
      replace(id, next)
      await persist()
      return next
    },
    async remove(id) {
      const before = agents.length
      agents = agents.filter((agent) => agent.id !== id)
      if (agents.length === before) return false
      await persist()
      return true
    },
    async recordRun(id, run) {
      const current = agents.find((agent) => agent.id === id)
      if (!current) return
      replace(id, { ...current, lastRun: run })
      await persist()
    },
    async failRun(id, workspaceId, message) {
      const current = agents.find((agent) => agent.id === id)
      const run = current?.lastRun
      if (!current || !run?.ok || run.workspaceId !== workspaceId) return false
      replace(id, { ...current, lastRun: { at: run.at, ok: false, message } })
      await persist()
      return true
    },
    async markFailureSeen(id) {
      const current = agents.find((agent) => agent.id === id)
      if (!current || !current.lastRun || current.lastRun.ok) return
      replace(id, { ...current, lastFailureSeenAt: now() })
      await persist()
    },
  }
}

// Each record is re-validated on the way in: a hand-edited or half-written
// entry is dropped with a warning rather than scheduled in a shape nothing
// else would have written.
function parseStoreFile(input: unknown, now: number, warn?: (message: string) => void): ScheduledAgent[] {
  if (!isRecord(input) || !Array.isArray(input.agents)) return []
  const agents: ScheduledAgent[] = []
  for (const entry of input.agents) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id) continue
    const validated = validateScheduledAgentDraft(entry, now)
    if (!validated.ok) {
      warn?.(`Scheduled agent "${entry.id}" was skipped: ${validated.message}`)
      continue
    }
    agents.push({
      ...validated.draft,
      id: entry.id,
      ownerModuleId: typeof entry.ownerModuleId === 'string' && entry.ownerModuleId ? entry.ownerModuleId : null,
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : now,
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : now,
      lastRun: parseLastRun(entry.lastRun),
      lastFailureSeenAt: typeof entry.lastFailureSeenAt === 'number' ? entry.lastFailureSeenAt : null,
    })
  }
  return agents
}

function parseLastRun(input: unknown): ScheduledAgentLastRun | null {
  if (!isRecord(input) || typeof input.at !== 'number') return null
  if (input.ok === true && typeof input.workspaceId === 'string') {
    return { at: input.at, ok: true, workspaceId: input.workspaceId }
  }
  if (input.ok === false && typeof input.message === 'string')
    return { at: input.at, ok: false, message: input.message }
  return null
}
