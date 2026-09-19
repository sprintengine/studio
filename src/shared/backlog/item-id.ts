// Single source of truth for Backlog item display identifiers.
//
// Identity is a workspace-global sequential integer, allocated once and never
// changed (across re-type, rename, or re-triage). It lives in the item's
// markdown frontmatter as `id: 240` (committed — git is the shared ledger). The
// human-facing identifier is `<KEY>-<number>` (e.g. `MC-240`), composed at
// render time from that number plus a per-workspace key, exactly like Jira
// (`PROJ-123`) and Linear (`ENG-123`): the prefix is the project/workspace, the
// number is permanent, and the item's *type* is conveyed by a glyph, never by
// the id. See backlog/2026-06-28-backlog-stable-display-identifiers.md.
//
// This module is pure and shared by both processes and (in spirit) the /backlog
// skill, so it must stay free of renderer-only or main-only imports — the same
// rule frontmatter.ts follows.

// A scanned item reduced to what allocation and duplicate detection need.
export type BacklogIdItem = {
  relativePath: string
  // The item's current numeric id (from frontmatter), or null/undefined when it
  // has none yet and is awaiting allocation.
  numericId?: number | null
  // ISO-8601 creation timestamp from the sidecar record, used only to order
  // un-id'd items so a backfill assigns ids oldest-first (history reads
  // naturally). Absent items sort after dated ones, then by path.
  createdAt?: string
}

// An external (imported) identity that should display in place of the native
// `<KEY>-<number>` scheme — a Jira/Linear/GitHub key kept verbatim. Reserved now
// so the importer item can light it up without reshaping this contract; native
// items pass it as undefined.
export type BacklogExternalId = {
  displayId?: string
}

// Parse a frontmatter `id:` value into the canonical numeric id. Tolerant of the
// bare integer we write (`240`) and of a prefixed form (`MC-240`, `#240`, or an
// external `PROJ-240`): the trailing integer group is the number. Anything
// without a positive trailing integer is treated as "no id".
export function parseBacklogNumericId(value: string | number | undefined | null): number | undefined {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (!text) return undefined
  const match = /(\d+)\s*$/.exec(text)
  if (!match) return undefined
  const parsed = Number.parseInt(match[1], 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

// Serialize a numeric id back to the bare-integer frontmatter scalar.
export function formatBacklogNumericId(numericId: number): string {
  return String(numericId)
}

// The next id to mint: one past the highest existing id (gaps and holes are
// fine — ids are never reused, so a deleted item's number simply stays vacant).
// Min 1. Non-integer/non-positive values are ignored.
export function allocateNextBacklogId(existing: Iterable<number | null | undefined>): number {
  let max = 0
  for (const value of existing) {
    if (typeof value === 'number' && Number.isInteger(value) && value > max) max = value
  }
  return max + 1
}

// Plan a backfill/allocation pass: every item lacking a valid id is assigned the
// next sequential id, oldest (by createdAt, then path) first, continuing past the
// current max. Pure — the caller writes the frontmatter. Returns a relativePath
// -> numericId map of only the *newly assigned* ids (already-id'd items are
// untouched), so an idempotent re-run over a fully-id'd backlog returns {}.
export function planBacklogIdAllocation(items: BacklogIdItem[]): Record<string, number> {
  let max = 0
  const missing: BacklogIdItem[] = []
  for (const item of items) {
    const current = item.numericId ?? undefined
    if (typeof current === 'number' && Number.isInteger(current) && current > 0) {
      if (current > max) max = current
    } else {
      missing.push(item)
    }
  }
  missing.sort(compareForAllocation)
  const assignments: Record<string, number> = {}
  let next = max
  for (const item of missing) {
    next += 1
    assignments[item.relativePath] = next
  }
  return assignments
}

// Oldest-first by createdAt, then by path for stability. Items without a
// createdAt sort last (a freshly scanned file with no sidecar record yet), so
// dated history keeps its natural order and undated captures take the tail.
function compareForAllocation(a: BacklogIdItem, b: BacklogIdItem): number {
  const aCreated = a.createdAt ?? ''
  const bCreated = b.createdAt ?? ''
  if (aCreated && bCreated) {
    if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1
  } else if (aCreated || bCreated) {
    return aCreated ? -1 : 1
  }
  if (a.relativePath !== b.relativePath) return a.relativePath < b.relativePath ? -1 : 1
  return 0
}

// Compose the human-facing display id. An external identity (imported issue)
// wins so a synced item shows its tracker key verbatim; otherwise it is the
// native `<KEY>-<number>`. No zero-padding — the number alone is the identity,
// matching Jira/Linear/GitHub.
export function formatBacklogDisplayId(input: {
  key: string
  numericId: number
  external?: BacklogExternalId | null
}): string {
  const external = input.external?.displayId?.trim()
  if (external) return external
  return `${input.key}-${input.numericId}`
}

// Derive a default workspace key from the workspace folder name, the same way a
// user would pick a Jira project key: initials for a multi-word name (ACME Web
// -> AW), else the first letters of a single word (sprintengine -> MUL). Uppercased
// and alphanumeric; falls back to `BL` (backlog) for an empty/symbol-only name.
// This is only the default — the key is configurable per workspace.
export function deriveDefaultBacklogKey(workspaceName: string): string {
  const words = workspaceName.split(/[^A-Za-z0-9]+/).filter(Boolean)
  let key = ''
  if (words.length >= 2) {
    key = words
      .map((word) => word[0])
      .join('')
      .slice(0, 5)
  } else if (words.length === 1) {
    key = words[0].slice(0, 3)
  }
  key = key.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  // Fall back to `BL` (backlog) when the name yields nothing key-shaped — e.g. a
  // purely numeric or symbol-only folder name, which isn't alpha-led.
  return isValidBacklogKey(key) ? key : 'BL'
}

// Validate a configured workspace key: a short alphanumeric token, optionally
// with internal hyphens/underscores, never the trailing-number slot. Keeps a bad
// config value from producing ids like `MY KEY-12` that won't round-trip.
const BACKLOG_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,11}$/

export function isValidBacklogKey(value: unknown): value is string {
  return typeof value === 'string' && BACKLOG_KEY_RE.test(value)
}

// Ids assigned to more than one item — the visible symptom of a concurrent
// scan-max allocation across unmerged branches (Decision 4 in the plan). The
// cure is git merge plus this surfaced warning, never silent renumbering.
// Sorted by id; each entry names every colliding path.
export function findDuplicateBacklogIds(items: BacklogIdItem[]): Array<{ numericId: number; relativePaths: string[] }> {
  const byId = new Map<number, string[]>()
  for (const item of items) {
    const id = item.numericId ?? undefined
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) continue
    const paths = byId.get(id) ?? []
    paths.push(item.relativePath)
    byId.set(id, paths)
  }
  const duplicates: Array<{ numericId: number; relativePaths: string[] }> = []
  for (const [numericId, relativePaths] of byId) {
    if (relativePaths.length > 1) duplicates.push({ numericId, relativePaths })
  }
  duplicates.sort((a, b) => a.numericId - b.numericId)
  return duplicates
}
