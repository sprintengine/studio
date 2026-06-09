import type { BacklogCriticality, BacklogDifficulty, BacklogItem, BacklogType } from './backlog'

// Triage view + sort logic for the Backlog panel, kept pure so the filtering
// and ordering rules can be unit-tested without a DOM. The panel owns the
// controls; this module owns the meaning of each lens and sort.

// Named lenses. Quick wins / strategic bets / defer span difficulty *ranges*
// (XS/S, L/XL) that a single-value filter can't express, which is why the panel
// surfaces them as presets rather than independent size/priority dropdowns.
export type BacklogView =
  | 'all'
  | 'quick_wins'
  | 'strategic_bets'
  | 'defer'
  | 'unestimated'
  | 'archived'

export type BacklogSort = 'recent' | 'priority' | 'largest' | 'smallest'

export const DIFFICULTY_LABEL: Record<BacklogDifficulty, string> = {
  xs: 'XS',
  s: 'S',
  m: 'M',
  l: 'L',
  xl: 'XL',
}

export const DIFFICULTY_WORD: Record<BacklogDifficulty, string> = {
  xs: 'Extra small',
  s: 'Small',
  m: 'Medium',
  l: 'Large',
  xl: 'Extra large',
}

export const CRITICALITY_LABEL: Record<BacklogCriticality, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  critical: 'Critical',
}

export const TYPE_LABEL: Record<BacklogType, string> = {
  feature: 'Feature',
  bug: 'Bug',
  mockup: 'Mockup',
}

const DIFFICULTY_RANK: Record<BacklogDifficulty, number> = { xs: 0, s: 1, m: 2, l: 3, xl: 4 }
const CRITICALITY_RANK: Record<BacklogCriticality, number> = { low: 0, normal: 1, high: 2, critical: 3 }

const SMALL: ReadonlySet<BacklogDifficulty> = new Set<BacklogDifficulty>(['xs', 's'])
const LARGE: ReadonlySet<BacklogDifficulty> = new Set<BacklogDifficulty>(['l', 'xl'])
const URGENT: ReadonlySet<BacklogCriticality> = new Set<BacklogCriticality>(['high', 'critical'])

type Triageable = Pick<BacklogItem, 'difficulty' | 'criticality' | 'status' | 'modifiedAt'>

// Missing either axis is the "unestimated" signal — a calm prompt to size or
// prioritise, never an error.
export function isBacklogUnestimated(item: Pick<BacklogItem, 'difficulty' | 'criticality'>): boolean {
  return item.difficulty == null || item.criticality == null
}

export function matchesBacklogView(item: Triageable, view: BacklogView): boolean {
  // Archived is its own lens; every other lens hides archived so a stale item
  // never surfaces as an active idea.
  if (view === 'archived') return item.status === 'archived'
  if (item.status === 'archived') return false

  switch (view) {
    case 'all':
      return true
    case 'quick_wins':
      return item.difficulty != null && SMALL.has(item.difficulty)
        && item.criticality != null && URGENT.has(item.criticality)
    case 'strategic_bets':
      return item.difficulty != null && LARGE.has(item.difficulty)
        && item.criticality != null && URGENT.has(item.criticality)
    case 'defer':
      return item.difficulty != null && LARGE.has(item.difficulty)
        && item.criticality === 'low'
    case 'unestimated':
      return isBacklogUnestimated(item)
    default:
      return true
  }
}

export function compareBacklogItems(a: Triageable, b: Triageable, sort: BacklogSort): number {
  switch (sort) {
    case 'priority': {
      // Highest criticality first; tiebreak on the smallest difficulty so a
      // small + critical "quick win" outranks a large + critical bet. Unset
      // criticality sorts below Low.
      const ca = a.criticality ? CRITICALITY_RANK[a.criticality] : -1
      const cb = b.criticality ? CRITICALITY_RANK[b.criticality] : -1
      if (ca !== cb) return cb - ca
      const da = a.difficulty ? DIFFICULTY_RANK[a.difficulty] : Number.POSITIVE_INFINITY
      const db = b.difficulty ? DIFFICULTY_RANK[b.difficulty] : Number.POSITIVE_INFINITY
      if (da !== db) return da - db
      return b.modifiedAt - a.modifiedAt
    }
    case 'largest':
    case 'smallest': {
      // Unestimated difficulty always sinks to the bottom, in either direction,
      // rather than masquerading as the smallest size.
      const da = a.difficulty ? DIFFICULTY_RANK[a.difficulty] : null
      const db = b.difficulty ? DIFFICULTY_RANK[b.difficulty] : null
      if (da == null && db == null) return b.modifiedAt - a.modifiedAt
      if (da == null) return 1
      if (db == null) return -1
      if (da !== db) return sort === 'largest' ? db - da : da - db
      return b.modifiedAt - a.modifiedAt
    }
    case 'recent':
    default:
      return b.modifiedAt - a.modifiedAt
  }
}
