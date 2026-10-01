import React, { useCallback, useLayoutEffect, useState } from 'react'

import { ChevronDownIcon } from '../AppIcons'
import { ChipButton } from './ChipButton'
import { Popover, type PopoverPlacement } from './Popover'
import { Tooltip } from './Tooltip'

// A toolbar row's secondary controls, folded behind one raised chevron chip
// when the row is too narrow to hold them (owner ruling 2026-10-01).
//
// The composer rows used to answer a narrow panel by wrapping onto a second
// line or crushing every chip to a sliver, which is what a squashed chat looked
// like. A control that disappears is a missing feature at that size, so nothing
// here is ever dropped: below the row's own budget the secondary controls move
// into a popover, as the same components, and the essential ones (the model,
// send) stay in the row.
//
// Measured against the ROW, not the window, for the reason the title strip's
// fold gives: the same panel width is a different budget depending on what sits
// beside the panel, and only the row knows what it has. The row must be a block
// whose width does not depend on its content — a full-width flex row — or
// folding would change the width that decided to fold.
//
// Rendered conditionally rather than hidden with a container query, so a folded
// control is mounted exactly once. Two mounted copies of a field or a picker
// would hold two focus targets, two popover states and two accessible names.

/**
 * Whether a row narrower than `minWidth` should fold. Returns `[folded, ref]`;
 * attach the ref to the row whose width is the budget.
 *
 * Width 0 is a detached or not-yet-laid-out element (and every element under
 * jsdom), not a 0px row, so it never folds: the unfolded row is the default.
 */
export function useMeasuredFold(minWidth: number): [boolean, (element: HTMLElement | null) => void] {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [folded, setFolded] = useState(false)

  const measure = useCallback(
    (width: number) => {
      if (width <= 0) return
      setFolded(width < minWidth)
    },
    [minWidth],
  )

  // Layout effect: the fold is part of the first paint. A passive effect would
  // draw the crushed row once and then fold it, which reads as a flinch every
  // time a narrow chat opens.
  useLayoutEffect(() => {
    if (!element) return
    measure(element.getBoundingClientRect().width)
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) measure(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, measure])

  return [folded, setElement]
}

/**
 * The fold itself. Unfolded, `children` render in place with no wrapper, so the
 * row's own gap and alignment govern them. Folded, a raised chevron chip — the
 * same family as the chips beside it — opens a popover holding the same
 * children, stacked.
 *
 * A chevron rather than ⋯ because a launch row may already carry a ⋯ of its
 * own (the menu of what to launch), and two identical glyphs side by side
 * would be two doors that look like one.
 */
export function FoldedControls({
  folded,
  ariaLabel,
  placement = 'top-start',
  warn = false,
  children,
}: {
  folded: boolean
  /** Names the trigger and the popover: "More composer options". */
  ariaLabel: string
  placement?: PopoverPlacement
  /**
   * A folded control carries a standing warning — permissions bypassed. Folding
   * must not hide it, so the trigger takes the warn tint the chip itself wore.
   */
  warn?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  if (!folded) return <>{children}</>
  // Nothing to fold — a terminal launch has no worktree and no skills — is no
  // chevron, not a chevron that opens an empty popover.
  if (React.Children.toArray(children).length === 0) return null
  const upward = placement.startsWith('top')
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={ariaLabel}
      popupRole="dialog"
      placement={placement}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        // The tooltip wraps the button, never the Popover: it attaches its
        // handlers by cloning its child.
        <Tooltip content={ariaLabel} placement="top">
          <ChipButton
            ref={ref}
            variant="raised"
            tint={warn ? 'var(--tone-warn)' : undefined}
            aria-label={ariaLabel}
            onClick={togglePopover}
            className="shrink-0"
            {...triggerProps}
          >
            {/* Points the way the popover opens. */}
            <ChevronDownIcon className={`size-icon-xs shrink-0 ${upward ? 'rotate-180' : ''}`} />
          </ChipButton>
        </Tooltip>
      )}
    >
      <div className="flex flex-col items-start gap-1.5 p-1.5">{children}</div>
    </Popover>
  )
}
