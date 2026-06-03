import type { Workspace } from '../types/workspace'

export function normalizeWorkspaceSearchQuery(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function normalizeSearchField(value: string | null | undefined): string {
  return (value ?? '').toLocaleLowerCase()
}

function workspaceModeLabel(mode: Workspace['mode']): string {
  if (mode === 'guided-brief') return 'guided brief'
  if (mode === 'sprintengine') return 'sprint engine sprintengine'
  return mode
}

export function workspaceMatchesSearch(workspace: Workspace, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true
  const folderPath = normalizeSearchField(workspace.folderPath)
  const folderName = folderPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? ''
  const searchableFields = [
    workspace.name,
    workspaceModeLabel(workspace.mode),
    folderPath,
    folderName,
  ]

  return searchableFields.some((field) => normalizeSearchField(field).includes(normalizedQuery))
}

export function filterWorkspacesBySearchQuery(workspaces: Workspace[], query: string): Workspace[] {
  const normalizedQuery = normalizeWorkspaceSearchQuery(query)
  if (!normalizedQuery) return workspaces
  return workspaces.filter((workspace) => workspaceMatchesSearch(workspace, normalizedQuery))
}
