// The Files / Git / Backlog panel switches, extracted out of the old PanelRail
// so they live in the window title bar (AppTitleBar) as the single nav toolbar.
// One source of the PANELS descriptor and its toggle / git-badge / module-gating
// / active-derivation semantics — the sidebar no longer carries a second copy.
//
// AppTitleBar is global chrome, so the active workspace id is passed in (it is
// window-scoped in WorkspaceManager and can't be resolved from the store alone);
// the layout model, folder path, and module overrides are subscribed here so the
// active accent underline tracks any layout mutation of that workspace live.

import { ChangePulse, Tooltip } from '../ui'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useGitStatus } from '../../hooks/useGitStatus'
import { selectModuleEnabled } from '../../modules'
import { jsonModelHasComponent, togglePanelRailComponent } from '../../utils/modelRegistry'
import type { WorkspaceId } from '../../types/workspace'
import {
  getEffectiveKeybindingLabel,
  platformKeybindingsFromApiPlatform,
} from '../../commands/effectiveKeybindings'

type PanelKey = 'explorer' | 'git' | 'backlog'

// 999 is the visible ceiling: it occupies the same three glyph slots as a
// "99+" cap would, so we just clamp the number and skip the suffix.
const MAX_GIT_BADGE_COUNT = 999

type PanelDescriptor = {
  key: PanelKey
  commandId?: string
  tabName: string
  label: string
  // Capability module that gates this button; the toolbar hides it when the
  // module is disabled. (All current panels belong to a module.)
  moduleId: string
  // Inline SVGs so we stay aligned with the existing 16 px stroke-1.3 chrome
  // used by the other AppTitleBar strip buttons.
  icon: (props: { className?: string }) => JSX.Element
}

// Single source of the panel-switch descriptor. Exported so any future consumer
// reuses the same behavior instead of re-implementing icons/badges/toggles.
export const PANELS: PanelDescriptor[] = [
  {
    key: 'explorer',
    commandId: 'panel.files.toggle',
    moduleId: 'dev-tools',
    tabName: 'Files',
    label: 'Files',
    icon: ({ className }) => (
      <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
        <path
          d="M2.5 4.25C2.5 3.56 3.06 3 3.75 3H6.5l1.5 1.5h4.25c.69 0 1.25.56 1.25 1.25v6c0 .69-.56 1.25-1.25 1.25H3.75c-.69 0-1.25-.56-1.25-1.25V4.25Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    key: 'git',
    commandId: 'panel.git.toggle',
    moduleId: 'git',
    tabName: 'Git',
    label: 'Git',
    icon: ({ className }) => (
      <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
        <circle cx="4.5" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="4.5" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="11.5" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M4.5 5.5v5M6 12c2.5 0 4-1.5 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: 'backlog',
    moduleId: 'backlog',
    tabName: 'Backlog',
    label: 'Backlog',
    icon: ({ className }) => (
      <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
        <path d="M6 4.5h7M6 8h7M6 11.5h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="3" cy="4.5" r="1" fill="currentColor" />
        <circle cx="3" cy="8" r="1" fill="currentColor" />
        <circle cx="3" cy="11.5" r="1" fill="currentColor" />
      </svg>
    ),
  },
]

type PanelSwitchesProps = {
  // Window-scoped active workspace; null while none is active — the whole switch
  // group (and its leading divider) hides so the strip reads as nav-only.
  activeWorkspaceId: WorkspaceId | null
}

export function PanelSwitches({ activeWorkspaceId }: PanelSwitchesProps) {
  // Subscribe to the active workspace's persisted layout so the accent underline
  // re-renders whenever any path (switch click, View menu, accelerator,
  // drag-and-drop, tab close) mutates its layout.
  const layoutModel = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.layoutModel
  )
  const folderPath = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.folderPath ?? null
  )

  // Hide a switch when its capability module is disabled — driven by each
  // descriptor's moduleId, so a new gated panel just sets moduleId.
  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  const keybindingSettings = useWorkspaceStore((state) => state.appSettings.keybindings)
  const keybindingPlatform = platformKeybindingsFromApiPlatform(window.api.platform)
  const panels = PANELS.filter((panel) => selectModuleEnabled(moduleOverrides, panel.moduleId))
  const shortcutFor = (commandId: string): string | null =>
    getEffectiveKeybindingLabel(commandId, keybindingSettings, keybindingPlatform)

  // Source of truth for the git change count badge on the Git switch.
  const { status: gitStatus, repoState: gitRepoState } = useGitStatus(folderPath)
  const gitChangeCount = Object.keys(gitStatus?.files ?? {}).length
  const gitHasChanges = gitRepoState === 'ready' && gitChangeCount > 0
  const gitBadgeLabel = String(Math.min(gitChangeCount, MAX_GIT_BADGE_COUNT))

  // No active workspace, or every panel's module disabled: render nothing at all
  // (including the divider) so the nav arrows sit alone.
  if (!activeWorkspaceId || panels.length === 0) return null

  const renderSwitch = (panel: PanelDescriptor) => {
    const Icon = panel.icon
    // Every switch maps 1:1 to its FlexLayout component.
    const active = jsonModelHasComponent(layoutModel, panel.key)
    const showGitBadge = panel.key === 'git' && gitHasChanges
    const shortcut = panel.commandId ? shortcutFor(panel.commandId) : null
    const baseTooltip = shortcut ? `${panel.label} (${shortcut})` : panel.label
    const tooltip = showGitBadge
      ? `${panel.label} · ${gitChangeCount} ${gitChangeCount === 1 ? 'change' : 'changes'}${
          shortcut ? ` (${shortcut})` : ''
        }`
      : baseTooltip
    const ariaLabel = showGitBadge
      ? `${panel.label}, ${gitChangeCount} ${gitChangeCount === 1 ? 'change' : 'changes'}`
      : panel.label
    // app-no-drag: interactive control inside the title bar's drag region.
    const buttonClass = `app-no-drag interactive relative inline-flex h-7 w-7 items-center justify-center bg-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] ${
      active
        ? 'text-[color:var(--text-strong)]'
        : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-default)]'
    }`
    return (
      <Tooltip key={panel.key} content={tooltip} placement="bottom">
        <button
          type="button"
          onClick={() => togglePanelRailComponent(activeWorkspaceId, panel.key, panel.tabName)}
          aria-pressed={active}
          aria-label={ariaLabel}
          className={buttonClass}
        >
          {/*
           * Wrapping the glyph in a relative span anchors the badge to the icon
           * itself. The Git glyph pulses in its badge colour each time the change
           * count moves while the strip stays mounted; keyed on the count, reset
           * on folder switch so swapping repos never flashes. Other glyphs render
           * bare.
           */}
          <span className="relative inline-flex">
            {panel.key === 'git' && gitHasChanges ? (
              <ChangePulse
                value={gitChangeCount}
                resetKey={folderPath}
                tint="var(--git-count-badge-bg)"
                className="inline-flex"
              >
                <Icon className="h-[16px] w-[16px]" />
              </ChangePulse>
            ) : (
              <Icon className="h-[16px] w-[16px]" />
            )}
            {showGitBadge ? (
              <span className="pointer-events-none absolute -right-[6px] -top-[6px] flex h-[14px] min-w-[14px] items-center justify-center rounded-full border-2 border-[color:var(--bg-surface)] bg-[color:var(--git-count-badge-bg)] px-[3px] text-[9px] font-bold leading-none tabular-nums text-[color:var(--git-count-badge-ink)]">
                {gitBadgeLabel}
              </span>
            ) : null}
          </span>
          {active ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute bottom-0 left-1.5 right-1.5 h-[2px] rounded-t bg-[color:var(--accent-primary)]"
            />
          ) : null}
        </button>
      </Tooltip>
    )
  }

  return (
    <div role="toolbar" aria-label="Workspace panels" className="flex items-center">
      {/* Hairline divider separating window nav (collapse · back · forward) from
          the per-workspace panel switches. */}
      <span aria-hidden="true" className="mx-1.5 h-4 w-px bg-[color:var(--border-subtle)]" />
      <div className="flex items-center gap-0.5">{panels.map(renderSwitch)}</div>
    </div>
  )
}
