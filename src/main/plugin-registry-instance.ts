import { existsSync } from 'fs'
import { join, resolve } from 'path'

import type {
  ConversationProviderListEntry,
  LoadedConversationProvider,
  LoadedPlugin,
  PluginManifest,
  PluginRegistryListEntry,
} from '../shared/plugin-manifest'
import {
  createPluginRegistry,
  defaultUserPluginRoot,
  type PluginRegistry,
  type PluginRegistryOptions,
  type PluginRegistryLoadReport,
} from './plugin-registry'
import { readTrustedModulesSync } from './modules/trust-store'
import { isPathInsideOrEqual } from './path-containment'

// Lazy require so this module can be imported in node-only test bundles
// that never reach the `ensureRegistry()` call. The electron `app` module
// throws on import in plain node.
function loadElectron(): typeof import('electron') {
  return require('electron')
}

// Lazy-initialized singleton plugin registry for the main process. The launch
// path needs synchronous access to plugin manifests; this module loads them
// once on first use from the appropriate bundled-resource location.

let registry: PluginRegistry | null = null
let lastReport: PluginRegistryLoadReport | null = null
let configuredUserRoot: string | null = null

function resolveBundledPluginRoot(): string {
  const electron = loadElectron()
  if (electron.app.isPackaged) {
    const packaged = join(process.resourcesPath, 'plugins')
    if (existsSync(packaged)) return packaged
  }

  const candidates = [
    join(process.cwd(), 'resources', 'plugins'),
    join(electron.app.getAppPath(), 'resources', 'plugins'),
    join(__dirname, '..', '..', 'resources', 'plugins'),
    join(__dirname, '..', '..', '..', 'resources', 'plugins'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]
}

function ensureRegistry(): PluginRegistry {
  if (registry) return registry
  const userRoot = defaultUserPluginRoot()
  registry = createPluginRegistry(
    createAppPluginRegistryOptions(loadElectron().app.getPath('userData'), resolveBundledPluginRoot(), userRoot)
  )
  configuredUserRoot = userRoot
  lastReport = registry.loadSync()
  return registry
}

export function createAppPluginRegistryOptions(
  userDataDir: string,
  bundledRoot: string = resolveBundledPluginRoot(),
  userRoot: string = defaultUserPluginRoot()
): PluginRegistryOptions {
  return {
    bundledRoot,
    userRoot,
    providerTrustContext: {
      trustedModules: readTrustedModulesSync(userDataDir),
    },
  }
}

export function getPluginRegistry(): PluginRegistry {
  return ensureRegistry()
}

/**
 * Re-scan the bundled and user plugin roots so a plugin installed (or removed)
 * while the app is running is reflected without a restart. Used by the
 * `plugins:install-folder` / `plugins:reload` IPC after a drop-in change.
 */
export function reloadPluginRegistry(): PluginRegistryLoadReport {
  const reg = ensureRegistry()
  lastReport = reg.loadSync()
  return lastReport
}

export function getPluginById(id: string): LoadedPlugin | undefined {
  return ensureRegistry().get(id)
}

export function getPluginManifest(id: string): PluginManifest | undefined {
  return ensureRegistry().get(id)?.manifest
}

export function listPluginRegistryEntries(): PluginRegistryListEntry[] {
  return ensureRegistry().list()
}

export function listConversationProviderRegistryEntries(): ConversationProviderListEntry[] {
  return ensureRegistry().listConversationProviders()
}

export function getConversationProviderById(id: string): LoadedConversationProvider | undefined {
  return ensureRegistry().getConversationProvider(id)
}

export function getPluginRegistryUserRoot(): string {
  ensureRegistry()
  return configuredUserRoot ?? defaultUserPluginRoot()
}

export type PluginSprintEngineRegistryRoot = {
  id: string
  root: string
}

export function getPluginSprintEngineRegistryRoots(): PluginSprintEngineRegistryRoot[] {
  return ensureRegistry().loaded().flatMap((plugin): PluginSprintEngineRegistryRoot[] => {
    const soulsDirectory = plugin.manifest.souls?.directory
    if (!soulsDirectory) return []
    const root = resolve(plugin.pluginRoot, soulsDirectory)
    if (!isPathInsideOrEqual(plugin.pluginRoot, root)) return []
    return [{ id: plugin.manifest.id, root }]
  })
}

// Test-only: lets unit tests substitute a registry built from a fixture root.
export function __setPluginRegistryForTest(custom: PluginRegistry, report: PluginRegistryLoadReport, userRoot?: string): void {
  registry = custom
  lastReport = report
  configuredUserRoot = userRoot ?? defaultUserPluginRoot()
}

export function __resetPluginRegistryForTest(): void {
  registry = null
  lastReport = null
  configuredUserRoot = null
}
