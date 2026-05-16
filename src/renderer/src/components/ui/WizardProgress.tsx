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
        return (
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
        )
      })}
    </div>
  )
}
