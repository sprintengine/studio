import { useRef } from 'react'
import { GhostButton, IconButton, OutlineButton } from '../../ui'
import {
  annotateSubmitLabel,
  annotationDisplayRect,
  type AnnotateSubmitState,
} from './annotateModel'
import type { AnnotationRect, MockupAnnotation } from './types'

// The floating batch tray (MC-1468 batch-first decision): pending notes
// accumulate here and leave as ONE submit. At rest it is a compact strip —
// count, Clear, and the send action; the count expands the numbered list
// (numbers mirror the pins, so identity is never color-only) with per-note
// edit/remove. A failed submit keeps the batch and says so; nothing is
// silently dropped.
//
// The strip and its buttons sit on the control radius, not `rounded-full`: a
// pill is for dots, avatars and badges, and a rectangular control in a capsule
// was a third radius on the canvas (audit, radii-off-the-ramp). Send is the
// outline button — the annotate composer's commit is the surface's one primary
// (ruling 9), and two accent fills were on screen whenever a batch existed
// while the composer was open.

type Props = {
  annotations: readonly MockupAnnotation[]
  anchors: Readonly<Record<string, AnnotationRect | null>>
  submitState: AnnotateSubmitState
  listOpen: boolean
  /** Host-named send action ("Send to designer"); defaults to "Send N notes".
   * The count still reads on the tray's leading chip either way. */
  submitLabel?: string
  onToggleList: () => void
  onEdit: (index: number) => void
  onRemove: (index: number) => void
  onClear: () => void
  onSend: () => void
}

export function AnnotateTray({
  annotations,
  anchors,
  submitState,
  listOpen,
  submitLabel,
  onToggleList,
  onEdit,
  onRemove,
  onClear,
  onSend,
}: Props) {
  const countButtonRef = useRef<HTMLButtonElement | null>(null)
  const submitting = submitState.kind === 'submitting'

  return (
    <div
      className="pointer-events-auto absolute bottom-3 left-1/2 z-[var(--z-pane)] flex w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-col items-center gap-2"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && listOpen) {
          event.stopPropagation()
          onToggleList()
          countButtonRef.current?.focus()
        }
      }}
    >
      {listOpen ? (
        <ul
          aria-label="Pending notes"
          className="max-h-48 w-[300px] max-w-full overflow-y-auto rounded-[var(--radius-md)] border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] py-1 shadow-[var(--shadow-drawer)]"
        >
          {annotations.map((annotation, index) => {
            const unanchored = annotationDisplayRect(annotation, anchors) === null
            return (
              <li key={`${annotation.selector}::${index}`} className="group flex items-start gap-2 px-2.5 py-1.5">
                <span
                  aria-hidden="true"
                  className="mt-0.5 grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-[color:var(--annotate-pin-bg)] px-1 text-micro font-semibold tabular-nums text-[color:var(--annotate-pin-ink)]"
                >
                  {index + 1}
                </span>
                {/* `inline` is the one step that spends no height, and `ink` the one
                    tone that takes no ground: the note's body IS the row, and a
                    26px box or a fill would set the list's rhythm instead of
                    riding it. */}
                <GhostButton
                  size="inline"
                  align="start"
                  tone="ink"
                  disabled={submitting}
                  onClick={() => onEdit(index)}
                  aria-label={`Edit note ${index + 1}: ${annotation.message}`}
                  className="min-w-0 flex-1"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="line-clamp-2 text-meta leading-5 text-[color:var(--text-default)]">
                      {annotation.message}
                    </span>
                    {unanchored ? (
                      <span className="text-micro text-[color:var(--tone-warn)]">
                        Unanchored — this element is no longer in the file
                      </span>
                    ) : null}
                  </span>
                </GhostButton>
                {/* Revealed on hover AND on keyboard focus inside the row; the
                    drawn square is the kit's 22px step, whose hit target still
                    pads out to the 24px floor. */}
                <IconButton
                  size="2xs"
                  tone="subtle"
                  disabled={submitting}
                  onClick={() => onRemove(index)}
                  aria-label={`Remove note ${index + 1}`}
                  className="mt-0.5 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <svg viewBox="0 0 12 12" className="icon-xs" fill="none" aria-hidden="true">
                    <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </IconButton>
              </li>
            )
          })}
        </ul>
      ) : null}
      {submitState.kind === 'failed' ? (
        <div
          role="alert"
          className="max-w-[360px] rounded-md border border-[color:var(--border-default)] bg-[color:var(--tone-warn-soft)] px-3 py-1.5 text-micro leading-4 text-[color:var(--tone-warn-on-tint)]"
        >
          {submitState.reason}
        </div>
      ) : null}
      <div className="flex items-center gap-1 rounded-[var(--radius-md)] border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] p-1 shadow-[var(--shadow-drawer)]">
        {/* `strong`: the ink stays put and only the ground moves, because hovering
            the control that opens the list must not read as dimming it. */}
        <GhostButton
          ref={countButtonRef}
          size="xs"
          tone="strong"
          onClick={onToggleList}
          aria-expanded={listOpen}
        >
          <span className="tabular-nums font-semibold">{annotations.length}</span>
          note{annotations.length === 1 ? '' : 's'}
          <svg
            viewBox="0 0 10 10"
            className={`h-2.5 w-2.5 text-[color:var(--text-subtle)] ${listOpen ? 'rotate-180' : ''}`}
            fill="none"
            aria-hidden="true"
          >
            <path d="M2 6.5 5 3.5l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </GhostButton>
        <GhostButton size="xs" tone="subtle" disabled={submitting} onClick={onClear}>
          Clear
        </GhostButton>
        <OutlineButton size="xs" disabled={submitting || annotations.length === 0} onClick={onSend}>
          {submitting ? 'Sending…' : submitLabel ?? annotateSubmitLabel(annotations.length)}
        </OutlineButton>
      </div>
    </div>
  )
}
