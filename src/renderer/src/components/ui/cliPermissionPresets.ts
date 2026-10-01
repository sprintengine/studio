import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentCli, CliPermissionPreset } from '../../types/workspace'

// The permission preset an agent spawns on, remembered PER CLI: one value for
// Claude Code, one for Codex, and so on (owner ruling 2026-09-24).
//
// A preset is a property of the runtime, not of the app — skipping Claude
// Code's prompts is not lifting Codex's sandbox, and a person can trust one CLI
// in a repository without trusting another — so one app-wide value cannot say
// what a person wants from both. But it is not a property of the MODEL either. It was remembered per
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
 * The CLI's own mode stored with its preset (Claude Code's Accept edits), or
 * undefined when the choice is the preset's own mode or was never made. A
 * spawn launches with it beside `resolveCliPermissionPreset`'s preset, which
 * is then that CLI's own choice too.
 */
export function storedCliPermissionMode(cli: AgentCli | null | undefined): string | undefined {
  if (!cli) return undefined
  const settings = useWorkspaceStore.getState().appSettings
  return settings.cliPermissionPresets?.[cli] ? settings.cliPermissionModes?.[cli] : undefined
}

// The app-wide value a CLI nobody chose for reads, unless the CLI has no
// setting for it in a terminal (Kimi Code has no Auto): then no flag, which is
// what it would run on anyway, said as what it is.
function fallbackFor(
  declared: readonly CliPermissionPreset[] | undefined,
  fallback: CliPermissionPreset,
): CliPermissionPreset {
  return declared && !declared.includes(fallback) ? 'none' : fallback
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
  const stored = storedCliPermissionPreset(cli)
  if (stored || !cli) return stored ?? fallback
  const declared = useWorkspaceStore
    .getState()
    .pluginCatalogEntries.find((entry) => entry.id === cli)?.permissionPresets
  return fallbackFor(declared, fallback)
}

/** The agent-record field for the CLI's own mode a spawn on `cli` launches with, if any. */
export function cliPermissionModePatch(cli: AgentCli | null | undefined): { cliPermissionMode?: string } {
  const mode = storedCliPermissionMode(cli)
  return mode ? { cliPermissionMode: mode } : {}
}

/** The same, as the `permissionMode` a launch input takes. */
export function cliPermissionModeLaunch(cli: AgentCli | null | undefined): { permissionMode?: string } {
  const mode = storedCliPermissionMode(cli)
  return mode ? { permissionMode: mode } : {}
}

export function setCliPermissionPreset(
  cli: AgentCli | null | undefined,
  preset: CliPermissionPreset,
  mode?: string | null,
): void {
  if (!cli) return
  useWorkspaceStore.getState().setCliPermissionPreset(cli, preset, mode ?? null)
}

/**
 * Test seam: empties the map so a suite can start from a known one. Local
 * only: it does not write to main.
 */
export function __resetCliPermissionPresetsForTest(): void {
  useWorkspaceStore.setState((state) => ({
    appSettings: { ...state.appSettings, cliPermissionPresets: {}, cliPermissionModes: {} },
  }))
}

/** The live preset for a CLI, re-rendering when any window changes it. */
export function useCliPermissionPreset(
  cli: AgentCli | null | undefined,
  fallback: CliPermissionPreset,
): CliPermissionPreset {
  const stored = useWorkspaceStore((state) => (cli ? state.appSettings.cliPermissionPresets?.[cli] : undefined))
  const declared = useWorkspaceStore((state) =>
    cli ? state.pluginCatalogEntries.find((entry) => entry.id === cli)?.permissionPresets : undefined,
  )
  return stored ?? fallbackFor(declared, fallback)
}

/** The live mode of the CLI's own chosen with its preset, or undefined for the preset's own. */
export function useCliPermissionMode(cli: AgentCli | null | undefined): string | undefined {
  return useWorkspaceStore((state) =>
    cli && state.appSettings.cliPermissionPresets?.[cli] ? state.appSettings.cliPermissionModes?.[cli] : undefined,
  )
}
