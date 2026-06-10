import { getRendererHost } from '../modules'
import type { Workspace } from '../types/workspace'

export function normalizeWorkspaceSearchQuery(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function normalizeSearchField(value: string | null | undefined): string {
  return (value ?? '').toLocaleLowerCase()
}

// Search match terms for a workspace mode come from its registered type
// definition (label + searchTerms); a shell-owned/unknown mode falls back to the
// raw id. Comparison lower-cases fields, so casing here is irrelevant.
function workspaceModeLabel(mode: Workspace['mode']): string {
  const definition = getRendererHost().getWorkspaceType(mode)
  if (!definition) return mode
  return [definition.label, ...(definition.searchTerms ?? [])].join(' ')
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
