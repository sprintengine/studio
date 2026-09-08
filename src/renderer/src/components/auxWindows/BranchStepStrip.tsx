import React from 'react'

import { ChipButton, Tooltip } from '../ui'
import { sameSelection, type StripEntry } from './branchSteps'
import type { BranchStepSelection } from '../../../../shared/electron-api'

// The commit step strip (the-diff-an-agent-made / changed-files-and-commit-steps),
// drawn from backlog/mockups/2026-09-04-changed-files-and-turn-steps.html.
//
// Left to right: the whole branch, then the uncommitted tail, then the commits
// oldest first — the order the work happened in. A step is a commit, so the
// strip is the branch's own history and needs nothing recorded as it happens.

function MergeGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-icon-xs shrink-0">
      <circle cx="4.5" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="4.5" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="11.5" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.5 5.5v5M6 4h1.5A2.5 2.5 0 0 1 10 6.5M6 12h1.5A2.5 2.5 0 0 0 10 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** The diff body this strip drives, for `aria-controls`. */
export const BRANCH_STEP_PANEL_ID = 'branch-step-panel'

export function BranchStepStrip({
  entries,
  selection,
  onSelect,
  note,
}: {
  entries: StripEntry[]
  selection: BranchStepSelection
  onSelect: (selection: BranchStepSelection) => void
  /** What this checkout may honestly claim, when it is not simply this chat's. */
  note: string | null
}) {
  const selectedIndex = Math.max(
    0,
    entries.findIndex((entry) => sameSelection(entry.selection, selection))
  )

  // A tablist is a SINGLE tab stop whose arrows move between tabs — the role we
  // announce, so the role we have to honour. Two things it must also do: move
  // focus with the selection, and stop the event, because the viewer wraps this
  // strip in a keydown handler that steers the FILE cursor with the same arrows.
  // Announcing "tab" and then paging files would be worse than no role at all.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const last = entries.length - 1
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = selectedIndex >= last ? 0 : selectedIndex + 1
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = selectedIndex <= 0 ? last : selectedIndex - 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    if (next === null) return
    event.preventDefault()
    event.stopPropagation()
    const target = entries[next]
    if (!target) return
    onSelect(target.selection)
    const list = event.currentTarget
    const buttons = list.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    buttons[next]?.focus()
  }

  // A strip with only the span offers no choice, so it is not a control group —
  // drawing one chip that cannot be unselected would be a fake affordance.
  if (entries.length <= 1 && !note) return null

  return (
    <div className="shrink-0 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]">
      {entries.length > 1 ? (
        <div
          role="tablist"
          aria-label="Branch steps"
          onKeyDown={onKeyDown}
          className="flex items-center gap-1 overflow-x-auto px-3 py-2"
        >
          {entries.map((entry, index) => {
            const active = sameSelection(entry.selection, selection)
            return (
              <ChipButton
                key={entry.key}
                variant="outline"
                selected={active}
                role="tab"
                aria-selected={active}
                // The chip's own `selected` would also emit `aria-current`; a tab
                // states its state as `aria-selected`, and two state attributes on
                // one row make a screen reader read the choice twice.
                aria-current={undefined}
                aria-controls={BRANCH_STEP_PANEL_ID}
                // Roving: one tab stop for the whole strip, on the selected chip.
                tabIndex={index === selectedIndex ? 0 : -1}
                onClick={() => onSelect(entry.selection)}
                className="shrink-0 whitespace-nowrap"
              >
                {entry.isMerge ? <MergeGlyph /> : null}
                {entry.hash ? (
                  <span className="font-mono text-micro tabular-nums text-[color:var(--text-subtle)]">
                    {entry.hash}
                  </span>
                ) : null}
                <span className="max-w-[22ch] overflow-hidden text-ellipsis">{entry.label}</span>
              </ChipButton>
            )
          })}
        </div>
      ) : null}
      {note ? (
        // The epic's honesty, at the length the panel has room for: the row's
        // tooltip says it in a sentence, this says it where the files are.
        <Tooltip content={note} placement="bottom">
          <p className="flex items-start gap-2 px-3 pb-2 pt-1 text-meta leading-snug text-[color:var(--text-subtle)]">
            <svg
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
              className="mt-[2px] size-icon-xs shrink-0"
            >
              <path d="M8 1.5 15 14H1L8 1.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
              <path d="M8 6.5v3M8 11.6v.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <span>{note}</span>
          </p>
        </Tooltip>
      ) : null}
    </div>
  )
}
