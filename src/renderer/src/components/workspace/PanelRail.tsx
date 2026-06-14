import { Tooltip } from '../ui'
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
  // Capability module that gates this button; the rail hides it when the module
  // is disabled. (All current rail panels belong to a module.)
  moduleId: string
  // Inline SVGs so we stay aligned with the existing 14–18 px stroke-1.3 chrome
  // used by WorkspaceTopBar buttons and the sidebar collapse glyph.
  icon: (props: { className?: string }) => JSX.Element
}

const PANELS: PanelDescriptor[] = [
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

type PanelRailProps = {
  // Null while no workspace is active: the rail still renders so the collapse
  // toggle (its trailing chrome) stays reachable; the panel switches hide.
  workspaceId: WorkspaceId | null
  collapsed: boolean
  onToggleCollapse: () => void
}

export default function PanelRail({ workspaceId, collapsed, onToggleCollapse }: PanelRailProps) {
  // Subscribe to the persisted layout model so the rail re-renders whenever
  // any path (rail toggle, View menu, menu accelerator, drag-and-drop, tab
  // close) mutates the layout.
  const layoutModel = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === workspaceId)?.layoutModel
  )
  const folderPath = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === workspaceId)?.folderPath ?? null
  )

  // Hide a panel button when its capability module is disabled — driven by each
  // descriptor's moduleId, so a new gated rail panel just sets moduleId.
  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  const keybindingSettings = useWorkspaceStore((state) => state.appSettings.keybindings)
  const keybindingPlatform = platformKeybindingsFromApiPlatform(window.api.platform)
  const panels = PANELS.filter((panel) => selectModuleEnabled(moduleOverrides, panel.moduleId))
  const shortcutFor = (commandId: string): string | null =>
    getEffectiveKeybindingLabel(commandId, keybindingSettings, keybindingPlatform)

  // Source of truth for the git change count badge on the Git rail icon
  // (consolidated here when the top-bar git button was retired).
  const { status: gitStatus, repoState: gitRepoState } = useGitStatus(folderPath)
  const gitChangeCount = Object.keys(gitStatus?.files ?? {}).length
  const gitHasChanges = gitRepoState === 'ready' && gitChangeCount > 0
  const gitBadgeLabel = String(Math.min(gitChangeCount, MAX_GIT_BADGE_COUNT))

  // Bare-icon activity-bar idiom: no container
  // chrome, no chip on active, hover just brightens the icon. Active state =
  // brighter foreground + 2px accent stripe (left edge in collapsed/vertical
  // mode hugs the sidebar's outer edge; bottom underline in expanded mode).
  // Expanded, the rail is the sidebar's top chrome row (48 px, hairline
  // underline) so the workspace tree below lines up with the workspace top
  // bar; collapsed it stacks vertically with the collapse toggle on top.
  const containerClass = collapsed
    ? 'flex flex-col items-stretch pt-2'
    : 'grid h-[48px] grid-cols-[32px_minmax(0,1fr)_32px] items-center border-b border-[color:var(--border-subtle)] px-2'

  // `right` placement in collapsed mode prevents the tooltip from overflowing
  // the viewport to the left of a 44 px sidebar (a top/bottom-centered
  // tooltip would extend past x=0).
  const tooltipPlacement = collapsed ? 'right' : 'bottom'
  const buttonSizing = collapsed ? 'h-9 w-full' : 'h-8 w-8'

  // The collapse toggle is chrome, not a nav switch: it brightens on hover
  // like the rail icons but carries no accent stripe. It leads in both
  // layouts — the full-width top row when collapsed, the leading grid cell
  // when expanded.
  const collapseToggle = (
    <Tooltip
      content={
        shortcutFor('workspace.sidebar.toggle')
          ? `${collapsed ? 'Open sidebar' : 'Collapse sidebar'} (${shortcutFor('workspace.sidebar.toggle')})`
          : collapsed ? 'Open sidebar' : 'Collapse sidebar'
      }
      placement={tooltipPlacement}
    >
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-label={collapsed ? 'Open sidebar' : 'Collapse sidebar'}
        className={`interactive inline-flex items-center justify-center bg-transparent text-[color:var(--text-subtle)] transition-colors hover:text-[color:var(--text-default)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] ${buttonSizing}`}
      >
        {/*
         * Standard `panel-left` sidebar glyph (rounded rect + left-panel
         * divider), the formal idiom of desktop developer tools.
         * One glyph for both states — the aria-label carries open/collapsed.
         */}
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 3V13" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
    </Tooltip>
  )

  // Shared between layouts: one nav switch button.
  const renderPanelButton = (panel: PanelDescriptor) => {
        const Icon = panel.icon
        // Every rail switch maps 1:1 to its FlexLayout component.
        const active = jsonModelHasComponent(layoutModel, panel.key)
        const showGitBadge = panel.key === 'git' && gitHasChanges
        const shortcut = panel.commandId ? shortcutFor(panel.commandId) : null
        const baseTooltip = shortcut
          ? `${panel.label} (${shortcut})`
          : panel.label
        const tooltip = showGitBadge
          ? `${panel.label} · ${gitChangeCount} ${gitChangeCount === 1 ? 'change' : 'changes'}${
              shortcut ? ` (${shortcut})` : ''
            }`
          : baseTooltip
        const ariaLabel = showGitBadge
          ? `${panel.label}, ${gitChangeCount} ${gitChangeCount === 1 ? 'change' : 'changes'}`
          : panel.label
        const buttonClass = `interactive relative inline-flex ${buttonSizing} items-center justify-center bg-transparent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] ${
          active
            ? 'text-[color:var(--text-strong)]'
            : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-default)]'
        }`
        const accentClass = collapsed
          ? 'pointer-events-none absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r bg-[color:var(--accent-primary)]'
          : 'pointer-events-none absolute bottom-0 left-1.5 right-1.5 h-[2px] rounded-t bg-[color:var(--accent-primary)]'
        return (
          <Tooltip key={panel.key} content={tooltip} placement={tooltipPlacement}>
            <button
              type="button"
              onClick={() => {
                if (workspaceId) togglePanelRailComponent(workspaceId, panel.key, panel.tabName)
              }}
              aria-pressed={active}
              aria-label={ariaLabel}
              className={buttonClass}
            >
              {/*
               * Wrapping the glyph in a relative span anchors the badge to
               * the icon itself rather than the button bounding box. In
               * collapsed mode the button stretches to the full 44 px rail
               * width, so a button-relative badge would float far from the
               * glyph; this keeps it glued to the icon corner regardless of
               * button size.
               *
               * Placement note: desktop editors sit the SCM count badge in
               * the icon's bottom-right corner with ~50 % overlap, and IDEs
               * keeps counts off the icon entirely, and Linear keeps counts
               * at the row's right edge. We honour the user's request to
               * "hover above" the icon by floating the badge above the
               * top-right corner with enough offset that no part of the
               * underlying glyph (the branch dots + lines) is obscured. A
               * 2 px ring tinted with the app background separates the
               * amber pill from the dark rail so it reads as a chip even
               * against the icon.
               */}
              <span className="relative inline-flex">
                <Icon className="h-[16px] w-[16px]" />
                {showGitBadge ? (
                  <span className="pointer-events-none absolute -right-[8px] -top-[10px] flex h-[14px] min-w-[14px] items-center justify-center rounded-full border-2 border-[color:var(--bg-app)] bg-[color:var(--git-count-badge-bg)] px-[3px] text-[9px] font-bold leading-none tabular-nums text-[color:var(--git-count-badge-ink)]">
                    {gitBadgeLabel}
                  </span>
                ) : null}
              </span>
              {active ? <span aria-hidden="true" className={accentClass} /> : null}
            </button>
          </Tooltip>
        )
  }

  // Expanded: the collapse toggle stays in the leading utility cell, while the
  // panel switches are centered in the row and balanced by a matching trailing
  // spacer. Collapsed: the toggle leads the vertical stack, the same reading
  // order.
  return (
    <div
      role="toolbar"
      aria-label="Workspace panels"
      aria-orientation={collapsed ? 'vertical' : 'horizontal'}
      className={containerClass}
    >
      {collapsed ? (
        <>
          {collapseToggle}
          {workspaceId ? panels.map(renderPanelButton) : null}
        </>
      ) : (
        <>
          <div className="flex h-8 w-8 items-center justify-center">
            {collapseToggle}
          </div>
          {workspaceId ? (
            <div className="flex min-w-0 items-center justify-center gap-4">
              {panels.map(renderPanelButton)}
            </div>
          ) : (
            <span aria-hidden="true" />
          )}
          <span aria-hidden="true" className="h-8 w-8" />
        </>
      )}
    </div>
  )
}
