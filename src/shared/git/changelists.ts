// Changelists — the app's own grouping of a repository's changed files (epic
// `git-commit-window`, T6; mockup 2522 panel 2).
//
// A CHANGELIST IS OURS, NOT GIT'S. Git has an index and nothing else; an IDE
// has changelists, and a decade of developers reach for them to keep two pieces
// of work apart in one working tree. So this is a named set of repo-relative
// paths, stored by the app per repository, and the index is NEVER consulted to
// build one. The checkbox on a row still means "staged"; which list a row sits
// in says nothing about whether it will be committed.
//
// The four rules everything below enforces, and the reason each exists:
//
//   ONE DEFAULT, UNDELETABLE. `Changes` is where a repository starts and where
//   a deleted list's paths return to. A model that could delete it would need a
//   second answer to "where does this path live now", and there isn't one.
//
//   EXACTLY ONE ACTIVE. New changes land in the active list, so "none active"
//   loses them and "two active" is a coin flip. `normalizeChangelists` is
//   therefore not a validator that reports — it REPAIRS, on every read and
//   after every write, so a half-applied rename/delete race cannot leave two.
//
//   A PATH IS IN AT MOST ONE LIST. Membership is explicit: every changed path
//   is written into exactly one list, including the default. The alternative —
//   the default holding no paths and meaning "everything unclaimed" — cannot
//   tell a file that has always been in Changes from one that appeared this
//   second, which is exactly the distinction "new changes land in the active
//   list" is made of.
//
//   THE LISTS FOLLOW STATUS. A path git no longer reports is pruned on read, so
//   a collapsed list can never show a count of files that are no longer there.
//
// Pure — no fs, no ipc, no React. The store (`src/main/git-changelists.ts`)
// spends these functions and owns the disk; the panel spends them and owns the
// pixels.

export const DEFAULT_CHANGELIST_ID = 'default'
export const DEFAULT_CHANGELIST_NAME = 'Changes'

/** The one shape, on disk and on the wire. `paths` are repo-relative and posix
 *  ('src/main/git.ts'), because that is the spelling git reports and the only
 *  one that survives a repository moving between machines. */
export type Changelist = {
  id: string
  name: string
  /** The list's comment — the composer offers it as the commit message's
   *  placeholder when the list is active. Absent, never empty. */
  comment?: string
  paths: string[]
  active: boolean
}

export function createDefaultChangelists(): Changelist[] {
  return [{ id: DEFAULT_CHANGELIST_ID, name: DEFAULT_CHANGELIST_NAME, paths: [], active: true }]
}

export function isDefaultChangelist(list: Pick<Changelist, 'id'>): boolean {
  return list.id === DEFAULT_CHANGELIST_ID
}

/** Repo-relative, posix, no leading `./`, no trailing slash. Everything that
 *  enters the model goes through this, so two spellings of one path can never
 *  end up in two different lists. */
export function normalizeChangelistPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .trim()
}

function normalizeName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed.slice(0, 120) : fallback
}

function normalizeComment(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Take whatever was on disk (or came off the wire) and return a set of lists
 * that obeys every rule above. REPAIR, not validation: a store file written by
 * an older build, or half-written by a crash, must still open the panel.
 *
 * The order of business matters. The default is forced to exist FIRST so it can
 * receive the paths that a duplicate id or a missing list would otherwise
 * strand; a path already claimed by an earlier list is dropped from every later
 * one, so "first claim wins" is the tie-break; and the active flag is resolved
 * last, over lists that are already known to exist.
 */
export function normalizeChangelists(value: unknown): Changelist[] {
  const raw = Array.isArray(value) ? value : []
  const out: Changelist[] = []
  const seenIds = new Set<string>()
  const claimed = new Set<string>()

  const push = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object') return
    const entry = candidate as Partial<Changelist>
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id || seenIds.has(id)) return
    seenIds.add(id)
    const paths: string[] = []
    for (const path of Array.isArray(entry.paths) ? entry.paths : []) {
      if (typeof path !== 'string') continue
      const normalized = normalizeChangelistPath(path)
      if (!normalized || claimed.has(normalized)) continue
      claimed.add(normalized)
      paths.push(normalized)
    }
    paths.sort()
    out.push({
      id,
      name: normalizeName(entry.name, id === DEFAULT_CHANGELIST_ID ? DEFAULT_CHANGELIST_NAME : 'Changelist'),
      ...(normalizeComment(entry.comment) ? { comment: normalizeComment(entry.comment) as string } : {}),
      paths,
      active: entry.active === true,
    })
  }

  // The default first, wherever it was, so it is the one list guaranteed to be
  // there when the loop below needs somewhere to put an orphan. A default the
  // file never had is synthesised INACTIVE, so a store written by a build that
  // only knew named lists keeps the list its owner had active.
  const defaultEntry = raw.find(
    (entry) => entry && typeof entry === 'object' && (entry as Partial<Changelist>).id === DEFAULT_CHANGELIST_ID,
  )
  push(defaultEntry ?? { id: DEFAULT_CHANGELIST_ID, name: DEFAULT_CHANGELIST_NAME, paths: [], active: false })
  for (const entry of raw) push(entry)

  return withOneActive(out)
}

/** Exactly one `active: true`, the first claim winning and the default taking
 *  it when nobody does. Called after every mutation, which is what makes "two
 *  lists both active" unrepresentable rather than merely unlikely. */
function withOneActive(lists: Changelist[]): Changelist[] {
  const activeId = lists.find((list) => list.active)?.id ?? DEFAULT_CHANGELIST_ID
  return lists.map((list) => ({ ...list, active: list.id === activeId }))
}

/**
 * Reconcile the stored lists against what git actually reports.
 *
 * PRUNE: a path git no longer mentions leaves every list. Without it a list
 * that was five files stays "5 files" long after four of them were committed.
 *
 * ADOPT: a changed path no list claims joins the ACTIVE one. That is the whole
 * meaning of "active" — a file an agent touched while a feature list was active
 * belongs to that feature, and one touched with `Changes` active lands in
 * `Changes` exactly as it always did.
 */
export function reconcileChangelists(lists: Changelist[], statusPaths: string[]): Changelist[] {
  const present = new Set(statusPaths.map(normalizeChangelistPath).filter(Boolean))
  const normalized = normalizeChangelists(lists)
  const claimed = new Set<string>()
  const pruned = normalized.map((list) => {
    const paths = list.paths.filter((path) => {
      if (!present.has(path) || claimed.has(path)) return false
      claimed.add(path)
      return true
    })
    return { ...list, paths }
  })

  const orphans = [...present].filter((path) => !claimed.has(path)).sort()
  if (orphans.length === 0) return pruned

  const activeId = pruned.find((list) => list.active)?.id ?? DEFAULT_CHANGELIST_ID
  return pruned.map((list) =>
    list.id === activeId ? { ...list, paths: [...list.paths, ...orphans].sort() } : list,
  )
}

export function setActiveChangelist(lists: Changelist[], id: string): Changelist[] {
  const normalized = normalizeChangelists(lists)
  if (!normalized.some((list) => list.id === id)) return normalized
  return normalized.map((list) => ({ ...list, active: list.id === id }))
}

/** A new list, always appended after the ones that exist so the order a person
 *  built is the order they read. `activate` is separate from creation because
 *  "make a list" and "send my next change there" are two decisions. */
export function createChangelist(
  lists: Changelist[],
  input: { id: string; name: string; comment?: string; activate?: boolean },
): Changelist[] {
  const normalized = normalizeChangelists(lists)
  const id = input.id.trim()
  if (!id || normalized.some((list) => list.id === id)) return normalized
  const comment = normalizeComment(input.comment)
  const created: Changelist = {
    id,
    name: normalizeName(input.name, 'Changelist'),
    ...(comment ? { comment } : {}),
    paths: [],
    active: false,
  }
  const next = [...normalized, created]
  return input.activate ? setActiveChangelist(next, id) : next
}

/** Rename and re-comment, the default included: an IDE lets a person rename
 *  Default, and the id — not the name — is what the paths are keyed to. */
export function renameChangelist(
  lists: Changelist[],
  id: string,
  input: { name: string; comment?: string },
): Changelist[] {
  const normalized = normalizeChangelists(lists)
  const comment = normalizeComment(input.comment)
  return normalized.map((list) =>
    list.id === id
      ? {
          id: list.id,
          name: normalizeName(input.name, list.name),
          ...(comment ? { comment } : {}),
          paths: list.paths,
          active: list.active,
        }
      : list,
  )
}

/**
 * Delete a list and hand its paths back to the default. Refuses the default
 * itself — the guard lives HERE rather than only in the menu, because a menu
 * item can be reached by a keyboard, a command, or a future caller, and the
 * model is the only place all three pass through.
 *
 * A deleted list that was active hands the flag to the default too, which is
 * `withOneActive`'s doing rather than a special case.
 */
export function deleteChangelist(lists: Changelist[], id: string): Changelist[] {
  const normalized = normalizeChangelists(lists)
  if (id === DEFAULT_CHANGELIST_ID) return normalized
  const doomed = normalized.find((list) => list.id === id)
  if (!doomed) return normalized
  return withOneActive(
    normalized
      .filter((list) => list.id !== id)
      .map((list) =>
        list.id === DEFAULT_CHANGELIST_ID
          ? { ...list, paths: [...new Set([...list.paths, ...doomed.paths])].sort() }
          : list,
      ),
  )
}

/** Move paths into one list. Every path leaves every OTHER list first, which is
 *  what keeps "a path is in at most one list" true through a move rather than
 *  only after a normalize. */
export function moveChangelistPaths(lists: Changelist[], targetId: string, paths: string[]): Changelist[] {
  const normalized = normalizeChangelists(lists)
  if (!normalized.some((list) => list.id === targetId)) return normalized
  const moving = new Set(paths.map(normalizeChangelistPath).filter(Boolean))
  if (moving.size === 0) return normalized
  return normalized.map((list) => {
    const kept = list.paths.filter((path) => !moving.has(path))
    if (list.id !== targetId) return { ...list, paths: kept }
    return { ...list, paths: [...new Set([...kept, ...moving])].sort() }
  })
}

export function activeChangelist(lists: Changelist[]): Changelist | null {
  return lists.find((list) => list.active) ?? lists.find(isDefaultChangelist) ?? lists[0] ?? null
}

export function changelistIdForPath(lists: Changelist[], path: string): string {
  const normalized = normalizeChangelistPath(path)
  return lists.find((list) => list.paths.includes(normalized))?.id ?? DEFAULT_CHANGELIST_ID
}

/**
 * Render order: the active list, then the rest as they were made, then the
 * default last when it is not the active one.
 *
 * The active list is first because it is the one the next change lands in, and
 * the default is last because it is the drawer everything unclaimed falls into
 * — reading a panel top to bottom should go from "what I am working on" to
 * "everything else", which is the order the mockup draws.
 */
export function orderedChangelists(lists: Changelist[]): Changelist[] {
  const normalized = normalizeChangelists(lists)
  const active = normalized.find((list) => list.active) ?? null
  const rest = normalized.filter((list) => list !== active && !isDefaultChangelist(list))
  const fallbackDefault = normalized.find((list) => isDefaultChangelist(list) && list !== active)
  return [...(active ? [active] : []), ...rest, ...(fallbackDefault ? [fallbackDefault] : [])]
}
