import { memo } from 'react'

import { ChipButton, IconButton, LifecycleGlyph, StarGlyph, Tooltip, TruncatedText, type LifecycleState } from '../ui'
import { BacklogTypeGlyph } from './BacklogTypeGlyph'
import type {
  BacklogCriticality,
  BacklogDifficulty,
  BacklogHighlightColor,
  BacklogItem,
  BacklogItemStatus,
} from '../../utils/backlog'
import type { BacklogEpicGroup, BacklogEpicMeta, BacklogEpicProgress } from '../../utils/backlogEpics'
import type { BacklogDependencyState, BacklogEpicBlockedRollup } from '../../utils/backlogDependencies'
import { getHighlightSwatch } from '../../utils/highlight'
import { CRITICALITY_LABEL, DIFFICULTY_LABEL, DIFFICULTY_WORD } from '../../utils/backlogTriage'
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

// The derived-blocked presentation word. Not a BacklogItemStatus — nothing is
// persisted; a stored `ready` gated by unresolved prerequisites *presents* as
// this instead of Ready (see backlogDependencies.isBlocked).
export const BACKLOG_BLOCKED_LABEL = 'Blocked'

// Canonical backlog row interior, shared by every surface that lists backlog
// items so they cannot drift. The selectable wrapper (listbox option, drag,
// click target) stays with each consumer; only the visual content lives here.
//
// Primary line: a leading readiness glyph is the row's status marker, then the
// title — the row's one priority — claims the entire width. Supporting line: the
// `KEY-n` id, size, and criticality bars flow from the left, with how long ago
// the item was touched holding the right. Everything except the glyph and title
// rides the supporting line so the title stays legible even when the panel is
// squeezed narrow; the type (feature/bug/…) lives in metadata and no longer
// earns a glyph, and the excerpt is dropped — at this width it only ever showed
// a few clipped words, so its space goes to the title instead.
// React.memo so a panel re-render only reconciles rows whose props actually
// changed. `item` is referentially stable between scans and `now` ticks every
// 30s, so the default shallow comparison lets unchanged rows skip rendering
// entirely. See backlog item Task 2.
// A small dot in an epic's identity colour (or a dashed neutral ring when the
// epic has no `color:` set). Shared by the row's member chip, the detail crumb,
// and the children roll-up so the epic always reads the same. The hex comes from
// the shared swatch helper (inline style — the same pattern the highlight
// swatch picker uses — so it never trips the design-token hex-in-className lint).
export function EpicColorDot({ color, size = 6 }: { color: BacklogHighlightColor | null; size?: number }): JSX.Element {
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

// The ink half of selection, for every Backlog row title (leaf rows and group
// headers alike): one rung below on an unpicked row so the lift is a real step,
// the same ramp `InboxRow` makes. On a pane that is not the one holding focus
// the selection-tier rules in assets/index.css rebind `--text-strong` on the row
// itself, so a selected title rests back down with its fill.
function titleInkClass(selected: boolean): string {
  return selected ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'
}

// Hover card for a backlog list row: the full (unclipped) title, the status
// word with the id (and an epic's completion), and the file path. The Backlog
// panel wraps each row in a Tooltip carrying this card, replacing the native
// `title` path tooltip; since the card always shows the full title, the host
// also sets `plainTitle` on the row content so the clipped-title tooltip
// doesn't stack a second popover over this one.
export function BacklogRowHoverCard({
  item,
  epicProgress,
  dependencyState,
}: {
  item: BacklogItem
  epicProgress?: BacklogEpicProgress
  /** Derived dependency marker (see backlogDependencies): 'blocked' replaces
   *  the status word so the card never claims Ready for a gated item. */
  dependencyState?: BacklogDependencyState | null
}): JSX.Element {
  const statusLabel = dependencyState === 'blocked' ? BACKLOG_BLOCKED_LABEL : BACKLOG_STATUS_LABEL[item.status]
  return (
    <span className="flex max-w-[300px] flex-col gap-0.5 py-0.5">
      <span className="whitespace-normal text-meta font-medium leading-snug text-[color:var(--text-strong)]">
        {item.title}
      </span>
      <span className="whitespace-normal text-[color:var(--text-muted)]">
        {statusLabel}
        {item.displayId ? ` · ${item.displayId}` : ''}
        {item.isEpic && epicProgress ? ` · ${epicProgress.done}/${epicProgress.total} complete` : ''}
      </span>
      <span className="whitespace-normal break-all font-mono text-micro text-[color:var(--text-subtle)]">
        {item.relativePath}
      </span>
    </span>
  )
}

export const BacklogRowContent = memo(function BacklogRowContent({
  item,
  now,
  dependencyState = null,
  epicBlocked,
  epicMeta,
  epicProgress,
  plainTitle = false,
  selected = false,
  onOpenEpic,
}: {
  item: BacklogItem
  now: number
  /** Derived dependency marker (never persisted; see backlogDependencies).
   *  'blocked' replaces the Ready presentation — glyph, label, and a "Blocked"
   *  badge — because unresolved prerequisites falsify the readiness claim.
   *  'waiting' keeps the status glyph and adds the softer "Waiting" badge.
   *  Absent for done/dependency-free items and for the source picker, which
   *  passes no dependency graph. */
  dependencyState?: BacklogDependencyState | null
  /** An epic row's granular dependency rollup: how many remaining children are
   *  blocked. Rendered as an "N blocked" count beside the progress meter — one
   *  gated child never freezes the container (that is dependencyState's job,
   *  set only when EVERY remaining child is blocked). */
  epicBlocked?: BacklogEpicBlockedRollup
  /** The epic identity (title/colour/id) this row renders with. For a member
   *  it is the PARENT epic, passed only in the flat (ungrouped) list so the
   *  member surfaces it as a small coloured pill (the grouped list omits it —
   *  the header already names it). For an epic row it is the epic's OWN
   *  identity, tinting the layers glyph and the progress meter. */
  epicMeta?: BacklogEpicMeta
  /** An epic row's true completion (completed/total children over the full
   *  scan). Leaf rows and surfaces without the rollup (source picker) omit it. */
  epicProgress?: BacklogEpicProgress
  /** Skip the clipped-title tooltip. Set by hosts that wrap the whole row in a
   *  hover card (which already carries the full title), so a clipped title
   *  never stacks two tooltips. */
  plainTitle?: boolean
  /** The row is the picked one — see `titleInkClass`. Hosts pass the same flag
   *  they give `backlogRowPaintClass`, so the fill and the ink cannot drift. A
   *  list whose selection lives elsewhere (a picker feeding another pane)
   *  leaves it unset and every row reads as unpicked. */
  selected?: boolean
  /** Makes the parent-epic pill a jump: clicking it opens the epic instead of
   *  selecting the member row. Hosts with cross-item navigation pass it; a
   *  host without (the source picker) leaves the pill inert. */
  onOpenEpic?: () => void
}): JSX.Element {
  // Blocked overrides the item's own status presentation: the stored `ready`
  // must never read as Ready while prerequisites are unresolved.
  const blocked = dependencyState === 'blocked'
  const lifecycle = blocked ? 'blocked' : backlogStatusToLifecycle(item.status)
  const statusLabel = blocked ? BACKLOG_BLOCKED_LABEL : BACKLOG_STATUS_LABEL[item.status]
  const titleInk = titleInkClass(selected)
  // Every row leads with its status glyph (the glyph-system placement rule) —
  // an epic included, so in-progress/completed/archived epics read at a glance.
  // The epic keeps its stacked-layers mark as a second, identity-coloured glyph
  // so the container still stands apart from its members.
  return (
    <>
      <div className="flex items-center gap-2">
        <Tooltip content={statusLabel} placement="top">
          {/* Static even when in_progress: the glyph animates only when genuinely
              live, and the item file is a record, not a live signal. */}
          <LifecycleGlyph state={lifecycle} live={false} />
        </Tooltip>
        {item.isEpic ? (
          <Tooltip content="Epic" placement="top" wrapperClassName="inline-flex shrink-0">
            <span
              className="inline-flex shrink-0"
              style={epicMeta?.color ? { color: getHighlightSwatch(epicMeta.color).hex } : undefined}
            >
              <BacklogTypeGlyph
                type="epic"
                label="Epic"
                className={`icon-sm ${epicMeta?.color ? '' : 'text-[color:var(--text-muted)]'}`}
              />
            </span>
          </Tooltip>
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {plainTitle ? (
            <span className={`min-w-0 truncate text-meta ${item.isEpic ? 'font-semibold' : 'font-medium'} ${titleInk}`}>
              {item.title}
            </span>
          ) : (
            <TruncatedText
              as="span"
              text={item.title}
              className={`min-w-0 text-meta ${item.isEpic ? 'font-semibold' : 'font-medium'} ${titleInk}`}
            />
          )}
          {/* Earned mark: the star exists only when starred — no placeholder
              outline on idle rows, same rule as the status dot. Matches the
              sidebar's starred-workspace glyph (color, size, name). */}
          {item.highlight?.starred ? (
            <StarGlyph filled className="icon-xs shrink-0 text-[color:var(--tone-warn)]" label="Starred" />
          ) : null}
        </span>
        {blocked ? <BlockedBadge /> : dependencyState != null ? <WaitingBadge /> : null}
        {item.danglingMockups && item.danglingMockups.length > 0 ? (
          <DanglingMockupBadge refs={item.danglingMockups} />
        ) : null}
      </div>
      {/* Supporting line: the triage metadata the title displaced — id, size,
          priority — flows from the left, and how long ago the item was touched
          holds the right. No excerpt: at this width it only ever showed a few
          clipped words, so the space goes to the title above instead. An epic
          carries no size/priority (it is a container, not a work item), so its
          slot holds the completion meter instead. */}
      <div className="mt-0.5 flex items-center gap-2 pl-[22px] text-micro">
        {item.displayId ? (
          <span className="shrink-0 font-mono tabular-nums text-[color:var(--text-subtle)]">{item.displayId}</span>
        ) : null}
        {item.isEpic ? (
          <>
            {epicProgress ? <EpicProgressMeter progress={epicProgress} color={epicMeta?.color ?? null} /> : null}
            {epicBlocked && epicBlocked.blocked > 0 ? <EpicBlockedCount rollup={epicBlocked} /> : null}
            {item.dependenciesPlanned !== true && !EPIC_ORDER_TERMINAL_STATUSES.has(item.status) ? (
              <UnorderedEpicMark />
            ) : null}
          </>
        ) : (
          <>
            <DifficultyIndicator difficulty={item.difficulty} />
            <CriticalityIndicator criticality={item.criticality} />
          </>
        )}
        {/* The parent-epic pill sits in the gap between the triage tokens and the
            right-aligned time. Its container carries the ml-auto (so the pill is
            pushed toward the time and the empty gap opens to its left) and clips
            on overflow; the time keeps a hard pl-2 gap so the pill can never
            touch it on a compressed panel. An epic row's epicMeta is its own
            identity, not a parent, so it never pills itself. */}
        {epicMeta && !item.isEpic ? (
          <div className="ml-auto flex min-w-0 shrink items-center overflow-hidden">
            <EpicPill epic={epicMeta} onOpen={onOpenEpic} />
          </div>
        ) : null}
        <span
          className={`${epicMeta && !item.isEpic ? 'pl-2' : 'ml-auto'} shrink-0 tabular-nums text-[color:var(--text-subtle)]`}
        >
          {formatRelativeMsAgo(item.modifiedAt, now) || 'unknown'}
        </span>
      </div>
    </>
  )
})

// The epic completion readout: a slim identity-coloured fill bar beside the
// `done/total` fraction. The numbers are the signal (the bar is decorative and
// aria-hidden inside the one accessible name), so meaning never rides on colour
// alone; an epic with no `color:` fills in the accent. Shared by the flat epic
// row and the grouped epic header so the two readouts can't drift.
export function EpicProgressMeter({
  progress,
  color,
}: {
  progress: BacklogEpicProgress
  color: BacklogHighlightColor | null
}): JSX.Element {
  const { done, total } = progress
  const percent = total > 0 ? Math.round((done / total) * 100) : 0
  const fill = color ? getHighlightSwatch(color).hex : 'var(--accent-primary)'
  return (
    <span
      role="img"
      aria-label={`${done} of ${total} complete`}
      // No min-w-0 here: the meter's floor is its min-content — the fraction
      // text — so a squeezed panel collapses the BAR (min-w-0, down to nothing)
      // and the numbers never paint over the right-aligned time.
      className="inline-flex shrink items-center gap-1.5"
    >
      <span
        aria-hidden="true"
        className="h-[3px] w-16 min-w-0 shrink overflow-hidden rounded-full bg-[color:var(--border-default)]"
      >
        <span className="block h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: fill }} />
      </span>
      <span aria-hidden="true" className="shrink-0 font-mono tabular-nums text-[color:var(--text-muted)]">
        {done}/{total}
      </span>
    </span>
  )
}

// Derived "waiting" marker: this item is active and at least one prerequisite is
// unresolved (see backlogDependencies). The word carries the meaning — never
// color alone — and an hourglass glyph shape-codes it; the whole token is one
// accessible name so a screen reader reads "Waiting on prerequisites" rather
// than a bare icon. Calm muted tone, no tinted pill: it is metadata beside the
// size/priority tokens, not a second status dot competing with the lifecycle
// glyph. Rendered only on waiting rows (earned, like the star).
// Derived "blocked" marker beside the title: this ready item's prerequisites
// are unresolved, so it presents as gated rather than startable. The word
// carries the meaning (never color alone) and the mini ring-with-bar echoes the
// row's Blocked lifecycle glyph; one accessible name so a screen reader reads
// the sentence, not a bare icon. Same calm muted tone as Waiting — a gate is
// ordinary sequencing, not a defect. Rendered only on blocked rows (earned).
function BlockedBadge(): JSX.Element {
  return (
    <span
      role="img"
      aria-label="Blocked by prerequisites"
      className="inline-flex shrink-0 items-center gap-1 text-micro font-medium text-[color:var(--text-muted)]"
    >
      <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0" aria-hidden="true">
        <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5.6 8h4.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      Blocked
    </span>
  )
}

// An epic's granular dependency readout: `N blocked` of the remaining children.
// A count, deliberately not a status flip — partial blockage never freezes the
// container. Sits beside the progress meter in the same muted metadata tone;
// the accessible name spells out the fraction the visible token abbreviates.
function EpicBlockedCount({ rollup }: { rollup: BacklogEpicBlockedRollup }): JSX.Element {
  return (
    <span
      role="img"
      aria-label={`${rollup.blocked} of ${rollup.remaining} remaining ${rollup.remaining === 1 ? 'item' : 'items'} blocked by prerequisites`}
      className="inline-flex shrink-0 items-center gap-1 text-micro text-[color:var(--text-muted)]"
    >
      <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0" aria-hidden="true">
        <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5.6 8h4.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      <span aria-hidden="true" className="tabular-nums">
        {rollup.blocked} blocked
      </span>
    </span>
  )
}

// An epic whose work is over has no ordering left to plan, so the mark below
// would be pure noise on it.
const EPIC_ORDER_TERMINAL_STATUSES: ReadonlySet<BacklogItemStatus> = new Set<BacklogItemStatus>([
  'completed',
  'archived',
])

// The epic ordering mark, on the epic row so an epic whose ordering
// was never declared finished is visible before anyone starts work from it. It
// reads the ABSENCE of `dependenciesPlanned: true` because that is the state
// with something left to do — a marked epic is simply ready and earns no token,
// the same rule the star and the status dot follow.
//
// Small and muted, deliberately not a status: it changes nothing about what the
// epic IS, only that whoever picks it up has to work out the order first.
const UNORDERED_EPIC_LABEL = 'Order not planned'

function UnorderedEpicMark(): JSX.Element {
  const explanation =
    'Ordering not marked done — work started from this epic has to plan first. ' +
    'Set `dependenciesPlanned: true` on the epic once its children’s order is authored ' +
    '(no dependsOn edges at all is a valid answer: it means deliberately parallel).'
  return (
    <Tooltip content={explanation} placement="top" wrapperClassName="inline-flex shrink-0">
      <span
        role="img"
        aria-label={explanation}
        className="inline-flex shrink-0 items-center gap-1 text-micro text-[color:var(--text-muted)]"
      >
        <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0" aria-hidden="true">
          <path d="M3 4.5h6M3 8h4M3 11.5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path
            d="M11 5.5l3 5M14 5.5l-3 5"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            opacity=".7"
          />
        </svg>
        <span aria-hidden="true">{UNORDERED_EPIC_LABEL}</span>
      </span>
    </Tooltip>
  )
}

// Data-integrity warning beside the title: a mockup this item names — attached or
// referenced in the body — resolves to no file on disk after the tolerant
// both-roots check. This is the root-cause surface for the failure that
// motivated the item: a path-prefix slip once hid the one artifact carrying the
// requirement, so the reference is SHOWN, never silently dropped. A defect, not
// ordinary sequencing — so it carries the warning tone (not the calm muted tone of
// Blocked/Waiting) and a triangle glyph; the word "Missing mockup" carries the
// meaning (never colour alone) and the accessible name spells out which refs and
// how to fix. Earned — rendered only when a reference actually dangles.
function DanglingMockupBadge({ refs }: { refs: readonly string[] }): JSX.Element {
  const label =
    refs.length === 1
      ? `Missing mockup: ${refs[0]} was not found on disk — fix the path or remove the reference`
      : `${refs.length} missing mockups: ${refs.join(', ')} were not found on disk — fix the paths or remove the references`
  return (
    <Tooltip content={label} placement="top" wrapperClassName="inline-flex shrink-0">
      <span
        role="img"
        aria-label={label}
        className="inline-flex shrink-0 items-center gap-1 text-micro font-medium text-[color:var(--tone-warn)]"
      >
        <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0" aria-hidden="true">
          <path d="M8 2.75 14.5 13.5h-13z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M8 6.4v3.1M8 11.4h.01" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        {refs.length === 1 ? 'Missing mockup' : `${refs.length} missing mockups`}
      </span>
    </Tooltip>
  )
}

function WaitingBadge(): JSX.Element {
  return (
    <span
      role="img"
      aria-label="Waiting on prerequisites"
      className="inline-flex shrink-0 items-center gap-1 text-micro font-medium text-[color:var(--text-muted)]"
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
function EpicPill({ epic, onOpen }: { epic: BacklogEpicMeta; onOpen?: () => void }): JSX.Element {
  const swatch = epic.color ? getHighlightSwatch(epic.color) : null
  const label = epic.displayId ?? epic.title
  // No vertical padding: the pill's own line box already stands it a hair
  // proud of the 11px supporting line, so a row's height no longer depends
  // on whether the item has a parent epic.
  const pillClass =
    'inline-flex min-w-0 max-w-[14ch] shrink items-center gap-1 rounded-full border px-1.5 text-micro font-medium text-[color:var(--text-muted)]'
  const pillStyle = swatch
    ? { borderColor: `${swatch.hex}59`, backgroundColor: `${swatch.hex}1f` }
    : { borderColor: 'var(--border-default)' }
  const body = (
    <>
      <EpicColorDot color={epic.color} size={6} />
      <span aria-hidden="true" className="min-w-0 truncate font-mono tabular-nums">
        {label}
      </span>
    </>
  )
  return (
    <Tooltip
      content={onOpen ? `Open epic: ${epic.title}` : epic.title}
      placement="top"
      wrapperClassName="inline-flex min-w-0 shrink"
    >
      {onOpen ? (
        // The one nested control inside a clickable row: the pill claims its own
        // click (stopPropagation) so opening the epic never also re-selects the
        // member row underneath it.
        <ChipButton
          aria-label={`Open epic ${epic.title}`}
          // The epic's hue as the kit's IDENTITY tint: its own ink over a 12% mix
          // of itself, which is the weight every other identity mark in the
          // system carries. The display-only form below keeps its own pill.
          tint={swatch?.hex}
          onClick={(event) => {
            event.stopPropagation()
            onOpen()
          }}
          className="max-w-[14ch] shrink"
        >
          {body}
        </ChipButton>
      ) : (
        <span role="img" aria-label={`Epic: ${epic.title}`} className={pillClass} style={pillStyle}>
          {body}
        </span>
      )}
    </Tooltip>
  )
}

// Size reads as the t-shirt token itself (XS/S/M/L/XL) — text is the signal, so
// it never depends on color. Right-aligned, fixed-width, tabular so the column
// scans straight down; unestimated is a calm dash, never a warning. The tooltip
// spells the size out in full (the row shows no other size label).
export function DifficultyIndicator({ difficulty }: { difficulty?: BacklogDifficulty }): JSX.Element {
  return (
    <Tooltip
      content={difficulty ? `Size: ${DIFFICULTY_WORD[difficulty]}` : 'Size unestimated'}
      placement="top"
      wrapperClassName="inline-flex shrink-0"
    >
      <span
        role="img"
        aria-label={difficulty ? `Size ${DIFFICULTY_WORD[difficulty]}` : 'Size unestimated'}
        className={`w-[2.25ch] shrink-0 text-right font-mono text-micro tabular-nums ${
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
          className="w-4 shrink-0 text-right text-micro text-[color:var(--text-disabled)]"
        >
          –
        </span>
      </Tooltip>
    )
  }
  const urgent = criticality === 'high' || criticality === 'critical'
  return (
    <Tooltip
      content={`Priority: ${CRITICALITY_LABEL[criticality]}`}
      placement="top"
      wrapperClassName="inline-flex shrink-0"
    >
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
// its left color stripe). A disclosure chevron toggles the group; an epic header
// then carries the epic's own status glyph (so in-progress/completed/archived
// read without expanding), the title sits in heavier weight than a leaf row so
// headers read as structure, and the completion rollup is the true full-scan
// `progress` when the panel supplies it — the group's own child list is the
// FILTERED view, so counting it zeroes the fraction under any lens that hides
// members (Epics hides all of them; Active hides the completed ones). Unknown
// groups surface their dangling slug so an orphaned `epic:` is identifiable.
export function BacklogEpicHeaderContent({
  group,
  collapsed,
  onToggleCollapse,
  progress,
  dependencyState,
  blockedRollup,
  selected = false,
}: {
  group: BacklogEpicGroup
  collapsed: boolean
  onToggleCollapse: () => void
  /** True full-scan completion for this group's slug; falls back to the
   *  view-relative group rollup when absent (the no-epic bucket). */
  progress?: BacklogEpicProgress
  /** The epic's derived dependency marker: 'blocked' (every remaining child
   *  gated, or the epic's own prerequisites unresolved) overrides its status
   *  glyph, exactly as on the flat epic row. */
  dependencyState?: BacklogDependencyState | null
  /** The granular children rollup for the "N blocked" count beside the meter. */
  blockedRollup?: BacklogEpicBlockedRollup
  /** A header is a selectable row like any other — see `titleInkClass`. */
  selected?: boolean
}): JSX.Element {
  const { done, total } = progress ?? group.progress
  const blocked = dependencyState === 'blocked'
  return (
    <div className="flex items-center gap-1.5">
      {/* The kit's icon button (26px, the one control-xs square): this was a 16px
          square under the 24px hit-target floor. Pulled back by its own padding
          so the chevron's glyph still sits where the 16px one did. */}
      <IconButton
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
        className="-my-1 -ml-1.5 shrink-0"
      >
        <DisclosureChevron expanded={!collapsed} />
      </IconButton>
      {group.kind === 'epic' && group.epic ? (
        <Tooltip content={blocked ? BACKLOG_BLOCKED_LABEL : BACKLOG_STATUS_LABEL[group.epic.status]} placement="top">
          <LifecycleGlyph state={blocked ? 'blocked' : backlogStatusToLifecycle(group.epic.status)} />
        </Tooltip>
      ) : null}
      <TruncatedText
        as="span"
        text={group.title}
        className={`min-w-0 flex-1 text-meta font-semibold ${titleInkClass(selected)}`}
      />
      {group.kind === 'unknown' && group.slug ? (
        <TruncatedText
          as="span"
          text={group.slug}
          className="max-w-[10rem] shrink-0 font-mono text-micro text-[color:var(--text-muted)]"
        />
      ) : null}
      {group.kind === 'epic' ? (
        <span className="flex shrink-0 items-center gap-2 text-micro">
          {blockedRollup && blockedRollup.blocked > 0 ? <EpicBlockedCount rollup={blockedRollup} /> : null}
          <EpicProgressMeter progress={{ done, total }} color={group.color} />
        </span>
      ) : (
        <span
          className="shrink-0 tabular-nums text-micro text-[color:var(--text-subtle)]"
          aria-label={`${done} of ${total} complete`}
        >
          {done}/{total}
        </span>
      )}
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
