// Models an agent CLI reported about itself, and the merged catalog the pickers
// render. Node-free on purpose: `src/shared` cannot import `src/main` (TS6307),
// and the discovery probes that populate this shape live in the main process.
import type { PluginModelOption } from './plugin-manifest'

// One model as a CLI described it. Only `id` — the value passed to `--model` —
// is guaranteed: `opencode models` returns bare ids while `codex debug models`
// returns the full record, so every richer field is progressively populated.
export type DiscoveredCliModel = {
  id: string
  displayName?: string
  description?: string
  // Canonical id the CLI claims this alias resolves to. Display only, and hedge
  // the copy: measured 2026-07-26, Claude's SDK reported `opus[1m]` resolving to
  // `claude-opus-4-8[1m]` while a real turn resolved it to `claude-opus-5[1m]`.
  // Never let it drive identity, dedupe, or recorded history.
  resolvedModel?: string
  contextWindow?: number
  effortLevels?: string[]
  defaultEffort?: string
  supportsFastMode?: boolean
}

// How a catalog was obtained. `argv-probe` is a subprocess enumeration command
// (`codex debug models`); `agent-sdk` is the Claude Agent SDK's supportedModels().
export type DiscoveredCliModelCatalogSource = 'argv-probe' | 'agent-sdk'

// What one CLI last reported, persisted per plugin id. An entry with zero models
// is meaningful — it records that the CLI answered and listed nothing — so it is
// kept rather than collapsed into "never probed".
export type DiscoveredCliModelCatalog = {
  models: DiscoveredCliModel[]
  fetchedAt: string
  source: DiscoveredCliModelCatalogSource
  // Version string that reported the models, for diagnosing a stale catalog.
  cliVersion?: string
}

// Which layer a merged row came from. A row present in several layers reports
// the strongest claim: user > discovered > hosted > manifest. Never rendered as
// words — it drives layering here and the user-added glyph in the Settings CLI
// detail. `hosted` is the model feed fetched from GitHub
// (src/shared/hosted-model-feed.ts): curated like the manifest, but live.
export type CliModelOrigin = 'manifest' | 'hosted' | 'discovered' | 'user'

export type MergedCliModelOption = PluginModelOption & {
  origin: CliModelOrigin
  // From the hosted layer only. The picker's "New" chip reads it against
  // HOSTED_MODEL_NEW_FOR_DAYS; manifest, discovered, and user rows have none.
  releasedAt?: string
}

// The picker-facing catalog: PluginModelCatalog with every row source-tagged.
// Assignable to PluginModelCatalog, so hosts that only render id/label need no
// change to display a discovered row.
export type MergedCliModelCatalog = {
  options: MergedCliModelOption[]
  allowCustomId: boolean
}
