// What the board picker shows, decided without a DOM.
//
// The list itself is the service's answer, in the service's order — newest
// first, ties by name — and this module never re-sorts it. What it does decide
// is everything AROUND the order: where a page starts and ends, what the page
// is called, which names need a folder beside them to be told apart, what the
// next new board is called, and how "when did this change" is said in the few
// characters a row has left at its end.
//
// Pure for the same reason `cataloguePaging.ts` is: a page boundary, a clamp
// and a duplicate name are the three things a paged list gets wrong, and none
// of them needs a renderer to be proved right.

import type { CanvasBoardSummary } from '../../../../../../shared/canvas/types'
import { CANVAS_LEGACY_FOLDER, canvasBoardIsInStore, canvasBoardName } from '../../../../../../shared/canvas/paths'

/**
 * Boards per page.
 *
 * Ten rows is about 480px of card — a docked pane shows the whole page without
 * scrolling, and a project with three boards still reads as a list rather than
 * as a page with a list somewhere on it. The "New board" affordance sits on the
 * heading line rather than in the card, so it is not one of the ten and never
 * pages away.
 */
export const CANVAS_PICKER_PAGE_SIZE = 10

/** The name a new board takes when the person does not type one. */
export const CANVAS_DEFAULT_NEW_BOARD_NAME = 'canvas'

/**
 * Clamp a page number into the range the list actually has.
 *
 * A picker can be holding page 3 when the folder loses a board under it (an
 * agent tidying up, a `git checkout`), and the honest answer is the last page
 * that exists — never an empty card with a working "previous".
 */
export function clampCanvasPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page)) return 1
  if (pageCount <= 0) return 1
  return Math.min(Math.max(Math.floor(page), 1), pageCount)
}

export type CanvasPickerPage = {
  /** 1-based and already clamped — a page number can outlive its rows. */
  page: number
  pageCount: number
  /** 1-based inclusive row range on this page; both 0 when there is nothing. */
  rangeStart: number
  rangeEnd: number
  /** "Showing 1–10 of 23" — the position, in words, beside the page numbers. */
  rangeLabel: string
  /** The boards this page holds, in the order they were handed over. */
  boards: CanvasBoardSummary[]
}

/** The page a person is standing on: which slice, and the sentence naming it. */
export function canvasPickerPage(input: {
  boards: readonly CanvasBoardSummary[]
  page: number
  pageSize?: number
}): CanvasPickerPage {
  const pageSize = Math.max(1, input.pageSize ?? CANVAS_PICKER_PAGE_SIZE)
  const total = input.boards.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const page = clampCanvasPage(input.page, pageCount)
  const start = (page - 1) * pageSize
  const end = Math.min(start + pageSize, total)
  const rangeStart = total === 0 ? 0 : start + 1
  const rangeEnd = total === 0 ? 0 : end
  return {
    page,
    pageCount,
    rangeStart,
    rangeEnd,
    rangeLabel: total === 0 ? 'No boards yet' : `Showing ${rangeStart}–${rangeEnd} of ${total}`,
    boards: input.boards.slice(start, end),
  }
}

/**
 * What a board in the app's store says instead of a folder. The store's real
 * path is a dot-folder inside the sidecar, which means nothing to a person
 * choosing between two boards of one name; where it is kept is what tells them
 * apart from the one in their project.
 */
export const CANVAS_STORE_LOCATION_LABEL = 'app storage'

/**
 * Where a board lives, as a row says it: its project folder, or the store's
 * label for a board in the app's store (and for a bare path, which lands
 * there).
 */
export function canvasBoardFolder(path: string): string {
  const slashed = String(path).replace(/\\/g, '/')
  const cut = slashed.lastIndexOf('/')
  if (cut <= 0 || canvasBoardIsInStore(slashed)) return CANVAS_STORE_LOCATION_LABEL
  return slashed.slice(0, cut)
}

/**
 * The names that appear on more than one board, folded to lower case.
 *
 * A row states its name and nothing else, because a folder repeated down every
 * row is a column of the word "diagrams" (owner, 2026-09-17). The one case that
 * cannot survive that is two boards called the same thing: "architecture" twice
 * is two rows nobody can choose between. Those rows — and only those — say
 * their folder as well.
 *
 * Folded, and computed over the WHOLE list rather than the page: two spellings
 * of one name are one file on the platforms most people are on, and a row that
 * grew a folder because of a board on page 3 must keep it on page 1.
 */
export function duplicateCanvasBoardNames(boards: readonly CanvasBoardSummary[]): ReadonlySet<string> {
  const seen = new Set<string>()
  const twice = new Set<string>()
  for (const board of boards) {
    const key = board.name.toLowerCase()
    if (seen.has(key)) twice.add(key)
    else seen.add(key)
  }
  return twice
}

/**
 * A name no board in the list is already using.
 *
 * The person making a second board almost always wants a second board, not to
 * be told the name is taken — so the default counts up instead. Anything they
 * type themselves is left exactly as typed, and collides loudly.
 */
export function uniqueCanvasBoardName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((path) => canvasBoardName(path).toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  return `${base}-${Date.now()}`
}

/**
 * The board a new name would collide with, or null.
 *
 * The path itself, and — for a board headed for the store — the same name in
 * the legacy folder too: a bare name finds the legacy board when the store has
 * none (that is what the canvas tools do with it), so a second board of that
 * name in the store would quietly take the name away from the one the person
 * already has.
 */
export function collidingCanvasBoardPath(
  candidatePath: string,
  taken: readonly string[],
  caseInsensitive: boolean,
): string | null {
  const fold = (path: string): string => (caseInsensitive ? path.toLowerCase() : path)
  const candidates = [fold(candidatePath)]
  if (canvasBoardIsInStore(candidatePath)) {
    candidates.push(fold(`${CANVAS_LEGACY_FOLDER}/${candidatePath.slice(candidatePath.lastIndexOf('/') + 1)}`))
  }
  return taken.find((path) => candidates.includes(fold(path))) ?? null
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Past four weeks a count of days has stopped being a time and become a date. */
const RELATIVE_HORIZON_DAYS = 28

function elapsed(ms: number, now: number): { minutes: number; hours: number; days: number } {
  const diff = Math.max(0, now - ms)
  return {
    minutes: Math.floor(diff / MINUTE),
    hours: Math.floor(diff / HOUR),
    days: Math.floor(diff / DAY),
  }
}

/**
 * When the board last changed, in the handful of characters the end of a row
 * has: `now`, `5m`, `2h`, `yesterday`, `2d`, then a date.
 *
 * Not `utils/relativeTime`'s `formatRelativeMs`, and the two differences are
 * the reason this exists. That one draws NOTHING for the first minute, which is
 * deliberate where it is used (a list of agents, where "idle for 40 seconds" and
 * "working" must not look alike) and wrong here, where a board saved seconds ago
 * is the single likeliest row to want. And past a month it counts on in `mo` and
 * `y`, which is a unit nobody reads as "when" — a board last touched in March is
 * better named by March.
 *
 * No "ago": every value in the column is in the past, and saying so ten times
 * down a card costs the width the names need.
 */
export function formatCanvasChangedAt(ms: number | null | undefined, now: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  const { minutes, hours, days } = elapsed(ms, now)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (hours < 24) return `${hours}h`
  if (days === 1) return 'yesterday'
  if (days < RELATIVE_HORIZON_DAYS) return `${days}d`
  const when = new Date(ms)
  const sameYear = when.getFullYear() === new Date(now).getFullYear()
  return when.toLocaleDateString(
    undefined,
    sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' },
  )
}

/**
 * The same fact in full words, for the row's accessible name. `5m` is a
 * drawing; a screen reader reading "five em" is not the row telling anyone
 * anything.
 */
export function describeCanvasChangedAt(ms: number | null | undefined, now: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  const { minutes, hours, days } = elapsed(ms, now)
  if (minutes < 1) return 'changed just now'
  if (minutes < 60) return `changed ${minutes} minute${minutes === 1 ? '' : 's'} ago`
  if (hours < 24) return `changed ${hours} hour${hours === 1 ? '' : 's'} ago`
  if (days === 1) return 'changed yesterday'
  if (days < RELATIVE_HORIZON_DAYS) return `changed ${days} days ago`
  return `changed on ${new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })}`
}

/**
 * What a row says when it is read out rather than looked at.
 *
 * The drawing drops the folder on all but the ambiguous rows and shortens the
 * time to two characters; the name says both in full every time, because a
 * person who cannot see which rows are adjacent has nothing else to tell
 * `architecture` from `architecture`.
 */
export function canvasBoardRowLabel(input: { name: string; folder: string; changed: string; open: boolean }): string {
  const parts = [`Open board ${input.name}`, `in ${input.folder}`]
  if (input.changed) parts.push(input.changed)
  if (input.open) parts.push('already open in another tab')
  return parts.join(', ')
}
