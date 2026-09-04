// The Backlog and pane switches, extracted out of the old PanelRail so they live
// in the window title bar (AppTitleBar / WorkspaceHeader) as the single nav
// toolbar. One source of the PANELS descriptor and its toggle / module-gating /
// active-derivation semantics — the sidebar no longer carries a second copy.
//
// Files and Git have no switches here: they are workspace-pane tabs now
// (browser-pane epic), and the workspace identity cluster's project chip and
// branch chip open them; the command palette and their keyboard shortcuts
// (panel.files.toggle / panel.git.toggle) toggle them.
//
// AppTitleBar is global chrome, so the active workspace id is passed in (it is
// window-scoped in WorkspaceManager and can't be resolved from the store alone);
// the layout model and pane record are subscribed here so the active treatment
// tracks any mutation of that workspace live.
//
// Two clusters, two columns: Backlog switches the left FlexLayout rail, the
// pane switch the right-hand workspace pane, and they are independent —
// opening one never closes the other.

import { Tooltip } from '../ui'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { selectModuleEnabled } from '../../modules'
import { jsonModelHasComponent, togglePanelRailComponent } from '../../utils/modelRegistry'
import type { WorkspaceId } from '../../types/workspace'
import {
  getEffectiveKeybindingLabel,
  platformKeybindingsFromApiPlatform,
} from '../../commands/effectiveKeybindings'

type PanelKey = 'backlog' | 'pane'

// Which header cluster a switch renders into.
export type PanelCluster = 'left' | 'right'

type PanelDescriptor = {
  key: PanelKey
  commandId?: string
  label: string
  // Accessible name and tooltip while the pane is open, for a control that reads
  // as a collapse once its pane is showing. Falls back to `label`.
  activeLabel?: string
  cluster: PanelCluster
  // Capability module that gates this button; the toolbar hides it when the
  // module is disabled. Undefined for a panel that belongs to no module and is
  // therefore always offered.
  moduleId?: string
  // What the switch drives: a strip-less FlexLayout rail component (active =
  // the tab exists in the persisted layout) or the workspace pane column
  // (active = the workspace's pane record says open).
  target: { kind: 'rail'; component: string; tabName: string } | { kind: 'pane' }
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
    label: 'Backlog',
    cluster: 'left',
    target: { kind: 'rail', component: 'backlog', tabName: 'Backlog' },
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
    key: 'pane',
    commandId: 'pane.toggle',
    label: 'Open pane',
    activeLabel: 'Close pane',
    cluster: 'right',
    target: { kind: 'pane' },
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
  // Subscribe to the active workspace's persisted layout and pane record so the
  // active treatment re-renders whenever any path (switch click, View menu,
  // accelerator, drag-and-drop, tab close) mutates either.
  const layoutModel = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.layoutModel
  )
  const paneOpen = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.paneState?.open ?? false
  )
  const setPaneOpen = useWorkspaceStore((state) => state.setPaneOpen)

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
    const active = panel.target.kind === 'rail'
      ? jsonModelHasComponent(layoutModel, panel.target.component)
      : paneOpen
    const label = active ? panel.activeLabel ?? panel.label : panel.label
    const shortcut = panel.commandId ? shortcutFor(panel.commandId) : null
    const tooltip = shortcut ? `${label} (${shortcut})` : label
    const toggle = () => {
      if (panel.target.kind === 'rail') {
        togglePanelRailComponent(activeWorkspaceId, panel.target.component, panel.target.tabName)
      } else {
        setPaneOpen(activeWorkspaceId, !paneOpen)
      }
    }
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
          onClick={toggle}
          aria-pressed={active}
          aria-label={label}
          className={buttonClass}
          // The pane's own close control hands focus back here (WorkspacePane).
          {...(panel.target.kind === 'pane' ? { 'data-pane-switch': '' } : {})}
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
