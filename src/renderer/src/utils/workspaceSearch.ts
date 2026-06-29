import { getRendererHost } from '../modules'
import type { Workspace } from '../types/workspace'
import { isHiddenFromRail } from './workspaceVisibility'

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
  // Rail-hidden workspaces (the background Automations host) are never a search
  // result — they are not part of normal navigation. This holds for every query,
  // including the empty one, so search can never surface a hidden host.
  if (isHiddenFromRail(workspace)) return false
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
  if (!normalizedQuery) {
    // An empty query is not a search, but a rail-hidden host is still never a
    // navigable result. Preserve the original array reference when nothing is
    // hidden so the no-query fast path stays allocation-free.
    const visible = workspaces.filter((workspace) => !isHiddenFromRail(workspace))
    return visible.length === workspaces.length ? workspaces : visible
  }
  return workspaces.filter((workspace) => workspaceMatchesSearch(workspace, normalizedQuery))
}
