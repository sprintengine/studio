// Regenerates the inline-CLI section of the bundled marketplace seed.
//
//   npm run catalogue:cli-entries
//
// Reads every resources/plugins/<id>/plugin.json, projects it into an
// inline-CLI marketplace entry (see cli-entries.ts), and rewrites:
//   resources/marketplace/marketplace.json   inline-CLI entries replaced
//   resources/marketplace/icons/<id>.svg     reviewable mark per entry
//
// Runs when a bundled plugin manifest changes — app builds and CI never run
// it; the committed output is reviewed like any other diff, and
// `node scripts/testing/run-tests.mjs resources/marketplace/cli-entries.test.ts` fails the build when the committed
// seed drifts from the manifests. Like catalogue:generate, ALWAYS run the
// app-schema gates on the output before committing:
//   npm run verify:marketplace-registry && node scripts/testing/run-tests.mjs resources/marketplace/cli-entries.test.ts

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { buildCliSeedEntries, spliceCliSeedEntries } from './cli-entries'

const repoRoot = resolve(process.cwd())
const marketplaceRoot = join(repoRoot, 'resources', 'marketplace')
const marketplacePath = join(marketplaceRoot, 'marketplace.json')

const { entries, marks } = buildCliSeedEntries(repoRoot)
const before = readFileSync(marketplacePath, 'utf8')
const replaced = (JSON.parse(before) as { plugins: Array<Record<string, unknown>> }).plugins
  .filter((plugin) => plugin.cli !== undefined).length

writeFileSync(marketplacePath, spliceCliSeedEntries(before, entries), 'utf8')
for (const [entryId, bytes] of marks) {
  writeFileSync(join(marketplaceRoot, 'icons', `${entryId}.svg`), bytes)
}

console.log(
  `marketplace.json: ${entries.length} inline-CLI entries generated from resources/plugins (${replaced} replaced); ` +
  `${marks.size} icon marks written under resources/marketplace/icons`
)
