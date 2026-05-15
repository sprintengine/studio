import React, { useRef } from 'react'
import { useFlipReorder } from '../../utils/flipReorder'

// BoardLane — canonical lane chrome for Switchboard, Sprint Engine, and any
// future board panel that needs a min-260 px column with a header, a
// FLIP-animated scrollable list, and optional drag-and-drop.
//
// The lane primitive owns:
//   - The flex column section with `min-w-[260px] flex-1`
//   - The header rhythm (label + optional glyph + count) matching the
//     Switchboard pattern documented in
//     knowledge/brand/panel-design-system.md
//   - The scrollable `<ol>` body with FLIP wired via useFlipReorder
//   - The visual state classes for the four drag states (default, dimmed,
//     legal-drop-target, source)
//   - The DnD event plumbing — `onDragOver` callbacks receive the computed
//     drop index, derived from the lane's own list ref + the canonical
//     `[data-task-card]` selector (TaskCard sets this; do not query
//     `[data-card]` — that legacy selector never matched the primitive)
//
// The lane does NOT own:
//   - Which cards to render (caller composes <TaskCard> children directly)
//   - The drop-indicator interleaving (caller interleaves
//     `<BoardLaneDropIndicator />` between cards based on the dropIndex
//     they hold in state)
//   - Empty-state copy (caller renders the empty placeholder as one of the
//     children when the records list is empty)
//
// Sprint Engine passes no `dnd` prop (gate-driven transitions). Switchboard
// passes the three handlers and renders DropIndicator children at the
// computed index. The visual state prop maps to:
//   default            — no special chrome
//   dimmed             — 40 % opacity (lane is not a legal drop target)
//   legal-drop-target  — accent ring (lane will accept the dragged card)
//   source             — neutral (the lane the card is being dragged from)

type LaneState = 'default' | 'dimmed' | 'legal-drop-target' | 'source'

type BoardLaneDnd = {
  /** Receives the computed drop index. Caller stores in state and
   *  interleaves `<BoardLaneDropIndicator />` children at that index. */
  onDragOver: (dropIndex: number) => void
  onDragLeave: () => void
  onDrop: () => void
}

type BoardLaneProps = {
  /** Sentence-case lane label. Renders semibold + strong ink. */
  label: string
  /** Optional leading glyph (e.g. StatusIcon). Sized at 14 px to align with
   *  the label's cap-height. */
  glyph?: React.ReactNode
  /** Item count. Rendered tabular-nums + subtle. */
  count: number
  /** Aria-label for the section. Defaults to `${label} lane`. */
  ariaLabel?: string
  /** FLIP signature. Typically `ids.join(',')`. Changing this triggers the
   *  reorder animation. */
  flipKey: string
  /** Drag state. See module header for the four-state matrix. */
  state?: LaneState
  /** DnD plumbing. Pass only when the lane participates in drag-and-drop. */
  dnd?: BoardLaneDnd
  /** Children rendered inside the lane's `<ol>`. Caller composes TaskCards
   *  (and DropIndicators when DnD is active). */
  children: React.ReactNode
}

function computeDropIndex(list: HTMLOListElement, clientY: number): number {
  const cards = list.querySelectorAll('[data-task-card]')
  for (let i = 0; i < cards.length; i += 1) {
    const rect = cards[i].getBoundingClientRect()
    if (clientY < rect.top + rect.height / 2) return i
  }
  return cards.length
}

/** Exposed helper — same algorithm `BoardLane` uses internally. Callers can
 *  reach for this if they need to compute a drop index outside the lane's
 *  own onDragOver (e.g., for keyboard-driven move targets). */
export function computeBoardLaneDropIndex(
  list: HTMLOListElement,
  clientY: number,
): number {
  return computeDropIndex(list, clientY)
}

export function BoardLane({
  label,
  glyph,
  count,
  ariaLabel,
  flipKey,
  state = 'default',
  dnd,
  children,
}: BoardLaneProps) {
  const listRef = useRef<HTMLOListElement | null>(null)
  useFlipReorder(listRef, flipKey)

  const sectionClass = [
    'flex h-full min-w-[260px] flex-1 flex-col transition-colors',
    state === 'legal-drop-target' ? 'ring-1 ring-[color:var(--accent-primary)]' : '',
    state === 'dimmed' ? 'opacity-40' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <section
      className={sectionClass}
      aria-label={ariaLabel ?? `${label} lane`}
      onDragOver={
        dnd
          ? (event) => {
              const list = listRef.current
              if (!list) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              dnd.onDragOver(computeDropIndex(list, event.clientY))
            }
          : undefined
      }
      onDragLeave={
        dnd
          ? (event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
              dnd.onDragLeave()
            }
          : undefined
      }
      onDrop={
        dnd
          ? (event) => {
              event.preventDefault()
              dnd.onDrop()
            }
          : undefined
      }
    >
      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-2.5">
        <span className="flex min-w-0 items-center gap-1.5">
          {glyph}
          <span className="truncate text-[12px] font-semibold text-[color:var(--text-strong)]">
            {label}
          </span>
        </span>
        <span className="shrink-0 tabular-nums text-[11px] text-[color:var(--text-subtle)]">
          {count}
        </span>
      </div>
      <ol ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 py-2">
        {children}
      </ol>
    </section>
  )
}

/** 2 px accent hairline rendered as an `<li>` so it lives inside the lane's
 *  `<ol>` list semantics. Caller places one between cards at the computed
 *  drop index. */
export function BoardLaneDropIndicator() {
  return (
    <li aria-hidden="true" className="-my-1 list-none">
      <div className="h-[2px] rounded-full bg-[color:var(--accent-primary)]" />
    </li>
  )
}
