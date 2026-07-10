/**
 * Renderer subscription + one-time hydration for the main-owned Sprint Engine
 * automation mode intent (MC-1567). Mounted once from `WorkspaceManager`.
 *
 * Jobs:
 *
 * 1. **Subscribe**: apply authoritative `sprintengine:automation-changed`
 *    broadcasts (any writer — another window, the phone, a future scheduler)
 *    into the workspace store through the exact `user_set_mode` reducer
 *    transition a local click takes. This window's own echoes are dropped by
 *    client token; broadcasts racing an outstanding local push are deferred
 *    and superseded by the push response (see the intent client's ordering
 *    model); a broadcast whose mode already matches the local derived mode is
 *    a revision-only no-op — re-applying `user_set_mode` is not free (it
 *    would flip a paused run back to running).
 *
 * 2. **Hydrate**: for each sprint workspace (statePath) seen this session,
 *    seed main's sidecar from the legacy renderer-persisted value when no
 *    sidecar exists, or adopt main's value when it exists and differs (e.g. a
 *    phone write landed while this window was closed). Failures (team dir not
 *    created yet, IPC hiccup) are retried on later sweeps — a statePath is
 *    only marked done on success.
 *
 * 3. **Reconcile late workspaces**: a broadcast can arrive before this
 *    window's projection load materializes the workspace. The event is
 *    stashed and applied by the sweep once the workspace exists, so the
 *    window can never be left showing a stale mode.
 */
import type { SprintEngineAutomationChangedEvent } from '../../../shared/electron-api'
import { useWorkspaceStore } from '../store/workspaceStore'
import { deriveSprintEngineAutomationMode } from './sprintengineAutomation'
import {
  SPRINT_ENGINE_AUTOMATION_CLIENT_TOKEN,
  hasOutstandingSprintEngineAutomationPush,
  isStaleSprintEngineAutomationRevision,
  noteAppliedSprintEngineAutomationRevision,
  setSprintEngineAutomationPushSettledListener,
} from './sprintengineAutomationIntentClient'

type SprintWorkspaceRef = {
  workspaceId: string
  statePath: string
}

function listSprintWorkspaceRefs(): SprintWorkspaceRef[] {
  return useWorkspaceStore.getState().workspaces.flatMap((workspace) => {
    const statePath = workspace.sprintEngineContext?.statePath
    if (!statePath || !workspace.sprintEngineState) return []
    return [{ workspaceId: workspace.id, statePath }]
  })
}

function findWorkspaceIdForStatePath(statePath: string): string | null {
  return listSprintWorkspaceRefs().find((ref) => ref.statePath === statePath)?.workspaceId ?? null
}

/**
 * Adopt an authoritative mode into the local store. `suppressMainSync` stops
 * the store action from pushing the value straight back to main (the no-echo
 * rule); the manual audit is main's job on the original write, never the
 * subscriber's. Same-mode records only advance the applied-revision floor.
 */
function adoptAuthoritativeRecord(workspaceId: string, event: SprintEngineAutomationChangedEvent): void {
  const store = useWorkspaceStore.getState()
  const workspace = store.workspaces.find((ws) => ws.id === workspaceId)
  if (!workspace) return
  noteAppliedSprintEngineAutomationRevision(event.statePath, event.record.revision)
  const currentMode = deriveSprintEngineAutomationMode(workspace.sprintEngineAutoState)
  if (currentMode === event.record.desiredMode) return
  store.setSprintEngineAutomationMode(workspaceId, event.record.desiredMode, {
    suppressMainSync: true,
    suppressManualAudit: true,
  })
}

/** Returns true when the statePath is fully hydrated (stop retrying). */
async function hydrateStatePath(ref: SprintWorkspaceRef): Promise<boolean> {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.readSprintEngineAutomationMode) return true
  const store = useWorkspaceStore.getState()
  const workspace = store.workspaces.find((ws) => ws.id === ref.workspaceId)
  if (!workspace) return false
  const localMode = deriveSprintEngineAutomationMode(workspace.sprintEngineAutoState)

  const read = await api.readSprintEngineAutomationMode({ statePath: ref.statePath }).catch(() => null)
  if (!read?.ok) return false

  if (read.record) {
    // Adopt whatever main holds — the applied-revision floor only tracks what
    // this window has applied, so it must not veto a first-load adoption.
    adoptAuthoritativeRecord(ref.workspaceId, { statePath: ref.statePath, record: read.record })
    return true
  }

  // No sidecar yet: seed it from the legacy renderer-persisted value. Main
  // accepts the first hydration only, so concurrent windows cannot fork it.
  const hydrated = await api.hydrateSprintEngineAutomationMode({
    statePath: ref.statePath,
    mode: localMode,
  }).catch(() => null)
  if (!hydrated?.ok) return false
  noteAppliedSprintEngineAutomationRevision(ref.statePath, hydrated.record.revision)
  if (hydrated.record.desiredMode !== localMode) {
    // Another window hydrated first with a different value; adopt it.
    adoptAuthoritativeRecord(ref.workspaceId, { statePath: ref.statePath, record: hydrated.record })
  }
  return true
}

/**
 * Start the subscription + hydration sweep. Returns a dispose function.
 * WorkspaceManager owns exactly one instance per window.
 */
export function initSprintEngineAutomationModeSync(): () => void {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.onSprintEngineAutomationChanged) return () => undefined

  const hydratedStatePaths = new Set<string>()
  // Latest authoritative record that could not be applied on arrival (no
  // matching workspace yet, or a local push in flight). Replayed by the sweep
  // and by the push-settled reconciliation.
  const pendingEventByStatePath = new Map<string, SprintEngineAutomationChangedEvent>()

  const tryApply = (event: SprintEngineAutomationChangedEvent): void => {
    if (isStaleSprintEngineAutomationRevision(event.statePath, event.record.revision)) {
      pendingEventByStatePath.delete(event.statePath)
      return
    }
    if (hasOutstandingSprintEngineAutomationPush(event.statePath)) {
      // Defer: main serializes writes per run, so our push's response record
      // supersedes this event; reconciliation happens on push settle.
      pendingEventByStatePath.set(event.statePath, event)
      return
    }
    const workspaceId = findWorkspaceIdForStatePath(event.statePath)
    if (!workspaceId) {
      // Workspace not materialized in this window yet (projection still
      // loading). Keep the event for the sweep; do NOT note the revision —
      // only applied revisions may advance the floor.
      pendingEventByStatePath.set(event.statePath, event)
      return
    }
    pendingEventByStatePath.delete(event.statePath)
    // An authoritative record exists, so the sidecar is seeded — hydration
    // for this statePath is moot from here on.
    hydratedStatePaths.add(event.statePath)
    adoptAuthoritativeRecord(workspaceId, event)
  }

  const unsubscribeBroadcast = api.onSprintEngineAutomationChanged((event) => {
    if (event.sourceClientToken === SPRINT_ENGINE_AUTOMATION_CLIENT_TOKEN) {
      // Our own echo: the local store already holds this state and the push
      // response records the revision; nothing to apply.
      pendingEventByStatePath.delete(event.statePath)
      return
    }
    tryApply(event)
  })

  setSprintEngineAutomationPushSettledListener(({ statePath, record }) => {
    // The push response is the newest authoritative state for this run at
    // this moment; it supersedes anything deferred while the push flew.
    pendingEventByStatePath.delete(statePath)
    if (!record) return
    if (hasOutstandingSprintEngineAutomationPush(statePath)) return
    const workspaceId = findWorkspaceIdForStatePath(statePath)
    if (!workspaceId) return
    hydratedStatePaths.add(statePath)
    adoptAuthoritativeRecord(workspaceId, { statePath, record })
  })

  const hydrationInFlight = new Set<string>()
  const sweep = (): void => {
    // Replay stashed broadcasts whose workspace has since materialized.
    for (const event of [...pendingEventByStatePath.values()]) {
      tryApply(event)
    }
    for (const ref of listSprintWorkspaceRefs()) {
      if (hydratedStatePaths.has(ref.statePath) || hydrationInFlight.has(ref.statePath)) continue
      hydrationInFlight.add(ref.statePath)
      void hydrateStatePath(ref)
        .then((done) => {
          if (done) hydratedStatePaths.add(ref.statePath)
        })
        .finally(() => {
          hydrationInFlight.delete(ref.statePath)
        })
    }
  }

  sweep()
  const unsubscribeStore = useWorkspaceStore.subscribe(sweep)

  return () => {
    unsubscribeBroadcast()
    unsubscribeStore()
    setSprintEngineAutomationPushSettledListener(null)
  }
}
