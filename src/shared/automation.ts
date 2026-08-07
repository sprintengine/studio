// Multicode app-automation surface: shared contracts between the main-process
// MCP server and the preload bridge.
//
// The automation server (src/main/automation/) is a local-only MCP endpoint
// owned by the app's main process. Reads answer from main's authoritative
// stores (the workspace registry + terminal runtime), and so do mutations:
// there is one lane, and no window is involved in any of them. See
// knowledge/multicode/automation-server.md.
//
// There used to be a second lane — a request/respond IPC pair that asked the
// primary window's renderer to run the same store actions the UI used. Every
// kind it carried is now a main service: agent launch and disposal
// (`src/main/agent-launch-service.ts`, MC-2159), workspace creation (main owns
// the registry, MC-2158), and sprint creation
// (`src/main/sprint-create-service.ts`, MC-2160). MC-2161 deleted the lane
// itself, and with it the whole error class that made every one of those
// operations fail when no window happened to be open.

export type AutomationServerStatus = {
  /** Compatibility field; the Studio gateway is always enabled. */
  enabled: boolean
  running: boolean
  /** Unix socket path (POSIX) or named pipe (Windows) while running. */
  socketPath: string | null
  /** Last start/stop failure, surfaced instead of silently staying off. */
  lastError: string | null
  /**
   * Absolute path of the repo/app-shipped stdio bridge script stock MCP
   * clients launch to reach the socket (`node <bridgeScriptPath>`). Static
   * app knowledge, present whether or not the server is running.
   */
  bridgeScriptPath: string | null
}

export const AUTOMATION_GET_STATUS_CHANNEL = 'automation:get-status'
export const AUTOMATION_SET_ENABLED_CHANNEL = 'automation:set-enabled'
