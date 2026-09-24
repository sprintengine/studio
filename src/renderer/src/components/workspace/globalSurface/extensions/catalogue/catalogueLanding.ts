// Where a deep link into a catalogue lands, and what to do when it cannot
// (skills-everywhere, 2026-09-10).
//
// A search result outside the door — the command palette's Extensions rows —
// dispatches `{ view, sourceId, pluginId }` or `{ view, sourceId, skillId }`
// and means "take me to exactly this one". The door can select the tab at
// once, but the plugin's pane needs the source's SCAN, and that may still be
// on its way (a repository read lazily the moment its tab is chosen), may
// fail, or may no longer hold the plugin. So the landing is a small state
// machine the catalogue re-runs as its reads land: wait while the answer is
// unknown; open when it is there; and when it is not, stand on the nearest
// thing that exists and say so quietly, rather than throwing or standing on
// a blank.
//
// Pure and DOM-free, so the loading, unknown-source and missing-item cases
// are tested without a renderer.

import type { ScanResult, SkillSource } from '../../../../../../../shared/skills'
import type { SkillScanLoad, SkillSourcesLoad } from '../skills/skillsSurfaceModel'
import type { ExtensionsSurfaceTarget } from '../extensionsSurfaceTarget'
import { catalogueTabLabel, INSTALLED_TAB_ID } from './catalogueTabs'

/**
 * What one catalogue owes a deep link: a source to stand on ('' when the link
 * named only the item), and the item to open, if any.
 */
export type CatalogueLanding = { sourceId: string; itemId: string | null }

export type CatalogueLandingOutcome =
  /** A read the answer depends on has not landed yet. Ask again when it does. */
  | { status: 'waiting' }
  /** The source exists and, when an item was named, so does it. */
  | { status: 'landed'; source: SkillSource; itemId: string | null }
  /** The link cannot be honoured in full; the notice says why. */
  | { status: 'missed'; notice: string }

/** The tab a target asks for, or null when it names only a view. */
export function targetTabId(target: ExtensionsSurfaceTarget): string | null {
  if (target.installed) return INSTALLED_TAB_ID
  return target.sourceId ?? null
}

/**
 * The landing a target asks of the view it names, or null when it asks for
 * nothing more than the view (or the Installed tab, which needs no read).
 */
export function landingFromTarget(target: ExtensionsSurfaceTarget): CatalogueLanding | null {
  const itemId = target.view === 'plugins' ? (target.pluginId ?? null) : (target.skillId ?? null)
  if (!target.sourceId && !itemId) return null
  return { sourceId: target.sourceId ?? '', itemId }
}

/**
 * A target that names a PLACE — a tab, a plugin, a skill — rather than a view.
 * The search box's query survives a view switch (skills-everywhere rule: it is
 * cleared only from the box itself), but a place is where the person asked to
 * be taken, and a results list would otherwise stand between them and it.
 */
export function targetNamesPlace(target: ExtensionsSurfaceTarget): boolean {
  return targetTabId(target) !== null || landingFromTarget(target) !== null
}

export function resolveCatalogueLanding(input: {
  landing: CatalogueLanding
  sourcesLoad: SkillSourcesLoad
  sources: readonly SkillSource[]
  scans: Readonly<Record<string, SkillScanLoad>>
  /** 'plugin' or 'skill' — the noun the notice uses. */
  noun: string
  /** Whether a ready scan holds the item, by the view's own lookup rule. */
  has: (scan: ScanResult, itemId: string) => boolean
}): CatalogueLandingOutcome {
  const { landing, noun } = input
  if (input.sourcesLoad.status === 'loading') return { status: 'waiting' }
  if (input.sourcesLoad.status === 'error') {
    return {
      status: 'missed',
      notice: `Your sources could not be read, so ${landing.itemId ?? 'that source'} could not be opened.`,
    }
  }

  // No source named: the item is looked for in every scan already in hand.
  // The palette always names one; this is for a caller that only knows the
  // plugin, and it never triggers a read — a source nobody has opened is not
  // searched, the same rule the search box keeps.
  if (landing.sourceId === '') {
    if (!landing.itemId) return { status: 'missed', notice: 'That link named nothing to open.' }
    let pending = false
    for (const source of input.sources) {
      const load = input.scans[source.id]
      if (load?.status === 'loading') pending = true
      if (load?.status === 'ready' && input.has(load.scan, landing.itemId)) {
        return { status: 'landed', source, itemId: landing.itemId }
      }
    }
    if (pending) return { status: 'waiting' }
    return { status: 'missed', notice: `No source that has been read lists a ${noun} called ${landing.itemId}.` }
  }

  const source = input.sources.find((candidate) => candidate.id === landing.sourceId) ?? null
  if (!source) {
    return {
      status: 'missed',
      notice: landing.itemId
        ? `The source ${landing.itemId} came from is not in your list any more, so it could not be opened.`
        : 'That source is not in your list any more.',
    }
  }
  if (!landing.itemId) return { status: 'landed', source, itemId: null }

  const label = catalogueTabLabel(source)
  const load = input.scans[source.id]
  // Not requested yet, or still reading: the tab this landing selected is what
  // asks for the read (the catalogue's ensureScan effect), so waiting is
  // waiting for that, not forever.
  if (!load || load.status === 'loading') return { status: 'waiting' }
  if (load.status === 'error') {
    return { status: 'missed', notice: `${label} could not be read, so ${landing.itemId} could not be opened.` }
  }
  if (!input.has(load.scan, landing.itemId)) {
    return {
      status: 'missed',
      notice: `${label} no longer lists a ${noun} called ${landing.itemId}. It may have been renamed or removed.`,
    }
  }
  return { status: 'landed', source, itemId: landing.itemId }
}
