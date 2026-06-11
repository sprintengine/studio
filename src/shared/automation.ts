// Multicode app-automation surface: shared contracts between the main-process
// MCP server, the preload bridge, and the renderer delegate.
//
// The automation server (src/main/automation/) is a local-only MCP endpoint
// owned by the app's main process. Read tools answer from main's authoritative
// stores (workspace-sync snapshot + terminal runtime). Mutation tools are
// delegated to the primary window's renderer, which executes the same store
// actions the UI uses — workspace construction and agent spawning stay
// renderer-owned, and the resulting workspace.created / agent_terminal.*
// events flow through the workspace-sync command bus exactly like
// user-initiated changes. See knowledge/multicode/automation-server.md.

export type AutomationServerStatus = {
  enabled: boolean
  running: boolean
  /** Unix socket path (POSIX) or named pipe (Windows) while running. */
  socketPath: string | null
  /** Last start/stop failure, surfaced instead of silently staying off. */
  lastError: string | null
}

// Mutations the automation server may ask the primary renderer to perform.
// Kept to the v1 tool surface deliberately — no settings mutation, no file APIs.
export type AutomationRendererRequest =
  | {
      kind: 'workspace.create'
      name?: string
      folderPath?: string
      templateId?: string
    }
  | {
      kind: 'agent.launch'
      workspaceId: string
      cli?: string
      name?: string
      prompt?: string
    }

export type AutomationRendererResponse =
  | { ok: true; workspaceId: string; agentId?: string }
  | { ok: false; code: string; message: string }

export const AUTOMATION_REQUEST_CHANNEL = 'automation:request'
export const AUTOMATION_RESPOND_CHANNEL = 'automation:respond'
export const AUTOMATION_GET_STATUS_CHANNEL = 'automation:get-status'
export const AUTOMATION_SET_ENABLED_CHANNEL = 'automation:set-enabled'
