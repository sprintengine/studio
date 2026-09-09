// The change row's right-click menu, declared as DATA rather than as JSX in the
// middle of the list (epic `git-commit-window`, T5).
//
// It is declared here because T6 finishes it: the editor's row menu (mockup panel
// 3) has fourteen items and this ships five of them — the ones that have a git
// action behind them today. Changelists bring "Commit files…", "Move to another
// changelist…", the New / Delete / Edit / Set-active quartet, "Create patch",
// "Copy path", "Add to git" and "Delete…". Adding one is appending an entry to
// the array this function returns; nothing in the list component changes.
//
// The shape follows `design-system/components/menu`: a reserved leading glyph
// slot, a mono shortcut hint carried ONLY where the shortcut works with the menu
// closed, and dividers grouping the items by what they act on — the file, the
// diff, the repository.

import React from 'react'

import { OpenInEditorGlyph, NextDifferenceGlyph, RefreshIcon, RollbackGlyph, StashGlyph } from '../../ui'
import type { GitChangeRow } from './gitChangesModel'

export type ChangeRowMenuEntry =
  | { kind: 'divider'; id: string }
  | {
      kind: 'item'
      id: string
      label: string
      icon?: React.ReactNode
      shortcut?: string
      danger?: boolean
      disabled?: boolean
      onSelect: () => void
    }

export type ChangeRowMenuContext = {
  /** The row the menu was opened on. */
  row: GitChangeRow
  /** How many rows the actions will touch — the right-click already made the
   *  row the selection if it was outside it, so this is the truth about scope
   *  and the labels say it out loud rather than acting on more than was named. */
  selectedCount: number
  /** A git command is in flight; the acting items are unavailable, the reading
   *  ones are not. */
  busy: boolean
  onDiscard: () => void
  onShowDiff: () => void
  onOpenInEditor: () => void
  onStash: () => void
  onRefresh: () => void
}

export function buildChangeRowMenu(context: ChangeRowMenuContext): ChangeRowMenuEntry[] {
  const many = context.selectedCount > 1
  return [
    {
      kind: 'item',
      id: 'discard',
      label: many ? `Discard changes in ${context.selectedCount} selected files…` : 'Discard changes…',
      icon: <RollbackGlyph className="icon-xs" />,
      danger: true,
      disabled: context.busy,
      onSelect: context.onDiscard,
    },
    { kind: 'divider', id: 'after-file' },
    {
      kind: 'item',
      id: 'show-diff',
      label: 'Show diff',
      icon: <NextDifferenceGlyph className="icon-xs" />,
      onSelect: context.onShowDiff,
    },
    {
      kind: 'item',
      id: 'open-in-editor',
      label: 'Open in editor',
      icon: <OpenInEditorGlyph className="icon-xs" />,
      onSelect: context.onOpenInEditor,
    },
    { kind: 'divider', id: 'after-diff' },
    {
      kind: 'item',
      id: 'stash',
      label: 'Stash changes…',
      icon: <StashGlyph className="icon-xs" />,
      disabled: context.busy,
      onSelect: context.onStash,
    },
    {
      kind: 'item',
      id: 'refresh',
      label: 'Refresh',
      icon: <RefreshIcon />,
      disabled: context.busy,
      onSelect: context.onRefresh,
    },
  ]
}
