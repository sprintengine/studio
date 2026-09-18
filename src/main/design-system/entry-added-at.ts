import { stat } from 'fs/promises'
import { join } from 'path'

import { getGitRepoRoot } from '../git'
import { runGitCommand } from '../git-utils'
import type { DesignSystemManifest } from '../../shared/design-system/manifest'
import { designSystemEntryKey } from '../../shared/design-system/new-entries'

// When each thing in a bundle ARRIVED — the fact behind the Design door's "New"
// marker.
//
// **Nothing is added to the bundle format for this.** `design-system.json` is a
// contract user-authored bundles already satisfy, and a marker that needed a new
// manifest field would only ever light up for bundles we generated. The date is
// derived from the two places it already exists on disk:
//
//   1. **Git**, when the bundle sits inside a repo. `--diff-filter=A` is the
//      commit that ADDED a path, which is what "arrived" means; the EARLIEST one
//      wins, so a component deleted and restored keeps its original arrival
//      rather than being announced twice.
//   2. **Birthtime**, when it does not. Weaker — a `cp -r` restamps it, and some
//      filesystems do not carry it at all — but for a bundle that was never
//      committed it is the only honest answer.
//
// If neither answers, the entry has no date and therefore no marker. An unknown
// date is never treated as new: see `new-entries.ts`.
//
// ONE `git log` per read, never one per entry. A 200-component bundle is 200
// process spawns the naive way, on a path the door walks every time it opens.

/** Entry key → ISO date the entry first appeared. */
export type DesignSystemAddedAt = Record<string, string>

/**
 * A git log line's date. `%aI` is strict ISO-8601, so this is deliberately tight
 * — a path that happened to look like a date would otherwise silently become the
 * arrival stamp for everything after it.
 */
const ISO_DATE_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)$/

/**
 * The bundle-relative path an entry lives at.
 *
 * `contents` declares entries two ways and both ship in the wild: bare stems
 * ("badge") and bundle-relative paths ("patterns/context-rail.html"). The
 * reader already tolerates both; so does this. A component resolves to its
 * DIRECTORY, which is right for both halves — git reports the files inside it,
 * and birthtime on a directory is when it was created.
 */
function entryRelativePath(groupKey: string, entry: string): string {
  const trimmed = entry.replace(/^\.?\/+/, '')
  if (trimmed === '') return groupKey
  if (trimmed === groupKey || trimmed.startsWith(`${groupKey}/`)) return trimmed
  return `${groupKey}/${trimmed}`
}

/**
 * Every group the manifest declares, with its entries. Open by construction: a
 * bundle declaring a group we have never seen gets dates for it too, exactly as
 * `declaredGroups` renders it.
 */
function declaredEntries(manifest: DesignSystemManifest): Array<{ group: string; entry: string }> {
  const out: Array<{ group: string; entry: string }> = []
  for (const [group, value] of Object.entries(manifest.contents)) {
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim() !== '') out.push({ group, entry })
    }
  }
  return out
}

/**
 * Earliest add date per bundle-relative file path, from one `git log`.
 *
 * `--relative` is load-bearing: it makes git print paths relative to the bundle
 * directory rather than the repo root, so we never have to subtract a prefix —
 * and on macOS the repo root comes back realpath-resolved (`/private/var/…`)
 * while the bundle path the caller handed us usually is not, which is exactly
 * the kind of subtraction that silently yields an empty map.
 *
 * Returns null when the bundle is not in a repo, or git is unavailable, or the
 * command fails. Null and empty are different answers: null means fall through
 * to birthtime for everything, empty means git had nothing to say about these
 * paths (an untracked bundle inside a repo), which falls through per entry.
 */
async function gitAddDates(bundleDir: string, groups: readonly string[]): Promise<Map<string, number> | null> {
  const root = await getGitRepoRoot(bundleDir)
  if (!root) return null
  if (groups.length === 0) return new Map()

  const result = await runGitCommand(bundleDir, [
    'log',
    '--diff-filter=A',
    '--name-only',
    '--relative',
    '--format=%aI',
    // Renames off: a component that was renamed ARRIVED at its new name, and
    // following the rename would date it to the life it had under another one.
    '--no-renames',
    '--',
    ...groups,
  ])
  if (!result.ok) return null

  const dates = new Map<string, number>()
  let current: number | null = null
  for (const rawLine of result.stdout.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    if (ISO_DATE_LINE.test(line)) {
      const parsed = Date.parse(line)
      current = Number.isNaN(parsed) ? null : parsed
      continue
    }
    if (current === null) continue
    // git logs newest first, so a later sighting is an EARLIER add. Take the
    // minimum outright rather than relying on that ordering.
    const existing = dates.get(line)
    if (existing === undefined || current < existing) dates.set(line, current)
  }
  return dates
}

/**
 * The extension a group's entries carry when they are declared as bare stems —
 * the same defaults the reader applies when it opens the file.
 */
const GROUP_DEFAULT_EXTENSION: Record<string, string> = {
  patterns: '.html',
  glyphs: '.svg',
}

/**
 * The earliest git add date at or under a bundle-relative path.
 *
 * Three shapes count as "this entry": the path itself (a declared file), any
 * path beneath it (a component directory), and the same stem with an extension
 * — because `contents.glyphs` may declare `close` for a file named `close.svg`.
 */
function earliestUnder(dates: Map<string, number>, relativePath: string): number | null {
  let earliest = dates.get(relativePath) ?? null
  const directoryPrefix = `${relativePath}/`
  const stemPrefix = `${relativePath}.`
  for (const [path, when] of dates) {
    if (!path.startsWith(directoryPrefix) && !path.startsWith(stemPrefix)) continue
    if (earliest === null || when < earliest) earliest = when
  }
  return earliest
}

/** `birthtimeMs`, or null when the path is gone or the filesystem has none. */
async function birthTime(absolutePath: string): Promise<number | null> {
  try {
    const stats = await stat(absolutePath)
    // Filesystems without a creation time report 0 (Linux, some network mounts).
    // Zero is the epoch, which would make everything ancient rather than
    // unknown — and unknown is the honest answer.
    return stats.birthtimeMs > 0 ? stats.birthtimeMs : null
  } catch {
    return null
  }
}

/**
 * Resolve the arrival date of every entry the manifest declares.
 *
 * Called once per bundle read, from `readDesignSystemBundle`, so it is scoped to
 * the read and invalidated with it — there is no separate cache to go stale, and
 * Reload genuinely re-reads.
 */
export async function resolveDesignSystemAddedAt(
  bundleDir: string,
  manifest: DesignSystemManifest,
): Promise<DesignSystemAddedAt> {
  const entries = declaredEntries(manifest)
  if (entries.length === 0) return {}

  const groups = [...new Set(entries.map((entry) => entry.group))]
  let dates: Map<string, number> | null = null
  try {
    dates = await gitAddDates(bundleDir, groups)
  } catch {
    // A missing git binary, a repo we cannot read: not an error the door should
    // ever show. The bundle still renders; it just renders without markers.
    dates = null
  }

  const addedAt: DesignSystemAddedAt = {}
  for (const { group, entry } of entries) {
    const relativePath = entryRelativePath(group, entry)
    const fromGit = dates ? earliestUnder(dates, relativePath) : null
    // Per ENTRY, not per bundle: a bundle inside a repo can still hold a
    // component that was never committed, and that one falls back on its own.
    const extension = GROUP_DEFAULT_EXTENSION[group]
    const when =
      fromGit ??
      (await birthTime(join(bundleDir, relativePath))) ??
      (extension && !relativePath.endsWith(extension)
        ? await birthTime(join(bundleDir, `${relativePath}${extension}`))
        : null)
    if (when === null) continue
    addedAt[designSystemEntryKey(group, entry)] = new Date(when).toISOString()
  }
  return addedAt
}
