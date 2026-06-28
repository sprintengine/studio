import { memo } from 'react'

import { LifecycleGlyph, StarGlyph, Tooltip, TruncatedText, type LifecycleState } from '../ui'
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
// title, then the triage column (size + criticality) the eye can scan straight
// down. Supporting line: the real excerpt (title already stripped), or the path
// when a capture has no body yet, with how long ago it was touched on the right.
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
  epicChip,
}: {
  item: BacklogItem
  now: number
  /** Live Sprint Engine run state, when this item is linked to an observable
   *  run. Overrides the item-status glyph so the row reflects the runner. */
  runGlyph?: BacklogRunGlyph
  /** The row's epic identity (dot + name), shown on the supporting line in the
   *  flat list only — the grouped list names the epic on its header instead. */
  epicChip?: BacklogEpicMeta
}): JSX.Element {
  const lifecycle = runGlyph?.state ?? backlogStatusToLifecycle(item.status)
  const statusLabel = runGlyph?.label ?? BACKLOG_STATUS_LABEL[item.status]
  // Default true keeps the standalone in_progress item spinning; a run override
  // earns the spinner only when the runner is genuinely running.
  const live = runGlyph?.live ?? true
  return (
    <>
      <div className="flex items-center gap-2">
        <Tooltip content={statusLabel} placement="top">
          <LifecycleGlyph state={lifecycle} live={live} />
        </Tooltip>
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
        <DifficultyIndicator difficulty={item.difficulty} />
        <CriticalityIndicator criticality={item.criticality} />
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-[22px] text-[11px]">
        {epicChip ? (
          <span className="flex min-w-0 shrink items-center gap-1 text-[color:var(--text-subtle)]">
            <EpicColorDot color={epicChip.color} />
            <TruncatedText as="span" text={epicChip.title} className="min-w-0 max-w-[12rem]" />
            <span aria-hidden="true" className="text-[color:var(--text-disabled)]">·</span>
          </span>
        ) : null}
        <TruncatedText
          as="span"
          text={item.excerpt || item.relativePath}
          className="min-w-0 flex-1 text-[color:var(--text-disabled)]"
        />
        <span className="shrink-0 tabular-nums text-[color:var(--text-subtle)]">
          {formatRelativeMsAgo(item.modifiedAt, now) || 'unknown'}
        </span>
      </div>
    </>
  )
})

// Size reads as the t-shirt token itself (XS/S/M/L/XL) — text is the signal, so
// it never depends on color. Right-aligned, fixed-width, tabular so the column
// scans straight down; unestimated is a calm dash, never a warning.
export function DifficultyIndicator({ difficulty }: { difficulty?: BacklogDifficulty }): JSX.Element {
  return (
    <span
      role="img"
      aria-label={difficulty ? `Size ${DIFFICULTY_WORD[difficulty]}` : 'Size unestimated'}
      className={`w-[2.25ch] shrink-0 text-right font-mono text-[11px] tabular-nums ${
        difficulty ? 'text-[color:var(--text-muted)]' : 'text-[color:var(--text-disabled)]'
      }`}
    >
      {difficulty ? DIFFICULTY_LABEL[difficulty] : '–'}
    </span>
  )
}

// Criticality pairs a shape-coded glyph (ascending bars / urgent mark — level by
// shape, never color alone) with the level word, satisfying the text+glyph rule
// while staying compact. Unset renders a calm dash, not an alert.
export function CriticalityIndicator({ criticality }: { criticality?: BacklogCriticality }): JSX.Element {
  if (!criticality) {
    return (
      <span
        role="img"
        aria-label="No priority set"
        className="w-[5.5rem] shrink-0 text-right text-[11px] text-[color:var(--text-disabled)]"
      >
        –
      </span>
    )
  }
  const urgent = criticality === 'high' || criticality === 'critical'
  return (
    <span
      className={`inline-flex w-[5.5rem] shrink-0 items-center justify-end gap-1 text-[11px] ${
        urgent ? 'font-medium text-[color:var(--text-default)]' : 'text-[color:var(--text-subtle)]'
      }`}
    >
      <CriticalityGlyph criticality={criticality} />
      {CRITICALITY_LABEL[criticality]}
    </span>
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
