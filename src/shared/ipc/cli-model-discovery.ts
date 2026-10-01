// The IPC contract for CLI model discovery: the main process asks each installed
// agent CLI which models it accepts and hands the answer to the renderer, which
// keeps it in appSettings.cliModelCatalog (the `discovered` layer of the model
// catalog merge). Node-free: shared between main, preload and renderer.
//
// Why the CLI and not a remote list: the CLI is the only authority on the
// values its own `--model` flag takes, it answers through the person's own
// login (no API key), and it tracks the version actually installed. The probes
// themselves live in src/main/model-discovery; this file is only the shape of
// the request and the answer.
import type { CliRuntimeSettings } from '../electron-api'
import type { DiscoveredCliModelCatalog } from '../cli-model-catalog'

export const CLI_MODELS_DISCOVER_CHANNEL = 'cli-models:discover'
export const CLI_MODELS_CHANGED_CHANNEL = 'cli-models:changed'

export type CliModelDiscoveryInput = {
  // Per-CLI command and WSL overrides, so a probe runs the same binary a launch
  // would. Same shape the availability detection takes.
  cliRuntimes?: Partial<Record<string, Partial<CliRuntimeSettings>>>
  // Only these plugin ids; every registered CLI when absent.
  clis?: string[]
  // Ignore the freshness window and re-probe (Settings "Refresh models").
  force?: boolean
  // The catalogs the renderer already holds, so a refresh can carry each row's
  // `firstSeenAt` forward and mark only the ids that are actually new.
  previous?: Partial<Record<string, DiscoveredCliModelCatalog>>
}

export type CliModelDiscoverySkipReason = 'not-installed' | 'no-probe' | 'fresh'

export type CliModelDiscoveryEntry = {
  cli: string
  // The catalog to store, or null when nothing changed or the probe was skipped.
  catalog: DiscoveredCliModelCatalog | null
  skipped?: CliModelDiscoverySkipReason
  // Plain words for the Settings line; a failed probe never empties the layer.
  error?: string
}

export type CliModelDiscoveryResult = {
  entries: CliModelDiscoveryEntry[]
  startedAt: string
  finishedAt: string
}
