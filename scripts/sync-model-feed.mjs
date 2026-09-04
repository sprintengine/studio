#!/usr/bin/env node
// Refresh the bundled model feed seed (resources/model-feed.json) from the live
// file in sprintengine/studio-releases, or from a local path.
//
//   npm run sync:model-feed                 fetch the live feed
//   npm run sync:model-feed -- --from path  copy a local file instead
//
// Run before cutting a release so the seed a fresh install boots with matches
// what every other machine is already polling. test:model-feed then checks the
// seed against the plugin manifests.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FEED_URL = 'https://raw.githubusercontent.com/sprintengine/studio-releases/main/model-feed.json'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'resources', 'model-feed.json')

const fromIndex = process.argv.indexOf('--from')
let body
if (fromIndex !== -1) {
  const from = process.argv[fromIndex + 1]
  if (!from) {
    console.error('--from needs a path')
    process.exit(1)
  }
  body = await readFile(resolve(from), 'utf8')
} else {
  const response = await fetch(FEED_URL, { headers: { accept: 'application/json' } })
  if (!response.ok) {
    console.error(`GitHub answered HTTP ${response.status} for ${FEED_URL}`)
    process.exit(1)
  }
  body = await response.text()
}

let parsed
try {
  parsed = JSON.parse(body)
} catch (error) {
  console.error(`The feed is not valid JSON: ${error.message}`)
  process.exit(1)
}
if (parsed.schemaVersion !== 1 || typeof parsed.updatedAt !== 'string' || typeof parsed.clis !== 'object') {
  console.error('The feed does not have the shape this build reads (schemaVersion 1, updatedAt, clis).')
  process.exit(1)
}
await writeFile(target, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
const total = Object.values(parsed.clis).reduce((n, cli) => n + (cli.models?.length ?? 0), 0)
console.log(`resources/model-feed.json: ${Object.keys(parsed.clis).length} CLIs, ${total} models, updated ${parsed.updatedAt}`)
