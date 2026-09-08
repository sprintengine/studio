#!/usr/bin/env node
// The sources seed gate (test:sources), the third of check-model-feed-seed.mjs
// and check-card-feed-seed.mjs.
//
// `resources/sources.json` is the recommended-sources list a fresh install
// offers before it has ever reached GitHub (MC-2519, owner ruling 2026-09-08):
// the studio stopped shipping other people's plugins and MCP servers, and
// points at places to get them instead. Every row in it is a one-click Add in
// the Extensions door, so a malformed or duplicated row is not a row that looks
// odd — it is an Add that either does not appear or cannot work.
//
// What this asserts:
//   - resources/sources.json parses under the SHIPPED parser
//     (src/shared/hosted-sources-feed.ts), which already enforces the schema
//     version, the `owner/name` repo shape, the `kind` vocabulary, unique ids
//     and unique repositories;
//   - at least one row, so the seed is not an empty offer;
//   - `anthropics/claude-plugins-official` is present. It is the first place to
//     look for a plugin and it is already an always-present source on every
//     machine, so it must be in the list the studio recommends — and the
//     de-duplication in `recommendedSourcesToAdd` is what stops it being
//     offered as an Add that does nothing;
//   - every always-present source that IS recommended de-duplicates against the
//     real `ALWAYS_PRESENT_SKILL_SOURCES` ids, so the seed can never offer an
//     Add for a source the store already holds and refuses to remove.
//
// **What this gate does NOT check, said here so nobody inherits the wrong
// comfort:** it reads `resources/sources.json` and only that. Whether each
// repository exists, is public, is unarchived and really carries
// `.claude-plugin/marketplace.json` is checked where the file is authored —
// `scripts/check-sources.mjs` in sprintengine/studio-releases, on every pull
// request touching it. This gate protects the installer; that one protects the
// hosted file. Neither reaches the network from here: a build must not fail
// because GitHub was slow.
//
// The parser and the always-present ids are the real ones, bundled out of the
// app's own modules with esbuild rather than re-typed here — a second copy of
// either would drift the day somebody edited one, and drift is what a gate is
// for.
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const seedPath = join(root, 'resources', 'sources.json')
const errors = []

const OFFICIAL_PLUGINS_REPO = 'anthropics/claude-plugins-official'

async function shipped(relative, name) {
  const outfile = join(root, 'node_modules', '.cache', 'multicode', `check-sources-seed.${name}.mjs`)
  await build({
    entryPoints: [join(root, ...relative)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  })
  return import(pathToFileURL(outfile).href)
}

const { parseHostedSourcesFeed, hostedSourceId, recommendedSourcesToAdd } = await shipped(
  ['src', 'shared', 'hosted-sources-feed.ts'],
  'parser',
)
// The two sources every machine already has, from the store's own list.
const { ALWAYS_PRESENT_SKILL_SOURCE_IDS } = await shipped(['src', 'shared', 'skills.ts'], 'skills')

let body
try {
  body = readFileSync(seedPath, 'utf8')
} catch (error) {
  console.error(`resources/sources.json is missing or unreadable: ${error.message}`)
  process.exit(1)
}

const parsed = parseHostedSourcesFeed(body)
if (!parsed.ok) {
  console.error(`resources/sources.json is not a feed this build reads: ${parsed.message}`)
  process.exit(1)
}

const { sources } = parsed.feed
if (sources.length === 0) errors.push('the seed recommends no sources at all')

if (!sources.some((source) => source.repo.toLowerCase() === OFFICIAL_PLUGINS_REPO.toLowerCase())) {
  errors.push(
    `${OFFICIAL_PLUGINS_REPO} is not in the list; it is the first place to look for a plugin and the ruling puts it first`,
  )
}

// Every recommendation that names a source the app already ships must fall out
// of the offer. If one did not, the door would show an Add for a source the
// store holds and refuses to remove — a button whose only outcome is a failure.
const offered = recommendedSourcesToAdd(parsed.feed, ALWAYS_PRESENT_SKILL_SOURCE_IDS)
for (const alwaysPresent of ALWAYS_PRESENT_SKILL_SOURCE_IDS) {
  if (offered.some((source) => hostedSourceId(source.repo).toLowerCase() === alwaysPresent.toLowerCase())) {
    errors.push(`${alwaysPresent} is offered as an Add, but the app already ships it and the store refuses to remove it`)
  }
}

if (errors.length) {
  console.error(`sources seed: ${errors.length} problem(s)`)
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}
console.log(
  `sources seed ok: ${sources.length} sources, ${offered.length} offered on a fresh install, updated ${parsed.feed.updatedAt}`,
)
