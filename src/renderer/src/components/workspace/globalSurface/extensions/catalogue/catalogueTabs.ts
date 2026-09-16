// The tab row of a catalogue: Installed first, then one tab per source.
//
// Source-tabs ruling (2026-09-05), which supersedes the nested Sources rail of
// backlog/2026-09-05-plugin-sources.md: the drawer and this row are the whole
// navigation, so the sources are peers across the top rather than a second
// column. Two rules the rail already held, kept here:
//
//   - A source is NEVER hidden from a kind it lacks. Hiding is how a person
//     loses a source: the tab is present with "No plugins here", and adding a
//     plugin to that repository makes the tab it is already looking at fill in.
//   - A count is never spoken while it is unknown. A scan still loading, or
//     one that failed, states that instead of rendering as 0.
//
// Pure and DOM-free, so the ordering, the labels and the honest states are
// tested without a renderer.

import {
  OFFICIAL_PLUGINS_SKILL_SOURCE_ID,
  OFFICIAL_PLUGINS_SKILL_SOURCE_NAME,
  STUDIO_SKILL_SOURCE_ID,
  STUDIO_SKILL_SOURCE_NAME,
  localSourceFolderName,
  skillSourceMonogram,
  sourceHasUpdate,
  type SkillSource,
} from '../../../../../../../shared/skills'

/** The three views of the Extensions door, which are its three catalogues. */
export type CatalogueKind = 'plugins' | 'skills' | 'agent-clis'

export const INSTALLED_TAB_ID = 'installed'

/**
 * What the app's own catalogue is called on screen: the product, not the
 * repository it is published from. Since the studio-marketplace ruling
 * (2026-09-06) the source IS `sprintengine/studio-releases`, and the store
 * already names it this — the constant stays so the label is one string and
 * a tab never renames itself mid-sync (see `catalogueTabLabel`).
 */
export const APP_CATALOGUE_LABEL = STUDIO_SKILL_SOURCE_NAME

/** A source's count for one kind, or why there is none to state. */
export type CatalogueCount =
  | { status: 'ready'; count: number }
  | { status: 'loading' }
  | { status: 'error'; message: string }

export type CatalogueTab = {
  /** `installed`, or the source id. */
  id: string
  label: string
  /** Null while the count is unknown; the tab then carries no number at all. */
  count: number | null
  /** The honest state behind the count, for the head line under the row. */
  state: CatalogueCount
  /** The source this tab shows, or null for Installed. */
  source: SkillSource | null
  /** A check has seen this source's repository move past the scanned commit. */
  updateAvailable: boolean
  /**
   * How many things IN this tab are behind their published version: agent CLIs
   * the registry has moved past, plugins whose source has a newer commit than
   * the one their receipt was written at.
   *
   * The number, not a glyph (owner, 2026-09-10). The owner opened Agent CLIs
   * from a notification and the page could not say which of ten rows the
   * notification was about; a count on the tab says how many are in there
   * before the tab is even opened, and the corner pips on the marks inside say
   * which. Zero means the tab wears nothing — a badge reading "0" is a badge
   * spent saying there is no news.
   */
  updateCount: number
  /**
   * The tab this catalogue opens on when the person has not chosen one. At most
   * one tab in a row carries it; a row with none opens on its first source, as
   * every row did before the official-plugins ruling.
   */
  isDefault: boolean
}

/**
 * What a source is called as a tab: a repository by `owner/name`, a folder by
 * its own name, the app's catalogue by the product's name, anything else by
 * the name it gave itself.
 */
export function catalogueTabLabel(source: SkillSource): string {
  if (source.id === STUDIO_SKILL_SOURCE_ID) return APP_CATALOGUE_LABEL
  // Both always-present marketplaces are called by their publisher, not by
  // their path. A tab reading `anthropics/claude-plugins-official` beside one
  // reading `sprintengine/studio-releases` names two peers by their addresses,
  // where what a person is choosing between is Anthropic and us
  // (official-plugins ruling, 2026-09-06).
  //
  // The record's OWN name is deliberately not consulted: a scan names a source
  // after the repository it read, so the copy Sync hands back reads
  // "claude-plugins-official" (or "studio-releases") until the source list is
  // read again — and the tab renamed itself under the person mid-sync.
  if (source.id === OFFICIAL_PLUGINS_SKILL_SOURCE_ID) return OFFICIAL_PLUGINS_SKILL_SOURCE_NAME
  if (source.repo) return source.repo
  if (source.kind === 'local') return localSourceFolderName(source.path ?? source.name)
  return source.name
}

/**
 * The badge letters for a source, taken from the name it is CALLED here. The
 * record's own monogram would read "MC" beside a heading naming SprintEngine
 * Studio, which is the app's old name in the one place a person compares the
 * two.
 */
export function catalogueMonogram(source: SkillSource): string {
  return skillSourceMonogram(catalogueTabLabel(source))
}

/**
 * Sources in tab order: the app's own catalogue first (it is the one every
 * install has, and the one a first-time reader wants), then Anthropic's
 * official marketplace, then the rest in the order the store lists them, which
 * is the order they were added.
 *
 * The two bundled catalogues lead because they are the two nobody chose and
 * nobody can remove; ours is first because a person looking for what THIS app
 * ships should not have to pass 292 of someone else's plugins to reach it
 * (official-plugins ruling, 2026-09-06).
 */
export function orderCatalogueSources(sources: readonly SkillSource[]): SkillSource[] {
  const rank = (source: SkillSource): number =>
    source.id === STUDIO_SKILL_SOURCE_ID ? 0 : source.id === OFFICIAL_PLUGINS_SKILL_SOURCE_ID ? 1 : 2
  // A stable partition, not a sort: everything else keeps the order it arrived
  // in, which is the order the sources were added.
  return [0, 1, 2].flatMap((tier) => sources.filter((source) => rank(source) === tier))
}

export function deriveCatalogueTabs(input: {
  kind: CatalogueKind
  sources: readonly SkillSource[]
  /** The installed count for this kind, or null while it is unknown. */
  installedCount: number | null
  /** Per-source count for this kind, keyed by source id. */
  counts: Readonly<Record<string, CatalogueCount>>
  /**
   * Per-tab count of things with an update waiting, keyed by source id and by
   * `installed`. A tab the caller says nothing about wears no badge: silence is
   * "not counted here", which is not the same claim as zero and must not be
   * drawn as one.
   */
  updateCounts?: Readonly<Record<string, number>>
}): CatalogueTab[] {
  const installed: CatalogueTab = {
    id: INSTALLED_TAB_ID,
    label: 'Installed',
    count: input.installedCount,
    state: input.installedCount === null ? { status: 'loading' } : { status: 'ready', count: input.installedCount },
    source: null,
    updateAvailable: false,
    updateCount: input.updateCounts?.[INSTALLED_TAB_ID] ?? 0,
    isDefault: false,
  }
  // Agent CLIs come from the marketplace registry and nowhere else: a skill
  // source's scan yields plugins, skills and MCP servers, never a CLI, so
  // listing every added repository here would be a row of tabs that can only
  // ever say "none". The app's own catalogue is the whole source list for
  // this kind — and the reason the plus is withheld from it (CatalogueSurface).
  const sources =
    input.kind === 'agent-clis'
      ? input.sources.filter((source) => source.id === STUDIO_SKILL_SOURCE_ID)
      : orderCatalogueSources(input.sources)
  return [
    installed,
    ...sources.map((source) => {
      const state = input.counts[source.id] ?? { status: 'loading' as const }
      return {
        id: source.id,
        label: catalogueTabLabel(source),
        count: state.status === 'ready' ? state.count : null,
        state,
        source,
        updateAvailable: sourceHasUpdate(source),
        updateCount: input.updateCounts?.[source.id] ?? 0,
        // Plugins opens on Anthropic: it is where the plugins are — 292 of
        // them against our own catalogue's handful — and the app's own tab is
        // one click away, still first in the row (official-plugins ruling,
        // 2026-09-06). Skills and Agent CLIs are unchanged; the app's own
        // skills are what a first-time reader of those wants.
        isDefault: input.kind === 'plugins' && source.id === OFFICIAL_PLUGINS_SKILL_SOURCE_ID,
      }
    }),
  ]
}

/**
 * The tab to stand on. The one asked for when it still exists, else this
 * catalogue's default tab, else the first source, else Installed — a removed
 * source must not leave the surface on a tab that is no longer in the row.
 */
export function resolveCatalogueTab(tabs: readonly CatalogueTab[], wanted: string | null): string {
  if (wanted && tabs.some((tab) => tab.id === wanted)) return wanted
  const preferred = tabs.find((tab) => tab.isDefault) ?? tabs.find((tab) => tab.source !== null)
  return preferred?.id ?? INSTALLED_TAB_ID
}

/**
 * What a source holds, each kind named: "292 plugins · 15 MCP servers".
 *
 * The Plugins tab used to total them into "292 listings", and a listing is not
 * a noun anybody uses — the owner read `anthropics/skills`'s five plugin
 * bundles as five skills, because four of them are named `*-skills`
 * (official-plugins ruling, 2026-09-06). A kind the source has none of is left
 * out rather than printed as a zero.
 */
export function catalogueHoldingsLine(kinds: readonly (readonly [number, string, string])[]): string {
  return kinds
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`)
    .join(' · ')
}

/** The head line under the tab row: what this source is, or why it is silent. */
export function catalogueStateLine(state: CatalogueCount, noun: string): string {
  if (state.status === 'loading') return 'Loading…'
  if (state.status === 'error') return state.message
  if (state.count === 0) return `No ${noun}s here`
  return `${state.count} ${state.count === 1 ? noun : `${noun}s`}`
}
