import type {
  AgentCli,
  AgentCliAvailabilityMap,
  AgentCliModelSelection,
  CliRuntimeSettings,
  PluginCatalogEntry,
  PluginCatalogStatus,
} from '../../../types/workspace'
import type {
  PluginModelCatalog,
  PluginModelOption,
  PluginReasoningCatalog,
} from '../../../../../shared/plugin-manifest'
import type {
  CliModelOrigin,
  DiscoveredCliModelCatalog,
  MergedCliModelCatalog,
  MergedCliModelOption,
} from '../../../../../shared/cli-model-catalog'
import type { HostedCliModelCatalogs, HostedModel } from '../../../../../shared/hosted-model-feed'

// What each CLI reported about its own models, keyed by plugin id — the
// `cliModelCatalog` app setting, passed in rather than read from the store so
// this module stays store-free.
export type DiscoveredCliModelCatalogs = Partial<Record<AgentCli, DiscoveredCliModelCatalog>>

export type AgentCliCatalogOption = {
  value: AgentCli
  label: string
  source?: PluginCatalogEntry['source']
  // Model choices for this CLI: the plugin manifest's seed options merged with
  // what the CLI reported about itself and the user-added ids from
  // `cliRuntimes[id].models`, each row tagged with which layer claimed it.
  // Absent when the plugin declares no modelSelection — such CLIs show no model
  // UI at all.
  modelSelection?: MergedCliModelCatalog
  // Reasoning-effort levels the CLI accepts (manifest-declared). Absent when
  // the plugin declares no reasoningSelection — such CLIs show no effort UI.
  reasoningSelection?: PluginReasoningCatalog
  // Set when this runtime is a hosted model (another CLI's binary redirected at
  // a provider endpoint); pickers group these under "Models via Claude Code".
  hostedVia?: PluginCatalogEntry['hostedVia']
  // Detected install state, attached once availability is known. `undefined`
  // means "not probed yet"; deployment surfaces hide only options that are
  // explicitly `installed === false` (see filterCatalogByAvailability).
  installed?: boolean
  resolvedPath?: string | null
}

// Trust state of the detected-availability map. Mirrors the slice's
// CliAvailabilityStatus without importing the store (keeps this util store-free).
export type CliAvailabilityFilterStatus = 'loading' | 'ready' | 'error'

export type CliAvailabilityFilter = {
  map: AgentCliAvailabilityMap | null | undefined
  status: CliAvailabilityFilterStatus
}

const CLAUDE_CODE_PLUGIN_ID = 'claude-code'

// Plugin ids that exist in the main-process registry but must never appear as a
// selectable agent CLI in spawn pickers. The AUTHORITATIVE gate is the
// manifest-projected `agentStateCapable` flag on each registry entry (hooks are
// the only supported status mechanism — decision of record 2026-08-31; a CLI
// without an agentStateSpec cannot report agent state and is not offered as an
// agent), applied in `buildAgentCliCatalog`'s registry path and enforced again
// main-side at launch. This static set is the manifest-LESS fallback mirror of
// that rule for the two contexts that cannot read manifests — the
// loading/error fallback catalog in `legacyCliRuntimeOptions` (where a
// persisted `cliRuntimes` key could otherwise leak a hidden id) and the
// id-only `isSelectableAgentCli` — and must list exactly the bundled plugins
// that declare no agentStateSpec (pinned by test against the shipped
// manifests):
//   - `generic-shell`: a bare `sh` pipe with no tool use, resume, or hooks —
//     it duplicates the Terminal quick row and stays registry-available for
//     direct terminal launch.
//   - `muse`: Muse Code's beta ignores its own documented hooks config
//     (.muse/hooks.json is silently dropped as of 0.2.1), so it cannot report
//     agent state; it stays installable/detectable and returns to the picker
//     when its hooks GA and its manifest gains an agentStateSpec.
const AGENT_PICKER_HIDDEN_CLI_IDS = new Set<AgentCli>(['generic-shell', 'muse'])

// Whether this plugin id is one the agent surfaces offer at all. Exported
// because "does this machine have an agent CLI?" is a question about these ids
// and only these: `generic-shell` ships with `binary: "sh"`, which every machine
// resolves, so a reader that counts the raw availability map answers "yes" on a
// machine with no agent CLI installed — and the first-run CLI card, which exists
// for exactly that machine, never appears while every picker stands empty.
export function isSelectableAgentCli(cli: AgentCli): boolean {
  return !AGENT_PICKER_HIDDEN_CLI_IDS.has(cli)
}

// Fallback model catalogs for the bundled CLIs, used only while the plugin
// registry is loading or errored (legacyCliRuntimeOptions / the `null`-plugins
// path). The registry path reads each plugin manifest's own `modelSelection`.
//
// Policy: ship NO seeded model ids. The CLIs expose no live catalog to query, so
// any baked-in list is a guess about the user's entitlements — offering a model
// the account can't run turns selection into a trap (the user picks it and the
// launch fails or silently falls back). Instead, the bare CLI row launches with
// the CLI's own default (no `--model` flag) and the user adds the ids they
// actually have access to via Settings → the model list persists per CLI in
// `cliRuntimes[id].models` and merges in through mergeModelCatalog. `allowCustomId`
// stays true so that add-your-own flow (and the picker passthrough) keeps working.
const BUNDLED_AGENT_MODEL_CATALOGS: Record<AgentCli, PluginModelCatalog> = {
  codex: {
    options: [],
    allowCustomId: true,
  },
  [CLAUDE_CODE_PLUGIN_ID]: {
    options: [],
    allowCustomId: true,
  },
  opencode: {
    options: [],
    allowCustomId: true,
  },
  // Z.AI runs the claude binary against Z.AI's endpoint; model tier is driven by
  // the manifest's ANTHROPIC_DEFAULT_*_MODEL env, so the picker seeds no models.
  zai: {
    options: [],
    allowCustomId: true,
  },
  grok: {
    options: [],
    allowCustomId: true,
  },
  'kimi-code': {
    options: [],
    allowCustomId: true,
  },
  // Kimi K3 via Claude Code runs the claude binary against Moonshot's endpoint;
  // model tier is driven by the manifest's ANTHROPIC_DEFAULT_*_MODEL env, so
  // the picker seeds no models (same as zai).
  'kimi-claude': {
    options: [],
    allowCustomId: true,
  },
  cursor: {
    options: [],
    allowCustomId: true,
  },
}

export function labelForCliRuntime(cli: AgentCli): string {
  if (cli === 'codex') return 'Codex'
  if (cli === 'claude-code') return 'Claude Code'
  if (cli === 'opencode') return 'OpenCode'
  // Title-casing would render this id as "Kimi Claude"; keep the registry
  // displayName so the loading/error fallback catalog reads the same.
  if (cli === 'kimi-claude') return 'Kimi K3'
  return cli
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ') || cli
}

function legacyCliRuntimeOptions(
  cliRuntimes: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>> | undefined,
  discovered: DiscoveredCliModelCatalogs | undefined,
  hosted: HostedCliModelCatalogs | undefined,
): AgentCliCatalogOption[] {
  const seen = new Set<AgentCli>()
  const orderedIds: AgentCli[] = []
  for (const id of ['codex', CLAUDE_CODE_PLUGIN_ID, 'opencode', ...Object.keys(cliRuntimes ?? {})]) {
    const trimmed = id.trim()
    const canonical = pluginRegistryIdForCli(trimmed)
    if (!canonical || seen.has(canonical) || AGENT_PICKER_HIDDEN_CLI_IDS.has(canonical)) continue
    seen.add(canonical)
    orderedIds.push(canonical)
  }
  return orderedIds.map((value) => {
    const modelSelection = mergeModelCatalog(
      BUNDLED_AGENT_MODEL_CATALOGS[value],
      cliRuntimes?.[value]?.models,
      discovered?.[value],
      hosted?.[value],
    )
    return {
      value,
      label: labelForCliRuntime(value),
      ...(modelSelection ? { modelSelection } : {}),
    }
  })
}

export function pluginRegistryIdForCli(cli: AgentCli): AgentCli {
  return cli
}

// What the install route offers, named from the registry rather than a
// hardcoded list, so the line on the install surfaces cannot drift from the
// plugins that actually ship. Empty string when there is nothing to name.
export function installableCliSummary(labels: string[]): string {
  const named = labels.slice(0, 3)
  if (named.length === 0) return ''
  const rest = labels.length - named.length
  return rest > 0 ? `${named.join(', ')}, and ${rest} more.` : `${named.join(', ')}.`
}

// Bundled entries first, then user entries, deduped by id — the row order for
// the Agents settings tab. Unlike buildAgentCliCatalog this keeps the full
// PluginCatalogEntry (binary, version, source) the settings rows need.
export function orderInstalledPlugins(
  entries: PluginCatalogEntry[] | null | undefined,
): PluginCatalogEntry[] {
  if (!entries) return []
  const seen = new Set<string>()
  const ordered: PluginCatalogEntry[] = []
  for (const entry of [...entries].sort((a, b) =>
    a.source === b.source ? 0 : a.source === 'bundled' ? -1 : 1,
  )) {
    const id = entry.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    ordered.push(entry)
  }
  return ordered
}

// Effective invocation override shown on a plugin's settings row. Uses the
// plugin-id key only; a blank command means "use the manifest binary" at launch.
export function cliRuntimeForPlugin(
  pluginId: AgentCli,
  cliRuntimes: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>> | undefined,
): { command: string; useWsl: boolean } {
  const direct = cliRuntimes?.[pluginId]
  const command =
    (typeof direct?.command === 'string' ? direct.command : undefined)
    ?? ''
  const useWsl = direct?.useWsl ?? false
  return { command, useWsl }
}

export function isAgentCliAvailable(
  cli: AgentCli,
  catalog: AgentCliCatalogOption[],
): boolean {
  const registryId = pluginRegistryIdForCli(cli)
  return catalog.some((option) => option.value === cli || option.value === registryId)
}

export function resolveAvailableAgentCli(
  cli: AgentCli | null | undefined,
  catalog: AgentCliCatalogOption[],
  fallback: AgentCli = CLAUDE_CODE_PLUGIN_ID,
): AgentCli {
  if (cli && isAgentCliAvailable(cli, catalog)) return pluginRegistryIdForCli(cli)
  if (isAgentCliAvailable(fallback, catalog)) return fallback
  return catalog[0]?.value ?? fallback
}

// The CLI a spawn should actually launch, or `null` when this machine has none.
//
// `resolveAvailableAgentCli` always answers with something — a picker needs a
// default to render even before its catalog resolves — and its last resort is
// `catalog[0] ?? fallback`. Against an availability-filtered catalog that is
// empty because nothing is installed, that answer is a guess: it hands a spawn a
// binary the machine does not have. Launch surfaces ask this instead, and render
// their install route on `null` rather than spawning against the guess.
export function resolveLaunchableAgentCli(
  cli: AgentCli | null | undefined,
  catalog: AgentCliCatalogOption[],
): AgentCli | null {
  const first = catalog[0]
  if (!first) return null
  return resolveAvailableAgentCli(cli, catalog, first.value)
}

export function isAgentCliMissing(
  cli: AgentCli | null | undefined,
  catalog: AgentCliCatalogOption[],
): boolean {
  return Boolean(cli && !isAgentCliAvailable(cli, catalog))
}

// CLI a New chat / template agent should spawn with.
//
// It NORMALISES; it does not verify. An explicit selection is answered with its
// registry id and nothing else is asked of it — this function never checks that
// the machine has that runtime, and callers must not read it as if it had. The
// check a spawn needs is `resolveLaunchableAgentCli`, which the spawn paths run
// on their way in and which answers null when the machine has nothing to launch.
// Only the REMEMBERED `lastSelectedCli` is clamped to an installed catalog entry
// here, so a stale default cannot seed a new agent with an uninstalled plugin
// id. With an empty catalog (registry still loading) it returns lastSelectedCli
// unchanged rather than throwing.
export function resolveTemplateAgentCli(
  explicitCli: AgentCli | null | undefined,
  lastSelectedCli: AgentCli,
  catalog: AgentCliCatalogOption[],
): AgentCli {
  const explicit = explicitCli?.trim()
  if (explicit) return pluginRegistryIdForCli(explicit)
  return resolveAvailableAgentCli(lastSelectedCli, catalog, catalog[0]?.value ?? lastSelectedCli)
}

export function buildAgentCliCatalog(
  plugins: PluginCatalogEntry[] | null | undefined,
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
  discovered?: DiscoveredCliModelCatalogs,
  hosted?: HostedCliModelCatalogs,
): AgentCliCatalogOption[] {
  if (!plugins) return legacyCliRuntimeOptions(cliRuntimes, discovered, hosted)

  const seen = new Set<AgentCli>()
  const ordered = [...plugins].sort((a, b) => {
    if (a.source === b.source) return 0
    return a.source === 'bundled' ? -1 : 1
  })
  const options: AgentCliCatalogOption[] = []
  for (const plugin of ordered) {
    const id = plugin.id.trim()
    if (!id || seen.has(id) || AGENT_PICKER_HIDDEN_CLI_IDS.has(id)) continue
    // The manifest-driven gate: a plugin whose manifest declares no
    // agentStateSpec cannot report authoritative agent state and is not
    // offered as an agent. `=== false` (not `!== true`) so a stale persisted
    // snapshot from an older main process — which lacks the field — keeps its
    // catalog until the live registry refreshes it, rather than emptying.
    if (plugin.agentStateCapable === false) continue
    seen.add(id)
    const modelSelection = mergeModelCatalog(
      plugin.modelSelection ?? BUNDLED_AGENT_MODEL_CATALOGS[id],
      cliRuntimes?.[id]?.models,
      discovered?.[id],
      hosted?.[id],
    )
    options.push({
      value: id,
      label: plugin.displayName,
      source: plugin.source,
      ...(modelSelection ? { modelSelection } : {}),
      ...(plugin.reasoningSelection ? { reasoningSelection: plugin.reasoningSelection } : {}),
      ...(plugin.hostedVia ? { hostedVia: plugin.hostedVia } : {}),
    })
  }
  return options
}

// Merge the four layers a model row can come from, in order:
//
//   manifest seed  ∪  the hosted feed  ∪  what the CLI reported  ∪  the user's own ids
//
// A union, never a replacement. Discovery under-reports — Claude's SDK omits
// Opus 5 on a machine where `--model claude-opus-5` runs fine — so a merge that
// took the discovered list as the truth would delete working models. Each layer
// instead syncs on its own terms: the manifest seed and the user's ids are
// curated and survive every refresh; the discovered layer is whatever the last
// probe returned, so a model the CLI stopped listing is gone from the picker.
// Both halves of that rule are load-bearing and separately tested.
//
// Dedupe is by exact `id` and nothing else. `resolvedModel` looks like it could
// collapse an alias against its pin, but it is stale for some rows (measured:
// `opus[1m]` reported as `claude-opus-4-8[1m]` while it actually resolves to
// `claude-opus-5[1m]`), so trusting it would merge two different models and
// mislabel the survivor.
//
// Later layers may enrich what earlier ones seeded: a discovered displayName
// replaces the manifest's hand-written label for the same id, because the CLI
// is more current than we are — this is what stops a stale label ("Opus 4.8")
// rotting onto a floating alias. Row order still comes from first appearance,
// and every row carries the strongest claim on it as `origin`.
//
// The hosted layer (the model feed from GitHub) sits between the manifest and
// discovery: curated like the manifest, but live, so a model can reach every
// picker without a release. It is replaced wholesale on every fetch, like the
// discovered layer. A hosted row marked `retired` is not shown and hides the
// manifest row of the same id — the one way to withdraw a model a shipped
// build still carries. It never touches a user-added row, and a row the CLI
// itself still lists stays as discovered: the CLI's word beats the feed's.
//
// User additions only apply when the plugin declares modelSelection — without
// declared args the launch path could not pass the model anyway.
function mergeModelCatalog(
  declared: PluginModelCatalog | undefined,
  userModels: string[] | undefined,
  discovered: DiscoveredCliModelCatalog | undefined,
  hosted?: HostedModel[],
): MergedCliModelCatalog | undefined {
  if (!declared) return undefined
  const byId = new Map<string, MergedCliModelOption>()
  const retired = new Set<string>()
  const upsert = (option: PluginModelOption, origin: CliModelOrigin): void => {
    const id = option.id.trim()
    if (!id) return
    const existing = byId.get(id)
    if (!existing) {
      byId.set(id, { ...option, id, origin })
      return
    }
    // Same id in a later layer: keep its position, take the newer label when it
    // has one, and record the stronger claim — the layers below are applied
    // weakest first (manifest → discovered → user), so a later one always wins.
    if (option.label) existing.label = option.label
    existing.origin = origin
  }
  for (const option of declared.options) upsert(option, 'manifest')
  const hostedModels = Array.isArray(hosted) ? hosted : []
  for (const model of hostedModels) {
    if (!model || typeof model.id !== 'string') continue
    const id = model.id.trim()
    if (!id) continue
    if (model.retired === true) {
      retired.add(id)
      continue
    }
    const label = typeof model.label === 'string' ? model.label.trim() : ''
    upsert(label ? { id, label } : { id }, 'hosted')
    const row = byId.get(id)
    if (row && typeof model.releasedAt === 'string' && model.releasedAt) row.releasedAt = model.releasedAt
  }
  // Tolerate a catalog that never went through the settings normalizer (a raw
  // IPC payload, a hand-edited profile): a bad discovered layer must leave the
  // curated ones rendering exactly as they did, not throw the picker away.
  const discoveredModels = Array.isArray(discovered?.models) ? discovered.models : []
  for (const model of discoveredModels) {
    if (!model || typeof model.id !== 'string') continue
    const label = typeof model.displayName === 'string' ? model.displayName.trim() : ''
    upsert(label ? { id: model.id, label } : { id: model.id }, 'discovered')
  }
  for (const entry of userModels ?? []) upsert({ id: entry }, 'user')
  const options = [...byId.values()].filter(
    (row) => !(retired.has(row.id) && (row.origin === 'manifest' || row.origin === 'hosted')),
  )
  return { options: newestFirst(options), allowCustomId: declared.allowCustomId }
}

// Newest first. The feed dates every model (releasedAt is required there), so
// a dated row sorts by its date, latest at the top, and the rows without one —
// aliases that float, manifest-only ids on a build the feed has not reached,
// discovered and user-added ids — follow in the order the layers put them.
// The sort is stable, so two models shipped the same day keep the feed's order.
function newestFirst(options: MergedCliModelOption[]): MergedCliModelOption[] {
  const releasedMs = (row: MergedCliModelOption): number | null => {
    if (!row.releasedAt) return null
    const ms = Date.parse(row.releasedAt)
    return Number.isNaN(ms) ? null : ms
  }
  return options
    .map((row, index) => ({ row, index, ms: releasedMs(row) }))
    .sort((a, b) => {
      if (a.ms !== null && b.ms !== null) return b.ms - a.ms || a.index - b.index
      if (a.ms !== null) return -1
      if (b.ms !== null) return 1
      return a.index - b.index
    })
    .map((entry) => entry.row)
}

// Effective model for a launch surface: the surface's own override only when
// it was picked for this CLI. Otherwise undefined means the CLI's own default,
// with no model flag passed.
export function resolveCliModel(
  cli: AgentCli,
  override: AgentCliModelSelection | null | undefined,
): string | undefined {
  const overrideModel = override && override.cli === cli ? override.model.trim() : ''
  return overrideModel || undefined
}

// Effective reasoning-effort level for a launch surface. Same guard as
// resolveCliModel, and for the same reason: levels are per-CLI manifest
// knowledge, so a level picked for Codex must never reach a Claude launch (the
// two CLIs do not even share a level set). Undefined means the CLI's own
// default effort, with no flag passed — and the render boundary drops a level
// the manifest does not declare, so this is not the only guard.
export function resolveCliReasoning(
  cli: AgentCli,
  override: AgentCliModelSelection | null | undefined,
): string | undefined {
  const overrideReasoning = override && override.cli === cli ? override.reasoning?.trim() : ''
  return overrideReasoning || undefined
}

// Effective model for a per-surface picker (specialist row): the
// surface's own (cli, model) override when it matches the bound CLI, else no
// model — the CLI's own default, no flag.
export function resolveSurfaceModel(
  cli: AgentCli,
  override: AgentCliModelSelection | null | undefined,
): string | undefined {
  return resolveCliModel(cli, override)
}

export function buildCliRuntimeOptions(
  cliRuntimes: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>> | undefined,
): AgentCliCatalogOption[] {
  return buildAgentCliCatalog(null, cliRuntimes)
}

// Renderer picker entry point: turns the non-persisted plugin catalog slice
// (status + entries from T2) into selectable options. Registry entries are only
// trusted once `status` is `ready`; while `loading` or after an `error` we fall
// back to the legacy bundled options so every picker stays populated and never
// throws. A `ready` registry with zero entries returns an empty list on purpose
// so callers can render a real "no agent plugins" state instead of inventing
// fallback agents.
export function selectAgentCliCatalog(
  status: PluginCatalogStatus,
  entries: PluginCatalogEntry[] | null | undefined,
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
  availability?: CliAvailabilityFilter,
  discovered?: DiscoveredCliModelCatalogs,
  hosted?: HostedCliModelCatalogs,
): AgentCliCatalogOption[] {
  const catalog = buildAgentCliCatalog(status === 'ready' ? entries ?? [] : null, cliRuntimes, discovered, hosted)
  if (!availability) return catalog
  return filterCatalogByAvailability(catalog, availability.map, availability.status)
}

// Annotate each option with its detected install state and hide the agent CLIs
// whose binary is not installed, so deployment pickers never offer (or default
// to) an uninstalled agent.
//
// Detection that is not trustworthy yet is a different answer from "nothing is
// installed", and only the first one earns a fallback:
//   - status is not `ready` (still loading, or detection errored), or the map is
//     absent → we do not know, so the unfiltered (annotated) catalog stands and
//     a transient probe failure never empties a picker on a machine that has CLIs.
//   - status is `ready` and every entry says not-installed → that IS the answer
//     on a fresh machine, so the result is empty and the surfaces render their
//     install state (MC-2093). The old escape hatch returned the whole catalog
//     here, and every downstream membership guard then read eight uninstalled
//     CLIs as launchable.
// Only options explicitly detected as `installed === false` are removed; an
// option with no availability entry (e.g. probed-after-add) stays visible.
export function filterCatalogByAvailability(
  catalog: AgentCliCatalogOption[],
  availabilityMap: AgentCliAvailabilityMap | null | undefined,
  status: CliAvailabilityFilterStatus,
): AgentCliCatalogOption[] {
  const annotated = catalog.map((option) => {
    const entry = availabilityMap?.[option.value]
    return entry
      ? { ...option, installed: entry.installed, resolvedPath: entry.resolvedPath }
      : option
  })

  if (status !== 'ready' || !availabilityMap) return annotated

  return annotated.filter((option) => availabilityMap[option.value]?.installed !== false)
}

// A runtime option, as much of it as a crumb needs. Structural on purpose: both
// catalog shapes in play — `AgentCliCatalogOption` here and the roster table's
// `SprintEngineCliOption` — satisfy it, so one helper serves every surface that
// spells a runtime out for a reader.
export type RuntimeCrumbCliOption = {
  value: string
  label: string
  modelSelection?: { options: ReadonlyArray<{ id: string; label?: string }> }
}

// Human "CLI · model" crumb for a line that names a runtime — the New sprint
// dialog's roster rows, and any host's team band (MC-2066). Lifted out of
// NewSprintDialog when the second host arrived: two copies of this would drift
// on how a model with no catalog entry reads. Null when there is no CLI to name,
// so a caller renders nothing rather than an empty crumb.
export function runtimeLabelFor(
  cli: string | undefined,
  model: string | null | undefined,
  cliOptions: ReadonlyArray<RuntimeCrumbCliOption>,
): string | null {
  if (!cli) return null
  const option = cliOptions.find((candidate) => candidate.value === cli)
  const cliLabel = option?.label ?? cli
  if (!model) return cliLabel
  const modelLabel = option?.modelSelection?.options.find((entry) => entry.id === model)?.label ?? model
  return `${cliLabel} · ${modelLabel}`
}
