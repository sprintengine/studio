// Pager — the foot of a list that is walked a page at a time.
//
// New primitive (2026-09-05, the Extensions source-tabs ruling). The product
// had exactly one long-list idiom before it, a per-section "Show N more"
// toggle, and that idiom cannot do what the ruling asks: it grows the page
// without ever telling you how much is left, it forgets where you were, and
// three sections each expanded to a different depth is a list with no
// position at all. A pager states the position in words ("Showing 13–24 of
// 318"), takes you to a numbered page, and mounts one page of rows.
//
// Anatomy: the range sentence on the left, the page controls on the right —
// previous, numbered pages with an elision, next. The numbers are buttons and
// the current one is `aria-current="page"`, which is the standard mark for
// "this is the page you are on"; there is no accent fill, because the accent
// budget belongs to the primary action.
//
// Documented at design-system/components/pager/component.md.

import React from 'react'

import { FOCUS_RING_CLASS } from './tokens'

/** A gap in the number strip, standing for the pages it hides. */
export type PagerStep = number | 'gap'

/**
 * Which page numbers to draw. Always the first and last page and a window
 * around the current one, with an elision where numbers were dropped — so the
 * strip's width does not grow with a 27-page source, and page 1 and the last
 * page are always one click away.
 */
export function pagerSteps(page: number, pageCount: number, window = 2): PagerStep[] {
  if (pageCount <= 1) return pageCount === 1 ? [1] : []
  const wanted = new Set<number>([1, pageCount])
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = page + offset
    if (candidate >= 1 && candidate <= pageCount) wanted.add(candidate)
  }
  const numbers = [...wanted].sort((a, b) => a - b)
  const steps: PagerStep[] = []
  let previous = 0
  for (const number of numbers) {
    // A single skipped page is drawn rather than elided: "1 … 3" is wider than
    // "1 2 3" and hides less.
    if (previous !== 0 && number - previous === 2) steps.push(number - 1)
    else if (previous !== 0 && number - previous > 2) steps.push('gap')
    steps.push(number)
    previous = number
  }
  return steps
}

const STEP_CLASS =
  'inline-flex h-control-sm min-w-[30px] items-center justify-center rounded-md px-2 text-meta tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-50'

export function Pager({
  page,
  pageCount,
  rangeLabel,
  onPageChange,
  ariaLabel,
  className,
}: {
  /** 1-based, already clamped by the caller's own model. */
  page: number
  pageCount: number
  /** "Showing 13–24 of 318" — the position, in words, beside the numbers. */
  rangeLabel: string
  onPageChange: (page: number) => void
  /** Names what is being paged ("Plugins in SprintEngine Studio"). */
  ariaLabel: string
  className?: string
}): JSX.Element {
  const steps = pagerSteps(page, pageCount)
  return (
    <nav
      aria-label={ariaLabel}
      className={['flex items-center justify-between gap-3 pt-3', className ?? ''].filter(Boolean).join(' ')}
    >
      {/* The range is a live region: paging replaces the rows without moving
          focus, so the sentence is the only thing that says the page changed. */}
      <span role="status" aria-live="polite" className="text-meta tabular-nums text-[color:var(--text-muted)]">
        {rangeLabel}
      </span>
      {pageCount > 1 ? (
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            className={`${STEP_CLASS} text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
          >
            <ChevronLeft />
          </button>
          {steps.map((step, index) =>
            step === 'gap' ? (
              <span
                key={`gap-${index}`}
                aria-hidden="true"
                className="px-1 text-meta text-[color:var(--text-subtle)]"
              >
                …
              </span>
            ) : (
              <button
                key={step}
                type="button"
                aria-current={step === page ? 'page' : undefined}
                aria-label={`Page ${step}`}
                onClick={() => onPageChange(step)}
                className={`${STEP_CLASS} ${FOCUS_RING_CLASS} ${
                  step === page
                    ? 'bg-[color:var(--bg-selected)] font-medium text-[color:var(--text-strong)]'
                    : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
                }`}
              >
                {step}
              </button>
            ),
          )}
          <button
            type="button"
            aria-label="Next page"
            disabled={page >= pageCount}
            onClick={() => onPageChange(page + 1)}
            className={`${STEP_CLASS} text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
          >
            <ChevronRight />
          </button>
        </span>
      ) : null}
    </nav>
  )
}

function ChevronLeft(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
      <path d="M10 3.5 5.5 8 10 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronRight(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
