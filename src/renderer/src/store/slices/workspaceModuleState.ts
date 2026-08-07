import type { SprintEngineState } from '../../../../shared/sprintengine/run-types'
import type { Workspace, WorkspaceModuleStateBag } from '../../types/workspace'
import { normalizeSprintEngineState } from '../../utils/sprintengine'
// The bundled Sprint Engine module's bag key (MC-1573). Defined in shared with
// MC-2160 because main writes the same bag entry when it composes a sprint
// workspace headlessly; re-exported here so renderer import sites are unchanged.
import { SPRINT_ENGINE_WORKSPACE_MODULE_ID } from '../../../../shared/sprintengine/workspace-record'

export const SPRINT_ENGINE_MODULE_ID = SPRINT_ENGINE_WORKSPACE_MODULE_ID

/**
 * A workspace's state entry for one module, from the per-module bag.
 * `undefined` means the module has recorded no state on this workspace.
 */
export function readWorkspaceModuleState(workspace: Workspace, moduleId: string): unknown {
  const bag = workspace.moduleState
  if (!isPlainBag(bag)) return undefined
  return bag[moduleId]
}

/**
 * Pure update: a workspace whose bag entry for `moduleId` is `state`.
 * `undefined`/`null` removes the entry (absence and null both read back as "no
 * state"; storing them would only bloat the persisted registry). Returns the
 * input workspace when nothing changes, so no-op writes keep reference
 * identity for subscribers.
 */
export function withWorkspaceModuleState(
  workspace: Workspace,
  moduleId: string,
  state: unknown,
): Workspace {
  const bag = isPlainBag(workspace.moduleState) ? workspace.moduleState : undefined
  if (state === undefined || state === null) {
    if (!bag || !(moduleId in bag)) {
      return bag === workspace.moduleState ? workspace : { ...workspace, moduleState: bag }
    }
    const { [moduleId]: _removed, ...rest } = bag
    return { ...workspace, moduleState: Object.keys(rest).length > 0 ? rest : undefined }
  }
  if (bag && bag[moduleId] === state) return workspace
  return { ...workspace, moduleState: { ...bag, [moduleId]: state } }
}

/**
 * Enforce the MC-1573 lockstep invariant on one workspace:
 * `moduleState.sprintengine` (canonical) and the legacy `sprintEngineState`
 * mirror hold the same normalized run state, and a non-object bag is dropped.
 *
 * When the bag carries a `sprintengine` entry it wins; otherwise a populated
 * legacy field (pre-bag persisted rows, hand-built fixtures) is adopted into
 * the bag. Runs in the persist merge() on every hydration — version-gated
 * migrations alone don't survive the dev-HMR current-version-envelope trap —
 * and returns the input workspace untouched when the invariant already holds.
 */
export function reconcileWorkspaceModuleState(workspace: Workspace): Workspace {
  const bag = isPlainBag(workspace.moduleState) ? workspace.moduleState : undefined
  const bagHasEntry = bag !== undefined && SPRINT_ENGINE_MODULE_ID in bag
  // A bag entry that is not a plain object (hand-edited string, array) is
  // corrupt, not a run state: treat it as null so normalizeSprintEngineState
  // never launders it into a minted-looking empty run. The entry then reads
  // as "no state" and the heal below removes it.
  const rawBagEntry = bagHasEntry ? bag[SPRINT_ENGINE_MODULE_ID] : undefined
  const canonical = normalizeSprintEngineState(
    (bagHasEntry
      ? (isPlainBag(rawBagEntry) ? rawBagEntry : null)
      : workspace.sprintEngineState) as SprintEngineState | null | undefined,
  )

  const mirrorInSync = (workspace.sprintEngineState ?? null) === canonical
  const bagInSync = canonical === null
    ? !bagHasEntry
    : bag !== undefined && bag[SPRINT_ENGINE_MODULE_ID] === canonical
  if (mirrorInSync && bagInSync && bag === workspace.moduleState) return workspace

  const next = withWorkspaceModuleState(
    bag === workspace.moduleState ? workspace : { ...workspace, moduleState: bag },
    SPRINT_ENGINE_MODULE_ID,
    canonical,
  )
  if ((next.sprintEngineState ?? null) === canonical) return next
  return { ...next, sprintEngineState: canonical }
}

/**
 * The bag as persisted: the `sprintengine` entry is stripped (it caches the
 * on-disk projection.json — persisting it re-creates the localStorage
 * write-storm the field's partialize-null fixed), every other module's entry
 * survives verbatim. An empty or non-object bag persists as absent.
 */
export function partializeWorkspaceModuleState(
  bag: WorkspaceModuleStateBag | undefined,
): WorkspaceModuleStateBag | undefined {
  if (!isPlainBag(bag)) return undefined
  if (!(SPRINT_ENGINE_MODULE_ID in bag)) return Object.keys(bag).length > 0 ? bag : undefined
  const { [SPRINT_ENGINE_MODULE_ID]: _stripped, ...rest } = bag
  return Object.keys(rest).length > 0 ? rest : undefined
}

// Persisted data is untrusted: a hand-edited or corrupted envelope can carry
// an array/string where the bag should be. Only a plain object is a bag.
function isPlainBag(value: unknown): value is WorkspaceModuleStateBag {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
