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
import { validateMarketplaceIndex } from '../../shared/marketplace'
import { installMarketplacePlugin, type MarketplacePluginInstallerServices } from '../modules/plugin-bundle-installer'
import { defaultUserModuleRoot, moduleInstallPath } from '../modules/user-module-registry'
import { getPluginRegistryUserRoot, reloadPluginRegistry } from '../plugin-registry-instance'
import { defaultMarketplacePluginStagingRoot, downloadMarketplacePluginBundle, type MarketplacePluginDownloadFetch } from './plugin-download'

export const MARKETPLACE_PLUGIN_INSTALLS_FILENAME = 'marketplace-plugin-installs.json'
const RECEIPT_COMPONENT_KINDS = new Set(['mcp', 'skills', 'module', 'cli'])

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
  if (value.classification !== 'verified' && value.classification !== 'community') {
    throw new Error(`${path}.classification: classification must be verified or community.`)
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
