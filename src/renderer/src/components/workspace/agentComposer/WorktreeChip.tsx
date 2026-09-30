import React from 'react'

import { CloseIconButton, IconButton, Input, Tooltip } from '../../ui'
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
    <span
      data-worktree-chip={on ? 'on' : 'off'}
      className={`inline-flex items-center gap-0.5 rounded py-0.5 pl-0.5 pr-1 text-meta ${
        on
          ? 'bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)]'
          : 'border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-subtle)]'
      }`}
    >
      <Tooltip content={on ? 'Runs in a worktree of its own' : 'Run in a worktree of its own'} placement="top">
        <IconButton
          size="2xs"
          pressed={on}
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
        fullWidth={false}
        value={name ?? ''}
        onChange={(event) => {
          const typed = event.currentTarget.value
          // Typing is the other way on; emptying the field while on keeps it on.
          onChange(typed.length > 0 ? typed : on ? '' : null)
        }}
        placeholder={on ? 'auto-named' : 'Worktree'}
        aria-label="Worktree name — leave empty to have one made up"
        className="field-sizing-content min-w-[8ch] max-w-[160px] text-meta"
      />
      {on ? <CloseIconButton size="2xs" onClick={() => onChange(null)} aria-label="Turn worktree off" /> : null}
    </span>
  )
}
