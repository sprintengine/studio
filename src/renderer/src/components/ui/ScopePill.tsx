// Scope pill — one machine-readable scope name (`terminal:control`) shown as a
// thing the reader can count and compare rather than as prose.
//
// Spec: design-system/components/scope-pill/component.md.
//
// Why it is neither `Badge` nor `MicroChip`, both of which were tried: those
// are UI-FACE labels — a word ABOUT the thing beside them, in the reader's
// language, in the UI family ("draft", "merged", "Default"). This content is
// not a word about anything, it IS the identifier: the same string that appears
// in the pairing request, in the audit line, and in the search box a person
// pastes it into. So it is mono (at 11px in the UI family, `l` / `1` / `I` and
// `:` / `;` stop being distinguishable, and this list decides what another
// machine may do on this one), it takes no tone ever (badge's whole vocabulary
// is tone; a scope has no state — it is held or it is not, and the HEADING says
// which), and it is a pill where micro-chip explicitly hands the rectangle back.
//
// Display only. No hover, no focus, no click: a scope a person can act on is a
// DescribedCheckRow, which is what the pairing dialog uses.

import React from 'react'

export type ScopePillProps = {
  /** The identifier itself — `workspace:read`. Never abbreviated: a scope shown
   *  as `terminal:cont…` is a scope that does not exist. */
  scope: string
  /**
   * The `--missing` variant: a scope listed as NOT granted beside the ones that
   * are. One step quieter on ink and border, and deliberately not a danger
   * tint — a scope the person never granted is a fact, not a fault. The heading
   * above the set is what says "not granted", so the ink step is reinforcement
   * and never the only carrier.
   */
  missing?: boolean
  className?: string
}

export function ScopePill({ scope, missing = false, className }: ScopePillProps): JSX.Element {
  return (
    <span
      className={[
        // 22px — the sub-control box step the button family already uses for its
        // smallest square. Deliberately not a control step: the smallest of
        // those means "a person can press this", which this cannot be. A
        // `min-h` rather than a height, so the pill grows with its line box in
        // a zoomed or larger-text context instead of clipping it.
        'inline-flex min-h-icon-lg shrink-0 items-center rounded-full border px-2',
        'bg-[color:var(--bg-surface)] font-mono text-micro',
        missing
          ? 'border-[color:var(--border-subtle)] text-[color:var(--text-subtle)]'
          : 'border-[color:var(--border-default)] text-[color:var(--text-default)]',
        className ?? '',
      ].join(' ')}
    >
      {scope}
    </span>
  )
}

/**
 * The set. Pills wrap as a group and never as a paragraph — the gap is the same
 * in both axes, so a two-row set reads as a grid of objects rather than as a
 * run-on line that happened to break.
 *
 * A labelled `role="group"` rather than a list: the pills are `<span>`s so one
 * can also stand alone inline, and a `role="list"` whose children are not
 * `listitem`s is a malformed list. The group carries the name.
 *
 * `ariaLabel` belongs HERE and not on the pills: without it a screen-reader
 * user meets eight unexplained identifiers, and naming each pill would just say
 * the same string twice.
 */
export function ScopePillSet({
  ariaLabel,
  className,
  children,
}: {
  ariaLabel?: string
  className?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div role="group" aria-label={ariaLabel} className={`flex flex-wrap gap-1.5 ${className ?? ''}`}>
      {children}
    </div>
  )
}
