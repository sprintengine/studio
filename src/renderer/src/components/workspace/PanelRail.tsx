import { Tooltip } from '../ui'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { jsonModelHasComponent, toggleComponentTab } from '../../utils/modelRegistry'
import type { WorkspaceId } from '../../types/workspace'

type PanelKey = 'explorer' | 'editor' | 'git'

type PanelDescriptor = {
  key: PanelKey
  tabName: string
  label: string
  shortcut: string
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

  // Bare-icon activity-bar idiom: no container
  // chrome, no chip on active, hover just brightens the icon. Active state =
  // brighter foreground + 2px accent stripe (left edge in collapsed/vertical
  // mode hugs the sidebar's outer edge; bottom underline in expanded mode).
  const containerClass = collapsed
    ? 'flex flex-col items-stretch pt-2'
    : 'mt-2 flex items-center justify-center gap-4'

  const tooltipPlacement = collapsed ? 'top' : 'bottom'
  const buttonSizing = collapsed ? 'h-9 w-full' : 'h-8 w-8'

  return (
    <div
      role="toolbar"
      aria-label="Workspace panels"
      aria-orientation={collapsed ? 'vertical' : 'horizontal'}
      className={containerClass}
    >
      {PANELS.map((panel) => {
        const Icon = panel.icon
        const active = jsonModelHasComponent(layoutModel, panel.key)
        const tooltip = `${panel.label} (${shortcutLabel(panel.shortcut)})`
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
              onClick={() => toggleComponentTab(workspaceId, panel.key, panel.tabName)}
              aria-pressed={active}
              aria-label={panel.label}
              className={buttonClass}
            >
              <Icon className="h-[16px] w-[16px]" />
              {active ? <span aria-hidden="true" className={accentClass} /> : null}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}
