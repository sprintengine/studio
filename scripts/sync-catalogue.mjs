#!/usr/bin/env node
// Refresh the bundled catalogue seed from the live files in
// sprintengine/studio-releases, the same way sync-model-feed refreshes the
// model feed (backlog/2026-09-05-plugin-sources.md, "Hosting").
//
//   npm run sync:catalogue                 fetch the live index and skills
//   npm run sync:catalogue -- --from dir   copy from a local checkout instead
//
// Pulls into resources/:
//   marketplace.json  -> resources/marketplace/marketplace.json  (the index)
//   mcps/catalog.json -> resources/mcps/catalog.json             (launchable servers)
//   skills/<id>/      -> resources/skills/<id>/                  (Multicode's own skills)
//
// The signed first-party bundles under plugins/ and the icons are NOT pulled:
// they are published FROM this repo's resources/marketplace to the releases
// repo, and their bytes are what the committed signatures cover. Run before
// cutting a release so a fresh install boots with the index every other
// machine is already polling; then run the app's own gates on the result:
//   npm run verify:marketplace-registry && npm run test:main:mcp-catalog
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAW_ROOT = 'https://raw.githubusercontent.com/sprintengine/studio-releases/main'
const API_TREE = 'https://api.github.com/repos/sprintengine/studio-releases/git/trees/main?recursive=1'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const fromIndex = process.argv.indexOf('--from')
const from = fromIndex !== -1 ? resolve(process.argv[fromIndex + 1] ?? '') : null
if (fromIndex !== -1 && !process.argv[fromIndex + 1]) {
  console.error('--from needs a path')
  process.exit(1)
}

async function readText(relative) {
  if (from) return readFile(join(from, relative), 'utf8')
  const response = await fetch(`${RAW_ROOT}/${relative}`, { headers: { accept: '*/*' } })
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} for ${relative}`)
  return response.text()
}

async function listSkillFiles() {
  if (from) {
    const files = []
    const walk = async (dir, prefix) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(join(dir, entry.name), rel)
        else files.push(`skills/${rel}`)
      }
    }
    await walk(join(from, 'skills'), '')
    return files
  }
  const response = await fetch(API_TREE, { headers: { accept: 'application/vnd.github+json' } })
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} for the tree listing`)
  const body = await response.json()
  if (body.truncated) throw new Error('The releases repo tree is truncated; sync from a local checkout with --from.')
  return body.tree.filter((entry) => entry.type === 'blob' && entry.path.startsWith('skills/')).map((entry) => entry.path)
}

// 1. The index. Parsed before it is written so a broken file never lands.
const index = await readText('marketplace.json')
const parsedIndex = JSON.parse(index)
if (parsedIndex.schemaVersion !== 1 || !Array.isArray(parsedIndex.plugins)) {
  console.error('marketplace.json does not have the shape this build reads (schemaVersion 1, plugins[]).')
  process.exit(1)
}
await writeFile(join(root, 'resources', 'marketplace', 'marketplace.json'), `${JSON.stringify(parsedIndex, null, 2)}\n`)
console.log(`resources/marketplace/marketplace.json: ${parsedIndex.plugins.length} plugins`)

// 2. The launchable server catalogue.
const catalog = await readText('mcps/catalog.json')
const parsedCatalog = JSON.parse(catalog)
if (!Array.isArray(parsedCatalog.servers)) {
  console.error('mcps/catalog.json has no servers array.')
  process.exit(1)
}
await writeFile(join(root, 'resources', 'mcps', 'catalog.json'), `${JSON.stringify(parsedCatalog, null, 2)}\n`)
console.log(`resources/mcps/catalog.json: ${parsedCatalog.servers.length} servers`)

// 3. Multicode's own skills: the whole directory, replaced as one.
const files = await listSkillFiles()
const staging = join(root, 'node_modules', '.cache', 'multicode', 'sync-catalogue-skills')
await rm(staging, { recursive: true, force: true })
for (const path of files) {
  const target = join(staging, path.slice('skills/'.length))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, await readText(path))
}
const skillsDir = join(root, 'resources', 'skills')
await rm(skillsDir, { recursive: true, force: true })
await cp(staging, skillsDir, { recursive: true })
const skillIds = (await readdir(skillsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
console.log(`resources/skills: ${skillIds.length} skills (${skillIds.join(', ')})`)
