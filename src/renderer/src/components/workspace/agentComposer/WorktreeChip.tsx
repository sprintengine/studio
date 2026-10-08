import React from 'react'

import { ChipButton, Input, Tooltip, WorktreeGlyph } from '../../ui'

/**
 * Worktree, in the New chat composer's context strip (owner ruling
 * 2026-10-04; it sat beside the agent picker from 2026-09-30). A switch that
 * can also be named. Pressed, it reads "Worktree", runs the chat in a
 * worktree of its own with a name made up at start, and offers a field for a
 * name of the person's own; the New chat door opens with it pressed. Pressed
 * again, it is off, reading "No worktree". Clearing the name while on keeps it
 * on, back to the made-up one.
 *
 * The kit's quiet chip, as every control in the strip is.
 */
export function WorktreeChip({
  name,
  onChange,
}: {
  /** Null is off; '' is on with a name made up at start. */
  name: string | null
  onChange: (next: string | null) => void
}) {
  const on = name !== null
  const inputRef = React.useRef<HTMLInputElement>(null)
  return (
    <span data-worktree-chip={on ? 'on' : 'off'} className="inline-flex shrink-0 items-center gap-0.5">
      <Tooltip content={on ? 'Runs in a worktree of its own' : 'Run in a worktree of its own'} placement="top">
        <ChipButton
          variant="raised"
          // One name for the switch in both states; `aria-pressed` says which.
          // A name that changed with the state would be read as a different
          // control each time it was pressed.
          pressed={on}
          aria-label="Run in a worktree"
          onClick={() => {
            if (on) {
              onChange(null)
              return
            }
            onChange('')
            window.requestAnimationFrame(() => inputRef.current?.focus())
          }}
        >
          {/* On, the chip wears the kit's thrown fill and strong ink; off, its
              mark steps down to disabled ink as well, so the two states read
              apart at a glance rather than by the word alone. */}
          <WorktreeGlyph className={`icon-xs shrink-0${on ? '' : ' text-[color:var(--text-disabled)]'}`} />
          {on ? 'Worktree' : 'No worktree'}
        </ChipButton>
      </Tooltip>
      {on ? (
        // Sized to what is typed, not a fixed field: a field that reserves room
        // for a long branch pushes the strip onto a second line.
        <Input
          ref={inputRef}
          variant="seamless"
          size="none"
          fullWidth={false}
          value={name ?? ''}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder="auto-named"
          aria-label="Worktree name — leave empty to have one made up"
          className="field-sizing-content h-control-xs min-w-[8ch] max-w-[160px] px-1 font-mono text-meta"
        />
      ) : null}
    </span>
  )
}
