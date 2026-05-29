import { Tooltip } from '../ui'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useGitStatus } from '../../hooks/useGitStatus'
import { selectModuleEnabled } from '../../modules'
import { jsonModelHasComponent, togglePanelRailComponent } from '../../utils/modelRegistry'
import type { WorkspaceId } from '../../types/workspace'

type PanelKey = 'explorer' | 'editor' | 'git' | 'memory-graph'

// 999 is the visible ceiling: it occupies the same three glyph slots as a
// "99+" cap would, so we just clamp the number and skip the suffix.
const MAX_GIT_BADGE_COUNT = 999

type PanelDescriptor = {
  key: PanelKey
  tabName: string
  label: string
  shortcut?: string
  // Inline SVGs so we stay aligned with the existing 14–18 px stroke-1.3 chrome
  // used by WorkspaceTopBar buttons and the sidebar collapse glyph.
  icon: (props: { className?: string }) => JSX.Element
}

const PANELS: PanelDescriptor[] = [
  {
    key: 'explorer',
    tabName: 'Files',
    label: 'Files',
    shortcut: 'Ctrl+Shift+E',
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
    key: 'editor',
    tabName: 'Editor',
    label: 'Editor',
    shortcut: 'Ctrl+Shift+O',
    icon: ({ className }) => (
      <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
        <path
          d="M5.5 4.5L2.5 8l3 3.5M10.5 4.5L13.5 8l-3 3.5M9 3.5L7 12.5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    key: 'git',
    tabName: 'Git',
    label: 'Git',
    shortcut: 'Ctrl+Shift+G',
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
    key: 'memory-graph',
    tabName: 'Knowledge Graph',
    label: 'Knowledge Graph',
    icon: ({ className }) => (
      <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
        <path d="M8 4L3.5 11.5M8 4L12.5 11.5M4 11.5h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="8" cy="4" r="1.6" fill="currentColor" />
        <circle cx="3.5" cy="11.5" r="1.6" fill="currentColor" />
        <circle cx="12.5" cy="11.5" r="1.6" fill="currentColor" />
      </svg>
    ),
  },
]

function shortcutLabel(shortcut: string): string {
  if (window.api.platform !== 'darwin') return shortcut
  return shortcut.replace(/\bCtrl\b/g, 'Cmd').replace(/\bAlt\b/g, 'Option')
}

type PanelRailProps = {
  workspaceId: WorkspaceId
  collapsed: boolean
}

export default function PanelRail({ workspaceId, collapsed }: PanelRailProps) {
  // Subscribe to the persisted layout model so the rail re-renders whenever
  // any path (rail toggle, View menu, menu accelerator, drag-and-drop, tab
  // close) mutates the layout.
  const layoutModel = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === workspaceId)?.layoutModel
  )
  const folderPath = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === workspaceId)?.folderPath ?? null
  )

  // Hide a panel button when its capability module is disabled. The Files and
  // Editor buttons gate on the dev-tools module; Git and Knowledge Graph on
  // their own modules.
  const memoryEnabled = useWorkspaceStore((state) => selectModuleEnabled(state.appSettings.modules, 'memory-graph'))
  const gitEnabled = useWorkspaceStore((state) => selectModuleEnabled(state.appSettings.modules, 'git'))
  const devToolsEnabled = useWorkspaceStore((state) => selectModuleEnabled(state.appSettings.modules, 'dev-tools'))
  const panels = PANELS.filter((panel) => {
    if (panel.key === 'memory-graph') return memoryEnabled
    if (panel.key === 'git') return gitEnabled
    if (panel.key === 'explorer' || panel.key === 'editor') return devToolsEnabled
    return true
  })

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
  const containerClass = collapsed
    ? 'flex flex-col items-stretch pt-2'
    : 'mt-2 flex items-center justify-center gap-4'

  // `right` placement in collapsed mode prevents the tooltip from overflowing
  // the viewport to the left of a 44 px sidebar (a top/bottom-centered
  // tooltip would extend past x=0).
  const tooltipPlacement = collapsed ? 'right' : 'bottom'
  const buttonSizing = collapsed ? 'h-9 w-full' : 'h-8 w-8'

  return (
    <div
      role="toolbar"
      aria-label="Workspace panels"
      aria-orientation={collapsed ? 'vertical' : 'horizontal'}
      className={containerClass}
    >
      {panels.map((panel) => {
        const Icon = panel.icon
        const active = jsonModelHasComponent(layoutModel, panel.key)
        const showGitBadge = panel.key === 'git' && gitHasChanges
        const baseTooltip = panel.shortcut
          ? `${panel.label} (${shortcutLabel(panel.shortcut)})`
          : panel.label
        const tooltip = showGitBadge
          ? `${panel.label} · ${gitChangeCount} ${gitChangeCount === 1 ? 'change' : 'changes'}${
              panel.shortcut ? ` (${shortcutLabel(panel.shortcut)})` : ''
            }`
          : baseTooltip
        const ariaLabel = showGitBadge
          ? `${panel.label}, ${gitChangeCount} ${gitChangeCount === 1 ? 'change' : 'changes'}`
          : panel.label
        const buttonClass = `interactive relative inline-flex ${buttonSizing} items-center justify-center bg-transparent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] ${
          active
            ? 'text-[color:var(--text-strong)]'
            : 'text-[color:var(--text-subtle)] hover:text-[color:var(--text-default)]'
        }`
        const accentClass = collapsed
          ? 'pointer-events-none absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r bg-[color:var(--accent-primary)]'
          : 'pointer-events-none absolute bottom-0 left-1.5 right-1.5 h-[2px] rounded-t bg-[color:var(--accent-primary)]'
        return (
          <Tooltip key={panel.key} content={tooltip} placement={tooltipPlacement}>
            <button
              type="button"
              onClick={() => togglePanelRailComponent(workspaceId, panel.key, panel.tabName)}
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
                  <span className="pointer-events-none absolute -right-[5px] -top-[10px] flex h-[14px] min-w-[14px] items-center justify-center rounded-full border-2 border-[color:var(--bg-app)] bg-[color:var(--tone-warn)] px-[3px] text-[9px] font-bold leading-none tabular-nums text-[color:var(--text-on-accent)]">
                    {gitBadgeLabel}
                  </span>
                ) : null}
              </span>
              {active ? <span aria-hidden="true" className={accentClass} /> : null}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}
