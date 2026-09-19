import React from 'react'

// The kit's empty state. Five surfaces declared a local `EmptyState`
// (or `DetailEmptyState`) for the same idea, and they disagreed on nearly
// everything: `text-sm` vs `text-body` vs `text-micro` for the line, centred in
// the pane vs padded at the top of a list, an action button that was a
// hand-rolled `rounded bg-…` rather than the kit's, and one that hardcoded
// `--text-disabled` for a sentence a person is meant to read.
//
// Two densities, because the audit found two genuinely different jobs:
//
//   pane  fills the space where content would be — a workspace with nothing
//         open, a detail pane with nothing selected. Centred, with room.
//   list  sits inside a list that came back empty. Top-aligned and compact, so
//         it reads as "this list is empty" rather than as a page of its own.
//
// The glyph slot is `icon-lg` (22px), which is what that token's own comment in
// assets/index.css says it is for ("prominent affordances and empty-state
// glyphs") — the one place in the ramp with a documented use for this.

export type EmptyStateProps = {
  /** The one sentence. Plain language, and never in disabled ink — this is copy
   *  to be read, not a greyed-out control. */
  title: React.ReactNode
  /** Optional second line: why it is empty, or what would fill it. */
  body?: React.ReactNode
  /** An optional glyph above the title. */
  glyph?: React.ReactNode
  /** The one call to action, when there is something to do about it. */
  action?: React.ReactNode
  /** `pane` (default) fills a region; `list` sits inside an empty list. */
  density?: 'pane' | 'list'
  className?: string
}

export function EmptyState({ title, body, glyph, action, density = 'pane', className }: EmptyStateProps): JSX.Element {
  const pane = density === 'pane'
  return (
    <div
      className={[
        'flex flex-col items-center text-center',
        // `space.4xl` (32px) is the scale's top step; the 40px this carried was
        // on no step.
        pane ? 'h-full justify-center gap-2 px-6 py-8' : 'gap-1 px-3 py-8',
        className ?? '',
      ].join(' ')}
    >
      {glyph ? (
        // `icon-lg` is the slot's SIZE, not its ceiling: a 22px glyph lands
        // exactly on the ramp, and an illustration that is deliberately larger
        // (the gallery's card skeleton) sets its own box rather than overflowing
        // a fixed one into the title. Still the ramp — `--spacing-lg`
        // reaches `min-*` as well as `size-*`, verified in the built CSS.
        <span className="mb-1 flex min-h-icon-lg min-w-icon-lg items-center justify-center text-[color:var(--text-subtle)]">
          {glyph}
        </span>
      ) : null}
      <p className={['text-body text-[color:var(--text-muted)]', pane ? 'max-w-[46ch]' : ''].join(' ')}>{title}</p>
      {body ? <p className="max-w-[46ch] text-meta leading-5 text-[color:var(--text-subtle)]">{body}</p> : null}
      {action ? <div className="mt-2 flex items-center gap-2">{action}</div> : null}
    </div>
  )
}
