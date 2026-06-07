import type {
  AgentCli,
  CliRuntimeSettings,
  PluginCatalogEntry,
  PluginCatalogStatus,
} from '../../../types/workspace'

export type AgentCliCatalogOption = {
  value: AgentCli
  label: string
  source?: PluginCatalogEntry['source']
}

const CLAUDE_CODE_PLUGIN_ID = 'claude-code'

function labelForCliRuntime(cli: AgentCli): string {
  if (cli === 'codex') return 'Codex'
  if (cli === 'claude-code') return 'Claude Code'
  return cli
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ') || cli
}

function legacyCliRuntimeOptions(
  cliRuntimes: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>> | undefined,
): AgentCliCatalogOption[] {
  const seen = new Set<AgentCli>()
  const orderedIds: AgentCli[] = []
  for (const id of ['codex', CLAUDE_CODE_PLUGIN_ID, ...Object.keys(cliRuntimes ?? {})]) {
    const trimmed = id.trim()
    const canonical = pluginRegistryIdForCli(trimmed)
    if (!canonical || seen.has(canonical)) continue
    seen.add(canonical)
    orderedIds.push(canonical)
  }
  return orderedIds.map((value) => ({ value, label: labelForCliRuntime(value) }))
}

export function pluginRegistryIdForCli(cli: AgentCli): AgentCli {
  return cli
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

export function isAgentCliMissing(
  cli: AgentCli | null | undefined,
  catalog: AgentCliCatalogOption[],
): boolean {
  return Boolean(cli && !isAgentCliAvailable(cli, catalog))
}

// CLI a New chat / template agent should spawn with. An explicit picker
// selection is honored as-is; otherwise the remembered `lastSelectedCli` is
// clamped to an installed catalog entry so a stale value cannot seed a new
// agent with an uninstalled plugin id. With an empty catalog (registry still
// loading) it returns lastSelectedCli unchanged rather than throwing.
export function resolveTemplateAgentCli(
  explicitCli: AgentCli | null | undefined,
  lastSelectedCli: AgentCli,
  catalog: AgentCliCatalogOption[],
): AgentCli {
  const explicit = explicitCli?.trim()
  if (explicit) return pluginRegistryIdForCli(explicit)
  return resolveAvailableAgentCli(lastSelectedCli, catalog, catalog[0]?.value ?? lastSelectedCli)
}

// Plugin ids that exist in the main-process registry but must never appear as a
// selectable agent CLI in spawn pickers. `generic-shell` is a bare `sh` pipe
// with no tool use or resume — it duplicates the Terminal quick row and reads as
// noise in the agent/specialist CLI lists, so it is hidden from the picker
// catalog while staying available to the registry for direct terminal launch.
const AGENT_PICKER_HIDDEN_CLI_IDS = new Set<AgentCli>(['generic-shell'])

export function buildAgentCliCatalog(
  plugins: PluginCatalogEntry[] | null | undefined,
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
): AgentCliCatalogOption[] {
  if (!plugins) return legacyCliRuntimeOptions(cliRuntimes)

  const seen = new Set<AgentCli>()
  const ordered = [...plugins].sort((a, b) => {
    if (a.source === b.source) return 0
    return a.source === 'bundled' ? -1 : 1
  })
  const options: AgentCliCatalogOption[] = []
  for (const plugin of ordered) {
    const id = plugin.id.trim()
    if (!id || seen.has(id) || AGENT_PICKER_HIDDEN_CLI_IDS.has(id)) continue
    seen.add(id)
    options.push({
      value: id,
      label: plugin.displayName,
      source: plugin.source,
    })
  }
  return options
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
): AgentCliCatalogOption[] {
  return buildAgentCliCatalog(status === 'ready' ? entries ?? [] : null, cliRuntimes)
}
