import React from 'react'

import { extensionIdFromName } from '../../../../../shared/extension-scaffold'
import { ExtensionsGlyph } from '../../AppIcons'
import { Input, Tooltip } from '../../ui'

/**
 * The extension's name, on the launch row where the worktree chip sits in a
 * plain New chat (owner, 2026-09-30): the same shape — a glyph and a field
 * sized to what is typed — in the extension violet, and required, so it has no
 * off state and no ×. What is typed is the folder made inside the project and
 * the module id, so it is kept to that rule as it is typed: "PR Radar" is
 * `pr-radar`.
 *
 * Empty, a dashed edge says it is still needed; `invalid` (the name is taken
 * by something that is not an extension, or breaks the id rule) draws the
 * error edge, and the reason is said under the composer.
 */
export function ExtensionNameChip({
  name,
  onChange,
  invalid,
}: {
  name: string
  onChange: (next: string) => void
  invalid: boolean
}) {
  const empty = name === ''
  const inputRef = React.useRef<HTMLInputElement>(null)
  return (
    <span
      data-extension-name-chip={empty ? 'empty' : invalid ? 'invalid' : 'named'}
      className={`inline-flex items-center gap-1 rounded-sm py-0.5 pl-1.5 pr-1.5 text-meta text-[color:var(--text-strong)] ${
        invalid
          ? 'border border-[color:var(--tone-error)]'
          : empty
            ? 'border border-dashed border-[color:var(--extension-ink)]'
            : 'bg-[color:var(--extension-soft)]'
      }`}
      onClick={() => inputRef.current?.focus()}
    >
      <Tooltip content="The extension's folder, made inside the project, and its id" placement="top">
        <span className="inline-flex">
          <ExtensionsGlyph className="icon-xs text-[color:var(--extension-ink)]" />
        </span>
      </Tooltip>
      {/* Sized to what is typed, as the worktree chip's field is: a chip that
          reserves room for a long name pushes the row onto a second line. */}
      <Input
        ref={inputRef}
        variant="seamless"
        fullWidth={false}
        value={name}
        onChange={(event) => onChange(extensionIdFromName(event.currentTarget.value, { typing: true }))}
        placeholder="Extension name"
        aria-label="Extension name"
        aria-invalid={invalid || undefined}
        spellCheck={false}
        className={`field-sizing-content ${empty ? 'min-w-[12ch]' : 'min-w-[2ch]'} max-w-[180px] font-mono text-meta`}
      />
    </span>
  )
}
