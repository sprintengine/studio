import { useWorkspaceStore } from '../store/workspaceStore'
import { revealAgentTab, type AgentTabRevealTarget } from './modelRegistry'

// The one store-bound "show me this agent's terminal" path.
//
// Revealing an agent terminal is never just a layout mutation. A door-routed
// full-page surface (the Backlog/Design doors, epic 1704)
// paints an opaque layer OVER the workspace layers, which stay mounted and
// inert beneath it — and a modal surface (Settings/Plugins/Automations/Design,
// doors→modals 2026-09-01) floats a scrim over them. So a caller that only
// asks the layout model to focus a tab succeeds — the tab really is selected —
// and the operator sees nothing at all, because the surface is still on top.
// Activating the workspace is what clears `activeGlobalSurface` AND
// `activeModalSurface` (workspacesSlice.setActiveWorkspace), and it is the
// step every working reveal already takes: the session manager's
// `openSession`, the Backlog "Open agent" action, the Reviews guide terminal.
//
// `revealAgentTab` then handles the second half — the live model when the
// workspace layer is mounted, the persisted layout plus a latched green flash
// when it is not (a workspace beyond the layer-retention window has no
// registered Model to mutate).
export function revealAgentTerminalTab(
  target: AgentTabRevealTarget,
  options: { activateWorkspace?: boolean } = {},
): boolean {
  // Activating is what clears a door surface, so it is the default and every
  // operator-facing reveal keeps it. `activateWorkspace: false` is for a tab
  // that must EXIST without the operator being moved into it — the main-owned
  // agent-launch projection (MC-2159) minting the tab for an agent launched into
  // a rail-hidden host (an Automations host). Jumping the view
  // into one of those on every background launch, or on every window open that
  // discovers one still running, would strand the operator in a workspace the
  // rail cannot navigate back to.
  const activateWorkspace = options.activateWorkspace ?? true
  return revealAgentTab(target, {
    getWorkspace: (workspaceId) =>
      useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspaceId) ?? null,
    setActiveWorkspace: (workspaceId) => {
      if (!activateWorkspace) return
      useWorkspaceStore.getState().setActiveWorkspace(workspaceId)
    },
    updateLayout: (workspaceId, layoutModel) =>
      useWorkspaceStore.getState().updateLayout(workspaceId, layoutModel),
  })
}
