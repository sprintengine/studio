import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
import { validateMarketplaceIndex } from '../../shared/marketplace'
import { installMarketplacePlugin, type MarketplacePluginInstallerServices } from '../modules/plugin-bundle-installer'
import { defaultUserModuleRoot, moduleInstallPath } from '../modules/user-module-registry'
import { getPluginRegistryUserRoot, reloadPluginRegistry } from '../plugin-registry-instance'
import { defaultMarketplacePluginStagingRoot, downloadMarketplacePluginBundle, type MarketplacePluginDownloadFetch } from './plugin-download'

export const MARKETPLACE_PLUGIN_INSTALLS_FILENAME = 'marketplace-plugin-installs.json'

export type MarketplacePluginInstallReceipt = {
  id: string
  displayName: string
  version: number
  sourceUrl: string
  classification: 'verified' | 'community'
  installedAt: string
  components: MarketplacePluginInstalledComponent[]
}

type MarketplacePluginInstallStore = {
  schemaVersion: 1
  plugins: Record<string, MarketplacePluginInstallReceipt>
}

export type MarketplacePluginLifecycleServices = MarketplacePluginInstallerServices & {
  receiptStorePath: string
  stagingRoot?: string
  fetcher?: MarketplacePluginDownloadFetch
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

  const store = await readInstallStore(services.receiptStorePath)
  const previous = store.plugins[entry.entry.id]

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

  if (download.classification === 'community' && input.trustGranted !== true) {
    await rm(download.stagedBundlePath, { recursive: true, force: true })
    return {
      ok: false,
      sourceUrl: download.sourceUrl,
      classification: download.classification,
      trust: download.trust.status,
      loadEligible: download.loadEligible,
      updated: Boolean(previous),
      message: 'Community marketplace plugin requires trust approval before install.',
      issues: [{ path: 'signature', message: 'Grant trust in the marketplace trust gate before installing this plugin.' }],
    }
  }

  const installClassification: 'verified' | 'community' = download.classification === 'verified' ? 'verified' : 'community'
  let nextMcpSettings = input.mcpSettings
  if (previous) {
    const removed = await uninstallReceipt(previous, { ...input, pluginId: previous.id, mcpSettings: nextMcpSettings }, services)
    if (!removed.ok) {
      await rm(download.stagedBundlePath, { recursive: true, force: true })
      return { ...removed, updated: true }
    }
    nextMcpSettings = removed.mcpSettings ?? nextMcpSettings
    delete store.plugins[previous.id]
    await writeInstallStore(services.receiptStorePath, store)
  }

  try {
    const installInput: MarketplacePluginInstallInput = {
      localFolder: download.stagedBundlePath,
      workspaceRoot: input.workspaceRoot,
      mcpSettings: nextMcpSettings,
      mcpClients: input.mcpClients,
      skillHarnesses: input.skillHarnesses,
    }
    const installed = await installMarketplacePlugin(installInput, services)
    if (!installed.ok) {
      return {
        ...installed,
        sourceUrl: download.sourceUrl,
        classification: download.classification,
        updated: Boolean(previous),
      }
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
    store.plugins[receipt.id] = receipt
    await writeInstallStore(services.receiptStorePath, store)

    return {
      ...installed,
      sourceUrl: download.sourceUrl,
      classification: installClassification,
      updated: Boolean(previous),
    }
  } finally {
    await rm(download.stagedBundlePath, { recursive: true, force: true })
  }
}

export async function uninstallMarketplacePlugin(
  input: MarketplacePluginUninstallInput,
  services: MarketplacePluginLifecycleServices
): Promise<MarketplacePluginUninstallResult> {
  const pluginId = input.pluginId?.trim()
  if (!pluginId) return { ok: false, message: 'Plugin id is required.' }

  const store = await readInstallStore(services.receiptStorePath)
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
          await removeSkillComponent(component, input, services)
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
  input: MarketplacePluginUninstallInput,
  services: MarketplacePluginLifecycleServices
): Promise<void> {
  const workspaceRoot = input.workspaceRoot?.trim()
  if (!workspaceRoot) throw new Error('Workspace root is required to uninstall skill components.')
  const result = await services.skillPackService.remove({
    workspaceRoot,
    slug: component.installedDirName ?? component.id,
    installedDirName: component.installedDirName ?? component.id,
    harnesses: component.harnesses?.length ? component.harnesses : input.skillHarnesses,
  })
  if (!result.ok && !/No installed copies/.test(result.message)) throw new Error(result.message)
}

function clientsFromServers(servers: McpServerConfig[]): McpClientTarget[] {
  const clients = servers.flatMap((server) => server.clients)
  return clients.length ? Array.from(new Set(clients)) : ['codex', 'claude-code']
}

function validateRegistryEntry(
  entry: MarketplacePluginEntry
): { ok: true; entry: MarketplacePluginEntry } | { ok: false; message: string; issues?: Array<{ path: string; message: string }> } {
  const result = validateMarketplaceIndex({ schemaVersion: 1, plugins: [entry] })
  if (!result.ok) return { ok: false, message: 'Marketplace plugin registry entry is invalid.', issues: result.issues }
  return { ok: true, entry: result.marketplace.plugins[0] }
}

async function readInstallStore(path: string): Promise<MarketplacePluginInstallStore> {
  try {
    const payload = JSON.parse(await readFile(path, 'utf8')) as MarketplacePluginInstallStore
    if (payload?.schemaVersion === 1 && payload.plugins && typeof payload.plugins === 'object') {
      return { schemaVersion: 1, plugins: payload.plugins }
    }
  } catch {
    // Missing or malformed receipt stores are treated as empty; installs rewrite
    // a valid store before claiming success.
  }
  return { schemaVersion: 1, plugins: {} }
}

async function writeInstallStore(path: string, store: MarketplacePluginInstallStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}
