// Which projects a person uses, and the order every project picker lists them in.
//
// The owner asked for the projects used most to come first wherever a project is
// picked for a new chat (owner, 2026-10-06): New chat here, and the phone's New.
// "Most" is frecency, a count that also weighs how recent each use was, because
// a pure count keeps last month's project above this week's for weeks and a pure
// recency throws the favourite away after one detour.
//
// THE SCORE. Each use contributes a weight of 1 when it happens, halving every
// `PROJECT_USE_HALF_LIFE_MS` (a week) after that:
//
//   score(now) = Σ over uses u of 2 ^ (-(now - u.at) / halfLife)
//
// It is kept as a running total rather than a list of uses. Decaying the total
// to the moment of a new use and adding 1 is the same sum exactly, so the record
// stays four numbers however often a project is used, and reading the score at
// any later moment is one more decay of it. No randomness and no wall clock in
// here: every function takes `now` or `at`, which is what lets a test pin it.
//
// A use is starting a new chat in the project, from this machine's New chat or
// from a paired device's. Main keeps the record (`projectUsage` in the
// agent-launch settings), so a chat started from the phone with no window open
// still counts, and `workspace.list` hands the score to the phone.
//
// THE ORDER. Used projects first, by score, then by the latest use; projects
// never used keep the order they came in, below all of them. A tie keeps the
// incoming order too, so the sort is stable and the same inputs always list
// the same way.

import { normalizeFolderKey } from './project-hue'

/** A use's weight halves every week. */
export const PROJECT_USE_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * At most this many projects are remembered; the least-used fall off first. A
 * project that fell off reads as never used, which is what a project untouched
 * long enough to be the hundredth-most-used one practically is.
 */
export const PROJECT_USAGE_LIMIT = 100

/** One project's uses, folded into a running score. */
export type ProjectUsage = {
  /** The decayed sum of every use, as of `scoredAt`. */
  score: number
  /** The moment `score` is measured at: the latest use, in epoch milliseconds. */
  scoredAt: number
  /** The latest use, in epoch milliseconds. */
  lastUsedAt: number
  /** How many uses were ever recorded. Not decayed; the wire carries it for a reader that wants it. */
  useCount: number
}

/** Usage by `projectUsageKey`. */
export type ProjectUsageMap = Record<string, ProjectUsage>

/**
 * The key a project's usage is kept under: its folder, spelled the way every
 * project list here compares folders (forward slashes, no trailing separator,
 * lower case). Null for no folder, which is not a project.
 */
export function projectUsageKey(folderPath: string | null | undefined): string | null {
  const trimmed = folderPath?.trim()
  if (!trimmed) return null
  return normalizeFolderKey(trimmed) || null
}

/** The project's score at `now`: its stored score decayed by the time since. Zero for never used. */
export function projectFrecency(usage: ProjectUsage | null | undefined, now: number): number {
  if (!usage) return 0
  // A clock that went backwards reads the score as it was stored rather than
  // inflating it.
  const elapsed = Math.max(0, now - usage.scoredAt)
  return usage.score * decay(elapsed)
}

/** `usage` with one more use at `at`. */
export function recordProjectUse(usage: ProjectUsage | null | undefined, at: number): ProjectUsage {
  if (!usage) return { score: 1, scoredAt: at, lastUsedAt: at, useCount: 1 }
  // A use stamped before the stored score (two processes' clocks a moment
  // apart) is added at its own decayed weight, so the sum is the same whichever
  // order the two uses arrive in.
  if (at < usage.scoredAt) {
    return { ...usage, score: usage.score + decay(usage.scoredAt - at), useCount: usage.useCount + 1 }
  }
  return {
    score: projectFrecency(usage, at) + 1,
    scoredAt: at,
    lastUsedAt: Math.max(usage.lastUsedAt, at),
    useCount: usage.useCount + 1,
  }
}

/**
 * `usage` with a use of `folderPath` recorded at `at`, trimmed to
 * `PROJECT_USAGE_LIMIT` projects. A folder that is no project changes nothing.
 * Pure: `usage` is not mutated.
 */
export function withProjectUse(usage: ProjectUsageMap, folderPath: string, at: number): ProjectUsageMap {
  const key = projectUsageKey(folderPath)
  if (!key) return usage
  const next: ProjectUsageMap = { ...usage, [key]: recordProjectUse(usage[key], at) }
  const keys = Object.keys(next)
  if (keys.length <= PROJECT_USAGE_LIMIT) return next
  // Drop the lowest scores as of this use; the one just recorded scores at
  // least 1 and is never the one dropped.
  const ranked = keys.sort((left, right) => projectFrecency(next[right], at) - projectFrecency(next[left], at))
  for (const dropped of ranked.slice(PROJECT_USAGE_LIMIT)) delete next[dropped]
  return next
}

/** One stored entry, or null when it is not one. Never throws. */
export function normalizeProjectUsage(value: unknown): ProjectUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const score = finite(raw.score)
  const scoredAt = finite(raw.scoredAt)
  const lastUsedAt = finite(raw.lastUsedAt)
  const useCount = finite(raw.useCount)
  if (score === null || scoredAt === null || lastUsedAt === null || useCount === null) return null
  if (score <= 0 || useCount < 1) return null
  return { score, scoredAt, lastUsedAt, useCount: Math.floor(useCount) }
}

/** A stored map, fail-soft: entries that are not usage are dropped. */
export function normalizeProjectUsageMap(value: unknown): ProjectUsageMap {
  const map: ProjectUsageMap = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return map
  for (const [key, entry] of Object.entries(value)) {
    const usage = key ? normalizeProjectUsage(entry) : null
    if (usage) map[key] = usage
  }
  return map
}

/**
 * `items` in project-use order: used projects by score at `now`, then by the
 * latest use; never-used ones after them, in the order given. A new array;
 * `items` is not reordered.
 */
export function sortByProjectUse<T>(
  items: readonly T[],
  folderOf: (item: T) => string | null | undefined,
  usage: ProjectUsageMap | null | undefined,
  now: number,
): T[] {
  const ranked = items.map((item, index) => {
    const key = projectUsageKey(folderOf(item))
    const entry = key ? usage?.[key] : undefined
    return { item, index, score: projectFrecency(entry, now), lastUsedAt: entry?.lastUsedAt ?? 0 }
  })
  ranked.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score
    if (left.lastUsedAt !== right.lastUsedAt) return right.lastUsedAt - left.lastUsedAt
    return left.index - right.index
  })
  return ranked.map((entry) => entry.item)
}

function decay(elapsedMs: number): number {
  return Math.pow(2, -elapsedMs / PROJECT_USE_HALF_LIFE_MS)
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
