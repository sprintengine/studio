import { memo } from 'react'

import { LifecycleGlyph, StarGlyph, Tooltip, TruncatedText, type LifecycleState } from '../ui'
import { BacklogTypeGlyph } from './BacklogTypeGlyph'
import type {
  BacklogCriticality,
  BacklogDifficulty,
  BacklogHighlightColor,
  BacklogItem,
  BacklogItemStatus,
} from '../../utils/backlog'
import type { BacklogEpicGroup, BacklogEpicMeta } from '../../utils/backlogEpics'
import { getHighlightSwatch } from '../../utils/highlight'
import type { SprintEngineRunGlyph } from '../../utils/sprintengine'
import {
  CRITICALITY_LABEL,
  DIFFICULTY_LABEL,
  DIFFICULTY_WORD,
} from '../../utils/backlogTriage'
import { formatRelativeMsAgo } from '../../utils/relativeTime'

// Backlog readiness → the shared lifecycle vocabulary. The pre-work states
// (idea / ready) are calm, not blockers; only `needs_input` — an agent working
// the item is genuinely awaiting a human — earns the warn glyph. Idea reads as
// a dashed ring, "needs structure" as a plain to-do ring.
export function backlogStatusToLifecycle(status: BacklogItemStatus): LifecycleState {
  switch (status) {
    case 'idea':
      return 'idea'
    case 'ready':
      return 'ready'
    case 'in_progress':
      return 'in_progress'
    case 'needs_input':
      return 'needs_input'
    case 'completed':
      return 'done'
    case 'archived':
      return 'archived'
  }
}

// Backlog-specific readiness words for the glyph tooltip — accurate to the
// item's status, independent of the (coarser) lifecycle shape it maps to.
export const BACKLOG_STATUS_LABEL: Record<BacklogItemStatus, string> = {
  idea: 'Idea',
  ready: 'Ready',
  in_progress: 'In progress',
  needs_input: 'Needs input',
  completed: 'Completed',
  archived: 'Archived',
}

// A live-run override for the readiness glyph: when a Backlog item is linked to
// a Sprint Engine run we can observe, the row's glyph reflects the *runner*'s
// real state (running / paused / blocked / failed / complete) instead of the
// item's coarse `in_progress` status. The rollup itself is shared with the
// workspace sidebar (`deriveSprintEngineRunGlyph`) so the two surfaces can't
// drift. The panel owns resolving it (it has the workspace store); the row
// just renders what it is handed.
export type BacklogRunGlyph = SprintEngineRunGlyph

// Canonical backlog row interior, shared by the Backlog panel list and the
// new-workspace Sprint Engine source picker so the two surfaces can't drift.
// The selectable wrapper (listbox option, drag, click target) stays with each
// consumer; only the visual content lives here.
//
// Primary line: a leading readiness glyph is the row's status marker, then the
// title — the row's one priority — claims the entire width. Supporting line: the
// `KEY-n` id, size, and criticality bars flow from the left, with how long ago
// the item was touched holding the right. Everything except the glyph and title
// rides the supporting line so the title stays legible even when the panel is
// squeezed narrow; the type (feature/bug/…) lives in metadata and no longer
// earns a glyph, and the excerpt is dropped — at this width it only ever showed
// a few clipped words, so its space goes to the title instead.
// React.memo so a panel re-render (e.g. a Sprint Engine projection tick) only
// reconciles rows whose props actually changed. `item` is referentially stable
// between scans, `now` ticks every 30s, and `runGlyph` is undefined for the
// common no-run-link row — so the default shallow comparison lets unchanged
// rows skip rendering entirely. See backlog item Task 2.
// A small dot in an epic's identity colour (or a dashed neutral ring when the
// epic has no `color:` set). Shared by the row's member chip, the detail crumb,
// and the children roll-up so the epic always reads the same. The hex comes from
// the shared swatch helper (inline style — the same pattern the highlight
// swatch picker uses — so it never trips the design-token hex-in-className lint).
export function EpicColorDot({
  color,
  size = 6,
}: {
  color: BacklogHighlightColor | null
  size?: number
}): JSX.Element {
  const dimension = { width: size, height: size }
  if (!color) {
    return (
      <span
        aria-hidden="true"
        className="shrink-0 rounded-full border border-dashed border-[color:var(--text-disabled)]"
        style={dimension}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className="shrink-0 rounded-full"
      style={{ ...dimension, backgroundColor: getHighlightSwatch(color).hex }}
    />
  )
}

export const BacklogRowContent = memo(function BacklogRowContent({
  item,
  now,
  runGlyph,
  isWaiting = false,
  epicMeta,
}: {
  item: BacklogItem
  now: number
  /** Live Sprint Engine run state, when this item is linked to an observable
   *  run. Overrides the item-status glyph so the row reflects the runner. */
  runGlyph?: BacklogRunGlyph
  /** Derived (never persisted): the item is active and has ≥1 unresolved
   *  prerequisite, so it earns the "Waiting" badge. Off for done/non-blocked
   *  items and for the source picker, which passes no dependency graph. */
  isWaiting?: boolean
  /** The parent epic's identity (title/colour/id), passed only in the flat
   *  (ungrouped) list so a member surfaces its epic as a small coloured pill.
   *  The grouped list omits it — the epic group header already names it. */
  epicMeta?: BacklogEpicMeta
}): JSX.Element {
  const lifecycle = runGlyph?.state ?? backlogStatusToLifecycle(item.status)
  const statusLabel = runGlyph?.label ?? BACKLOG_STATUS_LABEL[item.status]
  // Default true keeps the standalone in_progress item spinning; a run override
  // earns the spinner only when the runner is genuinely running.
  const live = runGlyph?.live ?? true
  // The leading glyph is the item's status — except for an epic, whose lifecycle
  // is derived from its children, so it earns a dedicated type glyph instead of
  // the (misleading) "idea" ring it would otherwise show.
  return (
    <>
      <div className="flex items-center gap-2">
        {item.isEpic ? (
          <Tooltip content="Epic" placement="top">
            <BacklogTypeGlyph type="epic" label="Epic" className="icon-sm text-[color:var(--text-muted)]" />
          </Tooltip>
        ) : (
          <Tooltip content={statusLabel} placement="top">
            <LifecycleGlyph state={lifecycle} live={live} />
          </Tooltip>
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <TruncatedText
            as="span"
            text={item.title}
            className="min-w-0 text-[12px] font-medium text-[color:var(--text-strong)]"
          />
          {/* Earned mark: the star exists only when starred — no placeholder
              outline on idle rows, same rule as the status dot. Matches the
              sidebar's starred-workspace glyph (color, size, name). */}
          {item.highlight?.starred ? (
            <StarGlyph
              filled
              className="icon-xs shrink-0 text-[color:var(--tone-warn)]"
              label="Starred"
            />
          ) : null}
        </span>
        {isWaiting ? <WaitingBadge /> : null}
      </div>
      {/* Supporting line: the triage metadata the title displaced — id, size,
          priority — flows from the left, and how long ago the item was touched
          holds the right. No excerpt: at this width it only ever showed a few
          clipped words, so the space goes to the title above instead. */}
      <div className="mt-0.5 flex items-center gap-2 pl-[22px] text-[11px]">
        {item.displayId ? (
          <span className="shrink-0 font-mono tabular-nums text-[color:var(--text-subtle)]">
            {item.displayId}
          </span>
        ) : null}
        <DifficultyIndicator difficulty={item.difficulty} />
        <CriticalityIndicator criticality={item.criticality} />
        {/* The parent-epic pill sits in the gap between the triage tokens and the
            right-aligned time. Its container carries the ml-auto (so the pill is
            pushed toward the time and the empty gap opens to its left) and clips
            on overflow; the time keeps a hard pl-2 gap so the pill can never
            touch it on a compressed panel. */}
        {epicMeta ? (
          <div className="ml-auto flex min-w-0 shrink items-center overflow-hidden">
            <EpicPill epic={epicMeta} />
          </div>
        ) : null}
        <span
          className={`${epicMeta ? 'pl-2' : 'ml-auto'} shrink-0 tabular-nums text-[color:var(--text-subtle)]`}
        >
          {formatRelativeMsAgo(item.modifiedAt, now) || 'unknown'}
        </span>
      </div>
    </>
  )
})

// Derived "waiting" marker: this item is active and at least one prerequisite is
// unresolved (see backlogDependencies). The word carries the meaning — never
// color alone — and an hourglass glyph shape-codes it; the whole token is one
// accessible name so a screen reader reads "Waiting on prerequisites" rather
// than a bare icon. Calm muted tone, no tinted pill: it is metadata beside the
// size/priority tokens, not a second status dot competing with the lifecycle
// glyph. Rendered only on waiting rows (earned, like the star).
function WaitingBadge(): JSX.Element {
  return (
    <span
      role="img"
      aria-label="Waiting on prerequisites"
      className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-[color:var(--text-muted)]"
    >
      <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0" aria-hidden="true">
        <path
          d="M4.5 3h7M4.5 13h7M5.5 3v1.6c0 1 .8 1.9 2.5 3.4 1.7-1.5 2.5-2.4 2.5-3.4V3M5.5 13v-1.6c0-1 .8-1.9 2.5-3.4 1.7 1.5 2.5 2.4 2.5 3.4V13"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Waiting
    </span>
  )
}

// Flat-list member badge: a small pill labelled with the parent epic's display
// id (e.g. `MC-240`) and carrying the epic's identity colour, so a member row
// reads its epic at a glance when no group header is in view. Colour is a subtle
// tint over the row (never colour alone — the id text is the label); the full
// epic title rides in the hover tooltip and the accessible name. Falls back to
// the epic title as the label only when the scan has not allocated a display id.
function EpicPill({ epic }: { epic: BacklogEpicMeta }): JSX.Element {
  const swatch = epic.color ? getHighlightSwatch(epic.color) : null
  const label = epic.displayId ?? epic.title
  return (
    <Tooltip content={epic.title} placement="top" wrapperClassName="inline-flex min-w-0 shrink">
      <span
        role="img"
        aria-label={`Epic: ${epic.title}`}
        className="inline-flex min-w-0 max-w-[14ch] shrink items-center gap-1 rounded-full border px-1.5 py-[1px] text-[10px] font-medium text-[color:var(--text-muted)]"
        style={
          swatch
            ? { borderColor: `${swatch.hex}59`, backgroundColor: `${swatch.hex}1f` }
            : { borderColor: 'var(--border-default)' }
        }
      >
        <EpicColorDot color={epic.color} size={6} />
        <span aria-hidden="true" className="min-w-0 truncate font-mono tabular-nums">
          {label}
        </span>
      </span>
    </Tooltip>
  )
}

// Size reads as the t-shirt token itself (XS/S/M/L/XL) — text is the signal, so
// it never depends on color. Right-aligned, fixed-width, tabular so the column
// scans straight down; unestimated is a calm dash, never a warning. The tooltip
// spells the size out in full (the row shows no other size label).
export function DifficultyIndicator({ difficulty }: { difficulty?: BacklogDifficulty }): JSX.Element {
  return (
    <Tooltip content={difficulty ? `Size: ${DIFFICULTY_WORD[difficulty]}` : 'Size unestimated'} placement="top" wrapperClassName="inline-flex shrink-0">
      <span
        role="img"
        aria-label={difficulty ? `Size ${DIFFICULTY_WORD[difficulty]}` : 'Size unestimated'}
        className={`w-[2.25ch] shrink-0 text-right font-mono text-[11px] tabular-nums ${
          difficulty ? 'text-[color:var(--text-muted)]' : 'text-[color:var(--text-disabled)]'
        }`}
      >
        {difficulty ? DIFFICULTY_LABEL[difficulty] : '–'}
      </span>
    </Tooltip>
  )
}

// Criticality is a shape-coded glyph only — ascending bars / urgent mark, level
// by shape, never color alone. The level word moved to the tooltip so the bars
// sit tight beside the size column instead of reserving a wide label track; that
// reclaimed width goes to the title. Unset renders a calm dash, not an alert.
export function CriticalityIndicator({ criticality }: { criticality?: BacklogCriticality }): JSX.Element {
  if (!criticality) {
    return (
      <Tooltip content="No priority set" placement="top" wrapperClassName="inline-flex shrink-0">
        <span
          role="img"
          aria-label="No priority set"
          className="w-4 shrink-0 text-right text-[11px] text-[color:var(--text-disabled)]"
        >
          –
        </span>
      </Tooltip>
    )
  }
  const urgent = criticality === 'high' || criticality === 'critical'
  return (
    <Tooltip content={`Priority: ${CRITICALITY_LABEL[criticality]}`} placement="top" wrapperClassName="inline-flex shrink-0">
      <span
        role="img"
        aria-label={`Priority ${CRITICALITY_LABEL[criticality]}`}
        className={`inline-flex w-4 shrink-0 items-center justify-end ${
          urgent ? 'text-[color:var(--text-default)]' : 'text-[color:var(--text-subtle)]'
        }`}
      >
        <CriticalityGlyph criticality={criticality} />
      </span>
    </Tooltip>
  )
}

// Decorative (the adjacent word carries the accessible name). Low/Normal/High
// are 1/2/3 filled ascending bars; Critical is a distinct filled mark so it
// never collides with High on bar count alone.
function CriticalityGlyph({ criticality }: { criticality: BacklogCriticality }): JSX.Element {
  if (criticality === 'critical') {
    return (
      <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0" aria-hidden="true">
        <rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="currentColor" />
        <path d="M8 5.5v3.2" className="[stroke:var(--bg-app)]" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="8" cy="11" r="0.85" className="[fill:var(--bg-app)]" />
      </svg>
    )
  }
  const filled = criticality === 'high' ? 3 : criticality === 'normal' ? 2 : 1
  const bars = [
    { x: 3, height: 4 },
    { x: 6.6, height: 7 },
    { x: 10.2, height: 10 },
  ]
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0" aria-hidden="true">
      {bars.map((bar, index) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={13 - bar.height}
          width="2.6"
          height={bar.height}
          rx="0.8"
          fill="currentColor"
          className={index < filled ? '' : 'opacity-30'}
        />
      ))}
    </svg>
  )
}

// Interior of an epic-group header row (the panel owns the selectable <li> and
// its left color stripe). A disclosure chevron toggles the group; the title sits
// in heavier weight than a leaf row so headers read as structure, and the
// `done/total` rollup is tabular so the column scans straight down. Unknown
// groups surface their dangling slug so an orphaned `epic:` is identifiable.
export function BacklogEpicHeaderContent({
  group,
  collapsed,
  onToggleCollapse,
}: {
  group: BacklogEpicGroup
  collapsed: boolean
  onToggleCollapse: () => void
}): JSX.Element {
  const { done, total } = group.progress
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        // The listbox owns roving focus via aria-activedescendant, so the chevron
        // stays out of the tab order; keyboard collapse runs through the list's
        // Enter/Arrow handler. stopPropagation keeps a click here from also
        // selecting the row.
        tabIndex={-1}
        aria-label={collapsed ? `Expand ${group.title}` : `Collapse ${group.title}`}
        aria-expanded={!collapsed}
        onClick={(event) => {
          event.stopPropagation()
          onToggleCollapse()
        }}
        className="interactive -ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] text-[color:var(--text-subtle)] hover:text-[color:var(--text-strong)]"
      >
        <DisclosureChevron expanded={!collapsed} />
      </button>
      <TruncatedText
        as="span"
        text={group.title}
        className="min-w-0 flex-1 text-[12px] font-semibold text-[color:var(--text-strong)]"
      />
      {group.kind === 'unknown' && group.slug ? (
        <TruncatedText
          as="span"
          text={group.slug}
          className="max-w-[10rem] shrink-0 font-mono text-[11px] text-[color:var(--text-disabled)]"
        />
      ) : null}
      <span
        className="shrink-0 tabular-nums text-[11px] text-[color:var(--text-subtle)]"
        aria-label={`${done} of ${total} complete`}
      >
        {done}/{total}
      </span>
    </div>
  )
}

// Right-pointing at rest, rotating down when the group is expanded.
function DisclosureChevron({ expanded }: { expanded: boolean }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={`icon-xs shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
