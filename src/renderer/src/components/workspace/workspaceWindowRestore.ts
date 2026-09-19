import type { CreateWorkspaceWindowInput, CreateWorkspaceWindowResult } from '../../../../shared/electron-api'
import type { WorkspaceWindowId, WorkspaceWindowState } from '../../types/workspace'

export async function restoreDetachedWorkspaceWindowsOnStartup(input: {
  primaryWorkspaceWindowId: WorkspaceWindowId
  workspaceWindows: Array<Pick<WorkspaceWindowState, 'id' | 'activeWorkspaceId' | 'bounds' | 'isMaximized'>>
  createWorkspaceWindow: (input: CreateWorkspaceWindowInput) => Promise<CreateWorkspaceWindowResult>
  closeWorkspaceWindow: (windowId: WorkspaceWindowId, fallbackWindowId: WorkspaceWindowId) => void
}): Promise<{ restoredWindowIds: WorkspaceWindowId[]; collapsedWindowIds: WorkspaceWindowId[] }> {
  const restoredWindowIds: WorkspaceWindowId[] = []
  const collapsedWindowIds: WorkspaceWindowId[] = []
  const persistedDetachedWindows = input.workspaceWindows.filter(
    (windowState) => windowState.id !== input.primaryWorkspaceWindowId,
  )
  for (const windowState of persistedDetachedWindows) {
    let restored = false
    try {
      const result = await input.createWorkspaceWindow({
        windowId: windowState.id,
        workspaceId: windowState.activeWorkspaceId,
        bounds: windowState.bounds,
        isMaximized: windowState.isMaximized,
      })
      restored = result.ok
    } catch {
      restored = false
    }
    if (restored) {
      restoredWindowIds.push(windowState.id)
    } else {
      input.closeWorkspaceWindow(windowState.id, input.primaryWorkspaceWindowId)
      collapsedWindowIds.push(windowState.id)
    }
  }
  return { restoredWindowIds, collapsedWindowIds }
}
