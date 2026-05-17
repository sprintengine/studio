import { readFile, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'

import type {
  LoadedPlugin,
  PluginManifest,
  PluginManifestValidationIssue,
  PluginManifestValidationResult,
  PluginRegistryListEntry,
} from '../shared/plugin-manifest'

import { validateManifestStructure } from './plugin-manifest-validate'

export type PluginRegistryOptions = {
  bundledRoot: string
  userRoot?: string
}

export type PluginRegistry = {
  load: () => Promise<PluginRegistryLoadReport>
  list: () => PluginRegistryListEntry[]
  get: (id: string) => LoadedPlugin | undefined
  validateManifestSource: (source: string) => PluginManifestValidationResult
}

export type PluginRegistryLoadReport = {
  loaded: LoadedPlugin[]
  rejected: Array<{
    source: 'bundled' | 'user'
    manifestPath: string
    issues: PluginManifestValidationIssue[]
  }>
}

export function defaultUserPluginRoot(): string {
  return join(homedir(), '.multicode', 'plugins')
}

export function createPluginRegistry(options: PluginRegistryOptions): PluginRegistry {
  const plugins = new Map<string, LoadedPlugin>()

  async function loadFromRoot(
    root: string,
    source: 'bundled' | 'user'
  ): Promise<PluginRegistryLoadReport> {
    const loaded: LoadedPlugin[] = []
    const rejected: PluginRegistryLoadReport['rejected'] = []

    if (!existsSync(root)) return { loaded, rejected }

    let entries: string[] = []
    try {
      entries = await readdir(root)
    } catch {
      return { loaded, rejected }
    }

    for (const entry of entries) {
      const pluginRoot = join(root, entry)
      try {
        const entryStat = await stat(pluginRoot)
        if (!entryStat.isDirectory()) continue
      } catch {
        continue
      }

      const manifestPath = join(pluginRoot, 'plugin.json')
      if (!existsSync(manifestPath)) continue

      let raw: string
      try {
        raw = await readFile(manifestPath, 'utf-8')
      } catch (err) {
        rejected.push({
          source,
          manifestPath,
          issues: [{ path: '', message: `Could not read plugin.json: ${formatError(err)}` }],
        })
        continue
      }

      const result = validateManifestSource(raw)
      if (!result.ok) {
        rejected.push({ source, manifestPath, issues: result.issues })
        continue
      }

      if (result.manifest.id !== entry) {
        rejected.push({
          source,
          manifestPath,
          issues: [
            {
              path: 'id',
              message: `Plugin id "${result.manifest.id}" does not match its containing directory "${entry}".`,
            },
          ],
        })
        continue
      }

      loaded.push({
        manifest: result.manifest,
        source,
        manifestPath,
        pluginRoot,
      })
    }

    return { loaded, rejected }
  }

  return {
    async load(): Promise<PluginRegistryLoadReport> {
      plugins.clear()

      const bundledRoot = resolveRoot(options.bundledRoot)
      const userRoot = resolveRoot(options.userRoot ?? defaultUserPluginRoot())

      const bundled = await loadFromRoot(bundledRoot, 'bundled')
      const user = await loadFromRoot(userRoot, 'user')

      const report: PluginRegistryLoadReport = {
        loaded: [],
        rejected: [...bundled.rejected, ...user.rejected],
      }

      // User plugins override bundled plugins of the same id.
      for (const plugin of bundled.loaded) {
        plugins.set(plugin.manifest.id, plugin)
        report.loaded.push(plugin)
      }
      for (const plugin of user.loaded) {
        const previous = plugins.get(plugin.manifest.id)
        if (previous) {
          const replacedIndex = report.loaded.findIndex((p) => p.manifest.id === plugin.manifest.id)
          if (replacedIndex >= 0) report.loaded.splice(replacedIndex, 1)
        }
        plugins.set(plugin.manifest.id, plugin)
        report.loaded.push(plugin)
      }

      return report
    },

    list(): PluginRegistryListEntry[] {
      return Array.from(plugins.values()).map((p) => ({
        id: p.manifest.id,
        displayName: p.manifest.displayName,
        source: p.source,
        version: p.manifest.version,
        binary: p.manifest.binary,
      }))
    },

    get(id: string): LoadedPlugin | undefined {
      return plugins.get(id)
    },

    validateManifestSource,
  }
}

export function validateManifestSource(source: string): PluginManifestValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (err) {
    return {
      ok: false,
      issues: [{ path: '', message: `plugin.json is not valid JSON: ${formatError(err)}` }],
    }
  }
  return validateManifestStructure(parsed)
}

function resolveRoot(root: string): string {
  if (isAbsolute(root)) return root
  return resolve(process.cwd(), root)
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function manifestToListEntry(plugin: LoadedPlugin): PluginRegistryListEntry {
  return {
    id: plugin.manifest.id,
    displayName: plugin.manifest.displayName,
    source: plugin.source,
    version: plugin.manifest.version,
    binary: plugin.manifest.binary,
  }
}

export type { PluginManifest, LoadedPlugin }
