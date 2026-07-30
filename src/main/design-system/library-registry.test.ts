import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  defaultDesignSystemLibraryRoot,
  listDesignSystemLibrary,
  readDesignSystemLibraryEntry,
} from './library-registry'

const exampleRoot = join(process.cwd(), 'resources', 'design-system', 'example')

const tests: Array<{ name: string; body: () => Promise<void> }> = []

function run(name: string, body: () => Promise<void>): void {
  tests.push({ name, body })
}

function readManifest(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(dir, 'design-system.json'), 'utf8'))
}

run('the default library root resolves under HOME at ~/.multicode/design-systems', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'ds-lib-home-'))
  const realHome = process.env.HOME
  try {
    process.env.HOME = fakeHome
    assert.equal(defaultDesignSystemLibraryRoot(), join(fakeHome, '.multicode', 'design-systems'))
  } finally {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    rmSync(fakeHome, { recursive: true, force: true })
  }
})

run('a bundle placed in the library lists and reads by name+version', async () => {
  // Nothing in the app writes the library any more (the release pipeline was
  // removed 2026-07-30), so the fixture stages a bundle directly — which is
  // what an import will do. The reader is what this module still owns.
  const root = mkdtempSync(join(tmpdir(), 'ds-lib-root-'))
  try {
    const entryDir = join(root, 'example-system', '1.0.0')
    mkdirSync(join(root, 'example-system'), { recursive: true })
    cpSync(exampleRoot, entryDir, { recursive: true })
    const manifest = readManifest(entryDir)
    manifest.name = 'example-system'
    manifest.version = '1.0.0'
    writeFileSync(join(entryDir, 'design-system.json'), `${JSON.stringify(manifest, null, 2)}\n`)

    const listed = await listDesignSystemLibrary(root)
    assert.deepEqual(listed.rejected, [])
    assert.equal(listed.entries.length, 1)
    assert.equal(listed.entries[0].name, 'example-system')
    assert.equal(listed.entries[0].version, '1.0.0')
    assert.equal(listed.entries[0].path, entryDir)

    const read = await readDesignSystemLibraryEntry(root, 'example-system', '1.0.0')
    assert.equal(read.ok, true)
    if (read.ok) assert.equal(read.manifest.name, 'example-system')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

run('list surfaces malformed entries as rejected; read validates its inputs and target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-lib-root-'))
  try {
    // Missing root is an empty library, not an error.
    assert.deepEqual(await listDesignSystemLibrary(join(root, 'nope')), { entries: [], rejected: [] })

    mkdirSync(join(root, 'broken', '1.0.0'), { recursive: true })
    writeFileSync(join(root, 'broken', '1.0.0', 'design-system.json'), '{ not json')
    const listed = await listDesignSystemLibrary(root)
    assert.deepEqual(listed.entries, [])
    assert.equal(listed.rejected.length, 1)
    assert.equal(listed.rejected[0].path, join(root, 'broken', '1.0.0'))

    const missing = await readDesignSystemLibraryEntry(root, 'ghost', '1.0.0')
    assert.equal(missing.ok, false)

    // Renderer-supplied names compose filesystem paths; traversal shapes are
    // rejected before any read.
    const traversal = await readDesignSystemLibraryEntry(root, '..', '1.0.0')
    assert.equal(traversal.ok, false)
    if (!traversal.ok) assert.ok(traversal.message.includes('valid design-system name'))
  } finally {
    rmSync(root, { recursive: true, force: true })
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
  console.log('library-registry.test.ts: ok')
}

void main()
