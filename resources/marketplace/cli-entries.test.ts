// Seed-drift gate for the inline-CLI marketplace entries: regenerate
// from the bundled plugin manifests and require the committed seed to be
// byte-identical, so a manifest edit that skips `npm run catalogue:cli-entries`
// fails the build instead of shipping a stale registry.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { buildCliSeedEntries, spliceCliSeedEntries } from './cli-entries'
import { validateMarketplaceIndex } from '../../src/shared/marketplace'
import { pluginRegistryIdForCli } from '../../src/renderer/src/components/workspace/newWorkspace/cliRuntimeOptions'
import { test } from 'vitest'

test("cli-entries", async () => {
const repoRoot = resolve(process.cwd())
const marketplaceRoot = join(repoRoot, 'resources', 'marketplace')
const committedSource = readFileSync(join(marketplaceRoot, 'marketplace.json'), 'utf8')
const { entries, marks } = buildCliSeedEntries(repoRoot)

function testEveryBundledPluginHasAnEntry(): void {
  const pluginDirs = readdirSync(join(repoRoot, 'resources', 'plugins'), { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .sort()
  assert.deepEqual(entries.map((entry) => entry.cli?.pluginId), pluginDirs)
  assert.ok(entries.length >= 12, `expected the 12 bundled plugins, got ${entries.length}`)
  for (const entry of entries) {
    assert.deepEqual(entry.provides, ['cli'], `${entry.id} must provide exactly ['cli']`)
    assert.equal(entry.source, undefined, `${entry.id} is inline — it must carry no bundle source`)
  }
}

function testCommittedSeedIsByteIdentical(): void {
  assert.equal(
    spliceCliSeedEntries(committedSource, entries),
    committedSource,
    'resources/marketplace/marketplace.json drifted from the plugin manifests — run `npm run catalogue:cli-entries` and commit the diff.'
  )
}

function testCommittedIconMarksMatch(): void {
  for (const [entryId, bytes] of marks) {
    const committed = readFileSync(join(marketplaceRoot, 'icons', `${entryId}.svg`))
    assert.ok(
      committed.equals(bytes),
      `icons/${entryId}.svg drifted from resources/plugins — run \`npm run catalogue:cli-entries\` and commit the diff.`
    )
  }
}

function testSeedValidatesThroughAppSchema(): void {
  // validateMarketplaceIndex runs every entry through the SDK module-manifest
  // id probe, so this also proves the generated ids are valid module ids.
  const result = validateMarketplaceIndex(JSON.parse(committedSource))
  assert.equal(result.ok, true, `seed must validate: ${JSON.stringify(!result.ok ? result.issues.slice(0, 5) : [])}`)
  if (result.ok) {
    const inlineCli = result.marketplace.plugins.filter((plugin) => plugin.cli !== undefined)
    assert.equal(inlineCli.length, entries.length)
  }
}

function testEntryIdsFollowThePluginRegistryMapping(): void {
  // The trap in the item: entry ids come from pluginRegistryIdForCli, never
  // assumed equal to the plugin folder id. The generator mirrors that mapping;
  // this assertion is what turns a future mapping change into a build failure.
  for (const entry of entries) {
    assert.ok(entry.cli, `${entry.id} must carry an inline cli block`)
    assert.equal(entry.id, pluginRegistryIdForCli(entry.cli.pluginId), `${entry.id} must equal pluginRegistryIdForCli(${entry.cli.pluginId})`)
  }
}

testEveryBundledPluginHasAnEntry()
testCommittedSeedIsByteIdentical()
testCommittedIconMarksMatch()
testSeedValidatesThroughAppSchema()
testEntryIdsFollowThePluginRegistryMapping()
console.log('marketplace inline-CLI seed tests passed')
})
