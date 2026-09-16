import type { Workspace, WorkspaceModuleStateBag } from '../../types/workspace'

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
 * The bag as persisted: every module's entry persists verbatim, and an empty
 * or non-object bag persists as absent. A module whose entry is a cache rather
 * than durable state keeps it out of the bag in the first place.
 */
export function partializeWorkspaceModuleState(
  bag: WorkspaceModuleStateBag | undefined,
): WorkspaceModuleStateBag | undefined {
  if (!isPlainBag(bag)) return undefined
  return Object.keys(bag).length > 0 ? bag : undefined
}

function isPlainBag(value: unknown): value is WorkspaceModuleStateBag {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
