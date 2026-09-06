// pluginsSurfaceModel — pure, DOM-free derivation for the Plugins surface, the
// skillsSurfaceModel idiom: the components own the IPC and the rendering, and
// everything that can be tested without a renderer lives here.
//
// The honesty rules it holds: a source's plugin count never renders as zero
// while it is loading or unreadable; a linked plugin's components are unknown
// until read, never empty; and what an install will do is stated per harness
// before it happens, in the same words the install reports afterwards.

import type { InstalledPluginRecord } from '../../../../../../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../../../../../../shared/marketplace/manifest'
import {
  BUILTIN_SKILL_SOURCE_ID,
  describePluginComponents,
  findScannedPlugin,
  pluginAliases,
  scanPluginRenames,
  scanPlugins,
  type ScanResult,
  type ScannedPlugin,
  type SkillHarness,
  type SkillSource,
} from '../../../../../../../shared/skills'
import type { SkillScanLoad, SkillSourcesLoad } from '../skills/skillsSurfaceModel'

export const HARNESS_LABEL: Record<SkillHarness, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
  grok: 'Grok',
  agents: 'Shared agents directory',
}

export function pluralPlugins(count: number): string {
  return `${count} ${count === 1 ? 'plugin' : 'plugins'}`
}

/** A source's plugin count, or why there is none to state. */
export function pluginCountLine(load: SkillScanLoad | undefined): string {
  if (!load || load.status === 'loading') return 'Loading…'
  if (load.status === 'error') return 'Count unavailable'
  const count = scanPlugins(load.scan).length
  return count === 0 ? 'No plugins here' : pluralPlugins(count)
}

/** The Extensions rail's own "Plugins" line: spoken only once every source answered. */
export function derivePluginsKindStateLine(
  sourcesLoad: SkillSourcesLoad,
  sources: readonly SkillSource[],
  scans: Readonly<Record<string, SkillScanLoad>>,
  /** The Multicode marketplace's count once it answered; null while it has not. */
  registryCount: number | null = null,
): string {
  if (sourcesLoad.status === 'loading') return 'Loading…'
  if (sourcesLoad.status === 'error') return 'Sources unavailable'
  const sourceLine = `${sources.length} source${sources.length === 1 ? '' : 's'}`
  // The Multicode source's plugins are the registry's, not its scan's.
  const scanned = sources.filter((source) => source.id !== BUILTIN_SKILL_SOURCE_ID)
  const loads = scanned.map((source) => scans[source.id])
  if (loads.some((load) => !load || load.status !== 'ready')) return sourceLine
  if (sources.some((source) => source.id === BUILTIN_SKILL_SOURCE_ID) && registryCount === null) return sourceLine
  const total =
    loads.reduce((sum, load) => sum + (load && load.status === 'ready' ? scanPlugins(load.scan).length : 0), 0)
    + (registryCount ?? 0)
  return `${sourceLine} · ${pluralPlugins(total)}`
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export type PluginInstallState =
  | { kind: 'not-installed' }
  | { kind: 'installed'; record: InstalledPluginRecord }
  /** Installed from this source at another commit than the source now pins. */
  | { kind: 'update-available'; record: InstalledPluginRecord }

export type PluginListItem = {
  pluginId: string
  name: string
  description: string
  /** "4 skills · 2 commands · 1 MCP", or "Read when opened" for an unread linked plugin. */
  components: string
  hasHooks: boolean
  linked: boolean
  install: PluginInstallState
}

/**
 * Which record says this plugin is installed. Our own receipt first; failing
 * that, a plugin the workspace's Claude settings enable under the same
 * `name@marketplace` key — enabled by hand, still installed.
 */
export function findInstalledRecord(
  records: readonly InstalledPluginRecord[],
  sourceId: string,
  plugin: Pick<ScannedPlugin, 'id'>,
  marketplaceName: string,
  /**
   * Names this plugin used to be listed under, from the marketplace's own
   * `renames` map. A receipt written before an upstream rename names the plugin
   * by the old name, and without them the plugin a person installed reads as
   * not installed and installing it again duplicates it.
   */
  aliases: readonly string[] = [],
): InstalledPluginRecord | null {
  // An exact id beats an alias, across ALL the records — not whichever comes
  // first in the list. Scanning the records once and asking "is this any of my
  // names" let a receipt for an old name outrank the receipt written under the
  // name the plugin goes by now, which is the wrong plugin's receipt whenever
  // both are installed.
  const older = aliases.filter((name) => name !== plugin.id)
  const own =
    records.find((record) => record.sourceId === sourceId && record.pluginId === plugin.id)
    ?? records.find((record) => record.sourceId === sourceId && older.includes(record.pluginId))
  if (own) return own
  if (marketplaceName === '') return null
  const key = `${plugin.id}@${marketplaceName}`
  return (
    records.find((record) => record.claudePluginKey === key)
    ?? records.find((record) => older.some((name) => record.claudePluginKey === `${name}@${marketplaceName}`))
    ?? null
  )
}

export function derivePluginInstallState(
  records: readonly InstalledPluginRecord[],
  sourceId: string,
  plugin: ScannedPlugin,
  marketplaceName: string,
  /** The commit the source (or the linked plugin) pins now. */
  currentCommit: string,
  /** Names this plugin used to be listed under — see findInstalledRecord. */
  aliases: readonly string[] = [],
): PluginInstallState {
  const record = findInstalledRecord(records, sourceId, plugin, marketplaceName, aliases)
  if (!record) return { kind: 'not-installed' }
  // Only our own receipts carry a commit to compare; a hand-enabled plugin has
  // no commit we wrote, and "update available" would be a guess.
  if (record.sourceId === sourceId && record.commitSha !== '' && currentCommit !== '' && record.commitSha !== currentCommit) {
    return { kind: 'update-available', record }
  }
  return { kind: 'installed', record }
}

export function pluginCommit(plugin: ScannedPlugin, source: SkillSource): string {
  return plugin.origin.kind === 'linked' ? plugin.origin.sha : source.commitSha
}

export function derivePluginRows(input: {
  source: SkillSource
  scan: ScanResult
  installed: readonly InstalledPluginRecord[]
  query: string
}): PluginListItem[] {
  const marketplaceName = input.scan.marketplaceName ?? ''
  const renames = scanPluginRenames(input.scan)
  const needle = input.query.trim().toLowerCase()
  return scanPlugins(input.scan)
    .filter((plugin) =>
      needle === '' || `${plugin.name} ${plugin.description} ${plugin.category} ${plugin.author}`.toLowerCase().includes(needle),
    )
    .map((plugin) => ({
      pluginId: plugin.id,
      name: plugin.name,
      description: plugin.description,
      components: describePluginComponents(plugin),
      hasHooks: plugin.components.hooks.length > 0,
      linked: plugin.origin.kind === 'linked',
      install: derivePluginInstallState(
        input.installed,
        input.source.id,
        plugin,
        marketplaceName,
        pluginCommit(plugin, input.source),
        pluginAliases(renames, plugin.id),
      ),
    }))
}

/** A plugin by the name it goes by now, or any name the marketplace renamed onto it. */
export function findPlugin(scan: ScanResult, pluginId: string): ScannedPlugin | null {
  return findScannedPlugin(scan, pluginId)
}

/** Where a plugin's bytes can be read by a person: its homepage, else its repository. */
export function pluginExternalUrl(plugin: ScannedPlugin, source: SkillSource): string | null {
  if (plugin.homepage) return plugin.homepage
  if (plugin.origin.kind === 'linked') return plugin.origin.url || null
  if (plugin.origin.kind === 'in-tree' && source.repo) {
    const path = plugin.origin.path ? `/tree/${source.commitSha || 'HEAD'}/${plugin.origin.path}` : ''
    return `https://github.com/${source.repo}${path}`
  }
  if (plugin.origin.kind === 'registry') return plugin.origin.sourceUrl || null
  return null
}

// ── What installs where ──────────────────────────────────────────────────────

export type HarnessPlanLine = { harness: SkillHarness; label: string; line: string }

/**
 * The per-harness sentence the pane shows BEFORE install, from the same rule
 * the installer applies: Claude Code enables a marketplace plugin natively;
 * every other harness gets the skills; a harness with nothing to receive is
 * told so rather than shown a blank.
 */
export function describeInstallPlan(input: {
  plugin: ScannedPlugin
  marketplaceName: string
  marketplaceRepo: string
  harnesses: readonly SkillHarness[]
}): HarnessPlanLine[] {
  const { plugin } = input
  if (!plugin.componentsKnown) {
    return input.harnesses.map((harness) => ({
      harness,
      label: HARNESS_LABEL[harness],
      line: 'Known once the plugin has been read.',
    }))
  }
  const native = input.marketplaceName !== '' && input.marketplaceRepo !== '' && plugin.origin.kind !== 'registry'
  const skills = plugin.components.skills.length
  const claudeOnly = claudeOnlyComponents(plugin)
  return input.harnesses.map((harness) => {
    if (harness === 'claude' && native) {
      return {
        harness,
        label: HARNESS_LABEL[harness],
        line: `Enabled as ${plugin.id}@${input.marketplaceName} in this workspace's .claude/settings.json. Claude Code loads its commands, agents, hooks, MCP servers and language servers itself.`,
      }
    }
    const parts: string[] = []
    if (skills > 0) parts.push(`${skills} ${skills === 1 ? 'skill' : 'skills'} copied into ${harnessDir(harness)}/skills`)
    if (plugin.components.mcpServers.length > 0) {
      parts.push(`${plugin.components.mcpServers.length} MCP ${plugin.components.mcpServers.length === 1 ? 'server' : 'servers'} added to MCP settings`)
    }
    if (parts.length === 0) {
      return {
        harness,
        label: HARNESS_LABEL[harness],
        line: claudeOnly ? `Nothing to install. Its ${claudeOnly} are Claude Code-format and have no equivalent here.` : 'Nothing to install.',
      }
    }
    const tail = claudeOnly ? ` Its ${claudeOnly} have no equivalent here.` : ''
    return { harness, label: HARNESS_LABEL[harness], line: `${parts.join('; ')}.${tail}` }
  })
}

function claudeOnlyComponents(plugin: ScannedPlugin): string {
  const parts: string[] = []
  if (plugin.components.commands.length > 0) parts.push('commands')
  if (plugin.components.agents.length > 0) parts.push('agents')
  if (plugin.components.hooks.length > 0) parts.push('hooks')
  // A language server is started by Claude Code's own editor integration and
  // has no equivalent in the other harnesses. Left out, the twelve `*-lsp`
  // plugins read "Nothing to install." under Codex with no reason given, which
  // is the blank this sentence exists to avoid.
  if (plugin.components.lspServers.length > 0) parts.push('LSP servers')
  return parts.join(', ')
}

function harnessDir(harness: SkillHarness): string {
  return `.${harness}`
}

// ── Availability and outcomes ────────────────────────────────────────────────

export type PluginInstallAvailability = { enabled: boolean; reason: string | null }

export function derivePluginInstallAvailability(
  workspaceRoot: string | null,
  plugin: ScannedPlugin | null,
  harnesses: readonly SkillHarness[],
  hooksAcknowledged: boolean,
): PluginInstallAvailability {
  if (!workspaceRoot) {
    return { enabled: false, reason: 'Open a workspace to install a plugin — a plugin installs into a workspace, not into the app.' }
  }
  if (!plugin) return { enabled: false, reason: null }
  if (harnesses.length === 0) return { enabled: false, reason: 'No agent CLI on this machine reads plugins or skills.' }
  if (plugin.componentsKnown && plugin.components.hooks.length > 0 && !hooksAcknowledged) {
    return { enabled: false, reason: 'Review the hook commands above, then confirm they may run.' }
  }
  return { enabled: true, reason: null }
}

/** One line for what an install did, per harness, in the installer's own words. */
export function summarizePluginInstall(outcome: {
  harnesses: readonly { harness: SkillHarness; mode: 'native' | 'skills' | 'nothing'; skillDirNames: string[] }[]
  mcpServers: readonly unknown[]
  warnings: readonly string[]
}): string {
  const parts: string[] = []
  const native = outcome.harnesses.filter((h) => h.mode === 'native')
  const skills = outcome.harnesses.filter((h) => h.mode === 'skills' && h.skillDirNames.length > 0)
  if (native.length > 0) parts.push(`enabled in ${native.map((h) => HARNESS_LABEL[h.harness]).join(', ')}`)
  if (skills.length > 0) {
    const count = Math.max(...skills.map((h) => h.skillDirNames.length))
    parts.push(`${count} ${count === 1 ? 'skill' : 'skills'} copied for ${skills.map((h) => HARNESS_LABEL[h.harness]).join(', ')}`)
  }
  if (outcome.mcpServers.length > 0) {
    parts.push(`${outcome.mcpServers.length} MCP ${outcome.mcpServers.length === 1 ? 'server' : 'servers'} added`)
  }
  const line = parts.length > 0 ? `Installed: ${parts.join('; ')}.` : 'Installed.'
  return outcome.warnings.length > 0 ? `${line} ${outcome.warnings[0]}` : line
}

// ── The Multicode source ─────────────────────────────────────────────────────

/** A registry entry as a plugin row: what it provides, in the row's words. */
export function deriveRegistryPluginRows(entries: readonly MarketplacePluginEntry[], query: string): PluginListItem[] {
  const needle = query.trim().toLowerCase()
  return entries
    .filter((entry) =>
      needle === '' || `${entry.name} ${entry.summary} ${entry.category} ${entry.publisher.name} ${(entry.tags ?? []).join(' ')}`.toLowerCase().includes(needle),
    )
    .map((entry) => ({
      pluginId: entry.id,
      name: entry.name,
      description: entry.summary,
      components: describeRegistryComponents(entry),
      hasHooks: false,
      linked: false,
      // Registry installs are recorded by the marketplace lifecycle's own
      // receipts, which the storefront detail panel reads; the row itself
      // does not claim a state it cannot see.
      install: { kind: 'not-installed' },
    }))
}

function describeRegistryComponents(entry: MarketplacePluginEntry): string {
  const parts: string[] = []
  const skills = entry.skills?.length ?? 0
  if (skills > 0) parts.push(`${skills} ${skills === 1 ? 'skill' : 'skills'}`)
  const servers = entry.mcp?.servers.length ?? (entry.provides.includes('mcp') ? 1 : 0)
  if (servers > 0) parts.push(`${servers} MCP`)
  if (entry.provides.includes('automation')) parts.push('automation')
  if (entry.provides.includes('module')) parts.push('module')
  if (entry.provides.includes('cli')) parts.push('agent CLI')
  return parts.length > 0 ? parts.join(' · ') : entry.provides.join(' · ')
}
