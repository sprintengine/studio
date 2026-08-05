import { useRef } from 'react'
import {
  annotateSubmitLabel,
  annotationDisplayRect,
  type AnnotateSubmitState,
} from './annotateModel'
import type { AnnotationRect, MockupAnnotation } from './types'

// The floating batch tray (MC-1468 batch-first decision): pending notes
// accumulate here and leave as ONE submit. At rest it is a compact pill —
// count, Clear, and the send action; the count expands the numbered list
// (numbers mirror the pins, so identity is never color-only) with per-note
// edit/remove. A failed submit keeps the batch and says so; nothing is
// silently dropped.

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
      className="pointer-events-auto absolute bottom-3 left-1/2 z-20 flex w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-col items-center gap-2"
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
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => onEdit(index)}
                  aria-label={`Edit note ${index + 1}: ${annotation.message}`}
                  className="
                    min-w-0 flex-1 text-left focus-visible:focus-ring disabled:opacity-60
                  "
                >
                  <span className="line-clamp-2 text-meta leading-5 text-[color:var(--text-default)]">
                    {annotation.message}
                  </span>
                  {unanchored ? (
                    <span className="text-micro text-[color:var(--tone-warn)]">
                      Unanchored — this element is no longer in the file
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => onRemove(index)}
                  aria-label={`Remove note ${index + 1}`}
                  className="
                    mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm
                    text-[color:var(--text-subtle)] opacity-0 transition-opacity
                    hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]
                    focus-visible:focus-ring
                    focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100
                    disabled:opacity-0
                  "
                >
                  <svg viewBox="0 0 12 12" className="icon-xs" fill="none" aria-hidden="true">
                    <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </button>
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
      <div className="flex items-center gap-1 rounded-full border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] py-1 pl-1 pr-1 shadow-[var(--shadow-drawer)]">
        <button
          ref={countButtonRef}
          type="button"
          onClick={onToggleList}
          aria-expanded={listOpen}
          className="
            inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-micro text-[color:var(--text-strong)]
            transition-colors hover:bg-[color:var(--bg-hover)]
            focus-visible:focus-ring
          "
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
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={onClear}
          className="
            inline-flex h-6 items-center rounded-full px-2 text-micro text-[color:var(--text-subtle)]
            transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]
            disabled:opacity-60
            focus-visible:focus-ring
          "
        >
          Clear
        </button>
        <button
          type="button"
          disabled={submitting || annotations.length === 0}
          onClick={onSend}
          className="
            inline-flex h-6 items-center rounded-full bg-[color:var(--accent-primary)] px-3 text-micro font-medium
            text-[color:var(--text-on-accent)] transition-colors disabled:opacity-60 enabled:hover:opacity-90
            focus-visible:focus-ring
          "
        >
          {submitting ? 'Sending…' : submitLabel ?? annotateSubmitLabel(annotations.length)}
        </button>
      </div>
    </div>
  )
}
