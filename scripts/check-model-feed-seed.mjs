#!/usr/bin/env node
// The seed gate (test:model-feed): the bundled model feed and the plugin
// manifests must agree, so the manifest stays the offline truth and the feed
// its live twin (epic 1864 decision 1). Fails when
//   - resources/model-feed.json is missing, malformed, or has no updatedAt;
//   - a CLI's non-retired feed ids and its manifest's modelSelection.options
//     ids differ in either direction;
//   - two feed rows share an id;
//   - a non-alias row has no releasedAt (the parser refuses such a feed).
// Fix a failure with `npm run sync:model-feed` and a manifest edit, whichever
// side is behind.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const seedPath = join(root, 'resources', 'model-feed.json')
const pluginsDir = join(root, 'resources', 'plugins')
const errors = []

let feed
try {
  feed = JSON.parse(readFileSync(seedPath, 'utf8'))
} catch (error) {
  console.error(`resources/model-feed.json is missing or not valid JSON: ${error.message}`)
  process.exit(1)
}
if (feed.schemaVersion !== 1) errors.push(`schemaVersion must be 1, got ${JSON.stringify(feed.schemaVersion)}`)
if (typeof feed.updatedAt !== 'string' || Number.isNaN(Date.parse(feed.updatedAt))) errors.push('updatedAt must be an ISO date-time')
if (!feed.clis || typeof feed.clis !== 'object') errors.push('clis must be an object')

const manifests = new Map()
for (const id of readdirSync(pluginsDir)) {
  const manifestPath = join(pluginsDir, id, 'plugin.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifests.set(manifest.id ?? id, manifest)
}

for (const [cli, entry] of Object.entries(feed.clis ?? {})) {
  const rows = Array.isArray(entry?.models) ? entry.models : null
  if (!rows) {
    errors.push(`${cli}.models must be an array`)
    continue
  }
  const seen = new Set()
  for (const row of rows) {
    if (typeof row.id !== 'string' || !row.id.trim()) errors.push(`${cli}: a row has no id`)
    else if (seen.has(row.id)) errors.push(`${cli}: duplicate id "${row.id}"`)
    else seen.add(row.id)
    if (row.alias !== true && (typeof row.releasedAt !== 'string' || Number.isNaN(Date.parse(row.releasedAt)))) {
      errors.push(`${cli}: "${row.id}" has no releasedAt (required on every model except an alias)`)
    }
  }
  const manifest = manifests.get(cli)
  if (!manifest) {
    errors.push(`${cli}: no plugin manifest under resources/plugins`)
    continue
  }
  const manifestIds = new Set((manifest.modelSelection?.options ?? []).map((option) => option.id))
  const liveIds = new Set(rows.filter((row) => row.retired !== true).map((row) => row.id))
  for (const id of manifestIds) if (!liveIds.has(id)) errors.push(`${cli}: manifest lists "${id}" but the feed does not (run npm run sync:model-feed, or add it to the feed)`)
  for (const id of liveIds) if (!manifestIds.has(id)) errors.push(`${cli}: feed lists "${id}" but resources/plugins/${cli}/plugin.json does not (add it to modelSelection.options)`)
}

if (errors.length) {
  console.error(`model feed seed: ${errors.length} problem(s)`)
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}
const total = Object.values(feed.clis).reduce((n, cli) => n + cli.models.length, 0)
console.log(`model feed seed ok: ${Object.keys(feed.clis).length} CLIs, ${total} models, matches the manifests, updated ${feed.updatedAt}`)
