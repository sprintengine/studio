import type { WorkspaceModuleStateBag } from '../../types/workspace'

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
