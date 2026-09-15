#!/usr/bin/env node
// Refresh the bundled `workflow-roles` seed from sprintengine/studio-releases,
// the same way sync-model-feed refreshes the model feed.
//
//   npm run sync:catalogue                 fetch the live plugin
//   npm run sync:catalogue -- --from dir   copy from a local checkout instead
//
// Pulls:
//   workflow-roles/  -> resources/studio-plugin/workflow-roles/
//   and upserts that plugin's listing into
//   resources/studio-plugin/.claude-plugin/marketplace.json
//
// Does not pull:
//   sprintengine-studio/   authored here, published there; pulling it back
//                          would overwrite the template this build materialises
//   studio-skills/         retired from the published manifest (MC-2491);
//                          never re-added
//   marketplace.json       the signed index; this directory is the source of
//                          truth and publishes outward (MC-2519)
//
// Run before cutting a release so a fresh install's SprintEngine Studio tab
// lists the pack every other machine is already polling. Then run:
//   node scripts/testing/run-tests.mjs workflow-roles sync-catalogue studio-plugin
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAW_ROOT = 'https://raw.githubusercontent.com/sprintengine/studio-releases/main'
const API_TREE = 'https://api.github.com/repos/sprintengine/studio-releases/git/trees/main?recursive=1'
const PLUGIN_ID = 'workflow-roles'
const PLUGIN_PREFIX = `${PLUGIN_ID}/`
const STUDIO_PLUGIN_ID = 'sprintengine-studio'

const fromIndex = process.argv.indexOf('--from')
const from = fromIndex !== -1 ? resolve(process.argv[fromIndex + 1] ?? '') : null
if (fromIndex !== -1 && !process.argv[fromIndex + 1]) {
  console.error('--from needs a path')
  process.exit(1)
}

const rootIndex = process.argv.indexOf('--root')
const root =
  rootIndex !== -1
    ? resolve(process.argv[rootIndex + 1] ?? '')
    : resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (rootIndex !== -1 && !process.argv[rootIndex + 1]) {
  console.error('--root needs a path')
  process.exit(1)
}

async function readText(relative) {
  if (from) return readFile(join(from, relative), 'utf8')
  const response = await fetch(`${RAW_ROOT}/${relative}`, { headers: { accept: '*/*' } })
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} for ${relative}`)
  return response.text()
}

async function listPluginFiles() {
  if (from) {
    const files = []
    const walk = async (dir, prefix) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(join(dir, entry.name), rel)
        else files.push(`${PLUGIN_PREFIX}${rel}`)
      }
    }
    await walk(join(from, PLUGIN_ID), '')
    return files
  }
  const response = await fetch(API_TREE, { headers: { accept: 'application/vnd.github+json' } })
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} for the tree listing`)
  const body = await response.json()
  if (body.truncated) throw new Error('The releases repo tree is truncated; sync from a local checkout with --from.')
  return body.tree
    .filter((entry) => entry.type === 'blob' && entry.path.startsWith(PLUGIN_PREFIX))
    .map((entry) => entry.path)
}

const claudeManifest = JSON.parse(await readText('.claude-plugin/marketplace.json'))
if (typeof claudeManifest.name !== 'string' || !Array.isArray(claudeManifest.plugins)) {
  console.error('.claude-plugin/marketplace.json does not have the shape a Claude marketplace has (name, plugins[]).')
  process.exit(1)
}
if (claudeManifest.plugins[0]?.name !== STUDIO_PLUGIN_ID) {
  console.error('The Claude marketplace must list sprintengine-studio first; the catalogues show it as the first row.')
  process.exit(1)
}
const publishedEntry = claudeManifest.plugins.find((plugin) => plugin.name === PLUGIN_ID)
if (!publishedEntry) {
  console.error(`The published marketplace does not list ${PLUGIN_ID}; nothing to seed.`)
  process.exit(1)
}
if (typeof publishedEntry.version !== 'string' || publishedEntry.version === '') {
  console.error(`The published ${PLUGIN_ID} entry declares no version.`)
  process.exit(1)
}

const files = await listPluginFiles()
if (files.length === 0) {
  console.error(`The published ${PLUGIN_ID} plugin has no files.`)
  process.exit(1)
}

const staging = join(root, 'node_modules', '.cache', 'multicode', 'sync-catalogue-workflow-roles')
await rm(staging, { recursive: true, force: true })
for (const path of files) {
  const target = join(staging, path.slice(PLUGIN_PREFIX.length))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, await readText(path))
}

const pluginDir = join(root, 'resources', 'studio-plugin', PLUGIN_ID)
await rm(pluginDir, { recursive: true, force: true })
await cp(staging, pluginDir, { recursive: true })

const localManifestPath = join(root, 'resources', 'studio-plugin', '.claude-plugin', 'marketplace.json')
const localManifest = JSON.parse(await readFile(localManifestPath, 'utf8'))
if (!Array.isArray(localManifest.plugins)) {
  console.error(`${localManifestPath} has no plugins array.`)
  process.exit(1)
}
const nextEntry = {
  name: PLUGIN_ID,
  source: `./${PLUGIN_ID}`,
  description:
    typeof publishedEntry.description === 'string' && publishedEntry.description !== ''
      ? publishedEntry.description
      : localManifest.plugins.find((plugin) => plugin.name === PLUGIN_ID)?.description ?? '',
  version: publishedEntry.version,
}
const existingIndex = localManifest.plugins.findIndex((plugin) => plugin.name === PLUGIN_ID)
if (existingIndex === -1) localManifest.plugins.push(nextEntry)
else localManifest.plugins[existingIndex] = { ...localManifest.plugins[existingIndex], ...nextEntry }
// Other local entries — including `studio-skills`, which the published
// manifest has already dropped — are left as they are. This script never
// re-adds a retired plugin and never rewrites sprintengine-studio's listing.
await writeFile(localManifestPath, `${JSON.stringify(localManifest, null, 2)}\n`)

const skillIds = (await readdir(join(pluginDir, 'skills'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
console.log(
  `resources/studio-plugin/${PLUGIN_ID}: ${skillIds.length} skills (${skillIds.join(', ')}), version ${publishedEntry.version}`,
)
console.log(
  `resources/studio-plugin/.claude-plugin/marketplace.json: ${localManifest.plugins.map((plugin) => plugin.name).join(', ')}`,
)
