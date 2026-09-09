// The change row's right-click menu, and the group band's, declared as DATA
// rather than as JSX in the middle of the list (epic `git-commit-window`, T5;
// completed in T6 — mockup 2522 panel 3).
//
// DATA, NOT JSX, for one reason: the menu is sixteen items long and half of
// them are conditional on what the row IS (untracked or not) and on which
// changelist it sits in. Expressed as JSX that logic would live inside the list
// component, tangled with the rendering; expressed as an array it is a function
// of a context object, and the list component renders whatever it is handed.
//
// The shape follows `design-system/components/menu`:
//
//   THE LEADING SLOT IS ALL-OR-NOTHING. Every item carries a glyph or renders
//   the empty slot, so the labels keep one left edge. `menuIconSlot` is that
//   empty slot, and it is not optional prettiness — a menu where only some rows
//   have a mark ladders its own text.
//
//   A HINT ONLY WHERE THE SHORTCUT WORKS WITH THE MENU CLOSED. Three of these
//   are real global commands (⌘D, ⌥⌘Z) and four more are keys the changes LIST
//   itself owns (⌘↓, F2, ⌫, ⌥⌘A) — those work whenever the list has focus,
//   which is what the rule asks. "Move to another changelist…" carries NO hint
//   even though the mockup drew ⇧⌘M: that chord already
//   belongs to the model picker at workspace scope, and the dispatcher takes
//   the first match, so a hint here would name a key that does something else.
//   The command is registered and bindable; the day it has a working chord the
//   hint comes back. The BAND menu's "Show diff for <list>" carries ⌘D on the
//   same terms: the panel routes that chord to the focused group band, so it is
//   a key that works from where the person is standing.
//
//   DESTRUCTIVE IS INK. `variant="danger"` colours the label; there is no fill,
//   no tone, no icon change.
//
//   SENTENCE CASE, and the labels say the SCOPE out loud when the selection is
//   more than the row that was clicked.

import React from 'react'

import {
  CreatePatchGlyph,
  DeleteChangelistGlyph,
  EditChangelistGlyph,
  MoveToChangelistGlyph,
  NewChangelistGlyph,
  OpenInEditorGlyph,
  RefreshIcon,
  RollbackGlyph,
  ShowDiffGlyph,
  StashGlyph,
} from '../../ui'
import {
  DEFAULT_CHANGELIST_ID,
  orderedChangelists,
  type Changelist,
} from '../../../../../shared/git/changelists'
import type { GitChangeGroup, GitChangeRow } from './gitChangesModel'

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
  | {
      kind: 'submenu'
      id: string
      label: string
      icon?: React.ReactNode
      disabled?: boolean
      /** Never empty — a submenu with nothing in it is a dead end, so a builder
       *  that would produce one emits a disabled item instead. */
      items: ChangeRowMenuEntry[]
    }

/** The reserved empty leading slot. Same box as a glyph, nothing drawn in it. */
export function menuIconSlot(): React.ReactNode {
  return <span aria-hidden="true" className="size-icon-xs shrink-0" />
}

/** What a path can be copied AS. Three spellings, because the three are wanted
 *  by three different readers: a shell, a code review, and a sentence. */
export type CopyPathKind = 'absolute' | 'relative' | 'filename'

export type ChangelistActions = {
  changelists: Changelist[]
  /** Which list the acted-on files sit in — the one "Delete changelist" and
   *  "Edit changelist…" mean, so the menu can never act on a list the person
   *  was not looking at. */
  currentChangelistId: string
  onMoveToChangelist: (changelistId: string) => void
  /** New list, and the acted-on files go straight into it. */
  onMoveToNewChangelist: () => void
  onNewChangelist: () => void
  onEditChangelist: (changelistId: string) => void
  onDeleteChangelist: (changelistId: string) => void
  onSetActiveChangelist: (changelistId: string) => void
}

export type ChangeRowMenuContext = ChangelistActions & {
  /** The row the menu was opened on. */
  row: GitChangeRow
  /** How many rows the actions will touch — the right-click already made the
   *  row the selection if it was outside it, so this is the truth about scope
   *  and the labels say it out loud rather than acting on more than was named. */
  selectedCount: number
  /** A git command is in flight; the acting items are unavailable, the reading
   *  ones are not. */
  busy: boolean
  /** Git has never heard of this file, so "Add to git" is real and "Discard"
   *  means delete rather than revert. */
  untracked: boolean
  /** EVERY row the actions will touch is untracked — so a move to a changelist
   *  would file paths that are drawn in the untracked group whatever list they
   *  are in, and nothing would appear to happen. */
  untrackedOnly: boolean
  /** EVERY row the actions will touch is a GUEST row — a changelist's view of
   *  hunks in a file that lives in another list. The file-level destructive
   *  items are unavailable there: discarding or deleting from a guest row would
   *  take lines this list does not own, which is the failure agent changelists
   *  exist to prevent. The file's own row still offers both. */
  partialOnly: boolean
  onCommitFiles: () => void
  onDiscard: () => void
  onShowDiff: () => void
  onOpenInEditor: () => void
  onCopyPath: (kind: CopyPathKind) => void
  onDeleteFiles: () => void
  onAddToGit: () => void
  onCreatePatch: () => void
  onCopyAsPatch: () => void
  onStash: () => void
  onRefresh: () => void
}

function filesPhrase(count: number): string {
  return count > 1 ? `${count} selected files` : 'file'
}

/**
 * The changelist half of both menus. Identical on a row and on a group band —
 * "New changelist" means the same thing
 * wherever it was asked for, and two spellings of one list of actions is how
 * two menus start to disagree.
 */
function changelistEntries(
  context: ChangelistActions,
  busy: boolean,
  // F2 is a key the changes LIST owns, so it only fires with a row under the
  // cursor. On the band's own menu it would name a key that does nothing from
  // where the person is standing, which is the same defect as a hint for a
  // shortcut that belongs to another command.
  options: { showEditHint: boolean },
): ChangeRowMenuEntry[] {
  const lists = orderedChangelists(context.changelists)
  const current = lists.find((list) => list.id === context.currentChangelistId) ?? null
  const others = lists.filter((list) => list.id !== context.currentChangelistId)
  const isDefault = context.currentChangelistId === DEFAULT_CHANGELIST_ID
  return [
    {
      kind: 'item',
      id: 'new-changelist',
      label: 'New changelist…',
      icon: <NewChangelistGlyph className="icon-xs" />,
      disabled: busy,
      onSelect: context.onNewChangelist,
    },
    {
      kind: 'item',
      id: 'delete-changelist',
      // The default list is not deletable, and the item says so by being
      // disabled rather than by vanishing: a menu whose length changes with the
      // row is a menu nobody learns the shape of.
      label: isDefault ? 'Delete changelist' : `Delete changelist “${current?.name ?? ''}”`,
      icon: <DeleteChangelistGlyph className="icon-xs" />,
      danger: !isDefault,
      disabled: busy || isDefault || !current,
      onSelect: () => context.onDeleteChangelist(context.currentChangelistId),
    },
    {
      kind: 'item',
      id: 'edit-changelist',
      label: 'Edit changelist…',
      icon: <EditChangelistGlyph className="icon-xs" />,
      ...(options.showEditHint ? { shortcut: 'F2' } : {}),
      disabled: busy || !current,
      onSelect: () => context.onEditChangelist(context.currentChangelistId),
    },
    others.length > 0
      ? {
          kind: 'submenu',
          id: 'set-active-changelist',
          label: 'Set active changelist',
          icon: menuIconSlot(),
          disabled: busy,
          items: lists.map((list) => ({
            kind: 'item' as const,
            id: `set-active-${list.id}`,
            label: list.active ? `${list.name} (active)` : list.name,
            icon: menuIconSlot(),
            disabled: busy || list.active,
            onSelect: () => context.onSetActiveChangelist(list.id),
          })),
        }
      : {
          kind: 'item',
          id: 'set-active-changelist',
          label: 'Set active changelist',
          icon: menuIconSlot(),
          disabled: true,
          onSelect: () => {},
        },
  ]
}

/**
 * The one sentence both controls that offer the move spend on why it is
 * unavailable. Short enough to sit in a menu label and in a tooltip.
 */
export const UNTRACKED_MOVE_REASON = 'tracked files only'

/** And the one a guest row spends, for the same reason and in the same place:
 *  in the LABEL, because a disabled control receives no pointer events and a
 *  tooltip on one is a sentence nobody can read. */
export const PARTIAL_ROW_REASON = 'use the file’s own row'

/** "Move to another changelist…" and its list of destinations. The list the
 *  files are already in is present and disabled — moving a file to where it
 *  already is is not an error, it is a no-op, and hiding the row would make the
 *  submenu a different shape for every row.
 *
 *  `unavailable` is the harder no-op: an UNTRACKED file is drawn in its own
 *  group under every grouping, so filing it in a changelist changes nothing a
 *  person can see. The store accepted the move and the panel announced it, and
 *  the file stayed exactly where it was. The item is kept and disabled rather
 *  than hidden (menu spec → Disabled), and the reason is in the LABEL rather
 *  than in a tooltip: a `disabled` control receives no pointer events, so a
 *  tooltip on one is a sentence nobody can read. */
function moveEntry(
  context: ChangelistActions,
  busy: boolean,
  label: string,
  unavailable = false,
): ChangeRowMenuEntry {
  const lists = orderedChangelists(context.changelists)
  if (unavailable) {
    return {
      kind: 'item',
      id: 'move-to-changelist',
      label: `${label.replace(/…$/, '')} — ${UNTRACKED_MOVE_REASON}`,
      icon: <MoveToChangelistGlyph className="icon-xs" />,
      disabled: true,
      onSelect: () => {},
    }
  }
  return {
    kind: 'submenu',
    id: 'move-to-changelist',
    label,
    icon: <MoveToChangelistGlyph className="icon-xs" />,
    disabled: busy,
    items: [
      ...lists.map((list) => ({
        kind: 'item' as const,
        id: `move-to-${list.id}`,
        label: list.active ? `${list.name} (active)` : list.name,
        icon: menuIconSlot(),
        disabled: busy || list.id === context.currentChangelistId,
        onSelect: () => context.onMoveToChangelist(list.id),
      })),
      { kind: 'divider' as const, id: 'move-to-new' },
      {
        kind: 'item' as const,
        id: 'move-to-new-changelist',
        label: 'New changelist…',
        icon: <NewChangelistGlyph className="icon-xs" />,
        disabled: busy,
        onSelect: context.onMoveToNewChangelist,
      },
    ],
  }
}

export function buildChangeRowMenu(context: ChangeRowMenuContext): ChangeRowMenuEntry[] {
  const many = context.selectedCount > 1
  const scope = filesPhrase(context.selectedCount)
  return [
    {
      kind: 'item',
      id: 'commit-files',
      label: many ? `Commit ${context.selectedCount} selected files…` : 'Commit file…',
      icon: menuIconSlot(),
      disabled: context.busy,
      onSelect: context.onCommitFiles,
    },
    {
      kind: 'item',
      id: 'discard',
      label: context.partialOnly
        ? `Discard changes — ${PARTIAL_ROW_REASON}`
        : many
        ? `Discard changes in ${context.selectedCount} selected files…`
        : 'Discard changes…',
      icon: <RollbackGlyph className="icon-xs" />,
      ...(context.partialOnly ? {} : { shortcut: '⌥⌘Z' }),
      danger: !context.partialOnly,
      disabled: context.busy || context.partialOnly,
      onSelect: context.onDiscard,
    },
    moveEntry(
      context,
      context.busy,
      many ? `Move ${scope} to another changelist…` : 'Move to another changelist…',
      context.untrackedOnly,
    ),
    {
      kind: 'item',
      id: 'show-diff',
      label: 'Show diff',
      icon: <ShowDiffGlyph className="icon-xs" />,
      shortcut: '⌘D',
      onSelect: context.onShowDiff,
    },
    {
      kind: 'item',
      id: 'open-in-editor',
      label: 'Open in editor',
      icon: <OpenInEditorGlyph className="icon-xs" />,
      shortcut: '⌘↓',
      onSelect: context.onOpenInEditor,
    },
    {
      kind: 'submenu',
      id: 'copy-path',
      label: many ? `Copy ${context.selectedCount} paths / references` : 'Copy path / reference',
      icon: menuIconSlot(),
      items: [
        {
          kind: 'item',
          id: 'copy-absolute',
          label: many ? 'Absolute paths' : 'Absolute path',
          icon: menuIconSlot(),
          onSelect: () => context.onCopyPath('absolute'),
        },
        {
          kind: 'item',
          id: 'copy-relative',
          label: many ? 'Paths from repository root' : 'Path from repository root',
          icon: menuIconSlot(),
          onSelect: () => context.onCopyPath('relative'),
        },
        {
          kind: 'item',
          id: 'copy-filename',
          label: many ? 'File names' : 'File name',
          icon: menuIconSlot(),
          onSelect: () => context.onCopyPath('filename'),
        },
      ],
    },
    { kind: 'divider', id: 'after-file' },
    {
      kind: 'item',
      id: 'delete-files',
      label: context.partialOnly
        ? `Delete — ${PARTIAL_ROW_REASON}`
        : many
        ? `Delete ${context.selectedCount} selected files…`
        : 'Delete…',
      icon: menuIconSlot(),
      ...(context.partialOnly ? {} : { shortcut: '⌫' }),
      danger: !context.partialOnly,
      disabled: context.busy || context.partialOnly,
      onSelect: context.onDeleteFiles,
    },
    // Only for a file git has never heard of. "Add to git" on a tracked file
    // would be a control that cannot do anything — the file is already added.
    ...(context.untracked
      ? [
          {
            kind: 'item' as const,
            id: 'add-to-git',
            label: many ? `Add ${context.selectedCount} selected files to git` : 'Add to git',
            icon: menuIconSlot(),
            shortcut: '⌥⌘A',
            disabled: context.busy,
            onSelect: context.onAddToGit,
          },
        ]
      : []),
    { kind: 'divider', id: 'after-changelists' },
    ...changelistEntries(context, context.busy, { showEditHint: true }),
    {
      kind: 'item',
      id: 'create-patch',
      label: many ? `Create patch from ${context.selectedCount} selected files…` : 'Create patch from changes…',
      icon: <CreatePatchGlyph className="icon-xs" />,
      disabled: context.busy,
      onSelect: context.onCreatePatch,
    },
    {
      kind: 'item',
      id: 'copy-as-patch',
      label: 'Copy as patch',
      icon: menuIconSlot(),
      disabled: context.busy,
      onSelect: context.onCopyAsPatch,
    },
    {
      kind: 'item',
      id: 'stash',
      // "all", because it is `git stash push` on the WHOLE repository — not on
      // the row the menu was opened on, and not on the selection the items
      // above it name. The label was the only thing that said otherwise.
      label: 'Stash all changes…',
      icon: <StashGlyph className="icon-xs" />,
      disabled: context.busy,
      onSelect: context.onStash,
    },
    { kind: 'divider', id: 'after-repo' },
    {
      kind: 'item',
      id: 'refresh',
      label: 'Refresh',
      icon: <RefreshIcon className="icon-xs" />,
      disabled: context.busy,
      onSelect: context.onRefresh,
    },
  ]
}

export type ChangeGroupMenuContext = ChangelistActions & {
  group: GitChangeGroup
  busy: boolean
  onStageAll: () => void
  onUnstageAll: () => void
  onDiscardAll: () => void
  /** Stage the whole list — every home file, and this list's hunks in the files
   *  it only owns a piece of — then put the caret in the composer. */
  onCommitChangelist: () => void
  /** The diff viewer, filtered to this list. */
  onShowChangelistDiff: () => void
  onRefresh: () => void
}

/**
 * The band's own menu: what can be done to a WHOLE list, then the changelist
 * half the row menu also carries.
 *
 * The three "all" items act on every row the group holds — including the ones
 * the render cap held back, exactly as the band's checkbox does. A group menu
 * that acted on the first five hundred would be the same quiet lie.
 */
export function buildChangeGroupMenu(context: ChangeGroupMenuContext): ChangeRowMenuEntry[] {
  const count = context.group.totalCount
  const empty = count === 0
  const listActions =
    context.group.kind === 'changelist'
      ? [
          { kind: 'divider' as const, id: 'after-group-files' },
          // The two items that act on the list AS A UNIT, at the top of the
          // changelist half — "Commit changelist" is the gesture the
          // whole feature is for, and it is not "stage all": it stages exactly
          // what this list owns, hunks included, and then hands the caret over.
          // It does NOT commit; the message is still unwritten, and the same
          // rule that keeps "Commit files…" from committing applies here.
          {
            kind: 'item' as const,
            id: 'commit-changelist',
            label: `Commit ${context.group.title}…`,
            icon: menuIconSlot(),
            disabled: context.busy || empty,
            onSelect: context.onCommitChangelist,
          },
          {
            kind: 'item' as const,
            id: 'show-changelist-diff',
            label: `Show diff for ${context.group.title}`,
            icon: <ShowDiffGlyph className="icon-xs" />,
            // The hint is legal here for the same reason the row menu's is: ⌘D
            // works with this menu CLOSED, on a focused group band, and the
            // panel routes it to this very action.
            shortcut: '⌘D',
            disabled: empty,
            onSelect: context.onShowChangelistDiff,
          },
          moveEntry(context, context.busy, `Move ${count === 1 ? 'the file' : 'these files'} to another changelist…`),
          ...changelistEntries(context, context.busy, { showEditHint: false }),
        ]
      : []
  return [
    {
      kind: 'item',
      id: 'stage-all',
      label: `Stage all in ${context.group.title}`,
      icon: menuIconSlot(),
      disabled: context.busy || empty,
      onSelect: context.onStageAll,
    },
    {
      kind: 'item',
      id: 'unstage-all',
      label: `Unstage all in ${context.group.title}`,
      icon: menuIconSlot(),
      disabled: context.busy || empty,
      onSelect: context.onUnstageAll,
    },
    {
      kind: 'item',
      id: 'discard-all',
      label: `Discard all in ${context.group.title}…`,
      icon: <RollbackGlyph className="icon-xs" />,
      danger: true,
      disabled: context.busy || empty,
      onSelect: context.onDiscardAll,
    },
    ...listActions,
    { kind: 'divider', id: 'after-group-repo' },
    {
      kind: 'item',
      id: 'refresh',
      label: 'Refresh',
      icon: <RefreshIcon className="icon-xs" />,
      disabled: context.busy,
      onSelect: context.onRefresh,
    },
  ]
}
