// Models an agent CLI reported about itself, and the merged catalog the pickers
// render. Node-free on purpose: `src/shared` cannot import `src/main` (TS6307),
// and the discovery probes that populate this shape live in the main process.
import type { PluginModelCatalog, PluginModelOption } from './plugin-manifest'
import { NEW_FOR_MS } from './new-for-days'

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
// not shown at all (mergeCliModelCatalog below).
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

// The rows a CLI's model picker offers, from three sources:
//
//   what the CLI reported (else the manifest seed)  +  the user's own ids
//
// The CLI's list is the list (owner ruling 2026-09-22). This replaced a union
// of the manifest seed, a hosted model list and the discovered rows, which was
// kept because discovery once under-reported and a replacement would have hidden
// working models. The union's cost turned out higher: a model the CLI stopped
// accepting stayed in the picker forever, a label nobody maintained outlived
// the model, and every release meant hand edits in two repositories. The one
// case the union protected — an id the CLI runs but does not advertise — is
// what the user's own ids are for.
//
//   - When a probe has succeeded for this CLI, the rows are exactly the
//     discovered rows in the CLI's own order, followed by the user's ids that
//     the CLI did not list. No manifest row is shown: a model the CLI stops
//     listing disappears on the next refresh. Hidden rows (Codex
//     `visibility: "hide"`) never reach the catalog; the probe drops them, so
//     this function trusts the list it is given.
//   - Until then — fresh install, CLI not installed, every probe failing — the
//     manifest seed stands in, followed by the user's ids. A discovered catalog
//     with zero rows counts as "until then": every probe here returns at least
//     one row when it works, so an empty answer is a CLI that told us nothing,
//     and an empty picker would be the worst reading of it.
//
// Dedupe is by exact `id` and nothing else. An alias the CLI reports (`opus`,
// `default`, `opus[1m]`) is an ordinary row with the CLI's own label, and is
// never collapsed onto a versioned id through `resolvedModel`: that field is
// stale for some rows (measured: `opus[1m]` reported as `claude-opus-4-8[1m]`
// while it actually resolves to `claude-opus-5[1m]`), so trusting it would
// merge two different models and mislabel the survivor.
//
// "New" is per machine: a discovered row is new while its `firstSeenAt` — when
// a probe on this machine first listed the id — is within NEW_FOR_DAYS of
// `now`. The first-ever probe for a CLI writes no `firstSeenAt`, so a fresh
// install does not light up every model. A future `firstSeenAt` (the clock
// moved back) still counts as new, as the Design door reads its own dates.
//
// A persisted choice the CLI no longer lists is not this function's concern:
// the picker renders it as a "Not listed" row and the launch still passes it.
//
// User additions only apply when the plugin declares modelSelection — without
// declared args the launch path could not pass the model anyway.
export function mergeCliModelCatalog(
  declared: PluginModelCatalog | undefined,
  userModels: string[] | undefined,
  discovered: DiscoveredCliModelCatalog | undefined,
  now: number,
): MergedCliModelCatalog | undefined {
  if (!declared) return undefined
  const byId = new Map<string, MergedCliModelOption>()
  const add = (option: MergedCliModelOption): void => {
    const id = option.id.trim()
    if (!id) return
    const existing = byId.get(id)
    if (!existing) {
      byId.set(id, { ...option, id })
      return
    }
    // An id the user also typed keeps its place and label but reports the
    // stronger claim, which is what the Settings user-added glyph reads.
    if (option.origin === 'user') existing.origin = 'user'
  }
  // Tolerate a catalog that never went through the settings normalizer (a raw
  // IPC payload, a hand-edited profile): a bad discovered layer reads as no
  // answer, and the manifest seed renders exactly as it would have.
  const discoveredModels = (Array.isArray(discovered?.models) ? discovered.models : []).filter(
    (model) => model && typeof model.id === 'string' && model.id.trim(),
  )
  if (discoveredModels.length > 0) {
    for (const model of discoveredModels) {
      const label = typeof model.displayName === 'string' ? model.displayName.trim() : ''
      add({
        id: model.id,
        ...(label ? { label } : {}),
        origin: 'discovered',
        ...(isRecentlyFirstSeen(model.firstSeenAt, now) ? { isNew: true as const } : {}),
      })
    }
  } else {
    for (const option of declared.options) add({ ...option, origin: 'manifest' })
  }
  for (const entry of userModels ?? []) {
    if (typeof entry === 'string') add({ id: entry, origin: 'user' })
  }
  return { options: [...byId.values()], allowCustomId: declared.allowCustomId }
}

function isRecentlyFirstSeen(firstSeenAt: string | undefined, now: number): boolean {
  if (typeof firstSeenAt !== 'string' || !firstSeenAt) return false
  const seen = Date.parse(firstSeenAt)
  if (Number.isNaN(seen)) return false
  return now - seen < NEW_FOR_MS
}
