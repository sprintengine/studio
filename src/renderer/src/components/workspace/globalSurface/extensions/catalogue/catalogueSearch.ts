// One search over every source at once (skills-everywhere, 2026-09-10).
//
// The search box on a catalogue used to filter the OPEN tab and nothing else —
// its placeholder said so, "Search this tab" — which made finding a plugin a
// guess about which of five sources it was in, followed by a Pager walk through
// the one you guessed. A query now reads every source the door already holds a
// scan for, and the results come back grouped by source so the answer says
// where each thing lives.
//
// What it does NOT do is go and read a source to answer. A repository nobody
// has opened is a tree call and a file read per plugin against an anonymous
// GitHub budget (useSkillSources), and a search must not spend that for every
// keystroke. Such a source is named as not yet read, and opening its tab is
// what reads it.
//
// Pure and DOM-free (the cataloguePaging idiom): the grouping, the ordering and
// the honesty line are decided here so they can be tested without a renderer.
// What a source's scan yields for a query is each view's own rule and arrives
// as a callback — a plugin row and a skill row are not the same thing.

import type { ScanResult, SkillSource } from '../../../../../../../shared/skills'
import type { SkillScanLoad } from '../skills/skillsSurfaceModel'
import { catalogueTabLabel, INSTALLED_TAB_ID, orderCatalogueSources } from './catalogueTabs'

/** A source's share of the results: its rows, under its own name. */
export type SourceSearchSection<T> = {
  /** The source id, or `installed` for what the workspace already holds. */
  key: string
  label: string
  /** Null for the Installed section, which has no source to wear. */
  source: SkillSource | null
  items: T[]
}

/** Why a source's holdings were not searched. */
export type UnreadSourceState = 'unscanned' | 'loading' | 'error'

export type UnreadSource = { source: SkillSource; label: string; state: UnreadSourceState }

export type CrossSourceSearch<T> = {
  query: string
  sections: SourceSearchSection<T>[]
  /** How many sources' scans were in hand to search. */
  searched: number
  /** How many sources the door lists, searched or not. */
  sourceCount: number
  /** The sources whose holdings this result does NOT cover, and why. */
  unread: UnreadSource[]
  /** Rows across every section. */
  total: number
}

/** A query that means "search everywhere" rather than "browse this tab". */
export function isCrossSourceQuery(query: string): boolean {
  return query.trim() !== ''
}

export function searchAcrossSources<T>(input: {
  query: string
  sources: readonly SkillSource[]
  scans: Readonly<Record<string, SkillScanLoad>>
  /** What one source's scan yields for the query — the view's own row rule. */
  match: (source: SkillSource, scan: ScanResult, query: string) => readonly T[]
  /**
   * What the Installed tab holds that the source hits do NOT already cover —
   * a skill written by hand into the workspace, an MCP server typed into
   * settings. Given the hits so the caller can leave out what is already
   * listed under its source, marked installed there.
   */
  installed?: (hits: readonly T[]) => readonly T[]
}): CrossSourceSearch<T> {
  const query = input.query.trim()
  const sections: SourceSearchSection<T>[] = []
  const unread: UnreadSource[] = []
  let searched = 0
  // Tab order, so the results read in the order the tabs do: the app's own
  // catalogue, Anthropic's, then the rest as they were added.
  for (const source of orderCatalogueSources(input.sources)) {
    const label = catalogueTabLabel(source)
    const load = input.scans[source.id]
    if (!load) {
      unread.push({ source, label, state: 'unscanned' })
      continue
    }
    if (load.status === 'loading') {
      unread.push({ source, label, state: 'loading' })
      continue
    }
    if (load.status === 'error') {
      unread.push({ source, label, state: 'error' })
      continue
    }
    searched += 1
    const items = input.match(source, load.scan, query)
    if (items.length > 0) sections.push({ key: source.id, label, source, items: [...items] })
  }
  const hits = sections.flatMap((section) => section.items)
  const installed = input.installed ? input.installed(hits) : []
  // Installed leads, as its tab does: what you already have is the first
  // answer to "do I have a thing called this".
  if (installed.length > 0) {
    sections.unshift({ key: INSTALLED_TAB_ID, label: 'Installed', source: null, items: [...installed] })
  }
  return {
    query,
    sections,
    searched,
    sourceCount: input.sources.length,
    unread,
    total: hits.length + installed.length,
  }
}

/**
 * The line under the head while a search is on: how much of the door the
 * answer covers. "Searched 2 of 3 sources" is a different claim from
 * "searched everything", and the person deciding whether a plugin exists
 * needs to know which one they are reading.
 */
export function crossSourceStateLine(result: Pick<CrossSourceSearch<unknown>, 'query' | 'searched' | 'sourceCount'>): string {
  const scope =
    result.searched === result.sourceCount
      ? `all ${result.sourceCount} ${result.sourceCount === 1 ? 'source' : 'sources'}`
      : `${result.searched} of ${result.sourceCount} sources`
  return `Searched ${scope} for “${result.query}”`
}

/**
 * The sources a search did not cover, and why, in one sentence each kind —
 * or null when it covered them all. Names them: "2 sources not yet read" with
 * no names sends a person hunting through the tab row for which two.
 */
export function unreadSourcesLine(unread: readonly UnreadSource[]): string | null {
  if (unread.length === 0) return null
  const names = (list: readonly UnreadSource[]): string => list.map((entry) => entry.label).join(', ')
  const count = (list: readonly UnreadSource[]): string => `${list.length} ${list.length === 1 ? 'source' : 'sources'}`
  const unscanned = unread.filter((entry) => entry.state === 'unscanned')
  const loading = unread.filter((entry) => entry.state === 'loading')
  const failed = unread.filter((entry) => entry.state === 'error')
  const parts: string[] = []
  if (unscanned.length > 0) {
    parts.push(`${count(unscanned)} not yet read: ${names(unscanned)}. Open a source's tab to read it.`)
  }
  if (loading.length > 0) parts.push(`${count(loading)} still being read: ${names(loading)}.`)
  if (failed.length > 0) parts.push(`${count(failed)} could not be read: ${names(failed)}.`)
  return parts.join(' ')
}
