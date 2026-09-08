import type {
  DesignSystemBundleReadFailure,
  DesignSystemBundleIdentity,
} from '../../../../../../shared/design-system/bundle-view'
import { designSystemRegistrationId } from '../../../../../../shared/design-system/library'

// Pure rail model for the Design door (item 2002). Grouping, row identity, and
// search matching live here so the surface stays composition and the rules are
// testable without a DOM.
//
// Two groups, and two is the minimum that earns headings at all — `principles.md`:
// a heading must separate something from something else. `SurfaceRail` already
// hides headings when it is handed a single group, so dropping empty groups here
// is what makes "one group, no headings" fall out rather than be special-cased.

/** Where a rail row's bundle came from. */
type DesignRailGroupKey = 'project' | 'library'

/**
 * One design system in the rail.
 *
 * `id` is the row's stable selection key. A bundle attached to the open project
 * and the same bundle registered in the library are two rows for one folder, so
 * the group is part of the identity — selecting one must not light the other.
 */
export interface DesignRailEntry {
  id: string
  group: DesignRailGroupKey
  /** Absolute bundle directory. The row's real subject. */
  path: string
  /** Resolved identity, or null while a read is in flight or has failed. */
  identity: DesignSystemBundleIdentity | null
  /** Why this row cannot be read, when it cannot be. */
  failure: DesignSystemBundleReadFailure | null
  /**
   * The library registration id, for rows the registry owns.
   *
   * Absent on the attached in-project bundle: that folder is a copy inside the
   * workspace, not something the user pointed at, so there is nothing to forget.
   */
  registrationId?: string
  /**
   * Name and version last read, kept by the registry so a folder that has gone
   * missing still shows what it used to be rather than going blank.
   */
  cachedName?: string | null
  cachedVersion?: string | null
}

/**
 * Map the registry's probe result onto the reader's failure vocabulary.
 *
 * They are deliberately the same four states: the registry probes cheaply while
 * listing, the reader confirms on open, and a row must not change WHICH kind of
 * broken it is between the two.
 */
export function sourceStateFailure(
  state: 'ok' | 'missing' | 'no-manifest' | 'invalid-manifest' | 'unreadable',
): DesignSystemBundleReadFailure | null {
  return state === 'ok' ? null : state
}

const DESIGN_RAIL_GROUP_LABELS: Record<DesignRailGroupKey, string> = {
  // Sentence case: `principles.md` rejects uppercase letter-spaced labels as
  // hierarchy, on section headers and metadata alike.
  project: 'In this project',
  library: 'Library',
}

/**
 * Which project the door is SHOWING.
 *
 * The door opens from the Extensions drawer, which is global, so it used to bind
 * to whichever workspace happened to be focused last. Now the user picks, and
 * the pick persists. The order is: the stored folder while it is still there,
 * else the active workspace, else nothing (and the group is simply absent, as it
 * always was with no workspace open).
 *
 * `storedPathExists` is null while the probe is in flight, and that counts as
 * present: a folder that is merely slow to answer must not flash the door onto
 * another project and back.
 */
export function resolveDesignProjectPath(input: {
  storedPath: string | null
  storedPathExists: boolean | null
  activeWorkspaceFolderPath: string | null
}): string | null {
  const stored = input.storedPath?.trim()
  if (stored && input.storedPathExists !== false) return stored
  return input.activeWorkspaceFolderPath?.trim() || null
}

/**
 * The row id for the bundle attached to the project the door is showing.
 *
 * Keyed on the FOLDER, hashed the way the library registry keys its own
 * registrations, rather than on a workspace id: the project can now be a folder
 * the user browsed to, which no open workspace claims and which therefore has no
 * workspace id to key on.
 */
export function projectRowId(bundlePath: string): string {
  return `project:${designSystemRegistrationId(bundlePath)}`
}

/** The row id for a bundle the library knows about, keyed by its folder. */
export function libraryRowId(bundlePath: string): string {
  return `lib:${bundlePath}`
}

/**
 * The one-line state a row shows beneath its title.
 *
 * A row that cannot be read says which way it is broken and shows its path —
 * never a generic error, and never a silently dropped row. A row still loading
 * says so rather than rendering an empty line that reads as "no version".
 */
export function designRowStateLine(entry: DesignRailEntry): string {
  if (entry.failure) return designFailureLine(entry.failure, entry.path)
  if (entry.identity) return entry.identity.version
  // Registered and not yet read: show the version the registry cached rather
  // than a bare "Reading…" that loses the row's identity mid-refresh.
  return entry.cachedVersion ?? 'Reading…'
}

export function designFailureLine(
  failure: DesignSystemBundleReadFailure,
  path: string,
): string {
  switch (failure) {
    case 'missing':
      return `Folder not found · ${path}`
    case 'no-manifest':
      return `No design-system.json · ${path}`
    case 'invalid-manifest':
      return `Manifest could not be read · ${path}`
    case 'unreadable':
      return `Folder could not be read · ${path}`
  }
}

/** The title a row shows: the bundle's own name, falling back to its folder. */
export function designRowTitle(entry: DesignRailEntry): string {
  if (entry.identity) return entry.identity.name
  // The registry's cached name keeps a missing folder recognisable; the folder
  // name is the last resort so a row is never untitled.
  return entry.cachedName ?? basenameOf(entry.path)
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/**
 * Does this row survive the rail's search box?
 *
 * Matches the name and the folder path: a user who cannot remember what they
 * named a system can still find it by where it lives. A row whose identity has
 * not resolved is matched on its path alone rather than being hidden, so a
 * broken row cannot disappear behind a search.
 */
export function designRowMatchesSearch(entry: DesignRailEntry, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  if (entry.path.toLowerCase().includes(needle)) return true
  if (entry.cachedName?.toLowerCase().includes(needle)) return true
  const identity = entry.identity
  if (!identity) return false
  return (
    identity.name.toLowerCase().includes(needle) ||
    identity.summary.toLowerCase().includes(needle)
  )
}

/**
 * The rail's one narrowing axis, behind the filter glyph (the shared door
 * anatomy: project/status lenses live in the FilterMenu, never as a standing
 * Select above the rows).
 *
 * Readable-vs-broken is a real axis here rather than a decorative one: a folder
 * that moved, lost its manifest, or will not parse stays in the rail as a named
 * broken row, so "show me only the ones that need fixing" is a question the list
 * can actually answer.
 */
export type DesignRailStatusFilter = 'all' | 'readable' | 'broken'

export const DESIGN_RAIL_STATUS_ITEMS: ReadonlyArray<{
  value: DesignRailStatusFilter
  label: string
}> = [
  { value: 'all', label: 'All' },
  { value: 'readable', label: 'Readable' },
  { value: 'broken', label: 'Needs attention' },
]

function designRowMatchesStatus(
  entry: DesignRailEntry,
  status: DesignRailStatusFilter,
): boolean {
  if (status === 'all') return true
  // A row still being read is neither yet. Keep it under "readable" so rows do
  // not flicker out of the list and back while their reads land.
  if (status === 'broken') return entry.failure !== null
  return entry.failure === null
}

export interface DesignRailGroup {
  key: DesignRailGroupKey
  label: string
  entries: DesignRailEntry[]
}

/**
 * Group the rail's entries, dropping any group with no rows.
 *
 * Dropping empties is load-bearing: `SurfaceRail` hides its headings when it is
 * handed fewer than two groups, so an empty library leaves "In this project" as
 * the only group and both headings correctly disappear.
 */
export function buildDesignRailGroups(
  entries: readonly DesignRailEntry[],
  search: string,
  status: DesignRailStatusFilter = 'all',
): DesignRailGroup[] {
  const matching = entries.filter(
    (entry) => designRowMatchesSearch(entry, search) && designRowMatchesStatus(entry, status),
  )
  const order: DesignRailGroupKey[] = ['project', 'library']
  return order
    .map((key) => ({
      key,
      label: DESIGN_RAIL_GROUP_LABELS[key],
      entries: matching.filter((entry) => entry.group === key),
    }))
    .filter((group) => group.entries.length > 0)
}
