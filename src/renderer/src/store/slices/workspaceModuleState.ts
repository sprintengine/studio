import type {
  SprintEngineRoleCliDefaults,
  SprintEngineState,
  SprintEngineWorkspaceContext,
} from '../../../../shared/sprintengine/run-types'
import type { Workspace, WorkspaceModuleStateBag } from '../../types/workspace'
import { normalizeSprintEngineState } from '../../utils/sprintengine'
import {
  SPRINT_ENGINE_WORKSPACE_MODULE_ID,
  type SprintEngineModuleState,
} from '../../../../shared/sprintengine/workspace-record'

export const SPRINT_ENGINE_MODULE_ID = SPRINT_ENGINE_WORKSPACE_MODULE_ID
export type { SprintEngineModuleState }

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
 * The in-tree reader for a workspace's `moduleState` bag. Same bag the SDK
 * accessors `getWorkspaceModuleState` / `setWorkspaceModuleState` address;
 * core surfaces that are not a module callback take the workspace object
 * rather than going through the host.
 */
export function getWorkspaceModuleState<T = unknown>(
  workspace: Workspace,
  moduleId: string,
): T | undefined {
  const bag = isPlainBag(workspace.moduleState) ? workspace.moduleState : undefined
  if (!bag || !(moduleId in bag)) return undefined
  return bag[moduleId] as T
}

/**
 * The Sprint Engine bag entry, unwrapping a pre-MC-2573 projection-shaped
 * value so every reader can treat `state` / `context` / `roleCliDefaults` as
 * fields of `moduleState.sprintengine`.
 */
export function getSprintEngineModuleState(
  workspace: { moduleState?: WorkspaceModuleStateBag },
): SprintEngineModuleState | undefined {
  const raw = getWorkspaceModuleState(workspace as Workspace, SPRINT_ENGINE_MODULE_ID)
  if (raw === undefined) return undefined
  return unwrapSprintEngineModuleState(raw)
}

function unwrapSprintEngineModuleState(raw: unknown): SprintEngineModuleState | undefined {
  if (!isPlainBag(raw)) return undefined
  if (isLegacySprintEngineProjectionBag(raw)) {
    return { state: raw as SprintEngineState }
  }
  const wrapped = raw as SprintEngineModuleState
  return {
    ...(wrapped.state !== undefined ? { state: wrapped.state } : {}),
    ...(wrapped.context !== undefined ? { context: wrapped.context } : {}),
    ...(wrapped.roleCliDefaults !== undefined ? { roleCliDefaults: wrapped.roleCliDefaults } : {}),
  }
}

/**
 * A pre-MC-2573 bag entry *was* the run projection: it carries the projection
 * identity fields and none of the wrapper keys. The wrapped form never has
 * `roleCounts` / `sprintEngineAgents` at the top level.
 */
function isLegacySprintEngineProjectionBag(value: WorkspaceModuleStateBag): boolean {
  if ('roleCounts' in value || 'sprintEngineAgents' in value || Array.isArray(value.tasks)) {
    return true
  }
  return false
}

function hasSprintEngineModuleContent(entry: SprintEngineModuleState): boolean {
  if (entry.state != null) return true
  if (entry.context != null) return true
  if (entry.roleCliDefaults != null && Object.keys(entry.roleCliDefaults).length > 0) return true
  return false
}

function compactSprintEngineModuleState(entry: SprintEngineModuleState): SprintEngineModuleState | null {
  const next: SprintEngineModuleState = {}
  if (entry.state != null) next.state = entry.state
  if (entry.context != null) next.context = entry.context
  if (entry.roleCliDefaults != null && Object.keys(entry.roleCliDefaults).length > 0) {
    next.roleCliDefaults = entry.roleCliDefaults
  }
  return hasSprintEngineModuleContent(next) ? next : null
}

export function withSprintEngineModuleState(
  workspace: Workspace,
  entry: SprintEngineModuleState | null,
): Workspace {
  return withWorkspaceModuleState(
    workspace,
    SPRINT_ENGINE_MODULE_ID,
    entry && hasSprintEngineModuleContent(entry) ? compactSprintEngineModuleState(entry) : null,
  )
}

/**
 * Merge a patch into the canonical `sprintengine` bag entry. Null `state` /
 * `context` / `roleCliDefaults` clear that field without dropping the others.
 */
export function patchSprintEngineModuleState(
  workspace: Workspace,
  patch: Partial<SprintEngineModuleState>,
): Workspace {
  const current = getSprintEngineModuleState(workspace) ?? {}
  const next: SprintEngineModuleState = { ...current }
  if ('state' in patch) {
    if (patch.state == null) delete next.state
    else next.state = patch.state
  }
  if ('context' in patch) {
    if (patch.context == null) delete next.context
    else next.context = patch.context
  }
  if ('roleCliDefaults' in patch) {
    if (patch.roleCliDefaults == null) delete next.roleCliDefaults
    else next.roleCliDefaults = patch.roleCliDefaults
  }
  return withSprintEngineModuleState(workspace, compactSprintEngineModuleState(next))
}

function sameSprintEngineState(
  left: SprintEngineState | null | undefined,
  right: SprintEngineState | null | undefined,
): boolean {
  return (left ?? null) === (right ?? null)
}

function sameContext(
  left: SprintEngineWorkspaceContext | null | undefined,
  right: SprintEngineWorkspaceContext | null | undefined,
): boolean {
  return (left ?? null) === (right ?? null)
}

function sameRoleCliDefaults(
  left: SprintEngineRoleCliDefaults | undefined,
  right: SprintEngineRoleCliDefaults | undefined,
): boolean {
  return left === right
}

export function sprintEngineRunState(workspace: { moduleState?: WorkspaceModuleStateBag }): SprintEngineState | null {
  return getSprintEngineModuleState(workspace)?.state ?? null
}

export function sprintEngineRunContext(workspace: { moduleState?: WorkspaceModuleStateBag }): SprintEngineWorkspaceContext | null {
  return getSprintEngineModuleState(workspace)?.context ?? null
}

export function sprintEngineRoleDefaults(workspace: { moduleState?: WorkspaceModuleStateBag }): SprintEngineRoleCliDefaults | undefined {
  return getSprintEngineModuleState(workspace)?.roleCliDefaults
}

/**
 * Run projection as stored on a persist row that may still carry the pre-hoist
 * top-level field. Callers that run on the migrate ladder before v76 use this
 * so they see HEAD-shaped rows; post-hoist readers use {@link sprintEngineRunState}.
 * Marked for deletion with the in-tree engine (extensions-installable-modules
 * 2026-08-03; dated 2026-09-16).
 */
export function legacySprintEngineRunState(
  workspace: LegacySprintEnginePersistWorkspace,
): SprintEngineState | null {
  return normalizeSprintEngineState(
    sprintEngineRunState(workspace) ?? workspace.sprintEngineState ?? null,
  )
}

export function legacySprintEngineRunContext(
  workspace: LegacySprintEnginePersistWorkspace,
): SprintEngineWorkspaceContext | null {
  return sprintEngineRunContext(workspace) ?? workspace.sprintEngineContext ?? null
}

export function legacySprintEngineRoleDefaults(
  workspace: LegacySprintEnginePersistWorkspace,
): SprintEngineRoleCliDefaults | undefined {
  return sprintEngineRoleDefaults(workspace) ?? workspace.sprintEngineRoleCliDefaults
}

/**
 * Pre-MC-2573 persist rows still carry these top-level fields. The hoist
 * below reads them once, writes `moduleState.sprintengine`, and omits them
 * from the returned workspace. Marked for deletion with the in-tree engine
 * (extensions-installable-modules 2026-08-03; dated 2026-09-16).
 */
export type LegacySprintEnginePersistWorkspace = Workspace & {
  sprintEngineState?: SprintEngineState | null
  sprintEngineContext?: SprintEngineWorkspaceContext | null
  sprintEngineRoleCliDefaults?: SprintEngineRoleCliDefaults
}

function omitLegacySprintEngineFields(workspace: LegacySprintEnginePersistWorkspace): Workspace {
  if (
    !('sprintEngineState' in workspace)
    && !('sprintEngineContext' in workspace)
    && !('sprintEngineRoleCliDefaults' in workspace)
  ) {
    return workspace
  }
  const {
    sprintEngineState: _legacyState,
    sprintEngineContext: _legacyContext,
    sprintEngineRoleCliDefaults: _legacyRoleCliDefaults,
    ...rest
  } = workspace
  return rest
}

/**
 * Hoist top-level `sprintEngineState` / `sprintEngineContext` /
 * `sprintEngineRoleCliDefaults` into `moduleState.sprintengine` and drop the
 * top-level fields. A bag-shaped (wrapped) entry wins over a top-level field
 * when both are present; a populated top-level field is adopted when the bag
 * has no value for that key (HEAD persist). Empty / non-object bags are
 * dropped. Runs in persist merge() on every hydration. Marked for deletion
 * with the in-tree engine (extensions-installable-modules 2026-08-03; dated
 * 2026-09-16).
 */
export function reconcileWorkspaceModuleState(workspace: Workspace): Workspace {
  const persisted = workspace as LegacySprintEnginePersistWorkspace
  const bag = isPlainBag(persisted.moduleState) ? persisted.moduleState : undefined
  const bagHasEntry = bag !== undefined && SPRINT_ENGINE_MODULE_ID in bag
  const rawBagEntry = bagHasEntry ? bag[SPRINT_ENGINE_MODULE_ID] : undefined
  const unwrapped = bagHasEntry ? unwrapSprintEngineModuleState(rawBagEntry) : undefined

  const canonicalState = normalizeSprintEngineState(
    (unwrapped?.state !== undefined
      ? unwrapped.state
      : persisted.sprintEngineState) as SprintEngineState | null | undefined,
  )
  const canonicalContext: SprintEngineWorkspaceContext | null =
    unwrapped?.context !== undefined
      ? (unwrapped.context ?? null)
      : (persisted.sprintEngineContext ?? null)
  const canonicalRoleCliDefaults: SprintEngineRoleCliDefaults | undefined =
    unwrapped?.roleCliDefaults !== undefined
      ? unwrapped.roleCliDefaults
      : persisted.sprintEngineRoleCliDefaults

  const nextEntry = compactSprintEngineModuleState({
    ...(canonicalState != null ? { state: canonicalState } : {}),
    ...(canonicalContext != null ? { context: canonicalContext } : {}),
    ...(canonicalRoleCliDefaults != null ? { roleCliDefaults: canonicalRoleCliDefaults } : {}),
  })

  const currentEntry = unwrapped && !isLegacySprintEngineProjectionBag(
    isPlainBag(rawBagEntry) ? rawBagEntry : {},
  )
    ? compactSprintEngineModuleState(unwrapped)
    : undefined
  const bagInSync = entriesEqual(currentEntry, nextEntry)
    && (!bagHasEntry || isPlainBag(rawBagEntry))
    && bag === persisted.moduleState
  const topLevelAbsent =
    !('sprintEngineState' in persisted)
    && !('sprintEngineContext' in persisted)
    && !('sprintEngineRoleCliDefaults' in persisted)

  if (bagInSync && topLevelAbsent) return workspace

  let next = bag === persisted.moduleState ? persisted : { ...persisted, moduleState: bag }
  next = withSprintEngineModuleState(next, nextEntry)
  return omitLegacySprintEngineFields(next)
}

function entriesEqual(
  left: SprintEngineModuleState | null | undefined,
  right: SprintEngineModuleState | null | undefined,
): boolean {
  if (left == null && right == null) return true
  if (left == null || right == null) return false
  return sameSprintEngineState(left.state, right.state)
    && sameContext(left.context, right.context)
    && sameRoleCliDefaults(left.roleCliDefaults, right.roleCliDefaults)
}

/**
 * One-time hoist of the three top-level Sprint Engine fields into
 * `moduleState.sprintengine`. Same work as {@link reconcileWorkspaceModuleState};
 * named so the persistence rung that calls it is the deletion marker for the
 * in-tree engine (extensions-installable-modules 2026-08-03; dated 2026-09-16).
 */
export function migrateSprintEngineFieldsIntoModuleBag(workspace: Workspace): Workspace {
  return reconcileWorkspaceModuleState(workspace)
}

/**
 * The bag as persisted: the live projection (`state`) is stripped — it caches
 * on-disk projection.json and persisting it re-creates the localStorage
 * write-storm the field's partialize-null fixed — while durable identity
 * (`context`, `roleCliDefaults`) survives. Every other module's entry
 * persists verbatim. An empty or non-object bag persists as absent.
 */
export function partializeWorkspaceModuleState(
  bag: WorkspaceModuleStateBag | undefined,
): WorkspaceModuleStateBag | undefined {
  if (!isPlainBag(bag)) return undefined
  if (!(SPRINT_ENGINE_MODULE_ID in bag)) return Object.keys(bag).length > 0 ? bag : undefined
  const unwrapped = unwrapSprintEngineModuleState(bag[SPRINT_ENGINE_MODULE_ID])
  const durable = unwrapped
    ? compactSprintEngineModuleState({
      ...(unwrapped.context != null ? { context: unwrapped.context } : {}),
      ...(unwrapped.roleCliDefaults != null ? { roleCliDefaults: unwrapped.roleCliDefaults } : {}),
    })
    : null
  const rest: WorkspaceModuleStateBag = { ...bag }
  if (durable) rest[SPRINT_ENGINE_MODULE_ID] = durable
  else delete rest[SPRINT_ENGINE_MODULE_ID]
  return Object.keys(rest).length > 0 ? rest : undefined
}

function isPlainBag(value: unknown): value is WorkspaceModuleStateBag {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
