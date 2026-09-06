// How a source's rows are walked, one page at a time.
//
// The source-tabs ruling (2026-09-05) replaced the per-section "Show N more"
// with ONE pager at the foot of the tab that walks the whole source. The
// groups stay — the registry's categories, a repository's folders — so a page
// is a window over the concatenation of the groups in order, and a group that
// does not fit continues onto the next page rather than being truncated or
// promoted to a page of its own.
//
// Pure and DOM-free (the pluginsSurfaceModel idiom): what a page contains,
// what it is called, and which page numbers are reachable are all decided
// here, so the boundaries can be tested without a renderer.

/** A group as its owner counts it: every row it holds, before paging. */
export type CatalogueGroup = { key: string; label: string; count: number }

/** One group's share of a page: a half-open slice of that group's own rows. */
export type CataloguePageGroup = {
  key: string
  label: string
  /** Rows in the whole group, which is what its heading states. */
  total: number
  /** Half-open [start, end) into the group's own row list. */
  start: number
  end: number
  /** The group began on an earlier page; its heading says so. */
  continued: boolean
}

export type CataloguePageView = {
  /** 1-based and clamped into range — a page number can outlive its rows. */
  page: number
  pageCount: number
  pageSize: number
  total: number
  /** 1-based inclusive row range on this page; both 0 when there are no rows. */
  rangeStart: number
  rangeEnd: number
  /** "Showing 13–24 of 318", or what to say when there is nothing to show. */
  rangeLabel: string
  groups: CataloguePageGroup[]
}

/**
 * Rows per page. Twelve is the mockup's own number and two full columns of
 * six: enough that a category reads as a list rather than a teaser, few enough
 * that a 318-row source never mounts more than a screenful at once.
 */
export const CATALOGUE_PAGE_SIZE = 12

/**
 * Clamp a page into the range a group list actually has. A removal can leave
 * the surface holding a page number past the end (remove the only source with
 * 27 pages while standing on page 9), and the honest answer is the last page
 * that exists — never an empty canvas with working previous/next.
 */
export function clampCataloguePage(page: number, pageCount: number): number {
  if (!Number.isFinite(page)) return 1
  const floor = Math.floor(page)
  if (pageCount <= 0) return 1
  return Math.min(Math.max(floor, 1), pageCount)
}

export function catalogueTotal(groups: readonly CatalogueGroup[]): number {
  return groups.reduce((sum, group) => sum + Math.max(0, group.count), 0)
}

export function catalogueRangeLabel(input: {
  rangeStart: number
  rangeEnd: number
  total: number
  /** What the tab is filtered by, if anything — a no-hit search says so. */
  query?: string
  /** Singular noun for the kind, e.g. 'plugin'. */
  noun?: string
}): string {
  const noun = input.noun ?? 'item'
  if (input.total === 0) {
    const trimmed = (input.query ?? '').trim()
    return trimmed ? `Nothing matches “${trimmed}”` : `No ${noun}s here`
  }
  return `Showing ${input.rangeStart}–${input.rangeEnd} of ${input.total}`
}

/**
 * The page a person is standing on: which slice of which groups, and the
 * sentence that names it.
 */
export function deriveCataloguePage(input: {
  groups: readonly CatalogueGroup[]
  page: number
  pageSize?: number
  query?: string
  noun?: string
}): CataloguePageView {
  const pageSize = Math.max(1, input.pageSize ?? CATALOGUE_PAGE_SIZE)
  const total = catalogueTotal(input.groups)
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const page = clampCataloguePage(input.page, pageCount)
  const windowStart = (page - 1) * pageSize
  const windowEnd = Math.min(windowStart + pageSize, total)

  const groups: CataloguePageGroup[] = []
  let cursor = 0
  for (const group of input.groups) {
    const count = Math.max(0, group.count)
    const groupStart = cursor
    cursor += count
    if (count === 0) continue
    // The overlap of this group's span with the page's window, expressed in
    // the group's own coordinates so the caller slices its own row array.
    const from = Math.max(windowStart, groupStart) - groupStart
    const to = Math.min(windowEnd, cursor) - groupStart
    if (to <= from) continue
    groups.push({
      key: group.key,
      label: group.label,
      total: count,
      start: from,
      end: to,
      continued: from > 0,
    })
  }

  const rangeStart = total === 0 ? 0 : windowStart + 1
  const rangeEnd = total === 0 ? 0 : windowEnd
  return {
    page,
    pageCount,
    pageSize,
    total,
    rangeStart,
    rangeEnd,
    rangeLabel: catalogueRangeLabel({ rangeStart, rangeEnd, total, query: input.query, noun: input.noun }),
    groups,
  }
}

/** Where the surface is standing: which list, and which page of it. */
export type CataloguePosition = { key: string; page: number }

/**
 * The position after a change. `key` is what the page is a page OF — the open
 * tab and the active search — and any change to it lands on page 1.
 *
 * A search that kept the page number would put a person on page 9 of a
 * two-page result; the clamp above would then quietly move them to page 2, so
 * the number they were standing on stopped meaning what it said. Same for a
 * tab switch: page 4 of `anthropics/skills` is not page 4 of anything else.
 */
export function stepCataloguePage(current: CataloguePosition, key: string, page?: number): CataloguePosition {
  if (current.key !== key) return { key, page: 1 }
  return { key, page: page ?? current.page }
}
