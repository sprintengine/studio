import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentCli, CliPermissionPreset } from '../../types/workspace'

// The permission preset an agent spawns on, remembered PER CLI: one value for
// Claude Code, one for Codex, and so on (owner ruling 2026-09-24).
//
// A preset is a property of the runtime, not of the app — Claude Code's auto
// mode is not Codex's sandbox, and the two CLIs do not even name their presets
// the same way — so one app-wide value cannot say what a person wants from
// both. But it is not a property of the MODEL either. It was remembered per
// model row for a while (owner, 2026-09-05), and that meant choosing Bypass for
// one Claude model and then choosing it again for every other Claude model the
// picker offered. A person trusts a runtime in a repository; which of its
// models they happen to pick does not change that. So every model of a CLI
// reads and writes the same entry.
//
// A CLI that was never set has no entry and resolves to the caller's fallback:
// `appSettings.lastAgentSpawnPermissionPreset`, the app-wide default that
// Settings still owns. So nothing changes for a CLI nobody has touched, and
// setting one CLI can never move another.
//
// The map is main's (`cliPermissionPresets` in the launch settings), and
// `appSettings.cliPermissionPresets` is this window's read model of it. Main
// resolves a launch with no window open from the same record, and its
// broadcast keeps every window's picker on the same value. A window writes one
// CLI's key at a time, so two windows setting two CLIs cannot overwrite each
// other.

/** The preset stored against a CLI, or undefined when it was never set. */
export function storedCliPermissionPreset(cli: AgentCli | null | undefined): CliPermissionPreset | undefined {
  // No CLI, nothing stored: a terminal and a conversation launch nothing that
  // reads a permission flag.
  if (!cli) return undefined
  return useWorkspaceStore.getState().appSettings.cliPermissionPresets?.[cli]
}

/**
 * What a spawn on this CLI actually launches with: the CLI's own preset, or the
 * app-wide default when it has never been set. Read at SPAWN time, for the CLI
 * being launched — never from a value captured when the picker opened.
 */
export function resolveCliPermissionPreset(
  cli: AgentCli | null | undefined,
  fallback: CliPermissionPreset,
): CliPermissionPreset {
  return storedCliPermissionPreset(cli) ?? fallback
}

export function setCliPermissionPreset(cli: AgentCli | null | undefined, preset: CliPermissionPreset): void {
  if (!cli) return
  useWorkspaceStore.getState().setCliPermissionPreset(cli, preset)
}

/**
 * Test seam: empties the map so a suite can start from a known one. Local
 * only: it does not write to main.
 */
export function __resetCliPermissionPresetsForTest(): void {
  useWorkspaceStore.setState((state) => ({
    appSettings: { ...state.appSettings, cliPermissionPresets: {} },
  }))
}

/** The live preset for a CLI, re-rendering when any window changes it. */
export function useCliPermissionPreset(
  cli: AgentCli | null | undefined,
  fallback: CliPermissionPreset,
): CliPermissionPreset {
  const stored = useWorkspaceStore((state) => (cli ? state.appSettings.cliPermissionPresets?.[cli] : undefined))
  return stored ?? fallback
}
