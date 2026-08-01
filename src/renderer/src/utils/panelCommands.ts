// The panel-command bus: panels listen on window for this event and run the
// local action matching the id. The one dispatch helper shared by the shell
// (palette, WorkspaceManager) and module command registrations — the
// sanctioned module→panel dispatch pattern.
export const PANEL_COMMAND_EVENT = 'multicode:panel-command'

export function dispatchPanelCommandEvent(id: string, workspaceId?: string): void {
  window.dispatchEvent(
    new CustomEvent(PANEL_COMMAND_EVENT, { detail: workspaceId ? { id, workspaceId } : { id } })
  )
}
