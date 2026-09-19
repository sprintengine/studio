// Inline-CLI seed entries: the bundled agent CLI plugins under
// resources/plugins/ projected into marketplace.json `cli` registry entries.
//
// The entries are GENERATED from the plugin manifests so the two cannot drift:
// `npm run catalogue:cli-entries` rewrites the seed's inline-CLI section (and
// the reviewable icon marks under icons/<id>.svg), and
// `npx vitest run resources/marketplace/cli-entries.test.ts` regenerates from the manifests and
// fails the build unless the committed seed is byte-identical. Entry fields
// come from each plugin.json (`summary`/`category`/`icon` were added there for
// exactly this purpose) — this module never invents copy.
//
// An inline-CLI entry ships no bundle: the referenced plugin already lives in
// the app bundle, and its install action is the plugin's `install` spec
// executed by the CLI runtime installer (src/main/cli-runtime-install.ts) —
// never PluginDetailPanel's download-a-bundle flow. Third-party CLI plugins
// keep using signed bundle entries (`source` + components.cli), installed by
// src/main/modules/plugin-bundle-installer.ts into the user plugin root.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { MarketplacePluginEntry } from '../../src/shared/marketplace'

// The one publisher allowed on generated inline-CLI entries. `verified: true`
// without a signature is legal for this shape only — see the inline-CLI lane
// in verify-marketplace.ts for the rule and its reasoning.
export const INLINE_CLI_PUBLISHER = { name: 'SprintEngine Labs', verified: true } as const

// Marketplace entry id for a bundled plugin id. Mirrors pluginRegistryIdForCli
// (src/renderer/src/components/workspace/newWorkspace/cliRuntimeOptions.ts) —
// identity today, but the seed test asserts parity with the real function so a
// future mapping change over there fails the build here instead of silently
// splitting the two id spaces.
export function marketplaceIdForBundledPlugin(pluginId: string): string {
  return pluginId
}

export type CliSeedBuild = {
  entries: MarketplacePluginEntry[]
  // Reviewable icon bytes per entry id, committed at icons/<id>.svg. The entry
  // `icon` is the base64 data URI of the same bytes (the automation-starter
  // convention: a data URI renders offline, the committed mark keeps it
  // reviewable, and verify-marketplace asserts the two match).
  marks: Map<string, Buffer>
}

type BundledPluginManifest = {
  id: string
  displayName: string
  version: number
  summary: string
  category: string
  icon: string
}

function requireManifestString(manifest: Record<string, unknown>, field: string, manifestPath: string): string {
  const value = manifest[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${manifestPath}: "${field}" is required (a non-empty string) to generate the plugin's marketplace entry.`)
  }
  return value.trim()
}

function readBundledPluginManifest(pluginsRoot: string, dirName: string): BundledPluginManifest {
  const manifestPath = join(pluginsRoot, dirName, 'plugin.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  const id = requireManifestString(manifest, 'id', manifestPath)
  if (id !== dirName) {
    throw new Error(`${manifestPath}: plugin id "${id}" does not match its containing directory "${dirName}".`)
  }
  if (typeof manifest.version !== 'number' || !Number.isInteger(manifest.version) || manifest.version < 1) {
    throw new Error(`${manifestPath}: "version" must be a positive integer.`)
  }
  return {
    id,
    displayName: requireManifestString(manifest, 'displayName', manifestPath),
    version: manifest.version,
    summary: requireManifestString(manifest, 'summary', manifestPath),
    category: requireManifestString(manifest, 'category', manifestPath),
    icon: requireManifestString(manifest, 'icon', manifestPath),
  }
}

export function buildCliSeedEntries(repoRoot: string): CliSeedBuild {
  const pluginsRoot = join(repoRoot, 'resources', 'plugins')
  const entries: MarketplacePluginEntry[] = []
  const marks = new Map<string, Buffer>()
  const dirs = readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory() && existsSync(join(pluginsRoot, dirent.name, 'plugin.json')))
    .map((dirent) => dirent.name)
    .sort()
  for (const dirName of dirs) {
    const manifest = readBundledPluginManifest(pluginsRoot, dirName)
    const iconPath = join(pluginsRoot, dirName, manifest.icon)
    if (!existsSync(iconPath)) {
      throw new Error(`resources/plugins/${dirName}: icon "${manifest.icon}" does not exist.`)
    }
    const iconBytes = readFileSync(iconPath)
    const entryId = marketplaceIdForBundledPlugin(manifest.id)
    marks.set(entryId, iconBytes)
    entries.push({
      id: entryId,
      name: manifest.displayName,
      publisher: { ...INLINE_CLI_PUBLISHER },
      summary: manifest.summary,
      category: manifest.category,
      icon: `data:image/svg+xml;base64,${iconBytes.toString('base64')}`,
      latest: manifest.version,
      provides: ['cli'],
      cli: { pluginId: manifest.id },
    })
  }
  return { entries, marks }
}

// Rewrite the seed index's inline-CLI section: existing inline-CLI entries are
// replaced wholesale, everything else rides through byte-verbatim, and the
// generated entries land at the end (after the carried repo-authored entries,
// matching generate-connector-catalogue.mjs's projection-then-carried order).
export function spliceCliSeedEntries(indexSource: string, entries: MarketplacePluginEntry[]): string {
  const index = JSON.parse(indexSource) as { plugins: Array<Record<string, unknown>> }
  const kept = index.plugins.filter((plugin) => plugin.cli === undefined)
  return `${JSON.stringify({ ...index, plugins: [...kept, ...entries] }, null, 2)}\n`
}
