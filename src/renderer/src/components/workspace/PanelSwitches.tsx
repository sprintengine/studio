// The Backlog panel switch, extracted out of the old PanelRail so it lives in
// the window title bar (AppTitleBar / WorkspaceHeader) as the single nav toolbar.
// One source of the PANELS descriptor and its toggle / module-gating /
// active-derivation semantics — the sidebar no longer carries a second copy.
//
// Files and Git no longer have switches here: the workspace identity cluster
// already carries a project chip (reveals Files) and a branch chip (opens Git),
// so a separate icon toggle for each was redundant. The git change count that
// used to badge the Git switch now rides the branch chip in WorkspaceIdentity.
// Files/Git stay reachable (and toggle-closeable) via the command palette and
// their keyboard shortcuts (panel.files.toggle / panel.git.toggle).
//
// AppTitleBar is global chrome, so the active workspace id is passed in (it is
// window-scoped in WorkspaceManager and can't be resolved from the store alone);
// the layout model and module overrides are subscribed here so the active
// treatment tracks any layout mutation of that workspace live.
//
// Two clusters, two docked rails: Backlog switches the left pane, Skills the
// right one, and they are independent — opening one never closes the other.

import { Tooltip } from '../ui'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { selectModuleEnabled } from '../../modules'
import {
  jsonModelHasComponent,
  togglePanelRailComponent,
  type RailSide,
} from '../../utils/modelRegistry'
import type { WorkspaceId } from '../../types/workspace'
import {
  getEffectiveKeybindingLabel,
  platformKeybindingsFromApiPlatform,
} from '../../commands/effectiveKeybindings'

type PanelKey = 'backlog' | 'skills'

// Which header cluster a switch renders into. It tracks `side` today and is a
// separate field because it answers a different question: `side` is where the
// pane docks in the layout model, `cluster` is where its control sits in the
// header.
export type PanelCluster = 'left' | 'right'

type PanelDescriptor = {
  key: PanelKey
  commandId?: string
  tabName: string
  label: string
  // Accessible name and tooltip while the pane is open, for a control that reads
  // as a collapse once its pane is showing. Falls back to `label`.
  activeLabel?: string
  // Which docked rail this switch drives.
  side: RailSide
  cluster: PanelCluster
  // Capability module that gates this button; the toolbar hides it when the
  // module is disabled. Undefined for a panel that belongs to no module and is
  // therefore always offered.
  moduleId?: string
  // Inline SVGs so we stay aligned with the existing 16 px chrome used by the
  // other header strip buttons.
  icon: (props: { className?: string }) => JSX.Element
}

// Single source of the panel-switch descriptor. Exported so any future consumer
// reuses the same behavior instead of re-implementing icons/module-gating.
export const PANELS: PanelDescriptor[] = [
  {
    key: 'backlog',
    moduleId: 'backlog',
    tabName: 'Backlog',
    label: 'Backlog',
    side: 'left',
    cluster: 'left',
    icon: ({ className }) => (
      <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
        <path d="M6 4.5h7M6 8h7M6 11.5h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="3" cy="4.5" r="1" fill="currentColor" />
        <circle cx="3" cy="8" r="1" fill="currentColor" />
        <circle cx="3" cy="11.5" r="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    key: 'skills',
    tabName: 'Skills and MCPs',
    label: 'Skills',
    activeLabel: 'Collapse skills',
    side: 'right',
    cluster: 'right',
    // SidebarChrome's collapse glyph mirrored: the same rect, the same 1.5
    // stroke, the divider moved from x=6 to x=10. One idiom, both edges.
    icon: ({ className }) => (
      <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
        <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 3V13" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
]

type PanelSwitchesProps = {
  // Window-scoped active workspace; null while none is active — the whole switch
  // group (and its leading divider) hides so the strip reads as nav-only.
  activeWorkspaceId: WorkspaceId | null
  // The leading hairline divider separates the switches from an adjacent window
  // nav cluster (collapse · back · forward) in the full-width AppTitleBar. In the
  // split-chrome WorkspaceHeader the switches lead the strip, so it's dropped.
  leadingDivider?: boolean
  // Which cluster's switches to render. The left group owns its own toolbar; the
  // right group joins WorkspaceHeader's existing right toolbar (diagnostics ·
  // attention), so it renders bare — a nested toolbar there would be invalid.
  cluster?: PanelCluster
}

export function PanelSwitches({
  activeWorkspaceId,
  leadingDivider = true,
  cluster = 'left',
}: PanelSwitchesProps) {
  // Subscribe to the active workspace's persisted layout so the active treatment
  // re-renders whenever any path (switch click, View menu, accelerator,
  // drag-and-drop, tab close) mutates its layout.
  const layoutModel = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.layoutModel
  )

  // Hide a switch when its capability module is disabled — driven by each
  // descriptor's moduleId, so a new gated panel just sets moduleId.
  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  const keybindingSettings = useWorkspaceStore((state) => state.appSettings.keybindings)
  const keybindingPlatform = platformKeybindingsFromApiPlatform(window.api.platform)
  const panels = PANELS.filter(
    (panel) =>
      panel.cluster === cluster
      && (!panel.moduleId || selectModuleEnabled(moduleOverrides, panel.moduleId))
  )
  const shortcutFor = (commandId: string): string | null =>
    getEffectiveKeybindingLabel(commandId, keybindingSettings, keybindingPlatform)

  // No active workspace, or every panel's module disabled: render nothing at all
  // (including the divider) so the nav arrows sit alone.
  if (!activeWorkspaceId || panels.length === 0) return null

  const renderSwitch = (panel: PanelDescriptor) => {
    const Icon = panel.icon
    // Every switch maps 1:1 to its FlexLayout component.
    const active = jsonModelHasComponent(layoutModel, panel.key)
    const label = active ? panel.activeLabel ?? panel.label : panel.label
    const shortcut = panel.commandId ? shortcutFor(panel.commandId) : null
    const tooltip = shortcut ? `${label} (${shortcut})` : label
    // app-no-drag: interactive control inside the title bar's drag region.
    // Active is the neutral selection fill, not an accent underline: the accent
    // is reserved for the one primary action per view (design-system
    // foundations/principles.md § Restraint).
    const buttonClass = `app-no-drag interactive inline-flex size-control-xs items-center justify-center rounded-sm focus-visible:focus-ring ${
      active
        ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
        : 'bg-transparent text-[color:var(--text-muted)] hover:text-[color:var(--text-default)]'
    }`
    return (
      <Tooltip key={panel.key} content={tooltip} placement="bottom">
        <button
          type="button"
          onClick={() => togglePanelRailComponent(activeWorkspaceId, panel.key, panel.tabName)}
          aria-pressed={active}
          aria-label={label}
          className={buttonClass}
        >
          <Icon className="size-icon-sm" />
        </button>
      </Tooltip>
    )
  }

  // The right cluster sits inside WorkspaceHeader's existing right toolbar, so
  // it contributes buttons only — its own wrapper would nest one toolbar in
  // another.
  if (cluster === 'right') return <>{panels.map(renderSwitch)}</>

  return (
    <div role="toolbar" aria-label="Workspace panels" className="flex items-center">
      {/* Hairline divider separating window nav (collapse · back · forward) from
          the per-workspace panel switches — only when they share a strip. */}
      {leadingDivider ? (
        <span aria-hidden="true" className="mx-1.5 h-4 w-px bg-[color:var(--border-subtle)]" />
      ) : null}
      <div className="flex items-center gap-0.5">{panels.map(renderSwitch)}</div>
    </div>
  )
}
