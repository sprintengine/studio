// Part of the IPC contract: agent CLI availability, launch previews and plugin detection.
// ../electron-api.ts re-exports everything here.

import type { CliPermissionPreset, CliRuntimeSettings } from './agent-runtime'
import type { AgentCli } from './conversations'

// Whether a single agent CLI's binary is actually installed/runnable on this
// machine, distinct from whether its plugin manifest is registered. Bundled
// manifests (e.g. `codex`, `claude-code`) are always registered; this says
// which of them the user can really deploy.
export type CliAvailability = {
  cli: AgentCli
  installed: boolean
  resolvedPath: string | null
  version: string | null
}

// Detected availability for every registered agent CLI, keyed by plugin id.
export type AgentCliAvailabilityMap = Record<AgentCli, CliAvailability>

export type PluginAvailabilityResult =
  { ok: true; availability: AgentCliAvailabilityMap } | { ok: false; message: string }

// The invocation a spawn would make, rendered for display before it happens
// (the new-agent tab's receipt line). Main renders it through the
// SAME function the launch path uses, because the renderer's plugin catalog
// withholds argv and a hand-written preview of the flags would drift the first
// time a manifest changed. The prompt is never part of it: it is on screen a
// line above, and re-rendering per keystroke would bury the flags.
// No `debugMode`: it prepends a directive to the PROMPT and never touches a
// flag, so on a prompt-free preview it has nothing to add — and rendering it
// would put a multi-line directive in a one-line receipt.
export type AgentLaunchPreviewInput = {
  cli: AgentCli
  cliModel?: string
  cliReasoning?: string
  cliPermissionPreset?: CliPermissionPreset
  cliRuntime?: CliRuntimeSettings
}

export type AgentLaunchPreview = {
  /** The resolved command — a path when the runtime override names one. */
  binary: string
  /** Everything after the command, in spawn order. */
  args: string[]
  /** Binary + args as one posix-quoted line, ready to render. */
  display: string
}

export type AgentLaunchPreviewResult = { ok: true; preview: AgentLaunchPreview } | { ok: false; message: string }

// Per-CLI runtime overrides the renderer forwards into a batch availability
// probe so detection runs against the same command/WSL mode each CLI launches
// with. `force` bypasses the main-process TTL cache (used after an install).
export type PluginDetectAvailabilityInput = {
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  force?: boolean
}

export type PluginInstallResult =
  | { ok: true; id: string; kind: 'cli' | 'provider'; displayName: string }
  | { ok: false; message: string; issues?: Array<{ path: string; message: string }> }
