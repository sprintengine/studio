import React from 'react'

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
   * Optional back-jump handler. When set, every already-completed dash (before
   * `active`) becomes a focusable button that calls this with the target step
   * index, so users can jump back to a finished step. Upcoming and current steps
   * stay non-interactive.
   */
  onStepSelect?: (index: number) => void
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
}: WizardProgressProps) {
  const doneCount = done ?? active
  const step = Math.min(total, active + 1)
  const baseLabel = ariaLabel ?? `Step ${step} of ${total}`
  const fullLabel = currentStepLabel ? `${baseLabel} · ${currentStepLabel}` : baseLabel
  return (
    <div
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={step}
      aria-label={fullLabel}
      className="flex min-w-0 flex-1 items-center gap-1.5"
    >
      {Array.from({ length: total }).map((_, idx) => {
        const isCurrent = idx === active
        const isDone = idx < doneCount && !isCurrent
        const dashClass = `h-[3px] flex-1 rounded-full transition-colors duration-300 ${
          isCurrent
            ? 'bg-[color:var(--text-strong)]'
            : isDone
              ? 'bg-[color:var(--text-disabled)]'
              : 'bg-[color:var(--border-default)]'
        }`
        // A completed step becomes a back-jump button when onStepSelect is set.
        // The button keeps the hairline dash visual but expands the hit area
        // vertically (py/-my) so it is an easy, accessible target.
        if (onStepSelect && idx < active) {
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
              className="group -my-2 flex flex-1 items-center rounded-full py-2 outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]"
            >
              <span
                aria-hidden="true"
                className={`${dashClass} group-hover:bg-[color:var(--text-muted)]`}
              />
            </button>
          )
        }
        return <span key={idx} aria-hidden="true" className={dashClass} />
      })}
    </div>
  )
}
