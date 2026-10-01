import React from 'react'

import { CloseIconButton, IconButton, Input, Tooltip } from '../../ui'
import { RAISED_CHIP_SHELL } from '../../ui/ChipButton'
import { FOCUS_RING_WITHIN_INPUT_CLASS } from '../../ui/tokens'
import { GitBranchGlyph } from '../../AppIcons'

/**
 * Worktree, on the launch row beside the agent picker (owner, 2026-09-30).
 * A switch that can also be named: off by default; the glyph turns it on with
 * a name made up at start, which is what most launches want; typing a name
 * turns it on with that name, from either state. On, it is the chip the row has
 * always drawn — the branch glyph, the name as typed, and × to turn it off.
 * Clearing the name while on keeps it on, back to the made-up one.
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
    // The raised chip's own shell, so the switch stands at the same height,
    // radius and elevation as the model and skills chips beside it rather
    // than a step taller (its field used to bring the form ramp's 30px with
    // it). The box is a wrapper around a field, so the wrapper takes the ring.
    // On reads from the accent glyph and the name, not from a tinted ground:
    // a second ground on one chip of a raised row breaks the row.
    <span
      data-worktree-chip={on ? 'on' : 'off'}
      className={`${RAISED_CHIP_SHELL} gap-0.5 pl-0.5 pr-1 ${FOCUS_RING_WITHIN_INPUT_CLASS} ${
        on ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-subtle)]'
      }`}
    >
      <Tooltip content={on ? 'Runs in a worktree of its own' : 'Run in a worktree of its own'} placement="top">
        <IconButton
          size="2xs"
          // A toggle, announced as one, but without the thrown fill: inside the
          // chip's own box a selected square is a box in a box. The accent
          // glyph is what says on.
          tone="ink"
          aria-pressed={on}
          aria-label={on ? 'Worktree on' : 'Run in a worktree'}
          onClick={() => {
            if (on) return inputRef.current?.focus()
            onChange('')
            window.requestAnimationFrame(() => inputRef.current?.focus())
          }}
        >
          <GitBranchGlyph
            className={`icon-xs ${on ? 'text-[color:var(--accent-primary)]' : 'text-[color:var(--text-subtle)]'}`}
          />
        </IconButton>
      </Tooltip>
      {/* Sized to what is typed, not a fixed field: a chip that reserves room
          for a long branch pushes the row onto a second line. */}
      <Input
        ref={inputRef}
        variant="seamless"
        size="none"
        fullWidth={false}
        value={name ?? ''}
        onChange={(event) => {
          const typed = event.currentTarget.value
          // Typing is the other way on; emptying the field while on keeps it on.
          onChange(typed.length > 0 ? typed : on ? '' : null)
        }}
        placeholder={on ? 'auto-named' : 'Worktree'}
        aria-label="Worktree name — leave empty to have one made up"
        className="field-sizing-content h-full min-w-[8ch] max-w-[160px] px-0.5 text-meta"
      />
      {on ? <CloseIconButton size="2xs" onClick={() => onChange(null)} aria-label="Turn worktree off" /> : null}
    </span>
  )
}
