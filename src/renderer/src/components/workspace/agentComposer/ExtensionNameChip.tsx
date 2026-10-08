import React from 'react'

import { extensionIdFromName } from '../../../../../shared/extension-scaffold'
import { ExtensionsGlyph } from '../../AppIcons'
import { ChipButton, CloseIconButton, Input, Tooltip } from '../../ui'
import { FolderGlyph } from '../../ui/FileTypeGlyph'

/**
 * The extension's name, on the launch row where the worktree chip sits in a
 * plain New chat (owner, 2026-09-30): the same shape — a glyph and a field
 * sized to what is typed — in the extension violet, and required, so it has no
 * off state and no ×. What is typed is the module id and the name of the new
 * folder made for it, so it is kept to that rule as it is typed: "PR Radar" is
 * `pr-radar`.
 *
 * With a folder of the person's own picked, the name is that folder's and the
 * field is read-only: a name typed over it would say one folder while the
 * extension went in another. Renaming is picking another folder.
 *
 * Empty, a dashed edge says it is still needed; `invalid` (the name is taken
 * by something that is not an extension, or breaks the id rule) draws the
 * error edge, and the reason is said under the composer.
 */
export function ExtensionNameChip({
  name,
  onChange,
  invalid,
  fromFolder = false,
}: {
  name: string
  onChange: (next: string) => void
  invalid: boolean
  /** The name is the picked folder's, and is not typed. */
  fromFolder?: boolean
}) {
  const empty = name === ''
  const inputRef = React.useRef<HTMLInputElement>(null)
  return (
    <span
      data-extension-name-chip={empty ? 'empty' : invalid ? 'invalid' : 'named'}
      className={`inline-flex h-control-xs items-center gap-1 rounded-sm px-1.5 text-meta text-[color:var(--text-strong)] ${
        invalid
          ? 'border border-[color:var(--tone-error)]'
          : empty
            ? 'border border-dashed border-[color:var(--extension-ink)]'
            : 'bg-[color:var(--extension-soft)]'
      }`}
      onClick={() => inputRef.current?.focus()}
    >
      <Tooltip
        content={
          fromFolder ? 'Named after its folder' : "The extension's id, and the name of the new folder made for it"
        }
        placement="top"
      >
        <span className="inline-flex">
          <ExtensionsGlyph className="icon-xs text-[color:var(--extension-ink)]" />
        </span>
      </Tooltip>
      {/* Sized to what is typed, as the worktree chip's field is: a chip that
          reserves room for a long name pushes the row onto a second line. */}
      <Input
        ref={inputRef}
        variant="seamless"
        // The chip owns the box and its height — the raised row's `xs` step —
        // so the field brings no ramp height of its own into it.
        size="none"
        fullWidth={false}
        value={name}
        onChange={(event) => onChange(extensionIdFromName(event.currentTarget.value, { typing: true }))}
        placeholder="Extension name"
        aria-label="Extension name"
        aria-invalid={invalid || undefined}
        readOnly={fromFolder}
        spellCheck={false}
        className={`field-sizing-content h-full ${empty ? 'min-w-[12ch]' : 'min-w-[2ch]'} max-w-[180px] font-mono text-meta`}
      />
    </span>
  )
}

/**
 * Where the extension is made, on the strip where a chat's project sits: the
 * end of the folder's path ("SprintEngine/Extensions/weekly-summary"), so
 * where it goes is read off the line rather than worked out from a project
 * and a name side by side, and the whole path is in the tooltip. By
 * default that is a new folder in the extensions home; a press picks a folder
 * of the person's own instead (an empty one, made in the dialog if need be),
 * and the × goes back to the default.
 */
export function ExtensionFolderChip({
  folder,
  label,
  picked,
  onPick,
  onReset,
}: {
  /** The extension's folder as it will be, or null before the home is known. */
  folder: string | null
  /** The end of `folder`'s path, as the chip shows it. */
  label: string | null
  /** `folder` is one the person picked, not a new one in the home. */
  picked: boolean
  onPick: () => void
  onReset: () => void
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-0.5" data-extension-folder={picked ? 'picked' : 'home'}>
      <Tooltip
        content={
          picked
            ? `The extension is made in ${folder} and named after it. Choose another folder`
            : `A new folder is made for the extension: ${folder ?? 'in Extensions'}. Choose a folder of your own, and the extension takes its name`
        }
        placement="top"
      >
        <ChipButton
          variant="raised"
          onClick={onPick}
          aria-label={`Extension folder: ${folder ?? 'not chosen'}. Choose a folder`}
          className="min-w-0"
        >
          <FolderGlyph className="icon-xs shrink-0 text-[color:var(--extension-ink)]" />
          <span className="min-w-0 truncate">{label ?? 'Choose a folder'}</span>
        </ChipButton>
      </Tooltip>
      {picked ? <CloseIconButton size="xs" aria-label="Make it in a new folder instead" onClick={onReset} /> : null}
    </span>
  )
}
