import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BundleScriptFork } from './derived-file-runner'
import {
  defaultDesignSystemLibraryRoot,
  listDesignSystemLibrary,
  readDesignSystemLibraryEntry,
  releaseDesignSystemBundle,
} from './library-registry'

// The production fork binding is Electron utilityProcess; the tests exercise
// the release pipeline with a plain child_process fork so the bundle's real
// lint + generator scripts run under node (same argv contract).
const nodeFork: BundleScriptFork = (scriptPath, args, options) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { cwd: options.cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => resolve({ exitCode: null, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }))
  })

const exampleRoot = join(process.cwd(), 'resources', 'design-system', 'example')

const tests: Array<{ name: string; body: () => Promise<void> }> = []

function run(name: string, body: () => Promise<void>): void {
  tests.push({ name, body })
}

function makeExampleCopy(base: string): string {
  const dir = mkdtempSync(join(tmpdir(), base))
  cpSync(exampleRoot, dir, { recursive: true })
  return dir
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

run('release produces a complete versioned copy: lint gate, stamp, force-regen, immutable copy', async () => {
  const bundle = makeExampleCopy('ds-lib-release-')
  const root = mkdtempSync(join(tmpdir(), 'ds-lib-root-'))
  try {
    // Unknown manifest fields must survive the read → stamp → write cycle.
    const authored = readManifest(bundle)
    authored.xFutureField = { keep: true }
    authored.provenance.xVendorNote = 'preserve-me'
    writeFileSync(join(bundle, 'design-system.json'), JSON.stringify(authored, null, 2))
    // Deleted derived files prove the release force-regenerates before copying.
    rmSync(join(bundle, 'foundations', 'tokens.css'))
    rmSync(join(bundle, 'catalog', 'index.html'))

    const result = await releaseDesignSystemBundle(bundle, '1.2.3', root, nodeFork)
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.equal(result.name, 'example')
    assert.equal(result.version, '1.2.3')
    assert.equal(result.path, join(root, 'example', '1.2.3'))
    assert.ok(!Number.isNaN(Date.parse(result.releasedAt)), result.releasedAt)

    // The copy is complete and self-contained: manifest, governance docs,
    // scripts, authored sources, and freshly regenerated derived files.
    const released = join(root, 'example', '1.2.3')
    for (const file of [
      'design-system.json',
      'USAGE.md',
      'AGENTS.md',
      'scripts/lint.mjs',
      'scripts/build-tokens.mjs',
      'scripts/build-catalog.mjs',
      'foundations/tokens.tokens.json',
      'foundations/tokens.css',
      'components/button/component.css',
      'catalog/index.html',
    ]) {
      assert.ok(existsSync(join(released, file)), `released copy is missing ${file}`)
    }

    const manifest = readManifest(released)
    assert.equal(manifest.version, '1.2.3')
    assert.equal(manifest.provenance.sourceLibraryId, 'example')
    assert.equal(manifest.provenance.sourceLibraryVersion, '1.2.3')
    assert.equal(manifest.provenance.releasedAt, result.releasedAt)
    assert.deepEqual(manifest.xFutureField, { keep: true }, 'unknown top-level field was dropped')
    assert.equal(manifest.provenance.xVendorNote, 'preserve-me', 'unknown provenance field was dropped')

    // Derived files were regenerated from the stamped manifest: the catalog
    // header embeds the released version, not the authoring one.
    const catalog = readFileSync(join(released, 'catalog', 'index.html'), 'utf8')
    assert.ok(catalog.includes('v1.2.3'), 'catalog was not regenerated from the stamped manifest')

    const listed = await listDesignSystemLibrary(root)
    assert.deepEqual(listed.rejected, [])
    assert.deepEqual(
      listed.entries.map((entry) => [entry.name, entry.version, entry.releasedAt]),
      [['example', '1.2.3', result.releasedAt]],
    )
    assert.equal(listed.entries[0].summary, manifest.summary)

    const read = await readDesignSystemLibraryEntry(root, 'example', '1.2.3')
    assert.equal(read.ok, true, JSON.stringify(read))
    if (read.ok) {
      assert.equal(read.manifest.version, '1.2.3')
      assert.equal(read.entry.path, released)
    }
  } finally {
    rmSync(bundle, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

run('a lint failure blocks the release with the findings; nothing is copied, nothing stamped', async () => {
  const bundle = makeExampleCopy('ds-lib-lintfail-')
  const root = mkdtempSync(join(tmpdir(), 'ds-lib-root-'))
  try {
    const cssPath = join(bundle, 'components', 'button', 'component.css')
    writeFileSync(cssPath, readFileSync(cssPath, 'utf8') + '\n.x { color: #ff0000; }\n')

    const result = await releaseDesignSystemBundle(bundle, '1.0.0', root, nodeFork)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.stage, 'lint')
    assert.ok(result.lintFindings?.includes('no-raw-hex'), result.lintFindings)
    assert.ok(!existsSync(join(root, 'example')), 'lint failure must copy nothing')
    assert.equal(readManifest(bundle).version, '0.1.0', 'lint failure must not stamp the source manifest')

    const listed = await listDesignSystemLibrary(root)
    assert.deepEqual(listed.entries, [])
  } finally {
    rmSync(bundle, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

run('releases are immutable: same name+version refuses, a new version is a sibling copy', async () => {
  const bundle = makeExampleCopy('ds-lib-immutable-')
  const root = mkdtempSync(join(tmpdir(), 'ds-lib-root-'))
  try {
    const first = await releaseDesignSystemBundle(bundle, '1.0.0', root, nodeFork)
    assert.equal(first.ok, true, JSON.stringify(first))
    const releasedManifest = readFileSync(join(root, 'example', '1.0.0', 'design-system.json'), 'utf8')

    const again = await releaseDesignSystemBundle(bundle, '1.0.0', root, nodeFork)
    assert.equal(again.ok, false)
    if (!again.ok) assert.equal(again.stage, 'conflict')
    assert.equal(
      readFileSync(join(root, 'example', '1.0.0', 'design-system.json'), 'utf8'),
      releasedManifest,
      'a refused re-release must not touch the existing copy',
    )

    const second = await releaseDesignSystemBundle(bundle, '1.0.1', root, nodeFork)
    assert.equal(second.ok, true, JSON.stringify(second))

    const listed = await listDesignSystemLibrary(root)
    assert.deepEqual(
      listed.entries.map((entry) => entry.version),
      ['1.0.1', '1.0.0'],
      'siblings list newest version first',
    )
  } finally {
    rmSync(bundle, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

run('a bundle with a symlink escaping the source refuses the release with nothing copied', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'ds-lib-symlink-'))
  const root = mkdtempSync(join(tmpdir(), 'ds-lib-root-'))
  try {
    const bundle = join(outer, 'bundle')
    cpSync(exampleRoot, bundle, { recursive: true })
    writeFileSync(join(outer, 'secret.txt'), 'not-for-the-library')
    symlinkSync(join('..', '..', 'secret.txt'), join(bundle, 'foundations', 'escape.css'))

    const result = await releaseDesignSystemBundle(bundle, '1.0.0', root, nodeFork)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.stage, 'source')
      assert.ok(result.message.includes('symlink'), result.message)
    }
    assert.ok(!existsSync(join(root, 'example')), 'a refused release must copy nothing into the library')
  } finally {
    rmSync(outer, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

run('an invalid version or unreadable bundle refuses before running anything', async () => {
  const bundle = makeExampleCopy('ds-lib-badversion-')
  const root = mkdtempSync(join(tmpdir(), 'ds-lib-root-'))
  try {
    const badVersion = await releaseDesignSystemBundle(bundle, 'not-semver', root, nodeFork)
    assert.equal(badVersion.ok, false)
    if (!badVersion.ok) assert.equal(badVersion.stage, 'manifest')
    assert.equal(readManifest(bundle).version, '0.1.0')

    const notABundle = mkdtempSync(join(tmpdir(), 'ds-lib-notbundle-'))
    try {
      const missing = await releaseDesignSystemBundle(notABundle, '1.0.0', root, nodeFork)
      assert.equal(missing.ok, false)
      if (!missing.ok) assert.equal(missing.stage, 'manifest')
    } finally {
      rmSync(notABundle, { recursive: true, force: true })
    }
    assert.ok(!existsSync(join(root, 'example')))
  } finally {
    rmSync(bundle, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

run('list surfaces malformed releases as rejected; read validates its inputs and target', async () => {
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
