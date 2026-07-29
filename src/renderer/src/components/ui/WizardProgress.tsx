import React from 'react'

import { CheckIcon } from '../AppIcons'

export type WizardProgressProps = {
  /** Total number of steps in the flow. */
  total: number
  /** 0-based index of the currently active step. */
  active: number
  /**
   * Optional count of completed steps. When omitted, every step before
   * `active` is treated as done (the simple-wizard default). Set this when
   * the active step itself may still be working — e.g., the guided-brief
   * flow keeps the active dash highlighted while the prior dashes mark
   * actually-completed sub-stages.
   */
  done?: number
  /** Optional accessible label override. Defaults to `Step <n> of <total>`. */
  ariaLabel?: string
  /** Optional descriptive name for the current step, appended to the label. */
  currentStepLabel?: string
  /**
   * Optional per-step names, used to label the back-jump controls. Index-aligned
   * with the dashes; only consulted when `onStepSelect` is set.
   */
  stepLabels?: string[]
  /**
   * Optional back-jump handler. When set, every already-completed step becomes a
   * focusable jump control that calls this with the target step index, so users
   * can return to a finished step. The jump controls live in a sibling group
   * layered over the dashes — the progressbar element itself stays a
   * non-interactive status indicator. Upcoming and current steps stay inert.
   */
  onStepSelect?: (index: number) => void
  /**
   * Rendering variant. 'dashes' (default) is the anonymous hairline-dash strip.
   * 'labeled' renders each step's name inline — done steps ticked (and
   * clickable when `onStepSelect` is set), the current step marked with a dot —
   * so a longer flow reads as named stations rather than a count. Requires
   * `stepLabels`; falls back to dashes without them.
   */
  variant?: 'dashes' | 'labeled'
}

/**
 * Horizontal step indicator used by multi-step flows (new-workspace wizard,
 * guided brief). Renders one hairline dash per step, with the active dash
 * highlighted and completed dashes filled.
 */
export function WizardProgress({
  total,
  active,
  done,
  ariaLabel,
  currentStepLabel,
  stepLabels,
  onStepSelect,
  variant = 'dashes',
}: WizardProgressProps) {
  const doneCount = done ?? active
  const step = Math.min(total, active + 1)
  const baseLabel = ariaLabel ?? `Step ${step} of ${total}`
  const fullLabel = currentStepLabel ? `${baseLabel} · ${currentStepLabel}` : baseLabel
  // One descriptor per dash. `isDone` is the single source of truth for both the
  // completed-dash fill and (when enabled) which steps can be jumped back to.
  const stepStates = Array.from({ length: total }).map((_, idx) => {
    const isCurrent = idx === active
    return { idx, isCurrent, isDone: idx < doneCount && !isCurrent }
  })

  if (variant === 'labeled' && stepLabels?.length) {
    return (
      <nav aria-label={fullLabel} className="flex min-w-0 flex-1 items-center justify-center gap-4">
        {stepStates.map(({ idx, isCurrent, isDone }) => {
          const label = stepLabels[idx] ?? `Step ${idx + 1}`
          const body = (
            <>
              {/* The step's own name carries the meaning, so the tick is a
                  silent mark that inherits the station's ink. */}
              {isDone ? <CheckIcon className="icon-xs shrink-0" /> : null}
              {isCurrent ? (
                <span aria-hidden="true" className="h-[5px] w-[5px] rounded-full bg-[color:var(--accent-primary)]" />
              ) : null}
              {label}
            </>
          )
          // Only completed steps are interactive (back-jump); the current and
          // upcoming steps stay inert status text.
          if (isDone && onStepSelect) {
            return (
              <button
                key={idx}
                type="button"
                onClick={() => onStepSelect(idx)}
                aria-label={`Go back to step ${idx + 1}: ${label}`}
                className="
                  inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] font-medium text-[color:var(--text-muted)]
                  transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
                "
              >
                {body}
              </button>
            )
          }
          return (
            <span
              key={idx}
              aria-current={isCurrent ? 'step' : undefined}
              className={`inline-flex items-center gap-1.5 px-1 py-0.5 text-[11px] font-medium ${
                isCurrent
                  ? 'text-[color:var(--text-strong)]'
                  : isDone
                    ? 'text-[color:var(--text-muted)]'
                    : 'text-[color:var(--text-subtle)]'
              }`}
            >
              {body}
            </span>
          )
        })}
      </nav>
    )
  }

  const progressbar = (
    <div
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={step}
      aria-label={fullLabel}
      className="flex min-w-0 flex-1 items-center gap-1.5"
    >
      {stepStates.map(({ idx, isCurrent, isDone }) => (
        <span
          key={idx}
          aria-hidden="true"
          className={`h-[3px] flex-1 rounded-full transition-colors duration-300 ${
            isCurrent
              ? 'bg-[color:var(--text-strong)]'
              : isDone
                ? 'bg-[color:var(--text-disabled)]'
                : 'bg-[color:var(--border-default)]'
          }`}
        />
      ))}
    </div>
  )

  // Without a back-jump handler the progressbar is the whole control.
  if (!onStepSelect) return progressbar

  // Back-jump enabled: keep the progressbar non-interactive and lay a sibling
  // group of jump controls over it. Each cell is flex-1 with the same gap as the
  // dashes, so the completed-step buttons align exactly over their dashes; the
  // group extends past the dashes vertically (-inset-y-2) for an easy hit area.
  return (
    <div className="relative flex min-w-0 flex-1 items-center">
      {progressbar}
      <div
        role="group"
        aria-label="Jump to a completed step"
        className="absolute inset-x-0 -inset-y-2 flex items-center gap-1.5"
      >
        {stepStates.map(({ idx, isDone }) => {
          if (!isDone) return <span key={idx} aria-hidden="true" className="flex-1" />
          const stepLabel = stepLabels?.[idx]
          return (
            <button
              key={idx}
              type="button"
              onClick={() => onStepSelect(idx)}
              aria-label={
                stepLabel
                  ? `Go back to step ${idx + 1}: ${stepLabel}`
                  : `Go back to step ${idx + 1}`
              }
              className="h-full flex-1 rounded-full outline-none transition-colors hover:bg-[color:var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]"
            />
          )
        })}
      </div>
    </div>
  )
}
