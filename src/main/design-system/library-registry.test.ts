import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { designSystemRegistrationId, normaliseRegistryPath } from '../../shared/design-system/library'
import {
  defaultDesignSystemLibraryRoot,
  defaultDesignSystemRegistryPath,
  forgetDesignSystemFolder,
  listDesignSystemLibrary,
  readDesignSystemLibraryEntry,
  readDesignSystemRegistry,
  registerDesignSystemFolder,
  type LibraryPaths,
} from './library-registry'
import { test } from 'vitest'

test('library-registry', async () => {
  // The library is a REGISTRY OF PATHS the user pointed at, not a store of copies
  // (item 2004). Two properties matter most and are easy to lose:
  //
  //  1. Nothing is ever copied, and nothing is ever written inside a registered
  //     folder. That folder belongs to the user's repo.
  //  2. A folder that breaks stays in the list as a NAMED broken row. Dropping it
  //     would hide the problem and remove the only way to repair it.

  const tests: Array<{ name: string; body: () => Promise<void> }> = []
  function run(name: string, body: () => Promise<void>): void {
    tests.push({ name, body })
  }

  const exampleRoot = join(process.cwd(), 'resources', 'design-system', 'example')

  interface Fixture extends LibraryPaths {
    home: string
  }

  function fixture(): Fixture {
    const home = mkdtempSync(join(tmpdir(), 'ds-registry-'))
    return {
      home,
      registryPath: join(home, '.multicode', 'design-systems.json'),
      legacyRoot: join(home, '.multicode', 'design-systems'),
    }
  }

  /** A real bundle at an arbitrary path — a folder inside someone's cloned repo. */
  function bundleAt(parent: string, name: string, version = '1.0.0'): string {
    const dir = join(parent, name)
    cpSync(exampleRoot, dir, { recursive: true })
    const manifestPath = join(dir, 'design-system.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.name = name
    manifest.version = version
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    return dir
  }

  /** Every file under a directory with its bytes, for an unchanged-after check. */
  function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {}
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) walk(full)
        else out[full.slice(dir.length)] = readFileSync(full, 'base64')
      }
    }
    walk(dir)
    return out
  }

  function directoryExists(dir: string): boolean {
    try {
      readdirSync(dir)
      return true
    } catch {
      return false
    }
  }

  run('the registry file sits BESIDE the legacy copy directory, never inside it', async () => {
    // A file where the old directory lives would collide with it; a machine that
    // has both must be able to carry both.
    assert.equal(`${defaultDesignSystemLibraryRoot()}.json`, defaultDesignSystemRegistryPath())
  })

  run('pointing at a folder registers a reference and copies nothing', async () => {
    const paths = fixture()
    const repo = mkdtempSync(join(tmpdir(), 'ds-repo-'))
    try {
      const bundle = bundleAt(repo, 'harbor', '1.2.0')
      const before = snapshot(bundle)

      const registered = await registerDesignSystemFolder(paths, bundle)
      assert.equal(registered.ok, true, registered.ok ? '' : registered.message)
      if (!registered.ok) return
      assert.equal(registered.entry.path, bundle, 'the entry points at the folder itself')
      assert.equal(registered.entry.name, 'harbor')
      assert.equal(registered.entry.sourceState, 'ok')

      assert.deepEqual(snapshot(bundle), before, 'the pointed-at folder is byte-identical')
      assert.equal(directoryExists(paths.legacyRoot), false, 'nothing was copied into our storage')

      const listed = await listDesignSystemLibrary(paths)
      assert.equal(listed.entries.length, 1)
      assert.equal(listed.entries[0].path, bundle)
    } finally {
      rmSync(paths.home, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  run('a live edit is visible on the next read — no copy, no sync, no watcher', async () => {
    const paths = fixture()
    const repo = mkdtempSync(join(tmpdir(), 'ds-repo-'))
    try {
      const bundle = bundleAt(repo, 'harbor', '1.2.0')
      await registerDesignSystemFolder(paths, bundle)

      // The user edits in their editor and comes back.
      const manifestPath = join(bundle, 'design-system.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      manifest.version = '1.3.0'
      manifest.summary = 'Edited in place.'
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

      const listed = await listDesignSystemLibrary(paths)
      assert.equal(listed.entries[0].version, '1.3.0', 'read live from disk')
      assert.equal(listed.entries[0].summary, 'Edited in place.')
    } finally {
      rmSync(paths.home, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  run('each way a folder breaks is its own row state, and the row never disappears', async () => {
    const paths = fixture()
    const repo = mkdtempSync(join(tmpdir(), 'ds-repo-'))
    try {
      const gone = bundleAt(repo, 'gone')
      const stripped = bundleAt(repo, 'stripped')
      const corrupt = bundleAt(repo, 'corrupt')
      const fine = bundleAt(repo, 'fine')
      for (const dir of [gone, stripped, corrupt, fine]) {
        assert.equal((await registerDesignSystemFolder(paths, dir)).ok, true)
      }

      rmSync(gone, { recursive: true, force: true })
      rmSync(join(stripped, 'design-system.json'), { force: true })
      writeFileSync(join(corrupt, 'design-system.json'), '{ not json')

      const listed = await listDesignSystemLibrary(paths)
      assert.equal(listed.entries.length, 4, 'every row survives — none silently dropped')
      const byPath = new Map(listed.entries.map((entry) => [entry.path, entry]))
      assert.equal(byPath.get(gone)?.sourceState, 'missing')
      assert.equal(byPath.get(stripped)?.sourceState, 'no-manifest')
      assert.equal(byPath.get(corrupt)?.sourceState, 'invalid-manifest')
      assert.equal(byPath.get(fine)?.sourceState, 'ok')
      // A missing folder keeps the identity it had, so the row stays recognisable.
      assert.equal(byPath.get(gone)?.name, 'gone', 'the cached display name survives')
      assert.equal(byPath.get(gone)?.path, gone, 'and the row names its path')

      // Reading a broken entry reports WHICH kind of broken, not a generic error.
      const brokenId = byPath.get(corrupt)?.id ?? ''
      const read = await readDesignSystemLibraryEntry(paths, brokenId)
      assert.equal(read.ok, false)
      if (!read.ok) assert.equal(read.sourceState, 'invalid-manifest')
    } finally {
      rmSync(paths.home, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  run('two folders may hold the same name and version — resolved by path, not coordinates', async () => {
    const paths = fixture()
    const repoA = mkdtempSync(join(tmpdir(), 'ds-repo-a-'))
    const repoB = mkdtempSync(join(tmpdir(), 'ds-repo-b-'))
    try {
      const a = bundleAt(repoA, 'harbor', '1.2.0')
      const b = bundleAt(repoB, 'harbor', '1.2.0')
      await registerDesignSystemFolder(paths, a)
      await registerDesignSystemFolder(paths, b)

      const listed = await listDesignSystemLibrary(paths)
      assert.equal(listed.entries.length, 2, 'a name clash is a display concern, not an error')
      assert.equal(new Set(listed.entries.map((entry) => entry.id)).size, 2, 'distinct ids')

      for (const entry of listed.entries) {
        const read = await readDesignSystemLibraryEntry(paths, entry.id)
        assert.equal(read.ok, true)
        if (read.ok) assert.equal(read.entry.path, entry.path, 'each id reads its OWN folder')
      }
    } finally {
      for (const dir of [paths.home, repoA, repoB]) rmSync(dir, { recursive: true, force: true })
    }
  })

  run('registering the same folder twice refreshes it rather than duplicating it', async () => {
    const paths = fixture()
    const repo = mkdtempSync(join(tmpdir(), 'ds-repo-'))
    try {
      const bundle = bundleAt(repo, 'harbor', '1.2.0')
      const first = await registerDesignSystemFolder(paths, bundle)
      const again = await registerDesignSystemFolder(paths, bundle)
      assert.equal(first.ok, true)
      assert.equal(again.ok, true)
      const listed = await listDesignSystemLibrary(paths)
      assert.equal(listed.entries.length, 1, 'pointing at the same folder twice is not an error')
      if (first.ok && again.ok) {
        assert.equal(again.entry.addedAt, first.entry.addedAt, 'the original addedAt is kept')
      }
    } finally {
      rmSync(paths.home, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  run('a folder that is not a design system is refused, not registered-then-broken', async () => {
    const paths = fixture()
    const repo = mkdtempSync(join(tmpdir(), 'ds-repo-'))
    try {
      const notABundle = join(repo, 'just-a-folder')
      mkdirSync(notABundle)
      const result = await registerDesignSystemFolder(paths, notABundle)
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.message, /design-system\.json/)
      assert.deepEqual((await listDesignSystemLibrary(paths)).entries, [], 'nothing was registered')
      assert.equal((await registerDesignSystemFolder(paths, '')).ok, false, 'and neither is nothing')
    } finally {
      rmSync(paths.home, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  run('forget removes the reference and NOTHING on disk', async () => {
    const paths = fixture()
    const repo = mkdtempSync(join(tmpdir(), 'ds-repo-'))
    try {
      const bundle = bundleAt(repo, 'harbor')
      const registered = await registerDesignSystemFolder(paths, bundle)
      assert.equal(registered.ok, true)
      if (!registered.ok) return
      const before = snapshot(bundle)

      const forgotten = await forgetDesignSystemFolder(paths, registered.entry.id)
      assert.equal(forgotten.forgotten, true)
      assert.deepEqual((await listDesignSystemLibrary(paths)).entries, [])
      assert.deepEqual(snapshot(bundle), before, 'the user’s folder is untouched')

      // Forgetting something already gone succeeds: the end state is already true.
      assert.equal((await forgetDesignSystemFolder(paths, 'nope')).forgotten, false)
    } finally {
      rmSync(paths.home, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  run('release-era copies are ADOPTED in place, once, and never moved or deleted', async () => {
    const paths = fixture()
    try {
      // A machine carrying copies from before the release pipeline was deleted.
      const legacy = join(paths.legacyRoot, 'brand', '1.1.0')
      mkdirSync(join(paths.legacyRoot, 'brand'), { recursive: true })
      cpSync(exampleRoot, legacy, { recursive: true })
      const manifestPath = join(legacy, 'design-system.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      manifest.name = 'brand'
      manifest.version = '1.1.0'
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      // A stray directory under the old root is NOT a bundle and must not become
      // a permanent broken row.
      mkdirSync(join(paths.legacyRoot, 'noise', '0.0.1'), { recursive: true })
      const before = snapshot(legacy)

      const listed = await listDesignSystemLibrary(paths)
      assert.equal(listed.entries.length, 1, 'the real copy is adopted, the stray one is not')
      assert.equal(listed.entries[0].path, legacy, 'adopted IN PLACE, pointing at itself')
      assert.deepEqual(snapshot(legacy), before, 'the copy is not moved, rewritten, or deleted')

      // Adoption runs once: a deliberate Forget must stick.
      await forgetDesignSystemFolder(paths, listed.entries[0].id)
      const after = await listDesignSystemLibrary(paths)
      assert.deepEqual(after.entries, [], 'a forgotten adoption does not come back')
      assert.equal(directoryExists(legacy), true, 'and the copy is still on disk')
      const registry = await readDesignSystemRegistry(paths.registryPath)
      assert.equal(registry.adoptedLegacyCopies, true)
    } finally {
      rmSync(paths.home, { recursive: true, force: true })
    }
  })

  run('a damaged registry file is an empty library, never a door that cannot open', async () => {
    const paths = fixture()
    try {
      mkdirSync(join(paths.home, '.multicode'), { recursive: true })
      writeFileSync(paths.registryPath, '{ not json')
      assert.deepEqual((await readDesignSystemRegistry(paths.registryPath)).entries, [])
      assert.deepEqual((await listDesignSystemLibrary(paths)).entries, [])

      // Entries missing a path are dropped; the rest of the file survives.
      writeFileSync(
        paths.registryPath,
        JSON.stringify({
          schemaVersion: 1,
          entries: [{ id: 'a' }, { path: '/somewhere/real' }, { path: '/somewhere/real' }],
        }),
      )
      const registry = await readDesignSystemRegistry(paths.registryPath)
      assert.equal(registry.entries.length, 1, 'pathless dropped, duplicate collapsed')
      assert.equal(registry.entries[0].path, '/somewhere/real')
      assert.equal(
        registry.entries[0].id,
        designSystemRegistrationId('/somewhere/real'),
        'an entry with no id gets the id its path implies',
      )
    } finally {
      rmSync(paths.home, { recursive: true, force: true })
    }
  })

  run('ids are stable per folder, and paths normalise to one spelling', async () => {
    assert.equal(
      designSystemRegistrationId('/work/brand/design-system'),
      designSystemRegistrationId('/work/brand/design-system/'),
      'a trailing separator is the same folder',
    )
    assert.notEqual(designSystemRegistrationId('/work/a'), designSystemRegistrationId('/work/b'))
    assert.equal(normaliseRegistryPath('C:\\work\\brand\\'), 'C:/work/brand')
    // Case is NOT folded: two genuinely different Linux folders must stay two.
    assert.notEqual(designSystemRegistrationId('/work/Brand'), designSystemRegistrationId('/work/brand'))
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
    console.log('library-registry.test.ts: ok')
  }

  const suiteRun = main()

  await suiteRun
})
