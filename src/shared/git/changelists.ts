// Changelists — the app's own grouping of a repository's changed files (epic
// `git-commit-window`, T6; mockup 2522 panel 2), and since agent changelists,
// of a file's individual HUNKS.
//
// A CHANGELIST IS OURS, NOT GIT'S. Git has an index and nothing else. A named
// set of paths is how a person keeps two pieces of work apart in one working
// tree. So this is a named set of repo-relative
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
// Three more rules arrived with AGENT changelists, where several agents edit
// one file in one checkout and each list must hold exactly the lines its agent
// wrote:
//
//   A SPAN IS A GUEST IN SOMEONE ELSE'S FILE. `paths` still means whole-file
//   membership — a file's HOME list — and stays exclusive. `spans` is the
//   second, weaker kind of membership: a run of new-side lines a list owns in a
//   file that lives somewhere else. A span whose path has no home, or whose
//   home is the list holding the span, is meaningless and is dropped; guest
//   spans for one path never overlap each other, because a line has one author.
//
//   THE REMAINDER BELONGS TO THE HOME. Whatever no list's spans cover is the
//   home list's. That is what keeps the model small: the home list never writes
//   spans for its own file, so a file nobody has partially claimed costs
//   nothing, and taking a line back from a guest is a deletion, not a write.
//
//   THE LATEST EDITOR OWNS THE LINES IT WROTE. `recordEdit` is a line tracker:
//   it moves every existing span through the edit's coordinate change first,
//   cutting whatever the edit overwrote, and only then hands the new region to
//   the editor. Ownership is therefore last-writer-wins per line, which is the
//   only answer that stays true when two agents alternate inside one function.
//
// Pure — no fs, no ipc, no React. The store (`src/main/git-changelists.ts`)
// spends these functions and owns the disk; the panel spends them and owns the
// pixels.

export const DEFAULT_CHANGELIST_ID = 'default'
export const DEFAULT_CHANGELIST_NAME = 'Changes'

/**
 * A run of NEW-side lines, in git's own hunk convention: `start` is 1-based and
 * `lines` may be 0 for a pure deletion anchored AFTER line `start` (git writes
 * `+4,0` for "deleted after new line 4", and `+0,0` when the deletion was at
 * the head of the file — which is the one case `start` is 0).
 *
 * A zero-length span is a point between two lines, not a line, so it neither
 * overlaps nor widens a run: it is kept as its own entry and dropped only when
 * the line it is anchored after is itself owned by the same list.
 */
export type OwnedSpan = { start: number; lines: number }

/** The agent a list was made for. `exited` is a flag the store sets when the
 *  agent's session ends; reconcile then deletes the list if it is also empty. */
export type ChangelistOwner = {
  kind: 'agent'
  agentId: string
  name: string
  workspaceId?: string
  exited?: boolean
}

/** One minimal changed region of a single tool call, in git hunk convention:
 *  `old*` in the file's coordinates BEFORE the call, `new*` after it. Not the
 *  hunk bounds of a context diff — the changed lines only. */
export type Edit = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
}
/** The same shape under a name that survives being imported next to a dozen
 *  other `Edit`s. */
export type ChangelistEdit = Edit

/** The new-side half of a git hunk — the only half ownership is expressed in.
 *  `DiffHunk` (`./hunks`) is assignable to it. */
export type HunkRange = { newStart: number; newLines: number }

/** The one shape, on disk and on the wire. `paths` are repo-relative and posix
 *  ('src/main/git.ts'), because that is the spelling git reports and the only
 *  one that survives a repository moving between machines. */
export type Changelist = {
  id: string
  name: string
  /** The list's comment — the composer offers it as the commit message's
   *  placeholder when the list is active. Absent, never empty. */
  comment?: string
  /** WHOLE-file membership: the file's home list. Exclusive across lists. */
  paths: string[]
  /** Repo-relative path -> the spans this list owns in a file whose home is a
   *  DIFFERENT list. Absent, never `{}`; no entry is ever empty. */
  spans?: Record<string, OwnedSpan[]>
  active: boolean
  /** Present on lists made for an agent (`agent:<agentId>`). */
  owner?: ChangelistOwner
}

export function createDefaultChangelists(): Changelist[] {
  return [{ id: DEFAULT_CHANGELIST_ID, name: DEFAULT_CHANGELIST_NAME, paths: [], active: true }]
}

export function isDefaultChangelist(list: Pick<Changelist, 'id'>): boolean {
  return list.id === DEFAULT_CHANGELIST_ID
}

/** The id of the list that belongs to an agent. One spelling, in one place,
 *  because main writes it and three renderer files read it back. */
export function changelistOwnerId(agentId: string): string {
  return `agent:${agentId.trim()}`
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

function normalizeOwner(value: unknown): ChangelistOwner | undefined {
  if (!value || typeof value !== 'object') return undefined
  const entry = value as Partial<ChangelistOwner>
  if (entry.kind !== 'agent') return undefined
  const agentId = typeof entry.agentId === 'string' ? entry.agentId.trim() : ''
  if (!agentId) return undefined
  const workspaceId = typeof entry.workspaceId === 'string' ? entry.workspaceId.trim() : ''
  return {
    kind: 'agent',
    agentId,
    name: normalizeName(entry.name, agentId),
    ...(workspaceId ? { workspaceId } : {}),
    ...(entry.exited === true ? { exited: true as const } : {}),
  }
}

// --- Spans: the arithmetic ---------------------------------------------------
//
// Every helper below works in NEW-side file coordinates and in git's own
// convention, so nothing has to be translated at the edges. A positive span
// covers the half-open line range [start, start + lines); a zero-length span is
// the gap after line `start`.

function isSpanShape(value: unknown): value is OwnedSpan {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<OwnedSpan>
  if (!Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.lines)) return false
  const start = entry.start as number
  const lines = entry.lines as number
  if (lines < 0) return false
  // `start >= 1` for a run of lines. A zero-length span may sit at 0, which is
  // exactly how git spells "deleted before the first line" (`+0,0`); refusing
  // it would silently hand every head-of-file deletion back to the home list.
  return lines > 0 ? start >= 1 : start >= 0
}

/** Sort, coalesce, and drop the redundant. Runs that touch or overlap become
 *  one run; anchors dedupe by position and disappear into a run that already
 *  owns the line they hang off. Within ONE list only — two lists' spans are
 *  kept apart by `attachSpans`, because merging across lists would be merging
 *  two authors. */
function mergeSpans(spans: OwnedSpan[]): OwnedSpan[] {
  const runs: OwnedSpan[] = []
  for (const span of spans.filter((span) => span.lines > 0).sort((a, b) => a.start - b.start)) {
    const last = runs[runs.length - 1]
    if (last && span.start <= last.start + last.lines) {
      last.lines = Math.max(last.start + last.lines, span.start + span.lines) - last.start
      continue
    }
    runs.push({ start: span.start, lines: span.lines })
  }
  const anchors = [...new Set(spans.filter((span) => span.lines === 0).map((span) => span.start))]
    .filter((start) => !runs.some((run) => run.start <= start && start < run.start + run.lines))
    .map((start) => ({ start, lines: 0 }))
  return [...runs, ...anchors].sort((a, b) => a.start - b.start || a.lines - b.lines)
}

/** `span` minus the line range [from, to). Returns 0, 1 or 2 pieces — TWO when
 *  the span straddles the range, which is the case that makes a guest's run
 *  survive a home edit in its middle. */
function cutSpan(span: OwnedSpan, from: number, to: number): OwnedSpan[] {
  if (span.lines === 0) {
    // The anchor hangs off line `start`; it dies with that line and survives
    // anywhere else, including at either boundary of the cut.
    return span.start >= from && span.start < to ? [] : [span]
  }
  const end = span.start + span.lines
  if (to <= span.start || from >= end) return [span]
  const pieces: OwnedSpan[] = []
  if (span.start < from) pieces.push({ start: span.start, lines: from - span.start })
  if (to < end) pieces.push({ start: to, lines: end - to })
  return pieces
}

/** Every piece of `spans` that is not already covered by `taken`. */
function subtractSpans(spans: OwnedSpan[], taken: OwnedSpan[]): OwnedSpan[] {
  let pieces = spans
  for (const claim of taken) {
    if (claim.lines === 0) {
      pieces = pieces.filter((span) => !(span.lines === 0 && span.start === claim.start))
      continue
    }
    pieces = pieces.flatMap((span) => cutSpan(span, claim.start, claim.start + claim.lines))
  }
  return pieces
}

/** How much of a hunk a set of spans covers, as (lines, anchors) — compared
 *  lexicographically, so a whole line always beats any number of deletion
 *  points and an anchor only decides between lists that cover no lines. */
function coverage(spans: OwnedSpan[] | undefined, hunk: HunkRange): { lines: number; anchors: number } {
  if (!spans || spans.length === 0) return { lines: 0, anchors: 0 }
  const start = Math.max(0, Math.trunc(hunk.newStart))
  const length = Math.max(0, Math.trunc(hunk.newLines))
  let lines = 0
  let anchors = 0
  for (const span of spans) {
    if (length === 0) {
      // A zero-length hunk is a deletion point: it matches the same point, or
      // any run that owns the line it hangs off.
      const hit = span.lines === 0 ? span.start === start : span.start <= start && start < span.start + span.lines
      if (hit) anchors += 1
      continue
    }
    if (span.lines === 0) {
      if (start <= span.start && span.start < start + length) anchors += 1
      continue
    }
    const overlap = Math.min(start + length, span.start + span.lines) - Math.max(start, span.start)
    if (overlap > 0) lines += overlap
  }
  return { lines, anchors }
}

function touchesHunks(span: OwnedSpan, hunks: HunkRange[]): boolean {
  return hunks.some((hunk) => {
    const { lines, anchors } = coverage([span], hunk)
    return lines > 0 || anchors > 0
  })
}

function readSpanRecord(value: unknown): Record<string, OwnedSpan[]> {
  const out: Record<string, OwnedSpan[]> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [rawPath, rawSpans] of Object.entries(value as Record<string, unknown>)) {
    const path = normalizeChangelistPath(rawPath)
    if (!path || !Array.isArray(rawSpans)) continue
    const spans = rawSpans.filter(isSpanShape).map((span) => ({ start: span.start, lines: span.lines }))
    if (spans.length === 0) continue
    // Two spellings of one path are one path, so their spans are one set.
    out[path] = mergeSpans([...(out[path] ?? []), ...spans])
  }
  return out
}

function spansOf(list: Changelist, path: string): OwnedSpan[] {
  return list.spans?.[path] ?? []
}

function hasSpans(list: Changelist): boolean {
  return Object.keys(list.spans ?? {}).length > 0
}

/** Put a rebuilt span record back on a list, dropping the key entirely when it
 *  came out empty — `spans: {}` and no `spans` would otherwise be two spellings
 *  of one list, and the store round-trips these through JSON. */
function withSpanRecord(list: Changelist, spans: Record<string, OwnedSpan[]>): Changelist {
  const { spans: _replaced, ...rest } = list
  return Object.keys(spans).length > 0 ? { ...rest, spans } : rest
}

/**
 * Second pass of normalize: hand each list back only the spans that are legal.
 *
 * Legality needs every list's `paths` to be known, which is why this cannot
 * happen inside the first loop — a span for `src/a.ts` is valid or not
 * depending on a home that may be declared three lists later.
 */
function attachSpans(
  lists: Changelist[],
  rawSpans: Map<string, Record<string, OwnedSpan[]>>,
  homes: Map<string, string>,
): Changelist[] {
  const takenByPath = new Map<string, OwnedSpan[]>()
  return lists.map((list) => {
    const raw = rawSpans.get(list.id)
    if (!raw) return list
    const spans: Record<string, OwnedSpan[]> = {}
    for (const path of Object.keys(raw).sort()) {
      const home = homes.get(path)
      if (!home || home === list.id) continue
      const taken = takenByPath.get(path) ?? []
      const kept = mergeSpans(subtractSpans(raw[path], taken))
      if (kept.length === 0) continue
      spans[path] = kept
      takenByPath.set(path, mergeSpans([...taken, ...kept]))
    }
    return Object.keys(spans).length > 0 ? { ...list, spans } : list
  })
}

/**
 * Take whatever was on disk (or came off the wire) and return a set of lists
 * that obeys every rule above. REPAIR, not validation: a store file written by
 * an older build, or half-written by a crash, must still open the panel.
 *
 * The order of business matters. The default is forced to exist FIRST so it can
 * receive the paths that a duplicate id or a missing list would otherwise
 * strand; a path already claimed by an earlier list is dropped from every later
 * one, so "first claim wins" is the tie-break; the active flag is resolved over
 * lists that are already known to exist; and spans are attached last, when
 * every home is finally known.
 */
export function normalizeChangelists(value: unknown): Changelist[] {
  const raw = Array.isArray(value) ? value : []
  const out: Changelist[] = []
  const seenIds = new Set<string>()
  const homes = new Map<string, string>()
  const rawSpans = new Map<string, Record<string, OwnedSpan[]>>()

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
      if (!normalized || homes.has(normalized)) continue
      homes.set(normalized, id)
      paths.push(normalized)
    }
    paths.sort()
    const spans = readSpanRecord(entry.spans)
    if (Object.keys(spans).length > 0) rawSpans.set(id, spans)
    const owner = normalizeOwner(entry.owner)
    out.push({
      id,
      name: normalizeName(entry.name, id === DEFAULT_CHANGELIST_ID ? DEFAULT_CHANGELIST_NAME : 'Changelist'),
      ...(normalizeComment(entry.comment) ? { comment: normalizeComment(entry.comment) as string } : {}),
      paths,
      active: entry.active === true,
      ...(owner ? { owner } : {}),
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

  return attachSpans(withOneActive(out), rawSpans, homes)
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
 * `Changes` exactly as it always did. One exception: when the active list is an
 * AGENT's, hidden paths (any `.segment`) go to the default instead — the app's
 * own scaffolding arrives with the agent, and it is not the agent's work.
 *
 * PRUNE SPANS: with `hunksByPath` — path -> the file's current `-U0` hunks — a
 * span that overlaps none of them is dropped. After a commit git no longer
 * reports those lines, so the span is inert; the alternative is a list that
 * claims hunks of a file whose diff moved on without it. A path MISSING from
 * the map is a path nobody looked up, not a path with no hunks, so its spans
 * are left alone; an explicit empty array drops them.
 *
 * And an owned list whose agent has exited and which now holds neither paths
 * nor spans is deleted here: the agent is gone and its work has been committed,
 * so the group would render as a permanent empty header.
 */
export function reconcileChangelists(
  lists: Changelist[],
  statusPaths: string[],
  hunksByPath?: Record<string, HunkRange[]>,
): Changelist[] {
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
  const active = pruned.find((list) => list.active)
  const activeId = active?.id ?? DEFAULT_CHANGELIST_ID
  // An AGENT's list adopts what it is plausibly the author of — and never the
  // dotfiles. Launching an agent is what makes its list active, and launching
  // an agent is also what writes the app's own scaffolding into the workspace
  // (`.claude/`, `.multicode/`, `.codex/`, `.mcp.json`, …): on a fresh
  // checkout that was ninety-nine untracked files landing in "Nadia · 101
  // files" before Nadia had touched one. A hidden path an agent really did
  // edit still reaches its list through the hook, which claims explicitly.
  const hiddenGoHome = Boolean(active?.owner)
  const isHidden = (path: string): boolean => path.split('/').some((segment) => segment.startsWith('.'))
  const toActive = hiddenGoHome ? orphans.filter((path) => !isHidden(path)) : orphans
  const toDefault = hiddenGoHome ? orphans.filter(isHidden) : []
  const adopted =
    orphans.length === 0
      ? pruned
      : pruned.map((list) => {
          const gained =
            list.id === activeId ? toActive : list.id === DEFAULT_CHANGELIST_ID ? toDefault : []
          return gained.length > 0 ? { ...list, paths: [...list.paths, ...gained].sort() } : list
        })

  // Re-normalize: pruning a path removes a home, which is what makes every
  // guest span on that file invalid.
  const settled = normalizeChangelists(adopted).map((list) => {
    if (!hunksByPath || !list.spans) return list
    const spans: Record<string, OwnedSpan[]> = {}
    for (const [path, owned] of Object.entries(list.spans)) {
      const hunks = hunksByPath[path]
      if (!hunks) {
        spans[path] = owned
        continue
      }
      const kept = owned.filter((span) => touchesHunks(span, hunks))
      if (kept.length > 0) spans[path] = kept
    }
    return withSpanRecord(list, spans)
  })

  const isSpentOwnedList = (list: Changelist): boolean =>
    !isDefaultChangelist(list) &&
    list.owner?.exited === true &&
    list.paths.length === 0 &&
    !hasSpans(list)
  const survivors = settled.filter((list) => !isSpentOwnedList(list))
  return survivors.length === settled.length ? settled : withOneActive(survivors)
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
  input: { id: string; name: string; comment?: string; activate?: boolean; owner?: ChangelistOwner },
): Changelist[] {
  const normalized = normalizeChangelists(lists)
  const id = input.id.trim()
  if (!id || normalized.some((list) => list.id === id)) return normalized
  const comment = normalizeComment(input.comment)
  const owner = normalizeOwner(input.owner)
  const created: Changelist = {
    id,
    name: normalizeName(input.name, 'Changelist'),
    ...(comment ? { comment } : {}),
    paths: [],
    active: false,
    ...(owner ? { owner } : {}),
  }
  const next = [...normalized, created]
  return input.activate ? setActiveChangelist(next, id) : next
}

/**
 * The list that belongs to an agent, made if it is not there and kept in step
 * with the agent's name if it is. Idempotent by construction — launch calls it,
 * every edit frame calls it, and the second call must not move a single path.
 *
 * The owner is taken as given, `exited` included, so relaunching an agent whose
 * list was marked exited brings the list back to life rather than leaving a
 * tombstone reconcile would delete out from under it.
 */
export function createOwnedChangelist(
  lists: Changelist[],
  owner: ChangelistOwner,
  options?: { activate?: boolean },
): Changelist[] {
  const normalized = normalizeChangelists(lists)
  const clean = normalizeOwner(owner)
  if (!clean) return normalized
  const id = changelistOwnerId(clean.agentId)
  const existing = normalized.find((list) => list.id === id)
  const next = existing
    ? normalized.map((list) => (list.id === id ? { ...list, name: clean.name, owner: clean } : list))
    : [...normalized, { id, name: clean.name, paths: [], active: false, owner: clean } satisfies Changelist]
  return options?.activate ? setActiveChangelist(next, id) : normalizeChangelists(next)
}

/** Rename and re-comment, the default included: the id — not the name — is
 *  what the paths are keyed to, so renaming Default is allowed. */
export function renameChangelist(
  lists: Changelist[],
  id: string,
  input: { name: string; comment?: string },
): Changelist[] {
  const normalized = normalizeChangelists(lists)
  const comment = normalizeComment(input.comment)
  return normalized.map((list) => {
    if (list.id !== id) return list
    const { comment: _dropped, ...rest } = list
    return { ...rest, name: normalizeName(input.name, list.name), ...(comment ? { comment } : {}) }
  })
}

/**
 * Delete a list and hand its paths back to the default. Refuses the default
 * itself — the guard lives HERE rather than only in the menu, because a menu
 * item can be reached by a keyboard, a command, or a future caller, and the
 * model is the only place all three pass through.
 *
 * Its SPANS are not handed anywhere: they were lines inside somebody else's
 * file, and with nobody to own them the remainder rule gives them back to that
 * file's home. A deleted list that was active hands the flag to the default
 * too, which is `withOneActive`'s doing rather than a special case.
 */
export function deleteChangelist(lists: Changelist[], id: string): Changelist[] {
  const normalized = normalizeChangelists(lists)
  if (id === DEFAULT_CHANGELIST_ID) return normalized
  const doomed = normalized.find((list) => list.id === id)
  if (!doomed) return normalized
  return normalizeChangelists(
    withOneActive(
      normalized
        .filter((list) => list.id !== id)
        .map((list) =>
          list.id === DEFAULT_CHANGELIST_ID
            ? { ...list, paths: [...new Set([...list.paths, ...doomed.paths])].sort() }
            : list,
        ),
    ),
  )
}

/**
 * Move paths into one list. Every path leaves every OTHER list first, which is
 * what keeps "a path is in at most one list" true through a move rather than
 * only after a normalize.
 *
 * A hand move is a FILE-level decision, so it also clears every list's spans
 * for those paths: a person who drags `git.ts` into `Refactor` is saying the
 * file is theirs, and leaving three agents' spans behind would render the file
 * in four groups the moment after they said otherwise.
 */
export function moveChangelistPaths(lists: Changelist[], targetId: string, paths: string[]): Changelist[] {
  const normalized = normalizeChangelists(lists)
  if (!normalized.some((list) => list.id === targetId)) return normalized
  const moving = new Set(paths.map(normalizeChangelistPath).filter(Boolean))
  if (moving.size === 0) return normalized
  return normalizeChangelists(
    normalized.map((list) => {
      const kept = list.paths.filter((path) => !moving.has(path))
      const spans = Object.fromEntries(
        Object.entries(list.spans ?? {}).filter(([path]) => !moving.has(path)),
      )
      const cleared = withSpanRecord(list, spans)
      if (list.id !== targetId) return { ...cleared, paths: kept }
      return { ...cleared, paths: [...new Set([...kept, ...moving])].sort() }
    }),
  )
}

/**
 * Record one tool call's edits to `path` on behalf of `editorListId` — the line
 * tracker the whole feature rests on.
 *
 * Coordinates are the trap here, so they are spelled out. Every `old*` in
 * `edits` is in the file's coordinates BEFORE the call, and the file the spans
 * are written against changes under each edit, so this walks the edits in
 * ascending order carrying the cumulative offset (`newLines - oldLines` so
 * far). Applying the same edits one at a time in DESCENDING order needs no
 * offset at all and lands in the same place — there is a test that proves it,
 * because the two are the only two ways to write this and they must agree.
 *
 * Git's convention for an empty side is the second trap: a zero-length region
 * is anchored after the preceding line, so `-4,0` means "inserted after old
 * line 4" and `+0,0` means "deleted before the first new line". The tracker
 * therefore works in the region's BEGIN line (`start` for a run, `start + 1`
 * for an anchor) and converts back only when it writes a span down.
 *
 * The new region's position is derived from the tracked coordinate rather than
 * read out of `newStart`: for a well-formed call the two are equal (asserted in
 * the tests), and when they are not, the derived one is the one the rest of the
 * spans were moved to match.
 */
export function recordEdit(
  lists: Changelist[],
  editorListId: string,
  path: string,
  edits: Edit[],
): Changelist[] {
  const normalized = normalizeChangelists(lists)
  const target = normalizeChangelistPath(path)
  if (!target) return normalized
  const editor = normalized.find((list) => list.id === editorListId)
  if (!editor) return normalized

  const home = normalized.find((list) => list.paths.includes(target))
  if (!home) {
    // Nobody owns the file yet, so the editor becomes its home and every line
    // in it is theirs by the remainder rule. No spans needed, ever, until
    // somebody else edits it.
    return normalizeChangelists(
      normalized.map((list) =>
        list.id === editor.id ? { ...list, paths: [...list.paths, target].sort() } : list,
      ),
    )
  }

  const clean = (Array.isArray(edits) ? edits : [])
    .filter(
      (edit): edit is Edit =>
        !!edit &&
        typeof edit === 'object' &&
        Number.isSafeInteger(edit.oldStart) &&
        Number.isSafeInteger(edit.oldLines) &&
        Number.isSafeInteger(edit.newLines) &&
        edit.oldStart >= 0 &&
        edit.oldLines >= 0 &&
        edit.newLines >= 0,
    )
    .sort((a, b) => a.oldStart - b.oldStart)
  if (clean.length === 0) return normalized

  const working = new Map<string, OwnedSpan[]>(
    normalized.map((list) => [list.id, [...spansOf(list, target)]]),
  )
  const isGuest = editor.id !== home.id

  let offset = 0
  for (const edit of clean) {
    const begin = Math.max(1, (edit.oldLines > 0 ? edit.oldStart : edit.oldStart + 1) + offset)
    const end = begin + edit.oldLines
    const shift = edit.newLines - edit.oldLines
    for (const [id, spans] of working) {
      const moved: OwnedSpan[] = []
      for (const span of spans) {
        for (const piece of cutSpan(span, begin, end)) {
          moved.push(piece.start >= end ? { start: piece.start + shift, lines: piece.lines } : piece)
        }
      }
      working.set(id, moved)
    }
    if (isGuest) {
      // Back into git's spelling: a run starts where the old region began; a
      // pure deletion is anchored after the line before it.
      const start = edit.newLines > 0 ? begin : Math.max(0, begin - 1)
      working.set(editor.id, mergeSpans([...(working.get(editor.id) ?? []), { start, lines: edit.newLines }]))
    }
    offset += shift
  }

  return normalizeChangelists(
    normalized.map((list) => {
      const spans = { ...list.spans }
      const owned = mergeSpans(working.get(list.id) ?? [])
      if (owned.length > 0) spans[target] = owned
      else delete spans[target]
      return withSpanRecord(list, spans)
    }),
  )
}

/**
 * Who owns a hunk: the list whose spans cover the most of its new-side lines,
 * and the file's home list when nobody's do (the remainder rule). A tie goes to
 * the list earlier in `lists`, so the answer is stable across reads rather than
 * flickering between two groups in the panel.
 */
export function hunkOwnerId(lists: Changelist[], path: string, hunk: HunkRange): string {
  const normalized = normalizeChangelists(lists)
  const target = normalizeChangelistPath(path)
  const home = normalized.find((list) => list.paths.includes(target))?.id ?? DEFAULT_CHANGELIST_ID
  let bestId: string | null = null
  let best = { lines: 0, anchors: 0 }
  for (const list of normalized) {
    const score = coverage(list.spans?.[target], hunk)
    if (score.lines === 0 && score.anchors === 0) continue
    if (bestId === null || score.lines > best.lines || (score.lines === best.lines && score.anchors > best.anchors)) {
      bestId = list.id
      best = score
    }
  }
  return bestId ?? home
}

/** Every path the list puts a row on: the files it owns whole, plus the files
 *  it owns a piece of. */
export function pathsOfChangelist(list: Changelist): string[] {
  return [...new Set([...list.paths, ...Object.keys(list.spans ?? {})])].sort()
}

/** True when the list owns SOME of this file but not the file — the row the
 *  panel draws with a `partial` chip. */
export function isPartialInList(list: Changelist, path: string): boolean {
  const target = normalizeChangelistPath(path)
  return spansOf(list, target).length > 0 && !list.paths.includes(target)
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
