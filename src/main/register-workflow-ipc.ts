import type { IpcMain } from 'electron'
import { registerConversationPeekIpc } from './ipc/conversation-peek-ipc'
import { registerPullRequestIpc } from './ipc/pull-request-ipc'
import { registerTerminalIpc } from './ipc/terminal-ipc'
import type { AppServices } from './app-services'

// The mobile relay IPC moved to its capability module (src/main/modules/),
// registered through the host kernel. What remains here is the always-on
// terminal runtime (agent-runtime), not yet migrated.
export function registerWorkflowIpc(ipcMain: IpcMain, services: AppServices): void {
  registerTerminalIpc(ipcMain, {
    ...services.terminalRuntime.ipcHandlers,
    // One idle-suspend setting governs both agent runtimes: PTY terminals and
    // headless conversation child processes share the threshold.
    setIdleSuspendThresholdMs: (value: unknown): void => {
      services.terminalRuntime.ipcHandlers.setIdleSuspendThresholdMs(value)
      services.conversationRuntime.setIdleThresholdMs(value)
    },
  })

  // The conversation peek reads a terminal session, so it registers alongside
  // the runtime that owns one rather than with the core surfaces.
  registerConversationPeekIpc(ipcMain, services.conversationPeek)

  // Same reason: the pull request marks are read off a terminal session's
  // observed checkout, so their one refresh channel registers beside the
  // runtime that owns the session.
  registerPullRequestIpc(ipcMain, {
    refreshPullRequestsForSession: (sessionId) => services.pullRequestRecord.refreshForSession(sessionId),
    // Keyed by conversation, for the rows with nothing running in them.
    listForWorkspaces: (workspaceIds) => {
      const out: Record<string, ReturnType<typeof services.pullRequestRecord.forWorkspace>> = {}
      for (const id of workspaceIds) {
        const list = services.pullRequestRecord.forWorkspace(id)
        // Only conversations that have something. An empty array per id would
        // make every answer the size of the question.
        if (list.length > 0) out[id] = list
      }
      return out
    },
  })
}
