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
   * the active step itself may still be working, so the active dash stays
   * highlighted while the prior dashes mark actually-completed sub-stages.
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
    // Same two-layer shape as the dashes below: one layer paints the stations,
    // and the back-jump buttons live in a sibling group laid over it. A
    // progressbar's children are presentational to assistive tech, so a button
    // inside one would vanish from the accessibility tree — which is why the
    // two layers cannot be one element. Both layers render every station with
    // identical content and gap, so they measure the same and each button sits
    // exactly under its label; the painted layer is pointer-transparent so the
    // buttons beneath take the hover and the click, and it sits above them so a
    // hover fill never covers the text.
    //
    // The progressbar role sits on a THIRD element, a sibling of both — never
    // on the painted layer. That same "descendants are presentational" rule
    // applies to text: with the role on the layer that draws the stations, the
    // station names and the `aria-current="step"` marking one of them left the
    // accessibility tree, and the button layer beneath carries only the
    // completed steps (its content is `aria-hidden` and `invisible`), so a
    // labeled wizard announced its position and not one of its stations.
    const stationClass = 'inline-flex items-center gap-1.5 px-1 py-0.5 text-micro font-medium'
    const stationBody = (isCurrent: boolean, isDone: boolean, label: string) => (
      <>
        {/* The step's own name carries the meaning, so the tick is a silent
            mark that inherits the station's ink. */}
        {isDone ? <CheckIcon className="icon-xs shrink-0" /> : null}
        {isCurrent ? (
          <span aria-hidden="true" className="h-[5px] w-[5px] rounded-full bg-[color:var(--accent-primary)]" />
        ) : null}
        {label}
      </>
    )
    const stationLabel = (idx: number) => stepLabels[idx] ?? `Step ${idx + 1}`
    return (
      <nav aria-label={fullLabel} className="relative isolate flex min-w-0 flex-1 items-center justify-center">
        {/* The strip's progressbar contract, on an element of its own. It draws
            nothing — the stations beside it are the picture — and it needs no
            children, because the position it reports is carried by its own name
            ("Step 3 of 6 · Roster"), which is what the spec asks a progressbar
            here to say. */}
        <span
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={total}
          aria-valuenow={step}
          aria-label={fullLabel}
          className="sr-only"
        />
        <div
          // `--z-sticky` is the in-card raise step: the painted text rides
          // above the hover fill of the jump buttons beneath it.
          className="pointer-events-none relative z-[var(--z-sticky)] flex items-center gap-4"
        >
          {stepStates.map(({ idx, isCurrent, isDone }) => (
            <span
              key={idx}
              aria-current={isCurrent ? 'step' : undefined}
              // A completed station is named twice over: once here, once by the
              // jump button sitting under it ("Go back to step 2: Project").
              // Where that button exists it is the one that carries the name,
              // so the painted twin steps out of the tree; the current and the
              // upcoming stations, which have no button, are read from here.
              aria-hidden={isDone && onStepSelect ? true : undefined}
              className={`${stationClass} ${
                isCurrent
                  ? 'text-[color:var(--text-strong)]'
                  : isDone
                    ? 'text-[color:var(--text-muted)]'
                    : 'text-[color:var(--text-subtle)]'
              }`}
            >
              {stationBody(isCurrent, isDone, stationLabel(idx))}
            </span>
          ))}
        </div>
        {onStepSelect ? (
          <div
            role="group"
            aria-label="Jump to a completed step"
            className="absolute inset-0 flex items-center justify-center gap-4"
          >
            {stepStates.map(({ idx, isCurrent, isDone }) => {
              const label = stationLabel(idx)
              // Only completed steps are interactive (back-jump); the current
              // and upcoming stations are layout-only twins so the row
              // measures the same as the painted one.
              if (!(isDone && onStepSelect)) {
                return (
                  <span key={idx} aria-hidden="true" className={`invisible ${stationClass}`}>
                    {stationBody(isCurrent, isDone, label)}
                  </span>
                )
              }
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => onStepSelect(idx)}
                  aria-label={`Go back to step ${idx + 1}: ${label}`}
                  className={`${stationClass} rounded-xs transition-colors hover:bg-[color:var(--bg-hover)] focus-visible:focus-ring`}
                >
                  {/* Layout-only: the painted layer above draws this text. */}
                  <span aria-hidden="true" className="invisible inline-flex items-center gap-1.5">
                    {stationBody(isCurrent, isDone, label)}
                  </span>
                </button>
              )
            })}
          </div>
        ) : null}
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
          // Done and current fill `accent.primary` — the accent as a hairline
          // marking real progress, the panel-header precedent — and upcoming
          // is the `border.default` hairline (spec States; ruled 2026-09-02).
          // This used to paint done in `text.disabled` and current in
          // `text.strong`, a private grey ramp the spec never described.
          className={`h-[3px] flex-1 rounded-full transition-colors duration-[var(--motion-normal)] ${
            // design-tokens-allow: the accent as a hairline marking real progress (wizard-progress spec States, ruled 2026-09-02) — a progressbar fill, not a selection mark
            isCurrent || isDone
              ? 'bg-[color:var(--accent-primary)]'
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
              className="h-full flex-1 rounded-full outline-none transition-colors hover:bg-[color:var(--bg-hover)] focus-visible:focus-ring"
            />
          )
        })}
      </div>
    </div>
  )
}
