// The one door onto scheduled agents that every caller goes through — the New
// chat panel over IPC, an extension through the SDK, an agent through the MCP
// tools — so each write is validated the same way and the scheduler hears of it.

import {
  validateScheduledAgentDraft,
  type ScheduledAgent,
  type ScheduledAgentLastRun,
  type ScheduledAgentView,
  type ScheduledAgentWriteResult,
} from '../../shared/scheduled-agents'
import type { ScheduledAgentsScheduler } from './scheduler'
import type { ScheduledAgentsStore } from './store'

export type ScheduledAgentsService = {
  list(options?: { ownerModuleId?: string }): ScheduledAgentView[]
  get(id: string): ScheduledAgentView | null
  create(input: unknown, options?: { ownerModuleId?: string }): Promise<ScheduledAgentWriteResult>
  update(id: string, input: unknown, options?: { ownerModuleId?: string }): Promise<ScheduledAgentWriteResult>
  remove(id: string, options?: { ownerModuleId?: string }): Promise<{ ok: true } | { ok: false; message: string }>
  runNow(
    id: string,
    options?: { ownerModuleId?: string },
  ): Promise<{ ok: true; run: ScheduledAgentLastRun } | { ok: false; message: string }>
  markFailureSeen(id: string): Promise<void>
  /** Called with the whole list after every change, including a run's outcome. */
  onChanged(listener: (agents: ScheduledAgentView[]) => void): () => void
  /** Something outside a write changed what the list says: a run finished, the computer woke. */
  notifyChanged(): void
}

export type ScheduledAgentsServiceDeps = {
  store: ScheduledAgentsStore
  scheduler: ScheduledAgentsScheduler
  now?: () => number
}

export function createScheduledAgentsService(deps: ScheduledAgentsServiceDeps): ScheduledAgentsService {
  const now = deps.now ?? Date.now
  const listeners = new Set<(agents: ScheduledAgentView[]) => void>()

  const view = (agent: ScheduledAgent): ScheduledAgentView => ({
    ...agent,
    nextRunAt: deps.scheduler.nextRunAt(agent.id),
  })
  const listViews = (): ScheduledAgentView[] => deps.store.list().map(view)
  const changed = (): void => {
    deps.scheduler.refresh()
    const views = listViews()
    for (const listener of listeners) listener(views)
  }

  // An extension reaches only the scheduled agents it made; the app reaches all.
  const reachable = (id: string, ownerModuleId: string | undefined): ScheduledAgent | null => {
    const agent = deps.store.get(id)
    if (!agent) return null
    if (ownerModuleId !== undefined && agent.ownerModuleId !== ownerModuleId) return null
    return agent
  }
  const notFound = (id: string) => ({ ok: false as const, message: `No scheduled agent "${id}".` })

  return {
    list(options) {
      const owner = options?.ownerModuleId
      return listViews().filter((agent) => owner === undefined || agent.ownerModuleId === owner)
    },
    get(id) {
      const agent = deps.store.get(id)
      return agent ? view(agent) : null
    },
    async create(input, options) {
      const validated = validateScheduledAgentDraft(input, now())
      if (!validated.ok) return validated
      const created = await deps.store.create(validated.draft, options?.ownerModuleId ?? null)
      changed()
      return { ok: true, agent: view(created) }
    },
    async update(id, input, options) {
      if (!reachable(id, options?.ownerModuleId)) return notFound(id)
      const validated = validateScheduledAgentDraft(input, now())
      if (!validated.ok) return validated
      const updated = await deps.store.update(id, validated.draft)
      if (!updated) return notFound(id)
      changed()
      return { ok: true, agent: view(updated) }
    },
    async remove(id, options) {
      if (!reachable(id, options?.ownerModuleId)) return notFound(id)
      await deps.store.remove(id)
      changed()
      return { ok: true }
    },
    async runNow(id, options) {
      if (!reachable(id, options?.ownerModuleId)) return notFound(id)
      const fired = await deps.scheduler.runNow(id)
      if (fired.ok) return { ok: true, run: fired.run }
      if (fired.refused === 'unknown') return notFound(id)
      return {
        ok: false,
        message:
          fired.refused === 'still_working'
            ? 'Its last run is still working.'
            : 'That scheduled agent is already starting a run.',
      }
    },
    async markFailureSeen(id) {
      await deps.store.markFailureSeen(id)
      changed()
    },
    onChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    notifyChanged: changed,
  }
}

/**
 * The extension-facing registry behind the SDK's `getScheduledAgentsService`:
 * the same service, with every call taking the module id first and scoped to
 * what that module created.
 */
export type ScheduledAgentsModuleRegistry = {
  create(moduleId: string, draft: unknown): Promise<ScheduledAgentWriteResult>
  update(moduleId: string, id: string, draft: unknown): Promise<ScheduledAgentWriteResult>
  remove(moduleId: string, id: string): Promise<{ ok: true } | { ok: false; message: string }>
  list(moduleId: string): Promise<ScheduledAgentView[]>
  runNow(moduleId: string, id: string): ReturnType<ScheduledAgentsService['runNow']>
  onChanged(moduleId: string, listener: (agents: ScheduledAgentView[]) => void): () => void
}

export function createScheduledAgentsModuleRegistry(service: ScheduledAgentsService): ScheduledAgentsModuleRegistry {
  return {
    create: (moduleId, draft) => service.create(draft, { ownerModuleId: moduleId }),
    update: (moduleId, id, draft) => service.update(id, draft, { ownerModuleId: moduleId }),
    remove: (moduleId, id) => service.remove(id, { ownerModuleId: moduleId }),
    list: async (moduleId) => service.list({ ownerModuleId: moduleId }),
    runNow: (moduleId, id) => service.runNow(id, { ownerModuleId: moduleId }),
    onChanged: (moduleId, listener) =>
      service.onChanged((agents) => listener(agents.filter((agent) => agent.ownerModuleId === moduleId))),
  }
}
