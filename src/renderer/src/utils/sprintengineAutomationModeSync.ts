/**
 * Renderer subscription + one-time hydration for the main-owned Sprint Engine
 * automation mode intent (MC-1567). Mounted once from `WorkspaceManager`.
 *
 * Two jobs:
 *
 * 1. **Subscribe**: apply authoritative `sprintengine:automation-changed`
 *    broadcasts (any writer — this window, another window, the phone, a future
 *    scheduler) into the workspace store through the exact `user_set_mode`
 *    reducer transition a local click takes. Stale/echo revisions are dropped,
 *    and a broadcast whose mode already matches the local derived mode is a
 *    revision-only no-op — re-applying `user_set_mode` is not free (it would
 *    flip a paused run back to running).
 *
 * 2. **Hydrate**: the first time a sprint workspace (statePath) is seen this
 *    session, seed main's sidecar from the legacy renderer-persisted value when
 *    no sidecar exists yet, or adopt main's value when it does and differs
 *    (e.g. a phone write landed while this window was closed).
 */
import type { SprintEngineAutomationChangedEvent } from '../../../shared/electron-api'
import { useWorkspaceStore } from '../store/workspaceStore'
import { deriveSprintEngineAutomationMode } from './sprintengineAutomation'
import {
  isStaleSprintEngineAutomationRevision,
  noteSprintEngineAutomationRevision,
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
 * subscriber's.
 */
function adoptAuthoritativeMode(workspaceId: string, event: SprintEngineAutomationChangedEvent): void {
  const store = useWorkspaceStore.getState()
  const workspace = store.workspaces.find((ws) => ws.id === workspaceId)
  if (!workspace) return
  noteSprintEngineAutomationRevision(event.statePath, event.record.revision)
  const currentMode = deriveSprintEngineAutomationMode(workspace.sprintEngineAutoState)
  if (currentMode === event.record.desiredMode) return
  store.setSprintEngineAutomationMode(workspaceId, event.record.desiredMode, {
    suppressMainSync: true,
    suppressManualAudit: true,
  })
}

async function hydrateStatePath(ref: SprintWorkspaceRef): Promise<void> {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.readSprintEngineAutomationMode) return
  const store = useWorkspaceStore.getState()
  const workspace = store.workspaces.find((ws) => ws.id === ref.workspaceId)
  if (!workspace) return
  const localMode = deriveSprintEngineAutomationMode(workspace.sprintEngineAutoState)

  const read = await api.readSprintEngineAutomationMode({ statePath: ref.statePath }).catch(() => null)
  if (!read?.ok) return

  if (read.record) {
    if (isStaleSprintEngineAutomationRevision(ref.statePath, read.record.revision)) return
    adoptAuthoritativeMode(ref.workspaceId, { statePath: ref.statePath, record: read.record })
    return
  }

  // No sidecar yet: seed it from the legacy renderer-persisted value. Main
  // accepts the first hydration only, so concurrent windows cannot fork it.
  const hydrated = await api.hydrateSprintEngineAutomationMode({
    statePath: ref.statePath,
    mode: localMode,
  }).catch(() => null)
  if (hydrated?.ok) {
    noteSprintEngineAutomationRevision(ref.statePath, hydrated.record.revision)
    if (hydrated.record.desiredMode !== localMode) {
      // Another window hydrated first with a different value; adopt it.
      adoptAuthoritativeMode(ref.workspaceId, { statePath: ref.statePath, record: hydrated.record })
    }
  }
}

/**
 * Start the subscription + hydration sweep. Returns a dispose function.
 * Idempotent per mount; WorkspaceManager owns exactly one instance.
 */
export function initSprintEngineAutomationModeSync(): () => void {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.onSprintEngineAutomationChanged) return () => undefined

  const hydratedStatePaths = new Set<string>()

  const unsubscribeBroadcast = api.onSprintEngineAutomationChanged((event) => {
    if (isStaleSprintEngineAutomationRevision(event.statePath, event.record.revision)) return
    hydratedStatePaths.add(event.statePath)
    const workspaceId = findWorkspaceIdForStatePath(event.statePath)
    if (!workspaceId) {
      // No matching workspace in this window (moved away / not yet loaded):
      // still record the revision so a later hydration doesn't regress.
      noteSprintEngineAutomationRevision(event.statePath, event.record.revision)
      return
    }
    adoptAuthoritativeMode(workspaceId, event)
  })

  const sweep = (): void => {
    for (const ref of listSprintWorkspaceRefs()) {
      if (hydratedStatePaths.has(ref.statePath)) continue
      hydratedStatePaths.add(ref.statePath)
      void hydrateStatePath(ref)
    }
  }

  sweep()
  const unsubscribeStore = useWorkspaceStore.subscribe(sweep)

  return () => {
    unsubscribeBroadcast()
    unsubscribeStore()
  }
}
