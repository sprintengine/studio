import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { designSystemRegistrationId } from '../../shared/design-system/library'
import { listDesignSystemArrivals } from './arrivals'
import { registerDesignSystemFolder, type LibraryPaths } from './library-registry'
import { test } from 'vitest'

test('arrivals', async () => {
  // Arrival dates for the whole library without reading a bundle. Two properties
  // carry the feature:
  //
  //  1. The row's key is the SAME key the door stamps — `designSystemRegistrationId`
  //     of the folder — or the count would never clear when someone opens a system.
  //  2. A registration that broke since it was added is skipped, not thrown. This
  //     is a count, not the repair surface: one moved folder must not delete the
  //     number the other systems earned.

  const tests: Array<{ name: string; body: () => Promise<void> }> = []
  function run(name: string, body: () => Promise<void>): void {
    tests.push({ name, body })
  }

  const exampleRoot = join(process.cwd(), 'resources', 'design-system', 'example')

  function fixture(): LibraryPaths & { home: string } {
    const home = mkdtempSync(join(tmpdir(), 'ds-arrivals-'))
    return {
      home,
      registryPath: join(home, '.sprintengine', 'design-systems.json'),
      legacyRoot: join(home, '.sprintengine', 'design-systems'),
    }
  }

  /** A real bundle at an arbitrary path — a folder inside someone's cloned repo. */
  function bundleAt(parent: string, name: string): string {
    const dir = join(parent, name)
    cpSync(exampleRoot, dir, { recursive: true })
    const manifestPath = join(dir, 'design-system.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.name = name
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    return dir
  }

  run('every readable registration returns its dates, keyed as the door stamps them', async () => {
    const paths = fixture()
    const repo = mkdtempSync(join(tmpdir(), 'ds-arrivals-repo-'))
    try {
      const bundle = bundleAt(repo, 'harbor')
      await registerDesignSystemFolder(paths, bundle)

      const { bundles } = await listDesignSystemArrivals(paths)
      assert.equal(bundles.length, 1)
      assert.equal(bundles[0].path, bundle)
      assert.equal(
        bundles[0].bundleId,
        designSystemRegistrationId(bundle),
        'the seen stamp and the arrivals row must agree on the key, or the count never clears',
      )
      // Outside git the dates come from birthtime; the example declares a button,
      // a pattern and a glyph, so the map is entry-keyed and non-empty.
      const keys = Object.keys(bundles[0].addedAt)
      assert.ok(keys.includes('components:button'), keys.join(', '))
      assert.ok(keys.includes('glyphs:glyphs/check.svg'), keys.join(', '))
      for (const iso of Object.values(bundles[0].addedAt)) {
        assert.ok(!Number.isNaN(Date.parse(iso)), `not an ISO date: ${iso}`)
      }
    } finally {
      rmSync(paths.home, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  run('a registration that broke is skipped, never thrown', async () => {
    const paths = fixture()
    const repo = mkdtempSync(join(tmpdir(), 'ds-arrivals-repo-'))
    try {
      const good = bundleAt(repo, 'harbor')
      const gone = bundleAt(repo, 'moved-away')
      await registerDesignSystemFolder(paths, good)
      await registerDesignSystemFolder(paths, gone)
      // The user moved the folder after registering it — the ordinary way a row
      // breaks. The library list keeps it as a named broken row; the count does
      // not, because there is nothing to count.
      rmSync(gone, { recursive: true, force: true })

      const { bundles } = await listDesignSystemArrivals(paths)
      assert.deepEqual(
        bundles.map((entry) => entry.path),
        [good],
      )
    } finally {
      rmSync(paths.home, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  run('an empty library lists no bundles at all', async () => {
    const paths = fixture()
    try {
      assert.deepEqual(await listDesignSystemArrivals(paths), { bundles: [] })
    } finally {
      rmSync(paths.home, { recursive: true, force: true })
    }
  })

  async function main(): Promise<void> {
    for (const test of tests) {
      try {
        await test.body()
        console.log(`ok - ${test.name}`)
      } catch (error) {
        console.error(`not ok - ${test.name}`)
        throw error
      }
    }
    console.log('design-system arrivals.test.ts: ok')
  }

  const suiteRun = main()

  await suiteRun
})
