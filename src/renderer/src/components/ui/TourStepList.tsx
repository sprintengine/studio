import type { JSX, ReactNode } from 'react'

import { CheckIcon, WarningIcon } from '../AppIcons'
import { PrimaryButton, GhostButton } from './Buttons'
import { RowButton } from './RowButton'
import { Tooltip } from './Tooltip'
import { TourGlyph } from './TourGlyphs'

// The tour's disclosures (design-system/components/tour-strip): the step list
// the strip's toggle shows beside the diff, and the card the tour waits behind
// until the owner presses Start.

export type TourStepListItem = {
  id: string
  title: string
  /** The file's name, not its path: the list is narrow. */
  file: string
  hoverTip?: string
  status: 'ok' | 'moved' | 'gone'
  visited: boolean
  kind: 'explain' | 'context' | 'caveat'
}

/**
 * Every step, in order. The current row takes the neutral selection fill;
 * a row's one trailing mark says visited (✓), moved (!) or gone (–), with the
 * same words in its accessible name — shape, then word, never colour alone.
 */
export function TourStepList({
  steps,
  current,
  onSelect,
}: {
  steps: readonly TourStepListItem[]
  current: number | null
  onSelect: (index: number) => void
}): JSX.Element {
  return (
    <nav
      aria-label="Tour steps"
      className="tour-step-list flex w-60 shrink-0 flex-col overflow-y-auto border-r border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] py-1"
    >
      <ol className="flex flex-col">
        {steps.map((step, index) => {
          const state =
            step.status === 'gone' ? 'gone' : step.status === 'moved' ? 'moved' : step.visited ? 'visited' : null
          const row = (
            <RowButton
              density="bleed"
              selected={index === current}
              onClick={() => onSelect(index)}
              aria-label={`Step ${index + 1}: ${step.title}${state ? ` (${state === 'gone' ? 'file no longer in the diff' : state === 'moved' ? 'code has changed' : 'visited'})` : ''}`}
              className="items-start px-3"
            >
              <span className="w-5 shrink-0 pt-px text-right font-mono text-meta tabular-nums text-[color:var(--text-subtle)]">
                {index + 1}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span
                  className={`truncate text-body ${step.status === 'gone' ? 'text-[color:var(--text-muted)]' : ''}`}
                >
                  {step.title}
                </span>
                <span className="truncate font-mono text-micro text-[color:var(--text-subtle)]">
                  {step.file}
                  {step.kind === 'caveat' ? ' · caveat' : ''}
                </span>
              </span>
              <span aria-hidden className="flex size-icon-sm shrink-0 items-center justify-center pt-0.5">
                {state === 'visited' ? (
                  <CheckIcon className="icon-xs text-[color:var(--text-subtle)]" />
                ) : state === 'moved' ? (
                  <WarningIcon className="icon-xs text-[color:var(--tone-warn)]" />
                ) : state === 'gone' ? (
                  <span className="h-px w-2 bg-[color:var(--text-subtle)]" />
                ) : null}
              </span>
            </RowButton>
          )
          return (
            <li key={step.id}>
              {step.hoverTip ? (
                <Tooltip content={step.hoverTip} placement="right" wrapperClassName="block">
                  {row}
                </Tooltip>
              ) : (
                row
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/**
 * The tour, waiting. Nothing plays until Start: an agent finishing a tour must
 * not move the owner's view. Start is the one accented action in the view.
 */
export function TourReadyCard({
  title,
  stepCount,
  fileCount,
  authorName,
  overview,
  resumeAt,
  closed = false,
  onStart,
  onDismiss,
}: {
  title: string
  stepCount: number
  fileCount: number
  authorName: string | null
  overview?: ReactNode
  /** 0-based step to resume at, when the tour was played before. */
  resumeAt: number | null
  /** The agent closed it: it can still be replayed, and the card says so. */
  closed?: boolean
  onStart: () => void
  onDismiss: () => void
}): JSX.Element {
  const meta = [
    `${stepCount} ${stepCount === 1 ? 'step' : 'steps'}`,
    `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`,
    authorName ? `by ${authorName}` : null,
    closed ? 'closed' : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="tour-ready-scrim absolute inset-0 flex items-center justify-center px-6">
      <section aria-label={`Tour ready: ${title}`} className="tour-ready-card w-full max-w-md">
        <div className="flex items-center gap-2 text-meta text-[color:var(--text-muted)]">
          <TourGlyph className="icon-sm shrink-0" />
          <span>{closed ? 'Tour' : 'Tour ready'}</span>
        </div>
        <h2 className="mt-2 text-title font-medium tracking-tight text-[color:var(--text-strong)]">{title}</h2>
        <p className="mt-1 text-meta tabular-nums text-[color:var(--text-muted)]">{meta}</p>
        {overview ? <div className="tour-ready-overview mt-3 max-h-56 overflow-y-auto">{overview}</div> : null}
        <div className="mt-5 flex items-center gap-2">
          <PrimaryButton size="md" onClick={onStart}>
            {resumeAt !== null && resumeAt > 0 ? `Resume at step ${resumeAt + 1}` : 'Start'}
          </PrimaryButton>
          <GhostButton size="md" onClick={onDismiss}>
            Not now
          </GhostButton>
        </div>
      </section>
    </div>
  )
}
