import assert from 'node:assert/strict'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { attachDesignSystemBundle, DESIGN_SYSTEM_ATTACH_DIRNAME } from './attach'

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

// Library entries are name/version-addressed directories whose manifest matches
// the directory pair; place the example there directly (reading the library is
// covered by library-registry.test.ts).
function makeLibraryWithExample(version: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ds-attach-lib-'))
  const entryDir = join(root, 'example', version)
  mkdirSync(join(root, 'example'), { recursive: true })
  cpSync(exampleRoot, entryDir, { recursive: true })
  const manifest = readManifest(entryDir)
  manifest.version = version
  manifest.provenance.releasedAt = '2026-07-01T00:00:00.000Z'
  writeFileSync(join(entryDir, 'design-system.json'), JSON.stringify(manifest, null, 2))
  return root
}

function readManifest(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(dir, 'design-system.json'), 'utf8'))
}

run('library attach lands the full bundle at design-system/ with provenance stamped, source untouched', async () => {
  const libraryRoot = makeLibraryWithExample('1.2.3')
  const workspace = mkdtempSync(join(tmpdir(), 'ds-attach-ws-'))
  try {
    // Unknown manifest fields must survive the read → stamp → write cycle.
    const entryDir = join(libraryRoot, 'example', '1.2.3')
    const entryManifest = readManifest(entryDir)
    entryManifest.xFutureField = { keep: true }
    entryManifest.provenance.xVendorNote = 'preserve-me'
    writeFileSync(join(entryDir, 'design-system.json'), JSON.stringify(entryManifest, null, 2))
    const libraryManifestBefore = readFileSync(join(entryDir, 'design-system.json'), 'utf8')

    const result = await attachDesignSystemBundle(
      { kind: 'library', name: 'example', version: '1.2.3' },
      workspace,
      libraryRoot,
    )
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.equal(result.name, 'example')
    assert.equal(result.version, '1.2.3')
    assert.equal(result.path, join(workspace, DESIGN_SYSTEM_ATTACH_DIRNAME))
    assert.ok(!Number.isNaN(Date.parse(result.attachedAt)), result.attachedAt)

    // The copy is the complete self-contained bundle.
    const attached = join(workspace, DESIGN_SYSTEM_ATTACH_DIRNAME)
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
      assert.ok(existsSync(join(attached, file)), `attached copy is missing ${file}`)
    }

    const manifest = readManifest(attached)
    assert.equal(manifest.provenance.sourceLibraryId, 'example')
    assert.equal(manifest.provenance.sourceLibraryVersion, '1.2.3')
    assert.equal(manifest.provenance.attachedAt, result.attachedAt)
    assert.deepEqual(manifest.xFutureField, { keep: true }, 'unknown top-level field was dropped')
    assert.equal(manifest.provenance.xVendorNote, 'preserve-me', 'unknown provenance field was dropped')

    // Attach never mutates the library copy, and leaves no staging dir behind.
    assert.equal(
      readFileSync(join(entryDir, 'design-system.json'), 'utf8'),
      libraryManifestBefore,
      'attach must not stamp the library source',
    )
    assert.ok(
      readdirSync(workspace).every((entry) => entry === DESIGN_SYSTEM_ATTACH_DIRNAME),
      'attach must leave nothing in the workspace but design-system/',
    )
  } finally {
    rmSync(libraryRoot, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})

run('browsed-folder attach validates the bundle first and preserves existing provenance', async () => {
  const folder = makeExampleCopy('ds-attach-folder-')
  const workspace = mkdtempSync(join(tmpdir(), 'ds-attach-ws-'))
  const libraryRoot = mkdtempSync(join(tmpdir(), 'ds-attach-lib-'))
  try {
    // A shared library entry keeps its own provenance; attach adds attachedAt.
    const source = readManifest(folder)
    source.provenance.sourceLibraryId = 'example'
    source.provenance.sourceLibraryVersion = '0.1.0'
    source.provenance.releasedAt = '2026-06-30T00:00:00.000Z'
    writeFileSync(join(folder, 'design-system.json'), JSON.stringify(source, null, 2))

    const result = await attachDesignSystemBundle({ kind: 'folder', path: folder }, workspace, libraryRoot)
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return

    const manifest = readManifest(join(workspace, DESIGN_SYSTEM_ATTACH_DIRNAME))
    assert.equal(manifest.provenance.sourceLibraryId, 'example')
    assert.equal(manifest.provenance.sourceLibraryVersion, '0.1.0')
    assert.equal(manifest.provenance.releasedAt, '2026-06-30T00:00:00.000Z')
    assert.equal(manifest.provenance.attachedAt, result.attachedAt)
    assert.equal(readManifest(folder).provenance.attachedAt, null, 'attach must not stamp the browsed source')
  } finally {
    rmSync(folder, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
    rmSync(libraryRoot, { recursive: true, force: true })
  }
})

run('an invalid browsed source fails typed with nothing written', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ds-attach-ws-'))
  const libraryRoot = mkdtempSync(join(tmpdir(), 'ds-attach-lib-'))
  const notABundle = mkdtempSync(join(tmpdir(), 'ds-attach-junk-'))
  try {
    // Missing manifest entirely.
    const missing = await attachDesignSystemBundle({ kind: 'folder', path: notABundle }, workspace, libraryRoot)
    assert.equal(missing.ok, false)
    if (!missing.ok) {
      assert.equal(missing.stage, 'source')
      assert.ok(missing.message.includes('design-system.json'), missing.message)
    }

    // Invalid manifest.
    writeFileSync(join(notABundle, 'design-system.json'), '{ "schemaVersion": "nope" }')
    const invalid = await attachDesignSystemBundle({ kind: 'folder', path: notABundle }, workspace, libraryRoot)
    assert.equal(invalid.ok, false)
    if (!invalid.ok) assert.equal(invalid.stage, 'source')

    // A source path that is not a folder at all.
    const notAFolder = await attachDesignSystemBundle(
      { kind: 'folder', path: join(notABundle, 'design-system.json') },
      workspace,
      libraryRoot,
    )
    assert.equal(notAFolder.ok, false)
    if (!notAFolder.ok) assert.equal(notAFolder.stage, 'source')

    // A library entry that does not exist.
    const ghost = await attachDesignSystemBundle(
      { kind: 'library', name: 'ghost', version: '1.0.0' },
      workspace,
      libraryRoot,
    )
    assert.equal(ghost.ok, false)
    if (!ghost.ok) assert.equal(ghost.stage, 'source')

    assert.deepEqual(readdirSync(workspace), [], 'a refused attach must write nothing into the workspace')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(libraryRoot, { recursive: true, force: true })
    rmSync(notABundle, { recursive: true, force: true })
  }
})

run('a bundle with symlinks escaping the source is a typed source refusal with nothing written', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'ds-attach-symlink-'))
  const workspace = mkdtempSync(join(tmpdir(), 'ds-attach-ws-'))
  const libraryRoot = mkdtempSync(join(tmpdir(), 'ds-attach-lib-'))
  try {
    // Bundle nested one level down so a ../ link has somewhere real to escape to.
    const bundle = join(outer, 'bundle')
    cpSync(exampleRoot, bundle, { recursive: true })
    writeFileSync(join(outer, 'secret.txt'), 'AKIA-not-really')

    // Absolute symlink shape: foundations/tokens.css -> <outside file>.
    const absoluteLink = join(bundle, 'foundations', 'stolen.css')
    symlinkSync(join(outer, 'secret.txt'), absoluteLink)
    const absolute = await attachDesignSystemBundle({ kind: 'folder', path: bundle }, workspace, libraryRoot)
    assert.equal(absolute.ok, false)
    if (!absolute.ok) {
      assert.equal(absolute.stage, 'source')
      assert.ok(absolute.message.includes('symlink'), absolute.message)
      assert.ok(absolute.message.includes(join('foundations', 'stolen.css')), absolute.message)
    }
    assert.deepEqual(readdirSync(workspace), [], 'a refused attach must write nothing into the workspace')
    rmSync(absoluteLink)

    // Relative ../ symlink shape escaping the bundle root.
    const relativeLink = join(bundle, 'components', 'button', 'escape.md')
    symlinkSync(join('..', '..', '..', 'secret.txt'), relativeLink)
    const relative = await attachDesignSystemBundle({ kind: 'folder', path: bundle }, workspace, libraryRoot)
    assert.equal(relative.ok, false)
    if (!relative.ok) assert.equal(relative.stage, 'source')
    assert.deepEqual(readdirSync(workspace), [])
    rmSync(relativeLink)

    // A relative link confined to the bundle stays attachable, and the landed
    // copy contains no link that resolves outside design-system/.
    symlinkSync('tokens.css', join(bundle, 'foundations', 'alias.css'))
    const confined = await attachDesignSystemBundle({ kind: 'folder', path: bundle }, workspace, libraryRoot)
    assert.equal(confined.ok, true, JSON.stringify(confined))
    const landedLink = join(workspace, DESIGN_SYSTEM_ATTACH_DIRNAME, 'foundations', 'alias.css')
    assert.ok(lstatSync(landedLink).isSymbolicLink())
    assert.equal(
      readFileSync(landedLink, 'utf8'),
      readFileSync(join(workspace, DESIGN_SYSTEM_ATTACH_DIRNAME, 'foundations', 'tokens.css'), 'utf8'),
    )
  } finally {
    rmSync(outer, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
    rmSync(libraryRoot, { recursive: true, force: true })
  }
})

run('an existing design-system/ in the target is a typed conflict refusal with no files written', async () => {
  const libraryRoot = makeLibraryWithExample('1.0.0')
  const workspace = mkdtempSync(join(tmpdir(), 'ds-attach-ws-'))
  try {
    const existing = join(workspace, DESIGN_SYSTEM_ATTACH_DIRNAME)
    mkdirSync(existing)
    writeFileSync(join(existing, 'hand-authored.css'), '.keep { color: inherit; }\n')

    const result = await attachDesignSystemBundle(
      { kind: 'library', name: 'example', version: '1.0.0' },
      workspace,
      libraryRoot,
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.stage, 'conflict')
      assert.ok(result.message.includes('already exists'), result.message)
    }

    // No overwrite, no merge, no staging leftovers.
    assert.deepEqual(readdirSync(existing), ['hand-authored.css'])
    assert.deepEqual(readdirSync(workspace), [DESIGN_SYSTEM_ATTACH_DIRNAME])

    // A plain file named design-system is a conflict too, not an overwrite.
    rmSync(existing, { recursive: true, force: true })
    writeFileSync(existing, 'not a directory')
    const fileConflict = await attachDesignSystemBundle(
      { kind: 'library', name: 'example', version: '1.0.0' },
      workspace,
      libraryRoot,
    )
    assert.equal(fileConflict.ok, false)
    if (!fileConflict.ok) assert.equal(fileConflict.stage, 'conflict')
    assert.equal(readFileSync(existing, 'utf8'), 'not a directory')
  } finally {
    rmSync(libraryRoot, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})

run('a missing target workspace folder refuses before anything is copied', async () => {
  const libraryRoot = makeLibraryWithExample('1.0.0')
  const workspace = mkdtempSync(join(tmpdir(), 'ds-attach-ws-'))
  try {
    const result = await attachDesignSystemBundle(
      { kind: 'library', name: 'example', version: '1.0.0' },
      join(workspace, 'does-not-exist'),
      libraryRoot,
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.stage, 'target')
    assert.ok(!existsSync(join(workspace, 'does-not-exist')), 'a refused attach must not create the workspace')
  } finally {
    rmSync(libraryRoot, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
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
  console.log('attach.test.ts: ok')
}

void main()
