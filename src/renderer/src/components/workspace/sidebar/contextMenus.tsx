// The sidebar's right-click menus for a workspace row and a folder header.

import { type Workspace, type HighlightColor } from '../../../types/workspace'
import { resolveEnabledWorkspaceType } from '../../AppIcons'
import type { WorkspaceTypeRowAction } from '../../../modules/renderer-host'
import {
  type SnoozePresetId,
  isSnoozedWorkspace,
  canSnoozeWorkspace,
  resolveSnoozePresets,
} from '../../../utils/workspaceSnooze'
import { newChatProjectTarget, type FolderGroup } from './folderGroups'
import { isStarred } from '../../../utils/highlight'
import { isSettledWorkspace } from '../../../utils/workspaceSettle'
import {
  ContextMenu,
  MenuItem,
  MenuDivider,
  StarGlyph,
  MenuFlyoutItem,
  MenuSwatchRow,
  ProjectColorSwatchRow,
} from '../../ui'
import { type ProjectColorSetting, type ProjectColor } from '../../../utils/projectColor'

export function sidebarWorkspaceOf(workspace: Workspace): {
  id: string
  name: string
  mode: Workspace['mode']
  moduleState: Workspace['moduleState']
} {
  return {
    id: workspace.id,
    name: workspace.name,
    mode: workspace.mode,
    moduleState: workspace.moduleState,
  }
}

export function workspaceTypeRowActions(
  workspace: Workspace,
  moduleOverrides: Parameters<typeof resolveEnabledWorkspaceType>[1],
): WorkspaceTypeRowAction[] {
  const type = resolveEnabledWorkspaceType(workspace.mode, moduleOverrides)
  const row = sidebarWorkspaceOf(workspace)
  return (type?.rowActions ?? []).filter((action) => action.isVisible?.(row) !== false)
}

export type ContextMenuAction =
  | 'open'
  | 'rename'
  | 'new-chat'
  | 'reveal'
  | 'move-to-new-window'
  | 'move-to-main-window'
  | 'close'
  | 'toggle-star'
  | 'toggle-settle'
  // Snooze presets dispatch as `snooze:<presetId>` so the union stays closed
  // while the list of wake times remains data: a new wake time is a row in the
  // preset table, not a new member of this union.
  | `snooze:${SnoozePresetId}`
  | 'wake'
  | 'clear-color'
  | `type-action:${string}`

// Workspace-row context menu. Generic menu chrome (surface, clamped
// positioning, items, dividers, swatch row, dismissal, focus handling) lives
// in the ui/ContextMenu primitive; only the sidebar's actions stay here.
export function WorkspaceContextMenu({
  x,
  y,
  workspace,
  moduleOverrides,
  isDetachedWindow,
  now,
  onClose,
  onSelect,
  onPickColor,
}: {
  x: number
  y: number
  workspace: Workspace | null
  moduleOverrides: Parameters<typeof resolveEnabledWorkspaceType>[1]
  isDetachedWindow: boolean
  /** The clock the wake times and the asleep/awake reading are resolved against. */
  now: number
  onClose: () => void
  onSelect: (action: ContextMenuAction) => void
  onPickColor: (color: HighlightColor) => void
}) {
  if (!workspace) return null
  const typeActions = workspaceTypeRowActions(workspace, moduleOverrides)
  // Reveal is about THIS row's folder, so a missing one takes it away. New
  // chat is about the project the row files under, which a pruned worktree
  // does not touch — hence the two predicates rather than one.
  const folderPathExists = Boolean(workspace.folderPath) && !workspace.folderMissing
  const canNewChatInProject = newChatProjectTarget(workspace) !== null
  const starred = isStarred(workspace.highlight)
  const settled = isSettledWorkspace(workspace)
  const snoozed = isSnoozedWorkspace(workspace, now)
  const canSnooze = canSnoozeWorkspace(workspace)
  const currentColor = workspace.highlight?.color ?? null

  return (
    <ContextMenu
      x={x}
      y={y}
      ariaLabel={`Workspace actions: ${workspace.name}`}
      onClose={onClose}
      surfaceClassName="min-w-[240px]"
    >
      <MenuItem onClick={() => onSelect('open')}>Open</MenuItem>
      <MenuItem onClick={() => onSelect('rename')} shortcut="F2">
        Rename
      </MenuItem>
      {canNewChatInProject ? <MenuItem onClick={() => onSelect('new-chat')}>New chat in project</MenuItem> : null}
      {folderPathExists ? <MenuItem onClick={() => onSelect('reveal')}>Reveal folder</MenuItem> : null}
      {isDetachedWindow ? (
        <MenuItem onClick={() => onSelect('move-to-main-window')}>Move to Main Window</MenuItem>
      ) : (
        <MenuItem onClick={() => onSelect('move-to-new-window')}>Move to New Window</MenuItem>
      )}
      <MenuDivider />
      <MenuItem
        checked={starred}
        onClick={() => onSelect('toggle-star')}
        icon={
          <StarGlyph
            filled={starred}
            stroked
            className={`icon-sm shrink-0 ${starred ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-disabled)]'}`}
          />
        }
      >
        {starred ? 'Unstar' : 'Star'}
      </MenuItem>
      {/* Rest by hand (settled-chats, 2026-09-07). Un-settle also holds the
          row out of the sweep until it sees new activity. A row born on a
          paired machine is the Remote band's, which has no shelf. */}
      {workspace.remoteOrigin ? null : (
        <MenuItem onClick={() => onSelect('toggle-settle')}>{settled ? 'Un-settle' : 'Settle'}</MenuItem>
      )}
      {/* Sleep by hand (snooze, 2026-09-10), beneath Settle because it is the
          softer of the two: Settle says the work is done, Snooze says only
          "not now". Resolved against the clock at OPEN time so the wake times
          on the rows are the ones the click will actually land on.

          Hidden entirely — rather than disabled — on a settled row and on a
          Remote-band row: neither has anywhere to sleep, and a permanently
          dead entry is worse than no entry. Disabled, not hidden, when the
          agent is waiting on the person: that one is temporary and the reason
          is worth showing. */}
      {snoozed ? (
        <MenuItem onClick={() => onSelect('wake')}>Wake now</MenuItem>
      ) : workspace.remoteOrigin || settled ? null : (
        <MenuFlyoutItem label="Snooze" ariaLabel="Snooze chat" disabled={!canSnooze}>
          {resolveSnoozePresets(Date.now()).map((preset) => (
            <MenuItem key={preset.id} hint={preset.whenLabel} onClick={() => onSelect(`snooze:${preset.id}`)}>
              {preset.label}
            </MenuItem>
          ))}
        </MenuFlyoutItem>
      )}
      <MenuSwatchRow
        label="Highlight color"
        value={currentColor}
        onPick={onPickColor}
        onClear={() => onSelect('clear-color')}
      />
      <MenuDivider />
      {typeActions.map((action) => (
        <MenuItem key={action.id} variant={action.variant} onClick={() => onSelect(`type-action:${action.id}`)}>
          {action.label}
        </MenuItem>
      ))}
      <MenuItem onClick={() => onSelect('close')}>Close workspace</MenuItem>
    </ContextMenu>
  )
}

export type FolderMenuAction = 'new-chat' | 'reveal' | 'forget'

export function FolderContextMenu({
  x,
  y,
  group,
  projectColorKey: colorKey,
  projectColorSettled,
  projectColor,
  automaticProjectColor,
  onClose,
  onSelect,
  onPickProjectColor,
}: {
  x: number
  y: number
  group: FolderGroup | null
  /** The project this header names, or null when it is not a project. */
  projectColorKey: string | null
  /** Whether that key is the project's FINAL one — see `canPickColor` below. */
  projectColorSettled: boolean
  /** The person's override for that project: a hue, `'none'`, or null for none. */
  projectColor: ProjectColorSetting | null
  /** The hue hashed from that project's key — what "Automatic" returns to. */
  automaticProjectColor: ProjectColor
  onClose: () => void
  onSelect: (action: FolderMenuAction) => void
  /** A hue, `'none'`, or null for "Automatic" (deletes the override). */
  onPickProjectColor: (color: ProjectColorSetting | null) => void
}) {
  if (!group) return null
  const canReveal = Boolean(group.fullPath) && !group.missing
  const canForget = Boolean(group.fullPath)
  const canCreateWorkspace = Boolean(group.fullPath) && !group.missing
  // "Changed by you" (decision 5) — but only where there is a project to
  // change, and only once we know which project it IS. The "No folder" bucket
  // is not a project, and a remote group's root lives on another machine with
  // no identity to key by.
  //
  // The `settled` half is not cosmetic. Before the repository read lands the key
  // is the folder's PATH; a person who right-clicks a header in that first
  // second and picks a hue would have it written to `folder:/path`, and a beat
  // later the project is keyed `repo:…` and their choice has silently vanished
  // — leaving a stray override on a key nothing reads. Better to not offer the
  // control for that beat than to take a choice and lose it.
  const canPickColor = Boolean(colorKey) && projectColorSettled

  return (
    <ContextMenu
      x={x}
      y={y}
      ariaLabel={`Folder actions: ${group.displayName}`}
      onClose={onClose}
      surfaceClassName="min-w-[220px]"
    >
      {canCreateWorkspace ? <MenuItem onClick={() => onSelect('new-chat')}>New chat in project</MenuItem> : null}
      {canReveal ? <MenuItem onClick={() => onSelect('reveal')}>Reveal folder</MenuItem> : null}
      {/* The same swatch control the row menu spends on "Highlight color", one
          menu up: a highlight is a tint a person puts ON a chat, a project
          colour is what the project IS, and the header is the one line that
          names the project. "Automatic" (the hashed hue), eight named hues,
          and "No colour" — the last for a project whose own logo already
          identifies it. */}
      {canPickColor ? (
        <ProjectColorSwatchRow
          label="Project color"
          value={projectColor}
          automaticColor={automaticProjectColor}
          onPick={onPickProjectColor}
        />
      ) : null}
      {canCreateWorkspace && canForget ? <MenuDivider /> : null}
      {canForget ? (
        <MenuItem variant="danger" onClick={() => onSelect('forget')}>
          Forget folder…
        </MenuItem>
      ) : null}
    </ContextMenu>
  )
}
