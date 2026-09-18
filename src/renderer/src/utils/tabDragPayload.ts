// Shared payload format for the cross-workspace tab drag gesture: pick up a
// closable tab in WorkspaceLayout, drop it on the workspace sidebar to either
// create a new workspace seeded with that tab, or tile it into an existing
// workspace as a side-by-side column.

export const TAB_DRAG_MIME = 'application/x-multicode-tab'

export type TabDragPayload = {
  sourceWorkspaceId: string
  tabId: string
  component: string
  name: string
  config: Record<string, unknown> | null
  className: string | null
}

export function serializeTabDragPayload(payload: TabDragPayload): string {
  return JSON.stringify(payload)
}

export function readTabDragPayload(dataTransfer: DataTransfer): TabDragPayload | null {
  const raw = dataTransfer.getData(TAB_DRAG_MIME)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<TabDragPayload>
    if (
      typeof parsed.sourceWorkspaceId !== 'string' ||
      typeof parsed.tabId !== 'string' ||
      typeof parsed.component !== 'string' ||
      typeof parsed.name !== 'string'
    ) {
      return null
    }
    const config =
      parsed.config && typeof parsed.config === 'object' ? (parsed.config as Record<string, unknown>) : null
    const className = typeof parsed.className === 'string' ? parsed.className : null
    return {
      sourceWorkspaceId: parsed.sourceWorkspaceId,
      tabId: parsed.tabId,
      component: parsed.component,
      name: parsed.name,
      config,
      className,
    }
  } catch {
    return null
  }
}

export function dataTransferHasTabDrag(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  for (const type of dataTransfer.types) {
    if (type === TAB_DRAG_MIME) return true
  }
  return false
}
