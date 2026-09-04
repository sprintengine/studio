// Whether keyboard focus is inside a workspace pane. Read by the shell's
// `layout.tab.close` handler so Primary+W closes the pane's active tab when
// the pane owns focus, and keeps its FlexLayout meaning everywhere else.
export const WORKSPACE_PANE_DATA_ATTRIBUTE = 'data-workspace-pane'

export function isWorkspacePaneFocused(): boolean {
  if (typeof document === 'undefined') return false
  const active = document.activeElement
  return Boolean(active && active.closest(`[${WORKSPACE_PANE_DATA_ATTRIBUTE}]`))
}
