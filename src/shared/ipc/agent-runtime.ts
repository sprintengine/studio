// Part of the IPC contract: how an agent runs, and detecting and installing its CLI.
// ../electron-api.ts re-exports everything here.

import type { AgentCli } from './conversations'
import type { ExecutionHostId } from '../execution-host'

export type AgentExecutionMode = 'current_workspace' | 'worktree'
export type { CliPermissionPreset } from '../cli-permission-preset'

export type CliRuntimeSettings = {
  command: string
  /**
   * The machine this runtime is resolved for, when it is not this one: a
   * detection, install or command run for a WSL distribution names it here,
   * with `command` already that machine's own override. Absent means this
   * machine. Never stored — the settings keep a machine's commands on the
   * machine (`AgentLaunchSettings.hosts`).
   */
  hostId?: ExecutionHostId
  // User-added model ids for this CLI, shown in pickers alongside the plugin
  // manifest's seed options. Terminal CLIs expose no live model catalog, so
  // this list is how users keep pace with new models.
  models?: string[]
}

// Result of probing whether an agent CLI binary is installed and runnable.
export type CliDetectResult = {
  cli: AgentCli
  binary: string
  installed: boolean
  version: string | null
  resolvedPath: string | null
  // The machine the probe ran on (`local`, or a WSL distribution).
  hostId: ExecutionHostId
  error: string | null
}

// One offered install path for a CLI on the current platform/runtime. The
// command string is authoritative in the main process; `commandPreview` is
// surfaced to the UI for transparency before the user consents to run it.
export type CliInstallMethodInfo = {
  id: string
  label: string
  // Whether the method's prerequisite (e.g. `npm`, `brew`) is present on PATH.
  available: boolean
  unavailableReason: string | null
  recommended: boolean
  commandPreview: string
  // The platform bucket this method was resolved from ('darwin' | 'linux' |
  // 'win32' | 'wsl').
  platform: string
}

export type CliInstallInput = {
  cli: AgentCli
  methodId: string
}

export type CliInstallResult = {
  ok: boolean
  cli: AgentCli
  installed: boolean
  version: string | null
  resolvedPath: string | null
  log: string
  error: string | null
}

export type McpClientTarget = AgentCli
export type McpTransport = 'stdio' | 'http' | 'sse'
