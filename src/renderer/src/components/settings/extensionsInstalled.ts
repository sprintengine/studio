// extensionsInstalled — pure, DOM-free derivation for the Settings → Extensions
// "Installed" inventory. The React component (`ExtensionsSettingsTab.tsx`) owns
// the IPC calls and rendering; everything that can be unit-tested without a
// renderer lives here so the lifecycle states (loading / unsupported /
// unavailable / error / empty / populated) get node-level coverage like
// `providerSettings.ts`.
//
// This is the single canonical inventory surface across the four extension
// primitives (per the approved TD1 design notes). It reads real installed state
// from the existing list APIs and never fabricates entries. A source that is
// missing (older build), unavailable (no workspace), or failing is surfaced as
// an explicit notice — a failed dependency must never read as an empty list.

import type {
  ModuleEnablementOverrides,
  ModuleTrustStatus,
  ThirdPartyModuleListResult,
} from '../../../../shared/modules/manifest'
import type { SkillPackEntry } from '../../../../shared/electron-api'
import type { PluginRegistryListEntry } from '../../../../shared/plugin-manifest'
import type { McpServerConfig } from '../../types/workspace'

export type ExtensionKind = 'mcp' | 'skill-pack' | 'cli' | 'module'

// Singular, sentence-case kind labels. Group order is the array order below:
// the direct-install primitives in the same order the MCP / skill-pack / module
// settings tabs present them.
export const EXTENSION_KIND_LABEL: Record<ExtensionKind, string> = {
  mcp: 'MCP server',
  'skill-pack': 'Skill pack',
  cli: 'Agent CLI',
  module: 'Module',
}

const GROUP_ORDER: ExtensionKind[] = ['mcp', 'skill-pack', 'cli', 'module']

// One row in the aggregated inventory. `trust` is only carried by capability
// modules (the security axis the trust dot encodes); `enabled` is tri-state —
// true/false where the primitive has an enable concept (MCP servers, modules),
// undefined where "installed" is the only state (skill packs, CLIs), so the row
// never implies a toggle that does not exist.
export type InstalledExtension = {
  key: string
  id: string
  name: string
  kind: ExtensionKind
  /** Provenance: 'Bundled' | 'User' | 'Custom'. */
  source: string
  trust?: ModuleTrustStatus
  enabled?: boolean
  /** One pre-formatted muted meta line (ids, transport, version). */
  detail?: string
}

export type InstalledExtensionGroup = {
  kind: ExtensionKind
  label: string
  items: InstalledExtension[]
}

// Per-source load outcome. `unsupported` = the running build's preload predates
// the API; `unavailable` = a precondition is missing (e.g. no workspace open for
// skill packs); `error` = the API was reached and failed.
export type LoadedSource<T> =
  | { status: 'loading' }
  | { status: 'unsupported' }
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; message: string }
  | { status: 'ok'; value: T }

export type ExtensionsInstalledInput = {
  // MCP servers come from the workspace store, not an IPC call, so they are
  // always available (possibly an empty array).
  mcpServers: McpServerConfig[]
  modules: LoadedSource<ThirdPartyModuleListResult>
  moduleOverrides: ModuleEnablementOverrides
  skillPacks: LoadedSource<SkillPackEntry[]>
  clis: LoadedSource<PluginRegistryListEntry[]>
}

export type SourceNotice = {
  kind: ExtensionKind
  // 'warn' for missing/unavailable sources (degraded but not broken); 'error'
  // for a source that was reached and failed.
  tone: 'warn' | 'error'
  message: string
}

export type ExtensionsInstalledView =
  | { status: 'loading' }
  // Every IPC-backed source predates this build and there are no MCP servers:
  // nothing can be listed and it is not the user's empty state.
  | { status: 'unsupported' }
  // Loaded cleanly with zero rows and nothing wrong — the genuine empty state.
  // Carries no notices, so "Nothing installed yet" only ever shows when there is
  // truly nothing to report.
  | { status: 'empty' }
  // Zero rows but at least one source failed, was unavailable, or rejected a
  // folder. The notices explain why nothing is shown; we never render the
  // "nothing installed" copy under a problem notice.
  | { status: 'degraded'; notices: SourceNotice[] }
  | { status: 'ready'; groups: InstalledExtensionGroup[]; total: number; notices: SourceNotice[] }

function sourceLabel(source: string | undefined): string {
  switch (source) {
    case 'bundled':
      return 'Bundled'
    case 'user':
      return 'User'
    case 'custom':
    case 'third-party':
      return 'Custom'
    default:
      return 'Bundled'
  }
}

export function mcpToInstalled(servers: McpServerConfig[]): InstalledExtension[] {
  return servers.map((server) => ({
    key: `mcp:${server.id}`,
    id: server.id,
    name: server.name,
    kind: 'mcp' as const,
    source: sourceLabel(server.source),
    enabled: server.enabled,
    detail: [server.id, server.transport, ...(server.clients.length ? [server.clients.join(', ')] : [])].join(' · '),
  }))
}

export function modulesToInstalled(
  result: ThirdPartyModuleListResult,
  overrides: ModuleEnablementOverrides,
): InstalledExtension[] {
  return result.modules.map((module) => ({
    key: `module:${module.manifest.id}`,
    id: module.manifest.id,
    name: module.manifest.displayName,
    kind: 'module' as const,
    source: sourceLabel(module.manifest.source),
    trust: module.trust,
    // Trust-blocked modules do not load regardless of the enablement intent, so
    // showing an "enabled" state for them would overstate reality. The enabled
    // intent mirrors the main launch gate and ThirdPartyModuleList's
    // `resolveModuleEnabled`: an explicit override wins, else the manifest default.
    enabled:
      module.trust === 'trusted'
        ? (overrides[module.manifest.id] ?? module.manifest.defaultEnabled)
        : false,
    detail: module.manifest.summary,
  }))
}

export function skillPacksToInstalled(packs: SkillPackEntry[]): InstalledExtension[] {
  return packs.map((pack) => ({
    key: `skill-pack:${pack.slug}`,
    id: pack.slug,
    name: pack.name,
    kind: 'skill-pack' as const,
    source: sourceLabel(pack.source),
    detail: [pack.slug, ...(pack.version ? [`v${pack.version}`] : []), pack.harnesses.join(', ')]
      .filter(Boolean)
      .join(' · '),
  }))
}

export function clisToInstalled(plugins: PluginRegistryListEntry[]): InstalledExtension[] {
  return plugins.map((plugin) => ({
    key: `cli:${plugin.id}`,
    id: plugin.id,
    name: plugin.displayName,
    kind: 'cli' as const,
    source: sourceLabel(plugin.source),
    detail: `${plugin.id} · v${plugin.version}`,
  }))
}

// Builds one notice for a non-ok, non-loading source. Returns null for ok/loading.
function sourceNotice(kind: ExtensionKind, source: LoadedSource<unknown>): SourceNotice | null {
  switch (source.status) {
    case 'unsupported':
      return {
        kind,
        tone: 'warn',
        message: `${EXTENSION_KIND_LABEL[kind]} listing needs a newer app build — restart after updating.`,
      }
    case 'unavailable':
      return { kind, tone: 'warn', message: source.reason }
    case 'error':
      return { kind, tone: 'error', message: source.message }
    default:
      return null
  }
}

export function deriveInstalledExtensions(input: ExtensionsInstalledInput): ExtensionsInstalledView {
  const ipcSources = [input.modules, input.skillPacks, input.clis]

  // Any IPC source still in flight holds the whole view in loading rather than
  // flashing a partial list then reflowing.
  if (ipcSources.some((source) => source.status === 'loading')) {
    return { status: 'loading' }
  }

  const groups: InstalledExtensionGroup[] = []
  const byKind: Record<ExtensionKind, InstalledExtension[]> = {
    mcp: mcpToInstalled(input.mcpServers),
    'skill-pack': input.skillPacks.status === 'ok' ? skillPacksToInstalled(input.skillPacks.value) : [],
    cli: input.clis.status === 'ok' ? clisToInstalled(input.clis.value) : [],
    module: input.modules.status === 'ok' ? modulesToInstalled(input.modules.value, input.moduleOverrides) : [],
  }

  for (const kind of GROUP_ORDER) {
    if (byKind[kind].length > 0) {
      groups.push({ kind, label: EXTENSION_KIND_LABEL[kind], items: byKind[kind] })
    }
  }

  const notices: SourceNotice[] = []
  const skillNotice = sourceNotice('skill-pack', input.skillPacks)
  const cliNotice = sourceNotice('cli', input.clis)
  const moduleNotice = sourceNotice('module', input.modules)
  if (skillNotice) notices.push(skillNotice)
  if (cliNotice) notices.push(cliNotice)
  if (moduleNotice) notices.push(moduleNotice)
  // Rejected module folders are an honest "could not load" signal, distinct from
  // a clean empty list.
  if (input.modules.status === 'ok' && input.modules.value.rejected.length > 0) {
    const count = input.modules.value.rejected.length
    notices.push({
      kind: 'module',
      tone: 'warn',
      message: `${count} module folder${count === 1 ? '' : 's'} could not be loaded.`,
    })
  }

  const total = groups.reduce((sum, group) => sum + group.items.length, 0)

  if (total === 0) {
    // Nothing installed AND every IPC source predates this build AND no MCP
    // servers: there is nothing this build can list — not the user's empty state.
    const allUnsupported = ipcSources.every((source) => source.status === 'unsupported')
    if (allUnsupported && input.mcpServers.length === 0) {
      return { status: 'unsupported' }
    }
    // Only a clean, fully-loaded zero-row result is the user's empty state. If any
    // source failed, was unavailable, or rejected a folder, surface those notices
    // as a degraded state instead of the misleading "nothing installed" copy.
    if (notices.length === 0) {
      return { status: 'empty' }
    }
    return { status: 'degraded', notices }
  }

  return { status: 'ready', groups, total, notices }
}
