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
import type { SprintEngineAutomationChangedEvent } from '../../../shared/sprintengine/ipc-types'
import type { SprintEngineAutomationIntentRecord } from '../../../shared/sprintengine/automation-intent'
import type { SprintEngineCliPermissionPreset } from '../types/workspace'
import { useWorkspaceStore } from '../store/workspaceStore'
import { deriveSprintEngineAutomationMode } from './sprintengineAutomation'
import {
  SPRINT_ENGINE_AUTOMATION_CLIENT_TOKEN,
  hasOutstandingSprintEngineAutomationPush,
  isStaleSprintEngineAutomationRevision,
  noteAppliedSprintEngineAutomationRevision,
  setSprintEngineAutomationPushSettledListener,
} from './sprintengineAutomationIntentClient'
import { isSprintEngineIpcBound, sprintEngineIpc } from '../modules/sprint-engine-ipc'

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
 * Adopt an authoritative record into the local store: the mode, and the CLI
 * permission preset that shares it. `suppressMainSync` stops the store action
 * from pushing the mode straight back to main (the no-echo rule); the manual
 * audit is main's job on the original write, never the subscriber's. Same-mode
 * records only advance the applied-revision floor.
 */
function adoptAuthoritativeRecord(workspaceId: string, event: SprintEngineAutomationChangedEvent): void {
  const store = useWorkspaceStore.getState()
  const workspace = store.workspaces.find((ws) => ws.id === workspaceId)
  if (!workspace) return
  noteAppliedSprintEngineAutomationRevision(event.statePath, event.record.revision)
  adoptAuthoritativeCliPermissionPreset(store, workspaceId, workspace, event.record)
  const currentMode = deriveSprintEngineAutomationMode(workspace.sprintEngineAutoState)
  if (currentMode === event.record.desiredMode) return
  store.setSprintEngineAutomationMode(workspaceId, event.record.desiredMode, {
    suppressMainSync: true,
    suppressManualAudit: true,
  })
}

/**
 * The preset half of the same record (MC-1799). It is written by statePath —
 * from the Sprints door, which has no workspace to write through, or from
 * another window — but it is read at spawn from this window's workspace record
 * (`buildRegistration` in `sprintengineRuntimeBridge.ts`). Without this the
 * door's control would persist a preset that nothing ever spawns with, and a
 * workspace attaching afterwards would silently keep its own stale value.
 *
 * Ahead of the mode's early return on purpose: a preset write does not change
 * the mode, so a same-mode record is exactly the shape this arrives in.
 *
 * The store action pushes the adopted value back to main; that write is the
 * value main already holds, and `setCliPermissionPreset` answers a same-preset
 * write with no revision bump and no broadcast, so the echo dies there.
 */
function adoptAuthoritativeCliPermissionPreset(
  store: Pick<ReturnType<typeof useWorkspaceStore.getState>, 'setSprintEngineCliPermissionPreset'>,
  workspaceId: string,
  workspace: { sprintEngineAutoState?: { cliPermissionPreset?: SprintEngineCliPermissionPreset } },
  record: SprintEngineAutomationIntentRecord,
): void {
  // Absent means "never set" (every record written before MC-1799, and every
  // run whose preset was never touched) — the workspace's own value stands.
  const preset = record.cliPermissionPreset
  if (!preset) return
  if (workspace.sprintEngineAutoState?.cliPermissionPreset === preset) return
  store.setSprintEngineCliPermissionPreset(workspaceId, preset)
}

/** Returns true when the statePath is fully hydrated (stop retrying). */
async function hydrateStatePath(ref: SprintWorkspaceRef): Promise<boolean> {
  if (!isSprintEngineIpcBound()) return true
  const store = useWorkspaceStore.getState()
  const workspace = store.workspaces.find((ws) => ws.id === ref.workspaceId)
  if (!workspace) return false
  const localMode = deriveSprintEngineAutomationMode(workspace.sprintEngineAutoState)

  const read = await sprintEngineIpc.readSprintEngineAutomationMode({ statePath: ref.statePath }).catch(() => null)
  if (!read?.ok) return false

  if (read.record) {
    // Adopt whatever main holds — the applied-revision floor only tracks what
    // this window has applied, so it must not veto a first-load adoption.
    adoptAuthoritativeRecord(ref.workspaceId, { statePath: ref.statePath, record: read.record })
    return true
  }

  // No sidecar yet: seed it from the legacy renderer-persisted value. Main
  // accepts the first hydration only, so concurrent windows cannot fork it.
  const hydrated = await sprintEngineIpc.hydrateSprintEngineAutomationMode({
    statePath: ref.statePath,
    mode: localMode,
  }).catch(() => null)
  if (!hydrated?.ok) return false
  // Adopt unconditionally: main returns the existing record when one appeared
  // between the read above and this call, and that record can differ from our
  // seed in EITHER half — a different mode from a window that hydrated first,
  // or a preset from a Sprints-door write. Adoption is a no-op per half when
  // that half already matches, so the old same-mode short-circuit only risked
  // dropping the other one.
  adoptAuthoritativeRecord(ref.workspaceId, { statePath: ref.statePath, record: hydrated.record })
  return true
}

/**
 * Start the subscription + hydration sweep. Returns a dispose function.
 * WorkspaceManager owns exactly one instance per window.
 */
export function initSprintEngineAutomationModeSync(): () => void {
  if (!isSprintEngineIpcBound()) return () => undefined

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

  const unsubscribeBroadcast = sprintEngineIpc.onSprintEngineAutomationChanged((event) => {
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
