import { existsSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'

import type { LoadedPlugin, PluginManifest } from '../shared/plugin-manifest'
import {
  createPluginRegistry,
  defaultUserPluginRoot,
  type PluginRegistry,
  type PluginRegistryLoadReport,
} from './plugin-registry'

// Lazy require so this module can be imported in node-only test bundles
// that never reach the `ensureRegistry()` call. The electron `app` module
// throws on import in plain node.
function loadElectron(): typeof import('electron') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron')
}

// Lazy-initialized singleton plugin registry for the main process. The launch
// path needs synchronous access to plugin manifests; this module loads them
// once on first use from the appropriate bundled-resource location.

let registry: PluginRegistry | null = null
let lastReport: PluginRegistryLoadReport | null = null

export function resolveBundledPluginRoot(): string {
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
  registry = createPluginRegistry({
    bundledRoot: resolveBundledPluginRoot(),
    userRoot: defaultUserPluginRoot(),
  })
  lastReport = registry.loadSync()
  return registry
}

export function getPluginRegistry(): PluginRegistry {
  return ensureRegistry()
}

export function getPluginById(id: string): LoadedPlugin | undefined {
  return ensureRegistry().get(id)
}

export function getPluginManifest(id: string): PluginManifest | undefined {
  return ensureRegistry().get(id)?.manifest
}

export function getLastPluginRegistryReport(): PluginRegistryLoadReport | null {
  ensureRegistry()
  return lastReport
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
export function __setPluginRegistryForTest(custom: PluginRegistry, report: PluginRegistryLoadReport): void {
  registry = custom
  lastReport = report
}

export function __resetPluginRegistryForTest(): void {
  registry = null
  lastReport = null
}

function isPathInsideOrEqual(parentPath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(targetPath))
  return (
    relativePath === ''
    || (!relativePath.startsWith('..') && !isAbsolute(relativePath) && !relativePath.split(sep).includes('..'))
  )
}
