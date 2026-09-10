// Every skill and every plugin the app can reach, as palette rows.
//
// The Extensions door searches one tab of one source at a time, four clicks in.
// This is the other half of the same catalogue, read from the SAME cached scans
// the door reads, and put behind one query box: the skills a source holds
// whether or not you have installed them, the plugins its marketplace lists,
// and the first-party registry's entries.
//
// What it deliberately does NOT do is search GitHub. `skillsSearch` is a code
// search against a 10-request-per-minute budget; a keystroke-driven palette
// would spend it in six seconds. Everything here is the cached scan on disk,
// so it is instant, it works offline, and it costs nothing to type into.
//
// The module is split so the interesting half is testable without a DOM: the
// LOAD (one warm, all the IPC) and the BUILD (scans + inventory → rows) are
// pure functions over data, and only `createExtensionsProvider` knows it is
// wired to a palette.

import type { MarketplacePluginEntry } from '../../../../shared/marketplace/manifest'
import type { ScanResult, ScannedPlugin, ScannedSkill, SkillSource } from '../../../../shared/skills'
import { scanPlugins, skillDirName } from '../../../../shared/skills'
import {
  extensionIconProps,
  pluginArtwork,
  pluginsByFolder,
  skillArtwork,
} from '../workspace/globalSurface/extensions/catalogue/pluginArtwork'
import { skillPluginFolder } from '../workspace/globalSurface/extensions/skills/skillsSurfaceModel'
import { resolveIconUrl } from '../settings/BrowseStorefront'
import {
  commandMatchesQuery,
  orderPaletteCommands,
  type PaletteCommandGroup,
} from '../commandPaletteSearch'
import type { PaletteCommand, PaletteResultProvider, PaletteRowIcon } from './paletteProvider'

/** The slot size the palette draws a row's mark at (an avatar asks for 2×). */
export const PALETTE_ROW_ICON_SIZE = 20

/** How many rows one group contributes when the palette is showing everything. */
export const EXTENSION_ROWS_PER_GROUP = 8

// ── What one warm reads ──────────────────────────────────────────────────────

/** One configured source and the cached scan behind it. */
export type ExtensionsSourceScan = {
  source: SkillSource
  scan: ScanResult
}

export type ExtensionsCatalogue = {
  sources: ExtensionsSourceScan[]
  /** The first-party registry's entries, and the URL its relative icons resolve against. */
  registry: MarketplacePluginEntry[]
  registryUrl: string | null
}

export const EMPTY_EXTENSIONS_CATALOGUE: ExtensionsCatalogue = {
  sources: [],
  registry: [],
  registryUrl: null,
}

/** Only the calls this module makes, so a test can hand it four functions. */
export type ExtensionsCatalogueApi = Pick<
  typeof window.api,
  'skillsListSources' | 'skillsGetScan' | 'readMarketplaceRegistry'
>

/**
 * One round of reads, run when the palette opens.
 *
 * Every leg is best-effort and independent: a source whose scan will not read
 * drops out of the list rather than emptying it, and a registry that is not
 * there leaves the source rows standing. The palette is a search box, and a
 * search box that refuses to search because one of five sources is unreachable
 * is worse than one that searches the other four.
 */
export async function loadExtensionsCatalogue(
  api: ExtensionsCatalogueApi,
): Promise<ExtensionsCatalogue> {
  const [sources, registry] = await Promise.all([
    loadSourceScans(api),
    loadRegistry(api),
  ])
  return { sources, ...registry }
}

async function loadSourceScans(api: ExtensionsCatalogueApi): Promise<ExtensionsSourceScan[]> {
  let listed: Awaited<ReturnType<ExtensionsCatalogueApi['skillsListSources']>>
  try {
    listed = await api.skillsListSources()
  } catch {
    return []
  }
  if (!listed.ok) return []
  const scans = await Promise.all(
    listed.sources.map(async (source): Promise<ExtensionsSourceScan | null> => {
      try {
        const outcome = await api.skillsGetScan({ sourceId: source.id })
        // The scan carries its own copy of the source record (a read may have
        // refreshed it); prefer it, and fall back to the listed one.
        return outcome.ok ? { source: outcome.source ?? source, scan: outcome.scan } : null
      } catch {
        return null
      }
    }),
  )
  return scans.filter((entry): entry is ExtensionsSourceScan => entry !== null)
}

async function loadRegistry(
  api: ExtensionsCatalogueApi,
): Promise<Pick<ExtensionsCatalogue, 'registry' | 'registryUrl'>> {
  try {
    const result = await api.readMarketplaceRegistry()
    if (!result.ok) return { registry: [], registryUrl: null }
    return { registry: result.marketplace.plugins ?? [], registryUrl: result.registryUrl ?? null }
  } catch {
    return { registry: [], registryUrl: null }
  }
}

// ── What one row is ──────────────────────────────────────────────────────────

/** A skill a source holds, and everything selecting it needs to know. */
export type ExtensionSkillRow = {
  kind: 'skill'
  /** Unique across the palette. */
  id: string
  sourceId: string
  sourceName: string
  /** The source-relative id `skillsInstall` takes. */
  skillId: string
  /** The directory name it installs as — the workspace inventory's own id. */
  dirName: string
  name: string
  description: string
  keywords: string
  icon: PaletteRowIcon
  installed: boolean
}

/** A plugin a source's marketplace lists, or the first-party registry holds. */
export type ExtensionPluginRow = {
  kind: 'plugin'
  id: string
  /** '' for a registry entry, which belongs to no skill source. */
  sourceId: string
  sourceName: string
  pluginId: string
  name: string
  description: string
  keywords: string
  icon: PaletteRowIcon
  /**
   * A registry entry installs through the storefront's own flow, not
   * `skillsInstallPlugin`, so selecting one is a deep link and never an install.
   */
  registry: boolean
  /** Declares hooks — shell commands, which must never be installed silently. */
  hooks: boolean
  /** False for a linked plugin nobody has opened: its skills are unknown, not none. */
  componentsKnown: boolean
  /** The directory names of the skills it ships, when they are known. */
  skillDirNames: string[]
}

export type ExtensionRow = ExtensionSkillRow | ExtensionPluginRow

/** Everything a row is searched by, in one string. */
function matchText(parts: readonly (string | undefined)[]): string {
  return parts
    .map((part) => (part ?? '').trim())
    .filter((part) => part !== '')
    .join(' ')
}

/**
 * The catalogue as rows, with each skill marked against what the workspace
 * already holds.
 *
 * `installedDirNames` is the workspace inventory's own ids — a skill installs
 * as the last segment of its source-relative path (`skillDirName`), which is
 * exactly what `workspaceSkillsList` files it under. A skill that is already
 * there is still listed: it is the row a person is most likely to want, and
 * hiding it would make the search that finds everything the one search that
 * cannot find what you have.
 */
export function buildExtensionRows(
  catalogue: ExtensionsCatalogue,
  installedDirNames: ReadonlySet<string>,
): ExtensionRow[] {
  const rows: ExtensionRow[] = []
  for (const { source, scan } of catalogue.sources) {
    const plugins = scanPlugins(scan)
    const byFolder = pluginsByFolder(plugins)
    for (const skill of scan.skills ?? []) {
      rows.push(skillRow(skill, source, byFolder.get(skillPluginFolder(skill.id)), installedDirNames))
    }
    for (const plugin of plugins) {
      rows.push(pluginRow(plugin, source))
    }
  }
  for (const entry of catalogue.registry) {
    rows.push(registryRow(entry, catalogue.registryUrl))
  }
  return rows
}

function skillRow(
  skill: ScannedSkill,
  source: SkillSource,
  plugin: ScannedPlugin | undefined,
  installedDirNames: ReadonlySet<string>,
): ExtensionSkillRow {
  const dirName = skillDirName(skill.id)
  return {
    kind: 'skill',
    id: `ext-skill-${source.id}-${skill.id}`,
    sourceId: source.id,
    sourceName: source.name,
    skillId: skill.id,
    dirName,
    name: skill.name,
    description: skill.description,
    keywords: matchText([skill.group, source.name, plugin?.name, plugin?.category, plugin?.author]),
    icon: extensionIconProps(skillArtwork(skill, source, PALETTE_ROW_ICON_SIZE, plugin)),
    installed: installedDirNames.has(dirName),
  }
}

function pluginRow(plugin: ScannedPlugin, source: SkillSource): ExtensionPluginRow {
  return {
    kind: 'plugin',
    id: `ext-plugin-${source.id}-${plugin.id}`,
    sourceId: source.id,
    sourceName: source.name,
    pluginId: plugin.id,
    name: plugin.name,
    description: plugin.description,
    keywords: matchText([
      plugin.category,
      plugin.author,
      source.name,
      plugin.keywords.join(' '),
      plugin.tags.join(' '),
    ]),
    icon: extensionIconProps(pluginArtwork(plugin, source, PALETTE_ROW_ICON_SIZE)),
    registry: false,
    hooks: plugin.components.hooks.length > 0,
    componentsKnown: plugin.componentsKnown,
    skillDirNames: plugin.components.skills.map((skill) => skillDirName(skill.id)),
  }
}

/** The first-party registry's own name, as the badge on its rows. */
export const REGISTRY_SOURCE_NAME = 'Marketplace'

function registryRow(entry: MarketplacePluginEntry, registryUrl: string | null): ExtensionPluginRow {
  const icon = resolveIconUrl(registryUrl, entry.icon)
  return {
    kind: 'plugin',
    id: `ext-registry-${entry.id}`,
    sourceId: '',
    sourceName: REGISTRY_SOURCE_NAME,
    pluginId: entry.id,
    name: entry.name,
    description: entry.summary,
    keywords: matchText([
      entry.category,
      entry.publisher.name,
      (entry.categories ?? []).join(' '),
      (entry.tags ?? []).join(' '),
    ]),
    icon: icon ? { icon } : {},
    registry: true,
    // A registry entry never installs from here, so its hooks and components
    // are the storefront's business, not this row's.
    hooks: false,
    componentsKnown: true,
    skillDirNames: (entry.skills ?? []).map((skill: { path?: string; name: string }) => skillDirName(skill.path ?? skill.name)),
  }
}

// ── Rows → palette commands ──────────────────────────────────────────────────

/** "Installed", or where it would come from. */
export function rowBadge(row: ExtensionRow): string {
  if (row.kind === 'skill') return row.installed ? 'Installed' : row.sourceName
  return row.sourceName
}

/** Which group a row lands in: a skill among skills, a plugin among extensions. */
export function rowGroup(row: ExtensionRow): PaletteCommandGroup {
  return row.kind === 'skill' ? 'skills' : 'extensions'
}

export type ExtensionsProviderDeps = {
  /**
   * The workspace inventory's ids, so a source's skill knows it is already in
   * — read at LOAD time, not at construction.
   *
   * Every one of these is a getter for the same reason: the provider warms once
   * per palette, and a provider re-created because the inventory finished
   * loading (or because the scope chip was popped) would throw the warm away
   * and re-run every source's scan. The identity has to be stable, so the
   * changing facts are read through a function.
   */
  getInstalledDirNames: () => ReadonlySet<string>
  /** Rows per group; the caller lifts the cap when the palette is scoped. */
  getLimit?: () => number
  /** Selecting a skill: install it if needed, then hand it to an agent. */
  onSelectSkill: (row: ExtensionSkillRow) => void
  /** Selecting a plugin: install, deep-link, or both — the caller decides. */
  onSelectPlugin: (row: ExtensionPluginRow) => void
  /** Overridable for tests; defaults to the real preload bridge. */
  api?: ExtensionsCatalogueApi
}

/** A row as the palette renders it. */
export function extensionRowToCommand(
  row: ExtensionRow,
  deps: Pick<ExtensionsProviderDeps, 'onSelectSkill' | 'onSelectPlugin'>,
): PaletteCommand {
  return {
    id: row.id,
    label: row.name,
    description: row.description,
    keywords: row.keywords,
    group: rowGroup(row),
    icon: row.icon,
    badge: rowBadge(row),
    installed: row.kind === 'skill' ? row.installed : undefined,
    run: () => {
      if (row.kind === 'skill') deps.onSelectSkill(row)
      else deps.onSelectPlugin(row)
    },
  }
}

/**
 * The matched rows, ranked, and capped per group.
 *
 * Capping is per GROUP rather than overall because the two groups answer
 * different questions: eight skills and eight plugins is a useful answer, and
 * sixteen skills that pushed every plugin off the list is not.
 */
export function selectExtensionCommands(
  rows: readonly ExtensionRow[],
  query: string,
  deps: Pick<ExtensionsProviderDeps, 'onSelectSkill' | 'onSelectPlugin'> & { limit?: number },
): PaletteCommand[] {
  const commands = rows
    .map((row) => extensionRowToCommand(row, deps))
    .filter((command) => commandMatchesQuery(command, query))
  const matched = orderPaletteCommands(commands, query)
  const limit = deps.limit ?? EXTENSION_ROWS_PER_GROUP
  const perGroup = new Map<PaletteCommandGroup, number>()
  return matched.filter((command) => {
    if (command.label.trim() === '') return false
    const count = (perGroup.get(command.group) ?? 0) + 1
    perGroup.set(command.group, count)
    return count <= limit
  })
}

/**
 * The provider itself: one warm on open, then a memory filter per keystroke.
 *
 * It answers an empty query too — with nothing typed, the palette's preview
 * should already show what a source holds rather than an empty Extensions
 * heading — and the per-group cap is what keeps that preview short.
 */
export function createExtensionsProvider(deps: ExtensionsProviderDeps): PaletteResultProvider {
  const api = deps.api ?? window.api
  let catalogue: ExtensionsCatalogue | null = null
  // Rows are rebuilt only when the inventory behind them changes — which is
  // once, when `workspaceSkillsList` lands — rather than on every keystroke.
  let cachedFor: ReadonlySet<string> | null = null
  let rows: ExtensionRow[] = []

  return {
    id: 'extensions',
    group: 'extensions',
    respondsToEmptyQuery: true,
    warm: async () => {
      catalogue = await loadExtensionsCatalogue(api)
    },
    load: (query) => {
      // Still warming: no rows rather than a stale list. The runner asks again
      // when the warm settles.
      if (!catalogue) return []
      const installedDirNames = deps.getInstalledDirNames()
      if (cachedFor !== installedDirNames) {
        rows = buildExtensionRows(catalogue, installedDirNames)
        cachedFor = installedDirNames
      }
      return selectExtensionCommands(rows, query, { ...deps, limit: deps.getLimit?.() })
    },
  }
}
