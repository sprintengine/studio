import type { FileActionContext, RegisteredFileAction } from '../../modules/renderer-host'

// Module-contributed Files-tree actions belong under a heading named for the
// module, never as core rows gated on enablement (epic rule: an entry point is
// a contribution, gone with the module). `order` then label is the sequence
// within a group; groups sort by module id so the menu reads the same across
// reloads.

export type FileExplorerModuleActionEntry = {
  id: string
  moduleId: string
  moduleLabel: string
  label: string
  order?: number
  disabled: boolean
}

export type FileExplorerModuleActionGroup = {
  moduleId: string
  heading: string
  actions: FileExplorerModuleActionEntry[]
}

function sortByOrderThenLabel(actions: readonly FileExplorerModuleActionEntry[]): FileExplorerModuleActionEntry[] {
  return [...actions].sort((a, b) => {
    const order = (a.order ?? 100) - (b.order ?? 100)
    return order === 0 ? a.label.localeCompare(b.label) : order
  })
}

export function groupFileExplorerModuleActions(
  actions: ReadonlyArray<FileExplorerModuleActionEntry>,
): FileExplorerModuleActionGroup[] {
  if (actions.length === 0) return []
  const byModule = new Map<string, FileExplorerModuleActionEntry[]>()
  const labels = new Map<string, string>()
  for (const action of actions) {
    labels.set(action.moduleId, action.moduleLabel)
    const members = byModule.get(action.moduleId) ?? []
    members.push(action)
    byModule.set(action.moduleId, members)
  }
  return [...byModule.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([moduleId, members]) => ({
      moduleId,
      heading: labels.get(moduleId) ?? moduleId,
      actions: sortByOrderThenLabel(members),
    }))
}

export function visibleFileExplorerModuleActions(input: {
  actions: readonly RegisteredFileAction[]
  moduleEnabled: (moduleId: string) => boolean
  moduleLabel: (moduleId: string) => string
  context: FileActionContext
}): FileExplorerModuleActionEntry[] {
  return input.actions
    .filter((action) => input.moduleEnabled(action.moduleId))
    .filter((action) => (action.isVisible ? action.isVisible(input.context) : true))
    .map((action) => ({
      id: action.id,
      moduleId: action.moduleId,
      moduleLabel: input.moduleLabel(action.moduleId),
      label: action.getLabel?.(input.context) ?? action.label,
      order: action.order,
      disabled: action.getState?.(input.context) === 'disabled',
    }))
}
