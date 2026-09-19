import type {
  BacklogCriticality,
  BacklogDifficulty,
  BacklogHighlightColor,
  BacklogItem,
  BacklogItemStatus,
  BacklogRisk,
  BacklogType,
} from './backlog'
import type { BacklogView, BacklogSort, BacklogGroup } from '../types/workspace'

// Triage view + sort logic for the Backlog panel, kept pure so the filtering
// and ordering rules can be unit-tested without a DOM. The panel owns the
// controls; this module owns the meaning of each lens and sort.

// Named lenses. Quick wins / strategic bets / defer span difficulty *ranges*
// (XS/S, L/XL) that a single-value filter can't express, which is why the panel
// surfaces them as presets rather than independent size/priority dropdowns.
// Canonical union definitions live in `types/workspace.ts` so the persisted
// WorkspaceBacklogState can reference them; this module owns their behavior and
// re-exports the types for the panel and its controls.
export type { BacklogView, BacklogSort, BacklogGroup }

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

export const RISK_LABEL: Record<BacklogRisk, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
}

export const TYPE_LABEL: Record<BacklogType, string> = {
  epic: 'Epic',
  feature: 'Feature',
  bug: 'Bug',
  mockup: 'Mockup',
  spike: 'Spike',
}

const DIFFICULTY_RANK: Record<BacklogDifficulty, number> = { xs: 0, s: 1, m: 2, l: 3, xl: 4 }
const CRITICALITY_RANK: Record<BacklogCriticality, number> = { low: 0, normal: 1, high: 2, critical: 3 }
const RISK_RANK: Record<BacklogRisk, number> = { low: 0, normal: 1, high: 2 }

// Worklist urgency order for the status sort: items waiting on a human decision
// surface first, then work that is actively running, then ready-to-start, then
// rough ideas, with finished/archived sinking to the bottom. Recency is the
// tiebreak within a status band (compareBacklogItems).
const STATUS_RANK: Record<BacklogItemStatus, number> = {
  needs_input: 0,
  in_progress: 1,
  ready: 2,
  idea: 3,
  completed: 4,
  archived: 5,
}

// Derived-blocked items (a stored `ready` gated by unresolved prerequisites —
// see backlogDependencies) band below every actionable status but above the
// terminal states: nothing can be done on them yet, but they are still open
// work, not finished work.
const BLOCKED_STATUS_RANK = 3.5

const SMALL: ReadonlySet<BacklogDifficulty> = new Set<BacklogDifficulty>(['xs', 's'])
const LARGE: ReadonlySet<BacklogDifficulty> = new Set<BacklogDifficulty>(['l', 'xl'])
const URGENT: ReadonlySet<BacklogCriticality> = new Set<BacklogCriticality>(['high', 'critical'])

type Triageable = Pick<
  BacklogItem,
  'difficulty' | 'criticality' | 'risk' | 'status' | 'modifiedAt' | 'createdAtMs' | 'relativePath' | 'isEpic' | 'epic'
>

// Missing either axis is the "unestimated" signal — a calm prompt to size or
// prioritise, never an error.
export function isBacklogUnestimated(item: Pick<BacklogItem, 'difficulty' | 'criticality'>): boolean {
  return item.difficulty == null || item.criticality == null
}

// "Unfiled" is the epic-axis gap, the structural sibling of `isBacklogUnestimated`:
// a leaf item that points at no epic, and so belongs to no grouping. An epic
// container is never unfiled — it *is* the filing cabinet, not a loose item —
// which is what keeps the `no_epic` sort a list of work to file rather than a
// list padded with every epic header.
export function isBacklogUnfiled(item: Pick<BacklogItem, 'epic' | 'isEpic'>): boolean {
  if (item.isEpic) return false
  return item.epic == null || item.epic.trim() === ''
}

export function matchesBacklogView(item: Triageable, view: BacklogView): boolean {
  // Completed and archived are each their own terminal lens, and 'all' is the
  // firehose that shows everything. Every other lens — the default 'active'
  // working set and the triage presets — hides both terminal states so a
  // finished or stale item never resurfaces as live work.
  if (view === 'all') return true
  if (view === 'archived') return item.status === 'archived'
  if (view === 'completed') return item.status === 'completed'
  // Epics is a structural lens: every epic container, at any lifecycle stage
  // (a finished or archived epic still reads as one grouping), and nothing else.
  // Evaluated before the terminal-state guard so completed/archived epics show.
  if (view === 'epics') return item.isEpic
  if (item.status === 'archived' || item.status === 'completed') return false

  switch (view) {
    case 'active':
      return true
    case 'quick_wins':
      return (
        item.difficulty != null &&
        SMALL.has(item.difficulty) &&
        item.criticality != null &&
        URGENT.has(item.criticality)
      )
    case 'strategic_bets':
      return (
        item.difficulty != null &&
        LARGE.has(item.difficulty) &&
        item.criticality != null &&
        URGENT.has(item.criticality)
      )
    case 'defer':
      return item.difficulty != null && LARGE.has(item.difficulty) && item.criticality === 'low'
    case 'unestimated':
      return isBacklogUnestimated(item)
    default:
      return true
  }
}

// `isBlocked` is the optional dependency-derived signal (the Backlog panel
// passes it from its graph; graph-less surfaces like the source picker omit it):
// true for an item whose readiness is gated by unresolved prerequisites. It
// demotes under the two "what should I act on" sorts — status and best — and is
// deliberately ignored everywhere else (recency/size orderings are not about
// actionability).
export function compareBacklogItems(
  a: Triageable,
  b: Triageable,
  sort: BacklogSort,
  isBlocked?: (item: Triageable) => boolean,
): number {
  switch (sort) {
    case 'status': {
      // needs_input → in_progress → ready → idea → blocked → completed →
      // archived, with newest-first inside each band so the freshest of two
      // in-progress items leads. A derived-blocked item leaves its stored
      // status band for the blocked band: it must never interleave with
      // genuinely ready work.
      const sa = isBlocked?.(a) ? BLOCKED_STATUS_RANK : STATUS_RANK[a.status]
      const sb = isBlocked?.(b) ? BLOCKED_STATUS_RANK : STATUS_RANK[b.status]
      if (sa !== sb) return sa - sb
      return b.modifiedAt - a.modifiedAt
    }
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
    case 'best': {
      // The composite "what should I pick up" order: impact first (criticality
      // desc), then risk (lowest first — a sure thing beats a gamble at equal
      // impact), then effort (smallest difficulty first — cheaper wins surface
      // sooner). A missing axis sinks below estimated peers *within its tier*,
      // never masquerading as the best value. The final tiebreak is the stable
      // path order so the list is deterministic across scans (not recency).
      // A dependency-blocked item cannot be picked up at all, so it sinks below
      // every unblocked item first, keeping the composite order within each half.
      const blockedA = isBlocked?.(a) ? 1 : 0
      const blockedB = isBlocked?.(b) ? 1 : 0
      if (blockedA !== blockedB) return blockedA - blockedB
      const ca = a.criticality ? CRITICALITY_RANK[a.criticality] : -1
      const cb = b.criticality ? CRITICALITY_RANK[b.criticality] : -1
      if (ca !== cb) return cb - ca
      const ra = a.risk ? RISK_RANK[a.risk] : Number.POSITIVE_INFINITY
      const rb = b.risk ? RISK_RANK[b.risk] : Number.POSITIVE_INFINITY
      if (ra !== rb) return ra - rb
      const da = a.difficulty ? DIFFICULTY_RANK[a.difficulty] : Number.POSITIVE_INFINITY
      const db = b.difficulty ? DIFFICULTY_RANK[b.difficulty] : Number.POSITIVE_INFINITY
      if (da !== db) return da - db
      return a.relativePath.localeCompare(b.relativePath)
    }
    case 'no_epic': {
      // The filing lens: items belonging to no epic rise to the top so the loose
      // work is one glance away, with everything already filed kept below in the
      // same order. Unlike a view, nothing is hidden — the epic'd tail is still
      // there to scroll into, and grouping stays orthogonal (a 'By epic' grouping
      // gathers this sort's leading band under the 'No epic' header).
      const ua = isBacklogUnfiled(a) ? 0 : 1
      const ub = isBacklogUnfiled(b) ? 0 : 1
      if (ua !== ub) return ua - ub
      // Within the filed band, keep an epic's members adjacent rather than
      // interleaving two epics by recency; the unfiled band shares one empty key
      // and so falls straight through to recency.
      const ea = a.epic ?? ''
      const eb = b.epic ?? ''
      if (ea !== eb) return ea.localeCompare(eb)
      return b.modifiedAt - a.modifiedAt
    }
    case 'created':
      // Newest-created first, mirroring 'recent' but keyed on creation time so an
      // item's position is fixed by when it was captured, not when it was last
      // edited.
      return b.createdAtMs - a.createdAtMs
    case 'recent':
    default:
      return b.modifiedAt - a.modifiedAt
  }
}

// Risk × effort → a calm heat hint reusing the highlight palette. Read as a
// gradient from a confident quick win (easy + low risk → green) to a costly
// gamble (hard + high risk → red); the unremarkable middle stays uncolored so
// the row list never lights up wholesale. Only the warm ramp (green → amber →
// orange → red) is used: the cool palette colors (blue/purple/pink) carry no
// risk meaning and stay reserved for the user's manual highlight. Ordering of
// the encoded heat is green < (uncolored) < amber < orange < red, monotonic in
// both axes. Pure + render-time only — no persisted field (Decision F7).
const RISK_COLOR_GRID: Record<BacklogRisk, Record<BacklogDifficulty, BacklogHighlightColor | null>> = {
  low: { xs: 'green', s: 'green', m: null, l: null, xl: 'amber' },
  normal: { xs: 'green', s: null, m: null, l: 'amber', xl: 'orange' },
  high: { xs: 'amber', s: 'amber', m: 'orange', l: 'orange', xl: 'red' },
}

// One palette color (or null) for a risk×difficulty pair. Either axis missing is
// the unestimated signal: no derived color, so an unsized item stays calm rather
// than guessing a heat it can't justify.
export function deriveRiskColor(risk?: BacklogRisk, difficulty?: BacklogDifficulty): BacklogHighlightColor | null {
  if (!risk || !difficulty) return null
  return RISK_COLOR_GRID[risk][difficulty]
}

// The row stripe's effective color: the user's manual highlight always wins; the
// derived risk heat is only an ambient fallback when no color was set by hand.
// Kept here (pure) so the override precedence is unit-testable without a DOM.
export function resolveBacklogStripeColor(
  item: Pick<BacklogItem, 'highlight' | 'risk' | 'difficulty'>,
): BacklogHighlightColor | null {
  return item.highlight?.color ?? deriveRiskColor(item.risk, item.difficulty)
}

// A backlog row's effective colour treatment, factoring in its epic's identity
// hue (option C — the epic colour fills the whole member row). Precedence, most
// specific first:
//   1. a hand-set highlight — the user's explicit per-item mark — fills the row;
//   2. else the epic identity colour fills the row, so members read as one unit;
//   3. else the derived risk heat tints the stripe alone (ambient, never a fill).
// `litFill` is true for cases 1 and 2 (full-width fill earned), false for case 3
// (stripe only) and when there is no colour at all. `epicColor` is the resolved
// `color:` of the row's epic (null when it has no epic or the epic set no
// colour). Pure so the precedence is unit-testable without a DOM.
export function resolveBacklogRowColor(
  item: Pick<BacklogItem, 'highlight' | 'risk' | 'difficulty'>,
  epicColor: BacklogHighlightColor | null,
): { color: BacklogHighlightColor | null; litFill: boolean } {
  const fill = item.highlight?.color ?? epicColor
  if (fill) return { color: fill, litFill: true }
  return { color: deriveRiskColor(item.risk, item.difficulty), litFill: false }
}
