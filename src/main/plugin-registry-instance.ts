import { existsSync } from 'fs'
import { join } from 'path'

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
import { studioPlatform } from '../server/platform/platform'

// Lazy-initialized singleton plugin registry for the main process. The launch
// path needs synchronous access to plugin manifests; this module loads them
// once on first use from the appropriate bundled-resource location.

let registry: PluginRegistry | null = null
let lastReport: PluginRegistryLoadReport | null = null

// The platform is read when the registry is first wanted, never at import, so
// a test that never reaches `ensureRegistry()` needs no platform.
function resolveBundledPluginRoot(): string {
  const paths = studioPlatform().paths
  const resourcesDir = paths.resourcesDir()
  if (paths.isPackaged() && resourcesDir) {
    const packaged = join(resourcesDir, 'plugins')
    if (existsSync(packaged)) return packaged
  }

  const appRoot = paths.appRoot()
  const candidates = [
    join(process.cwd(), 'resources', 'plugins'),
    ...(appRoot ? [join(appRoot, 'resources', 'plugins')] : []),
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
  registry = createPluginRegistry(
    createAppPluginRegistryOptions(
      studioPlatform().paths.dataDir(),
      resolveBundledPluginRoot(),
      defaultUserPluginRoot(),
    ),
  )
  lastReport = registry.loadSync()
  return registry
}

export function createAppPluginRegistryOptions(
  userDataDir: string,
  bundledRoot: string = resolveBundledPluginRoot(),
  userRoot: string = defaultUserPluginRoot(),
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
 * Re-scan the bundled and user plugin roots so a provider dropped into (or
 * removed from) the user root while the app is running is reflected without a
 * restart.
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

// Test-only: lets unit tests substitute a registry built from a fixture root.
export function __setPluginRegistryForTest(
  custom: PluginRegistry,
  report: PluginRegistryLoadReport,
  _userRoot?: string,
): void {
  registry = custom
  lastReport = report
}

export function __resetPluginRegistryForTest(): void {
  registry = null
  lastReport = null
}
