import type { DiffFileItem } from './diffFileList'

// "Viewed" marks in the diff viewer: a file the person has read is ticked off,
// and the window counts how many of its changed files are done. A mark is the
// file AS IT WAS READ — its two sides' fingerprint — so a file that changes
// again (an agent's next edit, a re-stage) is unread again, without anyone
// having to untick it.
//
// Kept per repository in this computer's renderer storage. It is a note about
// what this person has looked at here; it never goes into the repository and
// never leaves the machine.

/** What a mark is stored under: the file and which of its diffs it is. */
export type ViewedMarks = Readonly<Record<string, string>>

const STORAGE_PREFIX = 'sprintengine.diffViewed.v1:'
/**
 * Enough for any review; a repository's marks never grow past it. Past it the
 * oldest mark goes, in memory and in storage alike, since storage is written
 * from memory whole.
 */
export const MAX_VIEWED_MARKS = 500

export function diffViewedKey(
  item: Pick<DiffFileItem, 'kind' | 'relativePath'> & { originalRev?: string; modifiedRev?: string },
): string {
  const path = item.relativePath.replace(/\\/g, '/')
  // A commit step's file is one diff per pair of revisions: reading it in one
  // step says nothing about the next.
  if (item.kind === 'branch') return `branch:${item.originalRev ?? ''}..${item.modifiedRev ?? ''}:${path}`
  return `${item.kind}:${path}`
}

// FNV-1a over UTF-16 code units: a fingerprint, not a security boundary. Two
// texts that collide would let a changed file keep its tick, which is a
// mislabelled checkbox, nothing worse.
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * The fingerprint of a diff as it is on screen, or null while it cannot be
 * marked (still loading, or unreadable). A binary or too-large file is marked
 * by what it is, since its text is never read.
 */
export function fingerprintDiffContent(
  content: { state: 'ready'; original: string; modified: string } | { state: string },
): string | null {
  if (content.state === 'ready' && 'original' in content) {
    const { original, modified } = content
    return `${original.length}.${fnv1a(original)}:${modified.length}.${fnv1a(modified)}`
  }
  if (content.state === 'binary' || content.state === 'too-large') return content.state
  return null
}

/** Whether `item` is marked viewed as its content now reads; with no fingerprint yet, whether it has a mark at all. */
export function isDiffViewed(marks: ViewedMarks, item: DiffFileItem, fingerprint: string | null): boolean {
  const mark = marks[diffViewedKey(item)]
  if (mark === undefined) return false
  return fingerprint === null || mark === fingerprint
}

/** Mark or unmark one file. */
export function withViewedMark(
  marks: ViewedMarks,
  item: DiffFileItem,
  fingerprint: string | null,
  viewed: boolean,
): ViewedMarks {
  const key = diffViewedKey(item)
  if (!viewed || fingerprint === null) {
    if (!(key in marks)) return marks
    const { [key]: _dropped, ...rest } = marks
    return rest
  }
  if (marks[key] === fingerprint) return marks
  // Marked again, a file is the newest mark: the oldest are the ones dropped.
  const { [key]: _previous, ...rest } = marks
  const kept = Object.entries(rest)
  return Object.fromEntries([...kept.slice(Math.max(0, kept.length - MAX_VIEWED_MARKS + 1)), [key, fingerprint]])
}

/** How many of the listed files carry a mark. */
export function countViewed(marks: ViewedMarks, items: readonly DiffFileItem[]): number {
  return items.reduce((count, item) => count + (diffViewedKey(item) in marks ? 1 : 0), 0)
}

/**
 * The marks that still name a changed file. A file committed or reverted
 * leaves the list, and its mark with it; were it to change again, its new
 * diff would not be the one that was read.
 */
export function pruneViewedMarks(marks: ViewedMarks, items: readonly DiffFileItem[]): ViewedMarks {
  const listed = new Set(items.map(diffViewedKey))
  const kept = Object.entries(marks).filter(([key]) => listed.has(key))
  return kept.length === Object.keys(marks).length ? marks : Object.fromEntries(kept)
}

/** The first file after `from`, wrapping round, that is not marked; -1 when all are. */
export function nextUnviewedIndex(marks: ViewedMarks, items: readonly DiffFileItem[], from: number): number {
  for (let step = 1; step <= items.length; step++) {
    const index = (from + step) % items.length
    if (!(diffViewedKey(items[index]!) in marks)) return index
  }
  return -1
}

function storageKey(repoRoot: string): string {
  return `${STORAGE_PREFIX}${repoRoot}`
}

export function readViewedMarks(repoRoot: string, storage: Pick<Storage, 'getItem'> = localStorage): ViewedMarks {
  try {
    const raw: unknown = JSON.parse(storage.getItem(storageKey(repoRoot)) ?? '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
  } catch {
    return {}
  }
}

export function writeViewedMarks(
  repoRoot: string,
  marks: ViewedMarks,
  storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage,
): void {
  try {
    const entries = Object.entries(marks)
    if (entries.length === 0) storage.removeItem(storageKey(repoRoot))
    else storage.setItem(storageKey(repoRoot), JSON.stringify(Object.fromEntries(entries.slice(-MAX_VIEWED_MARKS))))
  } catch {
    // Storage full or unavailable: the marks hold for this window's session.
  }
}

/** Whether a `storage` event is about this repository's marks. */
export function isViewedMarksStorageKey(key: string | null, repoRoot: string): boolean {
  return key === storageKey(repoRoot)
}
