import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  MarketplacePluginInstallInput,
  MarketplacePluginInstalledComponent,
  MarketplacePluginRegistryInstallInput,
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginUninstallInput,
  MarketplacePluginUninstallResult,
  McpClientTarget,
  McpServerConfig,
  McpSettings,
} from '../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../shared/marketplace'
import { isClaudeCodePluginEntry, validateMarketplaceIndex } from '../../shared/marketplace'
import type { SkillHarness } from '../../shared/electron-api'
import { SKILL_HARNESS_DIR, SKILL_PACK_HARNESSES } from '../../shared/skill-harnesses'
import { uninstallSkill } from '../skills/install'
import { installMarketplacePlugin, type MarketplacePluginInstallerServices } from '../modules/plugin-bundle-installer'
import { normalizeMcpClients, normalizeMcpServerConfig } from '../mcp-config-service'
import { defaultUserModuleRoot, moduleInstallPath } from '../modules/user-module-registry'
import { getPluginRegistryUserRoot, reloadPluginRegistry } from '../plugin-registry-instance'
import {
  defaultMarketplacePluginStagingRoot,
  downloadClaudeCodePluginSource,
  downloadMarketplacePluginBundle,
  type MarketplaceInstallLog,
  type MarketplacePluginDownloadFetch,
} from './plugin-download'
import type { MarketplaceResourceResolver } from './resources'

export const MARKETPLACE_PLUGIN_INSTALLS_FILENAME = 'marketplace-plugin-installs.json'
const RECEIPT_COMPONENT_KINDS = new Set(['mcp', 'skills', 'module', 'cli', 'automation'])

export type MarketplacePluginInstallReceipt = {
  id: string
  displayName: string
  version: number
  sourceUrl: string
  classification: 'verified' | 'community' | 'unsigned'
  installedAt: string
  components: MarketplacePluginInstalledComponent[]
}

type MarketplacePluginInstallStore = {
  schemaVersion: 1
  plugins: Record<string, MarketplacePluginInstallReceipt>
}

type FilesystemComponentBackup = {
  originalPath: string
  backupPath: string
  existed: boolean
}

type PreviousInstallSnapshot = {
  filesystem: FilesystemComponentBackup[]
  mcpSettings?: McpSettings
}

export type MarketplacePluginLifecycleServices = MarketplacePluginInstallerServices & {
  receiptStorePath: string
  stagingRoot?: string
  fetcher?: MarketplacePluginDownloadFetch
  /**
   * Harness dirs a Claude-plugin skill install fans out to when the caller
   * passes no explicit `skillHarnesses` (see resolveInstalledSkillHarnesses).
   * Absent, installs fall back to Claude-only.
   */
  resolveSkillHarnesses?: () => Promise<SkillHarness[]>
  /** Test seam for packaged resource resolution (bundled claude-plugin skills). */
  packagedResourceResolver?: MarketplaceResourceResolver
  log?: MarketplaceInstallLog
}

export function defaultMarketplacePluginInstallStorePath(userDataDir: string): string {
  return join(userDataDir, MARKETPLACE_PLUGIN_INSTALLS_FILENAME)
}

export function createMarketplacePluginLifecycleService(services: MarketplacePluginLifecycleServices) {
  return {
    installFromRegistry: (input: MarketplacePluginRegistryInstallInput): Promise<MarketplacePluginRegistryInstallResult> =>
      installOrUpdateMarketplacePlugin(input, services),
    updateFromRegistry: (input: MarketplacePluginRegistryInstallInput): Promise<MarketplacePluginRegistryInstallResult> =>
      installOrUpdateMarketplacePlugin(input, services),
    uninstall: (input: MarketplacePluginUninstallInput): Promise<MarketplacePluginUninstallResult> =>
      uninstallMarketplacePlugin(input, services),
  }
}

export async function installOrUpdateMarketplacePlugin(
  input: MarketplacePluginRegistryInstallInput,
  services: MarketplacePluginLifecycleServices
): Promise<MarketplacePluginRegistryInstallResult> {
  const entry = validateRegistryEntry(input.entry)
  if (!entry.ok) return { ok: false, message: entry.message, issues: entry.issues }

  const storeResult = await loadInstallStore(services.receiptStorePath)
  if (!storeResult.ok) return { ok: false, message: storeResult.message }
  const store = storeResult.store
  const previous = store.plugins[entry.entry.id]

  // Inline-MCP entries carry server configs directly (no bundle to download).
  // Route them through the MCP config sync behind the same trust gate.
  if (entry.entry.mcp) {
    return installInlineMcpEntry(entry.entry, input, services, store, previous)
  }

  // Claude Code plugins are not Multicode bundles: their content is Claude's
  // plugin format, so they route through the claude-plugin adapter (skills
  // copied into workspace harness dirs) behind the same unsigned trust gate.
  if (isClaudeCodePluginEntry(entry.entry)) {
    return installClaudeCodePluginEntry(entry.entry, input, services, store, previous)
  }

  const download = await downloadMarketplacePluginBundle({
    entry: entry.entry,
    trustContext: services.trustContext(),
    stagingRoot: services.stagingRoot ?? defaultMarketplacePluginStagingRoot(dirname(services.receiptStorePath)),
    fetcher: services.fetcher,
  })

  if (!download.ok) {
    return {
      ok: false,
      message: download.message,
      sourceUrl: download.sourceUrl,
      classification: download.classification,
      trust: download.trust?.status,
      loadEligible: false,
      issues: download.issues,
      updated: Boolean(previous),
    }
  }

  // Community (signed, unverified publisher) and unsigned (mcp/skills-only)
  // bundles both require the server-side trust grant before install. Unsigned
  // code-bearing bundles never reach here: download hard-blocks them.
  if (
    (download.classification === 'community' || download.classification === 'unsigned') &&
    input.trustGranted !== true
  ) {
    await rm(download.stagedBundlePath, { recursive: true, force: true })
    return {
      ok: false,
      sourceUrl: download.sourceUrl,
      classification: download.classification,
      trust: download.trust.status,
      loadEligible: download.loadEligible,
      updated: Boolean(previous),
      message: download.classification === 'unsigned'
        ? 'Unsigned marketplace plugin requires trust approval before install.'
        : 'Community marketplace plugin requires trust approval before install.',
      issues: [{ path: 'signature', message: 'Grant trust in the marketplace trust gate before installing this plugin.' }],
    }
  }

  const installClassification: 'verified' | 'community' | 'unsigned' =
    download.classification === 'verified'
      ? 'verified'
      : download.classification === 'unsigned'
        ? 'unsigned'
        : 'community'
  const backupRoot = join(dirname(download.stagedBundlePath), `${entry.entry.id}-previous-${Date.now()}`)
  try {
    const previousSnapshot = previous
      ? await createPreviousInstallSnapshot(previous, input, services, backupRoot)
      : { ok: true as const, snapshot: undefined }
    if (!previousSnapshot.ok) {
      return {
        ok: false,
        message: `Could not snapshot previous marketplace plugin install: ${previousSnapshot.message}`,
        sourceUrl: download.sourceUrl,
        classification: installClassification,
        trust: download.trust.status,
        loadEligible: download.loadEligible,
        updated: true,
      }
    }

    const installInput: MarketplacePluginInstallInput = {
      localFolder: download.stagedBundlePath,
      workspaceRoot: input.workspaceRoot,
      mcpSettings: input.mcpSettings,
      mcpClients: input.mcpClients,
      skillHarnesses: input.skillHarnesses,
      ...(input.automationDefaultCli ? { automationDefaultCli: input.automationDefaultCli } : {}),
    }
    const installed = await installMarketplacePlugin(installInput, services)
    if (!installed.ok) {
      const rollback = await rollbackInstalledComponents(
        entry.entry.id,
        installed.installed ?? [],
        input,
        services,
        input.mcpSettings
      )
      const restored = previousSnapshot.snapshot
        ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot, input, services)
        : { ok: true as const }
      return appendRestoreFailure(appendRollbackFailure({
        ...installed,
        sourceUrl: download.sourceUrl,
        classification: download.classification,
        updated: Boolean(previous),
      }, rollback), restored)
    }

    const receipt: MarketplacePluginInstallReceipt = {
      id: installed.id,
      displayName: installed.displayName,
      version: installed.version,
      sourceUrl: download.sourceUrl,
      classification: installClassification,
      installedAt: new Date().toISOString(),
      components: installed.installed,
    }
    let finalMcpSettings = installed.mcpSettings ?? input.mcpSettings
    if (previous) {
      const staleComponents = componentsWithoutOverlap(previous.components, receipt.components)
      if (staleComponents.length > 0) {
        const removed = await uninstallReceipt(
          { ...previous, components: staleComponents },
          { ...input, pluginId: previous.id, mcpSettings: finalMcpSettings },
          services
        )
        if (!removed.ok) {
          const rollback = await rollbackInstalledComponents(
            receipt.id,
            componentsWithoutOverlap(receipt.components, previous.components),
            { ...input, mcpSettings: finalMcpSettings },
            services,
            finalMcpSettings
          )
          const restored = previousSnapshot.snapshot
            ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot, input, services)
            : { ok: true as const }
          return appendRestoreFailure(appendRollbackFailure({
            ok: false,
            message: `Could not remove previous marketplace plugin components: ${removed.message}`,
            sourceUrl: download.sourceUrl,
            classification: installClassification,
            trust: installed.trust,
            loadEligible: installed.loadEligible,
            installed: receipt.components,
            updated: true,
          }, rollback), restored)
        }
        finalMcpSettings = removed.mcpSettings ?? finalMcpSettings
      }
    }

    store.plugins[receipt.id] = receipt
    try {
      await writeInstallStore(services.receiptStorePath, store)
    } catch (error) {
      const rollback = await rollbackInstalledComponents(receipt.id, receipt.components, input, services, finalMcpSettings)
      const restored = previousSnapshot.snapshot
        ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot, input, services)
        : { ok: true as const }
      return appendRestoreFailure(appendRollbackFailure({
        ok: false,
        message: `Could not write marketplace plugin install receipt: ${formatError(error)}`,
        sourceUrl: download.sourceUrl,
        classification: installClassification,
        trust: installed.trust,
        loadEligible: installed.loadEligible,
        installed: receipt.components,
        updated: Boolean(previous),
      }, rollback), restored)
    }

    return {
      ...installed,
      ...(finalMcpSettings ? { mcpSettings: finalMcpSettings } : {}),
      sourceUrl: download.sourceUrl,
      classification: installClassification,
      updated: Boolean(previous),
    }
  } finally {
    await rm(download.stagedBundlePath, { recursive: true, force: true })
    await rm(backupRoot, { recursive: true, force: true })
  }
}

// Install an inline-MCP registry entry: the servers ship in the entry itself,
// so there is no bundle to download, verify, or sign. Because MCP config is
// code-execution config written to agent CLIs, this NEVER installs without the
// server-side trust grant, and is recorded with an honest 'unsigned' receipt.
async function installInlineMcpEntry(
  entry: MarketplacePluginEntry,
  input: MarketplacePluginRegistryInstallInput,
  services: MarketplacePluginLifecycleServices,
  store: MarketplacePluginInstallStore,
  previous: MarketplacePluginInstallReceipt | undefined
): Promise<MarketplacePluginRegistryInstallResult> {
  const updated = Boolean(previous)
  if (input.trustGranted !== true) {
    return {
      ok: false,
      sourceUrl: '',
      classification: 'unsigned',
      trust: 'unsigned',
      loadEligible: false,
      updated,
      message: 'Inline MCP marketplace entry requires trust approval before install.',
      issues: [{ path: 'mcp', message: 'Grant trust in the marketplace trust gate before installing this MCP server.' }],
    }
  }

  const workspaceRoot = input.workspaceRoot?.trim()
  if (!workspaceRoot) {
    return { ok: false, sourceUrl: '', classification: 'unsigned', updated, message: 'Workspace root is required to install inline MCP marketplace entries.' }
  }

  const servers: McpServerConfig[] = []
  for (const raw of entry.mcp?.servers ?? []) {
    const normalized = normalizeMcpServerConfig(raw, {
      enabled: true,
      scope: 'workspace',
      source: 'custom',
      clients: input.mcpClients?.length ? input.mcpClients : undefined,
    })
    if (!normalized) {
      return {
        ok: false,
        sourceUrl: '',
        classification: 'unsigned',
        updated,
        message: 'Inline MCP marketplace entry contains an invalid server configuration.',
        issues: [{ path: 'mcp.servers', message: 'MCP server did not normalize through the app MCP parser.' }],
      }
    }
    servers.push(normalized)
  }
  if (servers.length === 0) {
    return { ok: false, sourceUrl: '', classification: 'unsigned', updated, message: 'Inline MCP marketplace entry declares no servers.' }
  }

  const backupRoot = join(dirname(services.receiptStorePath), `${entry.id}-inline-previous-${Date.now()}`)
  try {
    const previousSnapshot = previous
      ? await createPreviousInstallSnapshot(previous, input, services, backupRoot)
      : { ok: true as const, snapshot: undefined }
    if (!previousSnapshot.ok) {
      return { ok: false, sourceUrl: '', classification: 'unsigned', updated, message: `Could not snapshot previous marketplace plugin install: ${previousSnapshot.message}` }
    }

    const nextSettings: McpSettings = {
      syncEnabled: true,
      servers: {
        ...(input.mcpSettings?.servers ?? {}),
        ...Object.fromEntries(servers.map((server) => [server.id, server])),
      },
    }
    const clients = normalizeMcpClients(input.mcpClients?.length ? input.mcpClients : servers.flatMap((server) => server.clients))
    const sync = services.mcpConfigService.sync({ workspaceRoot, settings: nextSettings, clients, write: true })
    if (!sync.ok) {
      const restored = previousSnapshot.snapshot
        ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot, input, services)
        : { ok: true as const }
      const issues = mcpSyncIssuesToMarketplaceIssues(sync.issues)
      return appendRestoreFailure({
        ok: false,
        sourceUrl: '',
        classification: 'unsigned',
        updated,
        message: sync.message,
        ...(issues ? { issues } : {}),
      }, restored)
    }

    const receipt: MarketplacePluginInstallReceipt = {
      id: entry.id,
      displayName: entry.name,
      version: entry.latest,
      sourceUrl: '',
      classification: 'unsigned',
      installedAt: new Date().toISOString(),
      components: [installedInlineMcpComponent(servers)],
    }

    let finalMcpSettings = nextSettings
    if (previous) {
      const stale = componentsWithoutOverlap(previous.components, receipt.components)
      if (stale.length > 0) {
        const removed = await uninstallReceipt(
          { ...previous, components: stale },
          { ...input, pluginId: previous.id, mcpSettings: finalMcpSettings },
          services
        )
        if (!removed.ok) {
          const rollback = await rollbackInstalledComponents(receipt.id, receipt.components, { ...input, mcpSettings: finalMcpSettings }, services, finalMcpSettings)
          const restored = previousSnapshot.snapshot
            ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot, input, services)
            : { ok: true as const }
          return appendRestoreFailure(appendRollbackFailure({
            ok: false,
            sourceUrl: '',
            classification: 'unsigned',
            trust: 'unsigned',
            loadEligible: false,
            installed: receipt.components,
            updated: true,
            message: `Could not remove previous marketplace plugin components: ${removed.message}`,
          }, rollback), restored)
        }
        finalMcpSettings = removed.mcpSettings ?? finalMcpSettings
      }
    }

    store.plugins[receipt.id] = receipt
    try {
      await writeInstallStore(services.receiptStorePath, store)
    } catch (error) {
      const rollback = await rollbackInstalledComponents(receipt.id, receipt.components, input, services, finalMcpSettings)
      const restored = previousSnapshot.snapshot
        ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot, input, services)
        : { ok: true as const }
      return appendRestoreFailure(appendRollbackFailure({
        ok: false,
        sourceUrl: '',
        classification: 'unsigned',
        trust: 'unsigned',
        loadEligible: false,
        installed: receipt.components,
        updated,
        message: `Could not write marketplace plugin install receipt: ${formatError(error)}`,
      }, rollback), restored)
    }

    return {
      ok: true,
      id: receipt.id,
      displayName: receipt.displayName,
      version: receipt.version,
      trust: 'unsigned',
      loadEligible: false,
      installed: receipt.components,
      mcpSettings: finalMcpSettings,
      sourceUrl: '',
      classification: 'unsigned',
      updated,
    }
  } finally {
    await rm(backupRoot, { recursive: true, force: true })
  }
}

// Claude Code plugins install by copying each staged `skills/<dir>` into the
// workspace's harness skill dirs — the same surface the driving-skill install
// uses, so the skills appear in the workspace inventory and skill pickers.
// SKILL.md content is harness-portable, so the default target set is resolved
// via services.resolveSkillHarnesses (shared `.agents` + every installed CLI
// with native skill support); input.skillHarnesses overrides, and this
// Claude-only constant is the last-resort fallback when no resolver is wired.
// Commands/agents in the plugin are not installed — skills are the one
// component Multicode delivers.
const DEFAULT_CLAUDE_PLUGIN_HARNESSES: SkillHarness[] = ['claude']

function previousHarnesses(previous: MarketplacePluginInstallReceipt | undefined): SkillHarness[] {
  const harnesses = new Set<SkillHarness>()
  for (const component of previous?.components ?? []) {
    if (component.kind !== 'skills') continue
    for (const harness of component.harnesses ?? []) harnesses.add(harness)
  }
  return [...harnesses]
}

async function resolveInstallHarnesses(
  input: MarketplacePluginRegistryInstallInput,
  services: MarketplacePluginLifecycleServices,
  previous: MarketplacePluginInstallReceipt | undefined
): Promise<SkillHarness[]> {
  // An explicit caller set is authoritative — a deliberate narrowing may
  // legitimately drop harness copies (the stale sweep handles it).
  if (input.skillHarnesses?.length) return input.skillHarnesses

  let resolved = DEFAULT_CLAUDE_PLUGIN_HARNESSES
  if (services.resolveSkillHarnesses) {
    // A resolver failure or empty set must not turn the install into a
    // silent no-op writing nowhere — fall back to the Claude-only default.
    try {
      const set = await services.resolveSkillHarnesses()
      if (set.length > 0) resolved = set
    } catch {
      // fall through to the default
    }
  }
  // Auto-resolution must never REMOVE a harness a previous install owned: a
  // transient CLI-probe hiccup (or resolver error) would otherwise narrow the
  // set and make the stale sweep permanently delete still-wanted skill copies
  // from CLIs that are actually still installed. Union with the prior set so
  // an auto-resolved update is only ever additive; a genuinely-removed CLI
  // keeps its harmless copy until an explicit skillHarnesses narrows it.
  const union = new Set<SkillHarness>([...resolved, ...previousHarnesses(previous)])
  return SKILL_PACK_HARNESSES.filter((harness) => union.has(harness))
}

async function installClaudeCodePluginEntry(
  entry: MarketplacePluginEntry,
  input: MarketplacePluginRegistryInstallInput,
  services: MarketplacePluginLifecycleServices,
  store: MarketplacePluginInstallStore,
  previous: MarketplacePluginInstallReceipt | undefined
): Promise<MarketplacePluginRegistryInstallResult> {
  const updated = Boolean(previous)
  const sourceUrl = entry.source?.trim() ?? ''
  if (input.trustGranted !== true) {
    return {
      ok: false,
      sourceUrl,
      classification: 'unsigned',
      trust: 'unsigned',
      loadEligible: false,
      updated,
      message: 'Claude Code plugin requires trust approval before install.',
      issues: [{ path: 'source', message: 'Grant trust in the marketplace trust gate before installing this plugin.' }],
    }
  }
  const workspaceRoot = input.workspaceRoot?.trim()
  if (!workspaceRoot) {
    return { ok: false, sourceUrl, classification: 'unsigned', updated, message: 'Workspace root is required to install Claude Code plugin skills.' }
  }

  services.log?.('claude-plugin:install-start', { entryId: entry.id })
  const download = await downloadClaudeCodePluginSource({
    entry,
    stagingRoot: services.stagingRoot ?? defaultMarketplacePluginStagingRoot(dirname(services.receiptStorePath)),
    packagedResourceResolver: services.packagedResourceResolver,
    log: services.log,
    // Install exactly what the trust prompt disclosed when the verify pin is
    // present; otherwise the staging computes the content identity itself.
    ...(input.claudePluginRef ? { refOverride: input.claudePluginRef } : {}),
  })
  if (!download.ok) {
    services.log?.('claude-plugin:install-failed', { entryId: entry.id, message: download.message })
    return {
      ok: false,
      sourceUrl: download.sourceUrl,
      classification: 'unsigned',
      updated,
      message: download.message,
      issues: [{ path: 'source', message: download.message }],
    }
  }

  const harnesses = await resolveInstallHarnesses(input, services, previous)
  // Ownership is per dir AND per harness: a previous install owning "foo" in
  // .claude says nothing about a hand-authored .agents/skills/foo.
  const previousHarnessesByDir = new Map<string, Set<SkillHarness>>()
  for (const component of previous?.components ?? []) {
    if (component.kind !== 'skills') continue
    const dir = component.installedDirName ?? component.id
    const owned = previousHarnessesByDir.get(dir) ?? new Set<SkillHarness>()
    for (const harness of component.harnesses ?? []) owned.add(harness)
    previousHarnessesByDir.set(dir, owned)
  }

  const backupRoot = join(dirname(services.receiptStorePath), `${entry.id}-claude-previous-${Date.now()}`)
  try {
    // Pre-flight: never silently clobber a skill dir this plugin does not own
    // (a hand-dropped custom skill or another pack sharing the name) — checked
    // per harness, so widening the harness set cannot skip the check.
    for (const dir of download.skillDirs) {
      for (const harness of harnesses) {
        if (previousHarnessesByDir.get(dir)?.has(harness)) continue
        const target = join(workspaceRoot, SKILL_HARNESS_DIR[harness], 'skills', dir)
        if (await pathExists(target)) {
          return {
            ok: false,
            sourceUrl,
            classification: 'unsigned',
            updated,
            message: `A skill folder named "${dir}" already exists in ${SKILL_HARNESS_DIR[harness]}/skills and is not owned by this plugin. Remove or rename it, then install again.`,
          }
        }
      }
    }

    const previousSnapshot = previous
      ? await createPreviousInstallSnapshot(previous, input, services, backupRoot)
      : { ok: true as const, snapshot: undefined }
    if (!previousSnapshot.ok) {
      return { ok: false, sourceUrl, classification: 'unsigned', updated, message: `Could not snapshot previous marketplace plugin install: ${previousSnapshot.message}` }
    }

    const components: MarketplacePluginInstalledComponent[] = []
    for (const dir of download.skillDirs) {
      // Count each harness BEFORE its copy starts so a mid-copy failure still
      // rolls back the partially written target — an untracked partial dir
      // would otherwise survive as an orphan the next install refuses over.
      const attempted: SkillHarness[] = []
      try {
        for (const harness of harnesses) {
          attempted.push(harness)
          const target = join(workspaceRoot, SKILL_HARNESS_DIR[harness], 'skills', dir)
          await mkdir(dirname(target), { recursive: true })
          await cp(join(download.stagedPath, 'skills', dir), target, { recursive: true, force: true })
        }
      } catch (error) {
        services.log?.('claude-plugin:copy-failed', { entryId: entry.id, skill: dir, message: formatError(error) })
        const partial: MarketplacePluginInstalledComponent = {
          kind: 'skills',
          id: dir,
          installedDirName: dir,
          harnesses: attempted,
          message: 'Partial copy rolled back.',
        }
        const rollback = await rollbackInstalledComponents(entry.id, [...components, partial], input, services, input.mcpSettings)
        const restored = previousSnapshot.snapshot
          ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot, input, services)
          : { ok: true as const }
        return appendRestoreFailure(appendRollbackFailure({
          ok: false,
          sourceUrl,
          classification: 'unsigned',
          trust: 'unsigned',
          loadEligible: false,
          installed: components,
          updated,
          message: `Could not copy plugin skill "${dir}": ${formatError(error)}`,
        }, rollback), restored)
      }
      components.push({
        kind: 'skills',
        id: dir,
        installedDirName: dir,
        harnesses,
        message: `Installed for ${harnesses.join(', ')}.`,
      })
    }

    const receipt: MarketplacePluginInstallReceipt = {
      id: entry.id,
      displayName: entry.name,
      version: entry.latest,
      sourceUrl,
      classification: 'unsigned',
      installedAt: new Date().toISOString(),
      components,
    }

    if (previous) {
      // Stale = previous skill dirs the new install no longer ships, PLUS —
      // because componentsOverlap keys skills on dir name only — the harness
      // copies a still-shipped dir no longer targets (else a harness change
      // would strand untracked copies forever).
      const staleDirs = componentsWithoutOverlap(previous.components, receipt.components)
      const staleHarnessCopies = (previous.components ?? [])
        .filter((component) => component.kind === 'skills')
        .flatMap((component): MarketplacePluginInstalledComponent[] => {
          const dir = component.installedDirName ?? component.id
          if (!download.skillDirs.includes(dir)) return [] // whole dir already stale above
          const removedHarnesses = (component.harnesses ?? []).filter((harness) => !harnesses.includes(harness))
          return removedHarnesses.length > 0 ? [{ ...component, harnesses: removedHarnesses }] : []
        })
      const stale = [...staleDirs, ...staleHarnessCopies]
      if (stale.length > 0) {
        const removed = await uninstallReceipt(
          { ...previous, components: stale },
          { ...input, pluginId: previous.id },
          services
        )
        if (!removed.ok) {
          const rollback = await rollbackInstalledComponents(receipt.id, receipt.components, input, services, input.mcpSettings)
          const restored = previousSnapshot.snapshot
            ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot, input, services)
            : { ok: true as const }
          return appendRestoreFailure(appendRollbackFailure({
            ok: false,
            sourceUrl,
            classification: 'unsigned',
            trust: 'unsigned',
            loadEligible: false,
            installed: receipt.components,
            updated: true,
            message: `Could not remove previous marketplace plugin components: ${removed.message}`,
          }, rollback), restored)
        }
      }
    }

    store.plugins[receipt.id] = receipt
    try {
      await writeInstallStore(services.receiptStorePath, store)
    } catch (error) {
      const rollback = await rollbackInstalledComponents(receipt.id, receipt.components, input, services, input.mcpSettings)
      const restored = previousSnapshot.snapshot
        ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot, input, services)
        : { ok: true as const }
      return appendRestoreFailure(appendRollbackFailure({
        ok: false,
        sourceUrl,
        classification: 'unsigned',
        trust: 'unsigned',
        loadEligible: false,
        installed: receipt.components,
        updated,
        message: `Could not write marketplace plugin install receipt: ${formatError(error)}`,
      }, rollback), restored)
    }

    services.log?.('claude-plugin:install-ok', {
      entryId: entry.id,
      skills: receipt.components.length,
      harnesses,
      updated,
    })
    const notices =
      download.metadataOnlySkills.length > 0
        ? [
            `${download.metadataOnlySkills.length} skill${download.metadataOnlySkills.length === 1 ? '' : 's'} in this plugin (${download.metadataOnlySkills.join(', ')}) ${download.metadataOnlySkills.length === 1 ? 'ships' : 'ship'} without bundled content and ${download.metadataOnlySkills.length === 1 ? 'was' : 'were'} not installed.`,
          ]
        : []
    return {
      ok: true,
      id: receipt.id,
      displayName: receipt.displayName,
      version: receipt.version,
      trust: 'unsigned',
      loadEligible: false,
      installed: receipt.components,
      ...(notices.length > 0 ? { notices } : {}),
      sourceUrl,
      classification: 'unsigned',
      updated,
    }
  } finally {
    await rm(download.stagedPath, { recursive: true, force: true }).catch(() => undefined)
    await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

function installedInlineMcpComponent(servers: McpServerConfig[]): MarketplacePluginInstalledComponent {
  return {
    kind: 'mcp',
    id: servers.map((server) => server.id).join(','),
    serverIds: servers.map((server) => server.id),
    servers,
    message: `Synced ${servers.length} inline MCP server${servers.length === 1 ? '' : 's'}.`,
  }
}

function mcpSyncIssuesToMarketplaceIssues(
  issues: Array<{ serverId?: string; client?: string; message: string }> | undefined
): Array<{ path: string; message: string }> | undefined {
  if (!issues?.length) return undefined
  return issues.map((issue) => ({
    path: issue.serverId ? `servers.${issue.serverId}` : issue.client ? `clients.${issue.client}` : '',
    message: issue.message,
  }))
}

export async function uninstallMarketplacePlugin(
  input: MarketplacePluginUninstallInput,
  services: MarketplacePluginLifecycleServices
): Promise<MarketplacePluginUninstallResult> {
  const pluginId = input.pluginId?.trim()
  if (!pluginId) return { ok: false, message: 'Plugin id is required.' }

  const storeResult = await loadInstallStore(services.receiptStorePath)
  if (!storeResult.ok) return { ok: false, message: storeResult.message }
  const store = storeResult.store
  const receipt = store.plugins[pluginId]
  if (!receipt) return { ok: false, message: `Marketplace plugin ${pluginId} is not installed.` }

  const result = await uninstallReceipt(receipt, input, services)
  if (!result.ok) return result

  delete store.plugins[pluginId]
  await writeInstallStore(services.receiptStorePath, store)
  return result
}

async function uninstallReceipt(
  receipt: MarketplacePluginInstallReceipt,
  input: MarketplacePluginUninstallInput,
  services: MarketplacePluginLifecycleServices
): Promise<MarketplacePluginUninstallResult> {
  const removed: MarketplacePluginInstalledComponent[] = []
  let nextMcpSettings = input.mcpSettings

  for (const component of [...receipt.components].reverse()) {
    try {
      switch (component.kind) {
        case 'mcp':
          nextMcpSettings = removeMcpComponent(component, input, services, nextMcpSettings)
          break
        case 'skills':
          await removeSkillComponent(component, input)
          break
        case 'module':
          await rm(moduleInstallPath((services.moduleRoot ?? defaultUserModuleRoot)(), component.id), { recursive: true, force: true })
          break
        case 'cli':
          await rm(join((services.pluginRoot ?? getPluginRegistryUserRoot)(), component.id), { recursive: true, force: true })
          {
            const reloadPlugins = services.reloadPlugins ?? reloadPluginRegistry
            reloadPlugins()
          }
          break
        case 'automation':
          // Deliberately left in place (owner ruling): an added automation is
          // the user's from the moment it lands — they name it, edit it, and
          // schedule it against their own repo. Silently deleting a scheduled
          // job because the plugin that shipped its starter went away is worse
          // than leaving a record they can see and remove themselves.
          break
      }
      removed.push(component)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        removed,
        ...(nextMcpSettings ? { mcpSettings: nextMcpSettings } : {}),
      }
    }
  }

  return {
    ok: true,
    id: receipt.id,
    removed,
    ...(nextMcpSettings ? { mcpSettings: nextMcpSettings } : {}),
  }
}

function removeMcpComponent(
  component: MarketplacePluginInstalledComponent,
  input: MarketplacePluginUninstallInput,
  services: MarketplacePluginLifecycleServices,
  currentSettings: McpSettings | undefined
): McpSettings {
  const workspaceRoot = input.workspaceRoot?.trim()
  if (!workspaceRoot) throw new Error('Workspace root is required to uninstall MCP components.')

  const serverIds = component.serverIds?.length ? component.serverIds : component.id.split(',').map((id) => id.trim()).filter(Boolean)
  const currentServers = { ...(currentSettings?.servers ?? {}) }
  const disabledServers: Record<string, McpServerConfig> = {}
  for (const serverId of serverIds) {
    const server = currentServers[serverId] ?? component.servers?.find((candidate) => candidate.id === serverId)
    delete currentServers[serverId]
    if (server) disabledServers[serverId] = { ...server, enabled: false }
  }

  const syncSettings: McpSettings = {
    syncEnabled: currentSettings?.syncEnabled ?? true,
    servers: { ...currentServers, ...disabledServers },
  }
  const clients = input.mcpClients?.length ? input.mcpClients : clientsFromServers(Object.values(disabledServers))
  const result = services.mcpConfigService.sync({
    workspaceRoot,
    settings: syncSettings,
    clients,
    write: true,
  })
  if (!result.ok) throw new Error(result.message)

  return {
    syncEnabled: currentSettings?.syncEnabled ?? true,
    servers: currentServers,
  }
}

async function removeSkillComponent(
  component: MarketplacePluginInstalledComponent,
  input: MarketplacePluginUninstallInput
): Promise<void> {
  const workspaceRoot = input.workspaceRoot?.trim()
  if (!workspaceRoot) throw new Error('Workspace root is required to uninstall skill components.')
  const dirName = component.installedDirName ?? component.id
  const result = await uninstallSkill({
    workspaceRoot,
    dirName,
    // The receipt names the harnesses the install wrote; without one, every
    // harness dir is swept rather than guessing which held a copy.
    harnesses: component.harnesses?.length
      ? component.harnesses
      : input.skillHarnesses?.length
        ? input.skillHarnesses
        : SKILL_PACK_HARNESSES,
  })
  // Already gone is the state uninstall wants, so an empty sweep is fine here;
  // only a real failure is one.
  if (!result.ok) throw new Error(result.message)
}

function clientsFromServers(servers: McpServerConfig[]): McpClientTarget[] {
  const clients = servers.flatMap((server) => server.clients)
  return clients.length ? Array.from(new Set(clients)) : ['codex', 'claude-code']
}

async function createPreviousInstallSnapshot(
  receipt: MarketplacePluginInstallReceipt,
  input: MarketplacePluginRegistryInstallInput,
  services: MarketplacePluginLifecycleServices,
  backupRoot: string
): Promise<{ ok: true; snapshot: PreviousInstallSnapshot } | { ok: false; message: string }> {
  try {
    const filesystem: FilesystemComponentBackup[] = []
    for (const originalPath of filesystemComponentPaths(receipt.components, input, services)) {
      const backupPath = join(backupRoot, String(filesystem.length))
      const existed = await pathExists(originalPath)
      if (existed) {
        await mkdir(dirname(backupPath), { recursive: true })
        await cp(originalPath, backupPath, { recursive: true, force: true })
      }
      filesystem.push({ originalPath, backupPath, existed })
    }
    return {
      ok: true,
      snapshot: {
        filesystem,
        mcpSettings: previousMcpSettings(receipt.components, input.mcpSettings),
      },
    }
  } catch (error) {
    return { ok: false, message: formatError(error) }
  }
}

async function restorePreviousInstallSnapshot(
  snapshot: PreviousInstallSnapshot,
  input: MarketplacePluginRegistryInstallInput,
  services: MarketplacePluginLifecycleServices
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    for (const backup of [...snapshot.filesystem].reverse()) {
      await rm(backup.originalPath, { recursive: true, force: true })
      if (!backup.existed) continue
      await mkdir(dirname(backup.originalPath), { recursive: true })
      await cp(backup.backupPath, backup.originalPath, { recursive: true, force: true })
    }

    const workspaceRoot = input.workspaceRoot?.trim()
    if (snapshot.mcpSettings && workspaceRoot) {
      const servers = Object.values(snapshot.mcpSettings.servers)
      const result = services.mcpConfigService.sync({
        workspaceRoot,
        settings: snapshot.mcpSettings,
        clients: input.mcpClients?.length ? input.mcpClients : clientsFromServers(servers),
        write: true,
      })
      if (!result.ok) return { ok: false, message: result.message }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, message: formatError(error) }
  }
}

function filesystemComponentPaths(
  components: MarketplacePluginInstalledComponent[],
  input: MarketplacePluginRegistryInstallInput,
  services: MarketplacePluginLifecycleServices
): string[] {
  const paths: string[] = []
  for (const component of components) {
    switch (component.kind) {
      case 'skills':
        paths.push(...skillComponentPaths(component, input))
        break
      case 'module':
        paths.push(moduleInstallPath((services.moduleRoot ?? defaultUserModuleRoot)(), component.id))
        break
      case 'cli':
        paths.push(join((services.pluginRoot ?? getPluginRegistryUserRoot)(), component.id))
        break
      case 'mcp':
      // An automation is a store record, not a path, and an update never
      // rewrites it: the receipt's id keeps pointing at the record the first
      // install created, so there is nothing to snapshot or restore.
      case 'automation':
        break
    }
  }
  return Array.from(new Set(paths))
}

function skillComponentPaths(
  component: MarketplacePluginInstalledComponent,
  input: MarketplacePluginRegistryInstallInput
): string[] {
  const workspaceRoot = input.workspaceRoot?.trim()
  if (!workspaceRoot) return []
  const dirName = component.installedDirName ?? component.id
  const harnesses = component.harnesses?.length ? component.harnesses : input.skillHarnesses?.length ? input.skillHarnesses : ['agents']
  return harnesses.map((harness) => join(workspaceRoot, harness === 'agents' ? '.agents' : `.${harness}`, 'skills', dirName))
}

function previousMcpSettings(
  components: MarketplacePluginInstalledComponent[],
  currentSettings: McpSettings | undefined
): McpSettings | undefined {
  const mcpComponents = components.filter((component) => component.kind === 'mcp')
  if (mcpComponents.length === 0) return undefined
  const servers = { ...(currentSettings?.servers ?? {}) }
  for (const component of mcpComponents) {
    for (const server of component.servers ?? []) {
      servers[server.id] = { ...server, enabled: server.enabled ?? true }
    }
  }
  return {
    syncEnabled: currentSettings?.syncEnabled ?? true,
    servers,
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissingFileError(error)) return false
    throw error
  }
}

async function rollbackInstalledComponents(
  pluginId: string,
  components: MarketplacePluginInstalledComponent[],
  input: Omit<MarketplacePluginUninstallInput, 'pluginId'>,
  services: MarketplacePluginLifecycleServices,
  mcpSettings: McpSettings | undefined
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (components.length === 0) return { ok: true }
  const rollback = await uninstallReceipt(
    {
      id: pluginId,
      displayName: pluginId,
      version: 0,
      sourceUrl: '',
      classification: 'community',
      installedAt: new Date().toISOString(),
      components,
    },
    { ...input, pluginId, mcpSettings },
    services
  )
  if (rollback.ok) return { ok: true }
  return { ok: false, message: rollback.message }
}

function appendRollbackFailure<T extends Extract<MarketplacePluginRegistryInstallResult, { ok: false }>>(
  result: T,
  rollback: { ok: true } | { ok: false; message: string }
): T {
  if (rollback.ok) return result
  return {
    ...result,
    message: `${result.message} Rollback after failed marketplace install also failed: ${rollback.message}`,
  }
}

function appendRestoreFailure<T extends Extract<MarketplacePluginRegistryInstallResult, { ok: false }>>(
  result: T,
  restore: { ok: true } | { ok: false; message: string }
): T {
  if (restore.ok) return result
  return {
    ...result,
    message: `${result.message} Restore of previous marketplace install also failed: ${restore.message}`,
  }
}

function componentsWithoutOverlap(
  source: MarketplacePluginInstalledComponent[],
  keepers: MarketplacePluginInstalledComponent[]
): MarketplacePluginInstalledComponent[] {
  return source.filter((component) => !keepers.some((keeper) => componentsOverlap(component, keeper)))
}

function componentsOverlap(a: MarketplacePluginInstalledComponent, b: MarketplacePluginInstalledComponent): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'mcp') {
    const aServers = componentServerIds(a)
    const bServers = componentServerIds(b)
    return aServers.some((serverId) => bServers.includes(serverId))
  }
  if (a.kind === 'skills') return (a.installedDirName ?? a.id) === (b.installedDirName ?? b.id)
  return a.id === b.id
}

function componentServerIds(component: MarketplacePluginInstalledComponent): string[] {
  return component.serverIds?.length ? component.serverIds : component.id.split(',').map((id) => id.trim()).filter(Boolean)
}

function validateRegistryEntry(
  entry: MarketplacePluginEntry
): { ok: true; entry: MarketplacePluginEntry } | { ok: false; message: string; issues?: Array<{ path: string; message: string }> } {
  const result = validateMarketplaceIndex({ schemaVersion: 1, plugins: [entry] })
  if (!result.ok) return { ok: false, message: 'Marketplace plugin registry entry is invalid.', issues: result.issues }
  return { ok: true, entry: result.marketplace.plugins[0] }
}

async function loadInstallStore(
  path: string
): Promise<{ ok: true; store: MarketplacePluginInstallStore } | { ok: false; message: string }> {
  try {
    return { ok: true, store: validateInstallStore(JSON.parse(await readFile(path, 'utf8'))) }
  } catch (error) {
    if (isMissingFileError(error)) return { ok: true, store: { schemaVersion: 1, plugins: {} } }
    return { ok: false, message: `Marketplace plugin install receipt store is invalid: ${formatError(error)}` }
  }
}

async function writeInstallStore(path: string, store: MarketplacePluginInstallStore): Promise<void> {
  validateInstallStore(store)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

function validateInstallStore(value: unknown): MarketplacePluginInstallStore {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.plugins)) {
    throw new Error('schemaVersion must be 1 and plugins must be an object.')
  }
  const plugins: Record<string, MarketplacePluginInstallReceipt> = {}
  for (const [pluginId, receipt] of Object.entries(value.plugins)) {
    if (!isSafeIdentifier(pluginId)) throw new Error(`plugins.${pluginId}: plugin id is not safe.`)
    plugins[pluginId] = validateReceipt(receipt, `plugins.${pluginId}`)
  }
  return { schemaVersion: 1, plugins }
}

function validateReceipt(value: unknown, path: string): MarketplacePluginInstallReceipt {
  if (!isRecord(value)) throw new Error(`${path}: receipt must be an object.`)
  if (!isSafeIdentifier(value.id)) throw new Error(`${path}.id: id is required and must be a safe identifier.`)
  if (typeof value.displayName !== 'string' || value.displayName.trim().length === 0) {
    throw new Error(`${path}.displayName: displayName is required.`)
  }
  const version = value.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new Error(`${path}.version: version must be a non-negative integer.`)
  }
  if (typeof value.sourceUrl !== 'string') throw new Error(`${path}.sourceUrl: sourceUrl must be a string.`)
  if (value.classification !== 'verified' && value.classification !== 'community' && value.classification !== 'unsigned') {
    throw new Error(`${path}.classification: classification must be verified, community, or unsigned.`)
  }
  if (typeof value.installedAt !== 'string' || value.installedAt.trim().length === 0) {
    throw new Error(`${path}.installedAt: installedAt is required.`)
  }
  if (!Array.isArray(value.components)) throw new Error(`${path}.components: components must be an array.`)
  return {
    id: value.id,
    displayName: value.displayName,
    version,
    sourceUrl: value.sourceUrl,
    classification: value.classification,
    installedAt: value.installedAt,
    components: value.components.map((component, index) => validateReceiptComponent(component, `${path}.components[${index}]`)),
  }
}

function validateReceiptComponent(value: unknown, path: string): MarketplacePluginInstalledComponent {
  if (!isRecord(value)) throw new Error(`${path}: component must be an object.`)
  if (typeof value.kind !== 'string' || !RECEIPT_COMPONENT_KINDS.has(value.kind)) {
    throw new Error(`${path}.kind: unsupported component kind.`)
  }
  if (!isSafeIdentifier(value.id)) throw new Error(`${path}.id: component id must be safe.`)
  const component: MarketplacePluginInstalledComponent = {
    kind: value.kind as MarketplacePluginInstalledComponent['kind'],
    id: value.id,
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
  }
  if (value.installedDirName !== undefined) {
    if (!isSafeIdentifier(value.installedDirName)) throw new Error(`${path}.installedDirName: installed directory name must be safe.`)
    component.installedDirName = value.installedDirName
  }
  if (value.serverIds !== undefined) component.serverIds = validateStringArray(value.serverIds, `${path}.serverIds`, isSafeIdentifier)
  if (value.harnesses !== undefined) component.harnesses = validateStringArray(value.harnesses, `${path}.harnesses`, isSafeIdentifier) as typeof component.harnesses
  if (value.servers !== undefined) {
    if (!Array.isArray(value.servers)) throw new Error(`${path}.servers: servers must be an array.`)
    component.servers = value.servers.map((server, index) => {
      if (!isRecord(server) || !isSafeIdentifier(server.id)) throw new Error(`${path}.servers[${index}].id: server id must be safe.`)
      return server as McpServerConfig
    })
  }
  return component
}

function validateStringArray(value: unknown, path: string, predicate: (entry: unknown) => entry is string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path}: must be an array.`)
  return value.map((entry, index) => {
    if (!predicate(entry)) throw new Error(`${path}[${index}]: value must be a safe string.`)
    return entry
  })
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    !value.includes('\0') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
