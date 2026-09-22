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
  // When a probe on THIS machine first listed the id (ISO). Carried forward
  // from the previous catalog on every refresh, so it survives the wholesale
  // replacement below; absent on a row the first-ever probe returned, because a
  // fresh install must not light up every model as new. The picker's "New" chip
  // reads it against NEW_FOR_DAYS — per machine, since no remote list dates
  // models for us any more.
  firstSeenAt?: string
}

// How a catalog was obtained. `argv-probe` is a subprocess enumeration command
// (`codex debug models`); `agent-sdk` is the Claude Agent SDK's supportedModels().
type DiscoveredCliModelCatalogSource = 'argv-probe' | 'agent-sdk'

// What one CLI last reported, persisted per plugin id. Discovery never stores an
// entry with zero models (an empty answer is a failed probe and keeps the last
// good list); one persisted by an older build reads as "never probed", which is
// how the picker and the firstSeenAt carry both treat it.
export type DiscoveredCliModelCatalog = {
  models: DiscoveredCliModel[]
  fetchedAt: string
  source: DiscoveredCliModelCatalogSource
  // Version string that reported the models, for diagnosing a stale catalog.
  cliVersion?: string
}

// Which layer a merged row came from. A row present in several layers reports
// the strongest claim: user > discovered > manifest. Never rendered as words —
// it drives the user-added glyph in the Settings CLI detail. Manifest and
// discovered rows never meet: once a probe has answered, the manifest seed is
// not shown at all (cliRuntimeOptions.mergeModelCatalog).
export type CliModelOrigin = 'manifest' | 'discovered' | 'user'

export type MergedCliModelOption = PluginModelOption & {
  origin: CliModelOrigin
  // Set on a discovered row whose `firstSeenAt` falls within NEW_FOR_DAYS of
  // the merge's clock: what the picker's "New" chip reads. A row the CLI did
  // not list (a manifest seed row, a user id alone) is never new.
  isNew?: true
}

// The picker-facing catalog: PluginModelCatalog with every row source-tagged.
// Assignable to PluginModelCatalog, so hosts that only render id/label need no
// change to display a discovered row.
export type MergedCliModelCatalog = {
  options: MergedCliModelOption[]
  allowCustomId: boolean
}
