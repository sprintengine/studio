import { getRendererHost } from '../modules'
import type { Workspace } from '../types/workspace'

// Pure search logic for the global-search palette (CommandPalette.tsx), split
// out so the query matching and workspace-keyword derivation can be unit-tested
// without rendering the palette. Keeping these here is also what preserves the
// mode-label/searchTerms matching the retired sidebar "Search workspaces" box
// used to own (see workspaceSearchKeywords below).

/** The fields a palette command exposes to the query filter. `keywords` is
 *  searched but never displayed — it carries a workspace's type label and
 *  curated search terms so those match without crowding the visible row. */
export interface CommandSearchFields {
  label: string
  description?: string
  keywords?: string
}

/** True when the (case-insensitive, trimmed) query appears in the command's
 *  label, description, or hidden keyword text. An empty query matches every
 *  command, which is how the palette shows its no-query preview. */
export function commandMatchesQuery(command: CommandSearchFields, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return (
    command.label.toLowerCase().includes(normalized) ||
    (command.description?.toLowerCase().includes(normalized) ?? false) ||
    (command.keywords?.toLowerCase().includes(normalized) ?? false)
  )
}

/** A workspace type's label + curated search terms joined into one match
 *  string. Pure over the definition so it is directly testable; an
 *  unregistered/shell mode falls back to the raw mode id. */
export function workspaceKeywordsFromDefinition(
  definition: { label: string; searchTerms?: readonly string[] } | null | undefined,
  fallbackId: string,
): string {
  if (!definition) return fallbackId
  return [definition.label, ...(definition.searchTerms ?? [])].join(' ')
}

/** The keyword match string for a workspace's mode, resolved against the live
 *  workspace-type registry — mirrors the matching the deleted workspaceSearch
 *  util provided so typing a mode name ("sprint engine", "roster", "cron")
 *  still surfaces its workspaces in the palette. */
export function workspaceSearchKeywords(mode: Workspace['mode']): string {
  return workspaceKeywordsFromDefinition(getRendererHost().getWorkspaceType(mode), mode)
}
