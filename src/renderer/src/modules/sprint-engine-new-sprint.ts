import { useWorkspaceStore } from '../store/workspaceStore'
import { releaseSprintCreationDoorClaim } from '../components/workspace/globalSurface/sprints/sprintDoorRequests'
import type { FuturePlanWorkspaceSource } from '../types/workspace'
import { SPRINT_ENGINE_NEW_MODAL_ID, type NewSprintOpenArgs } from './sprint-engine-commands'

// Pending New-sprint payload. The modal body reads this for its whole
// visit (so a Strict-Mode remount still sees the source) and the shell
// clears it when the modal surface id leaves `sprint-engine-new`.

export type PendingNewSprint = {
  folderPath: string | null
  source: FuturePlanWorkspaceSource | null
}

let pendingNewSprint: PendingNewSprint | null = null

export function noteNewSprintRequest(initial?: NewSprintOpenArgs): void {
  pendingNewSprint = {
    folderPath: initial?.source?.folderPath ?? initial?.folderPath ?? null,
    source: initial?.source ?? null,
  }
}

export function readNewSprintRequest(): PendingNewSprint {
  return pendingNewSprint ?? { folderPath: null, source: null }
}

export function clearNewSprintRequest(): void {
  pendingNewSprint = null
}

export function openSprintEngineNewSprint(initial?: NewSprintOpenArgs): void {
  const store = useWorkspaceStore.getState()
  const active = store.workspaces.find((workspace) => workspace.id === store.activeWorkspaceId)
  noteNewSprintRequest({
    folderPath: initial?.source?.folderPath ?? initial?.folderPath ?? active?.folderPath ?? null,
    source: initial?.source ?? null,
  })
  // Opening releases whatever claim came before: the dialog now on screen is
  // the one this caller opened, and a door re-claims immediately after.
  releaseSprintCreationDoorClaim()
  store.closeGlobalSurface()
  store.openModalSurface(SPRINT_ENGINE_NEW_MODAL_ID)
}
