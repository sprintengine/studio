// The one door onto scheduled agents that every caller goes through — the New
// chat panel over IPC, an extension through the SDK, an agent through the MCP
// tools — so each write is validated the same way and the scheduler hears of it.

import type { CliPermissionPreset } from '../../shared/cli-permission-preset'
import { isLooserCliPermissionPreset } from '../../shared/cli-permission-preset'
import {
  validateScheduledAgentDraft,
  type ScheduledAgent,
  type ScheduledAgentDraft,
  type ScheduledAgentLastRun,
  type ScheduledAgentView,
  type ScheduledAgentWriteResult,
} from '../../shared/scheduled-agents'
import { refuseScheduledAgentRun } from '../automation/launch-permission-cap'
import { moduleConversationCeiling } from '../module-host/module-conversation-service'
import {
  clampToModuleToolCaller,
  moduleToolCallerCeiling,
  moduleToolCallerScheduledRun,
} from '../module-host/module-tool-caller'
import type { ScheduledAgentsScheduler } from './scheduler'
import type { ScheduledAgentsStore } from './store'

/** Lowers a validated draft's preset before it is stored; the identity when absent. */
type CapPreset = (preset: CliPermissionPreset | null) => CliPermissionPreset | null

export type ScheduledAgentsService = {
  list(options?: { ownerModuleId?: string }): ScheduledAgentView[]
  get(id: string): ScheduledAgentView | null
  create(
    input: unknown,
    options?: { ownerModuleId?: string; capPreset?: CapPreset },
  ): Promise<ScheduledAgentWriteResult>
  update(
    id: string,
    input: unknown,
    options?: { ownerModuleId?: string; capPreset?: CapPreset },
  ): Promise<ScheduledAgentWriteResult>
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
  const capped = (draft: ScheduledAgentDraft, capPreset: CapPreset | undefined): ScheduledAgentDraft =>
    capPreset ? { ...draft, permissionPreset: capPreset(draft.permissionPreset) } : draft
  /** A write the store refused (its file could not be read), as the caller's answer rather than a throw. */
  const refused = (error: unknown) => ({
    ok: false as const,
    message: error instanceof Error ? error.message : String(error),
  })

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
      const draft = capped(validated.draft, options?.capPreset)
      let created: ScheduledAgent
      try {
        created = await deps.store.create(draft, options?.ownerModuleId ?? null)
      } catch (error) {
        return refused(error)
      }
      changed()
      return { ok: true, agent: view(created) }
    },
    async update(id, input, options) {
      await deps.store.load()
      if (!reachable(id, options?.ownerModuleId)) return notFound(id)
      const validated = validateScheduledAgentDraft(input, now())
      if (!validated.ok) return validated
      let updated: ScheduledAgent | null
      try {
        updated = await deps.store.update(id, capped(validated.draft, options?.capPreset))
      } catch (error) {
        return refused(error)
      }
      if (!updated) return notFound(id)
      changed()
      return { ok: true, agent: view(updated) }
    },
    async remove(id, options) {
      await deps.store.load()
      if (!reachable(id, options?.ownerModuleId)) return notFound(id)
      try {
        await deps.store.remove(id)
      } catch (error) {
        return refused(error)
      }
      changed()
      return { ok: true }
    },
    async runNow(id, options) {
      await deps.store.load()
      if (!reachable(id, options?.ownerModuleId)) return notFound(id)
      const fired = await deps.scheduler.runNow(id)
      if (fired.ok) return { ok: true, run: fired.run }
      if (fired.refused === 'unknown') return notFound(id)
      return {
        ok: false,
        message:
          fired.refused === 'still_working'
            ? 'Its last run is still working.'
            : fired.refused === 'stopped'
              ? 'Studio is quitting, so the run did not start.'
              : 'That scheduled agent is already starting a run.',
      }
    },
    async markFailureSeen(id) {
      // Unsaved when the file could not be read; the failure is still shown.
      await deps.store.markFailureSeen(id).catch(() => undefined)
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

export function createScheduledAgentsModuleRegistry(
  service: ScheduledAgentsService,
  getModulePermissions: (moduleId: string) => readonly string[] | undefined,
): ScheduledAgentsModuleRegistry {
  // A module's schedule starts chats the way its conversation service's
  // `create` does, so it is held to the same ceilings: its own (`auto`, or
  // `bypass` with `conversation:bypass`), and that of the agent whose tool
  // call into the module is running, which the stored preset is pinned to.
  const capFor =
    (moduleId: string): CapPreset =>
    (preset) =>
      clampToModuleToolCaller(
        lowerToModuleCeiling(preset, getModulePermissions(moduleId)) ?? undefined,
        moduleToolCallerCeiling(),
      ) ?? null
  // Asked during a scheduled run's tool call (the run's chat, or anything it
  // started), a module's write is refused as the run's own `schedule.*` call
  // is: a module tool must not be the way round "runs don't schedule runs".
  const refusedForRun = (action: string): { ok: false; message: string } | null =>
    moduleToolCallerScheduledRun()
      ? {
          ok: false,
          message: `This was asked during a scheduled agent's run, and a scheduled run may not ${action} one.`,
        }
      : null
  return {
    create: async (moduleId, draft) =>
      refusedForRun('create') ?? service.create(draft, { ownerModuleId: moduleId, capPreset: capFor(moduleId) }),
    update: async (moduleId, id, draft) =>
      refusedForRun('change') ??
      service.update(id, draft, { ownerModuleId: moduleId, capPreset: capFor(moduleId) }),
    remove: async (moduleId, id) => refusedForRun('remove') ?? service.remove(id, { ownerModuleId: moduleId }),
    list: async (moduleId) => service.list({ ownerModuleId: moduleId }),
    runNow: async (moduleId, id) => {
      const forRun = refusedForRun('run')
      if (forRun) return forRun
      const stored = service.list({ ownerModuleId: moduleId }).find((agent) => agent.id === id)
      // Asked during a capped agent's tool call, a run that could start looser
      // than that agent is refused, as the agent's own `schedule.run` is.
      const refused = stored ? refuseScheduledAgentRun(stored.permissionPreset, moduleToolCallerCeiling()) : null
      if (refused) return { ok: false, message: refused.message }
      return service.runNow(id, { ownerModuleId: moduleId })
    },
    onChanged: (moduleId, listener) =>
      service.onChanged((agents) => listener(agents.filter((agent) => agent.ownerModuleId === moduleId))),
  }
}

/** A preset lowered to the ceiling of a module with these permissions; null (the person's own default) stays null. */
function lowerToModuleCeiling(
  preset: CliPermissionPreset | null,
  permissions: readonly string[] | undefined,
): CliPermissionPreset | null {
  const ceiling = moduleConversationCeiling(permissions ?? [])
  return preset && isLooserCliPermissionPreset(preset, ceiling) ? ceiling : preset
}

/**
 * The scheduled agent as a run starts it: one an extension made goes no looser
 * than that extension may go now, so a module updated without
 * `conversation:bypass`, or no longer installed, does not keep a `bypass`
 * schedule it was once allowed.
 */
export function withinOwnerModuleCeiling(
  agent: ScheduledAgent,
  getModulePermissions: (moduleId: string) => readonly string[] | undefined,
): ScheduledAgent {
  if (!agent.ownerModuleId) return agent
  const permissionPreset = lowerToModuleCeiling(agent.permissionPreset, getModulePermissions(agent.ownerModuleId))
  return permissionPreset === agent.permissionPreset ? agent : { ...agent, permissionPreset }
}
