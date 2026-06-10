import type { CreationMode } from './types'

export type WorkspaceFolderHint = {
  hasSprintEngineTeam?: boolean
  hasMultiloop?: boolean
}

export type FolderHintModuleEnablement = {
  sprintEngineEnabled: boolean
  multiloopEnabled: boolean
}

// A folder carrying a saved Sprint Engine team or Multiloop marker can pre-select
// that mode when the user picks the folder — but never into a module the user has
// disabled, which would strand the wizard on a hidden mode. Sprint Engine takes
// precedence when both markers are present; if its module is disabled the
// Multiloop marker is still honoured when Multiloop is enabled.
export function folderHintAutoSelectMode(
  hint: WorkspaceFolderHint | null | undefined,
  { sprintEngineEnabled, multiloopEnabled }: FolderHintModuleEnablement,
): CreationMode | null {
  if (hint?.hasSprintEngineTeam && sprintEngineEnabled) return 'sprintengine'
  if (hint?.hasMultiloop && multiloopEnabled) return 'multiloop'
  return null
}
