import type { ReactNode, JSX } from 'react'

// The "New" mark: a soft-accent pill saying a thing arrived recently.
//
// It shipped first inside `CliModelPicker` — the chip on a model that arrived
// in the last thirty days — as an inline span, which is where the
// Design door found it when it needed to say the same thing about a component
// that landed in a bundle since the person last opened it. Rather than draw a
// second "New" one pixel away from the first, the one drawing moved here and
// both surfaces render it. Spec: `design-system/components/badge/component.md`
// ("The New mark").
//
// Why it is not `Badge`'s label species: that one is a `status.*-soft` fill with
// a matching hairline and `text.muted` ink, for a state a row is IN ("Blocked",
// "Waiting"). This is not a state and it is not a status — it is the system
// pointing at something, which is the one job `accent.primary` has. So: accent
// ink on `accent.primary-soft`, no hairline (a border would make it read as a
// state chip), and nothing else in the accent budget nearby.
//
// It is never a hoist and never a sort key. The row stays exactly where the list
// put it, so muscle memory still lands — the chip is the only difference.

export function NewChip({
  /** The word, when a count belongs in it ("3 new"). Defaults to "New". */
  children = 'New',
  /**
   * Hide from assistive tech — correct ONLY where the surrounding element writes
   * its own accessible name and has already composed the word into it (a tile
   * with an `aria-label`). Everywhere else the chip is the one thing saying a
   * component is new, and hiding it deletes that for anyone not looking.
   */
  decorative = false,
  className,
}: {
  children?: ReactNode
  decorative?: boolean
  className?: string
}): JSX.Element {
  return (
    <span
      aria-hidden={decorative ? true : undefined}
      className={`shrink-0 whitespace-nowrap rounded-full bg-[color:var(--accent-primary-soft)] px-1.5 text-micro font-medium leading-[1.5] text-[color:var(--accent-primary)] ${className ?? ''}`}
    >
      {children}
    </span>
  )
}
