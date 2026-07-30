import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readDesignSystemBundle } from './bundle-read'

// The Design door's reader (item 2002). Two contracts matter here:
//
//  1. Every way a folder can fail is its OWN typed reason carrying the path — a
//     folder we cannot read must never look like a system with no components.
//  2. The accent is resolved from `foundations/tokens.tokens.json`, the declared
//     source of truth, NOT the generated `foundations/tokens.css`. The door never
//     regenerates, so reading the generated file would draw stale values and the
//     staleness would look like ours.

const tests: Array<{ name: string; body: () => Promise<void> }> = []
function run(name: string, body: () => Promise<void>): void {
  tests.push({ name, body })
}

const exampleRoot = join(process.cwd(), 'resources', 'design-system', 'example')

function exampleCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ds-read-'))
  cpSync(exampleRoot, dir, { recursive: true })
  return dir
}

function editTokens(bundleDir: string, mutate: (tokens: Record<string, any>) => void): void {
  const path = join(bundleDir, 'foundations', 'tokens.tokens.json')
  const tokens = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
  mutate(tokens)
  writeFileSync(path, `${JSON.stringify(tokens, null, 2)}\n`)
}

run('a real bundle reads its identity and its accent, per mode', async () => {
  const dir = exampleCopy()
  try {
    const result = await readDesignSystemBundle(dir)
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const { identity, manifest } = result.view
    assert.equal(identity.path, dir)
    assert.equal(identity.name, manifest.name)
    assert.equal(identity.version, manifest.version)
    // The example declares a mode-varying accent, so light and dark differ and
    // both are real colours rather than the unresolved `{ref.…}` alias text.
    assert.ok(identity.accent.light?.startsWith('#'), `light: ${identity.accent.light}`)
    assert.ok(identity.accent.dark?.startsWith('#'), `dark: ${identity.accent.dark}`)
    assert.notEqual(identity.accent.light, identity.accent.dark)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

run('the accent comes from the token SOURCE, not the generated tokens.css', async () => {
  const dir = exampleCopy()
  try {
    const before = await readDesignSystemBundle(dir)
    assert.equal(before.ok, true)
    if (!before.ok) return

    // Author edits the source and does NOT regenerate — exactly the drift the
    // door must not inherit. tokens.css keeps the old value on disk.
    editTokens(dir, (tokens) => {
      tokens.ref.color.green['600'].$value = '#123456'
    })
    const cssPath = join(dir, 'foundations', 'tokens.css')
    const css = readFileSync(cssPath, 'utf8')
    assert.ok(!css.includes('#123456'), 'the generated file is deliberately left stale')

    const after = await readDesignSystemBundle(dir)
    assert.equal(after.ok, true)
    if (!after.ok) return
    assert.equal(after.view.identity.accent.light, '#123456', 'read from the source of truth')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

run('a bundle with no token file still reads — it just has no accent', async () => {
  const dir = exampleCopy()
  try {
    rmSync(join(dir, 'foundations', 'tokens.tokens.json'), { force: true })
    const result = await readDesignSystemBundle(dir)
    // Mid-authoring is not broken: a manifest without tokens yet is a system
    // with nothing to paint the chip, not a system that failed to load.
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    assert.deepEqual(result.view.identity.accent, { light: null, dark: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

run('an unresolvable or non-colour accent is null, never the raw alias text', async () => {
  const dir = exampleCopy()
  try {
    editTokens(dir, (tokens) => {
      tokens.sem.color.accent.primary.$value = '{ref.color.green.nope}'
      tokens.sem.color.accent.primary.$extensions['com.multicode'].modes = {
        light: '{ref.color.green.nope}',
        dark: '{ref.color.green.nope}',
      }
    })
    const result = await readDesignSystemBundle(dir)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.view.identity.accent, { light: null, dark: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

run('a token alias cycle terminates instead of hanging', async () => {
  const dir = exampleCopy()
  try {
    editTokens(dir, (tokens) => {
      tokens.ref.color.green['600'].$value = '{ref.color.green.500}'
      tokens.ref.color.green['500'].$value = '{ref.color.green.600}'
    })
    const result = await readDesignSystemBundle(dir)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.view.identity.accent.light, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

run('each way a folder can fail is its own typed reason, carrying the path', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ds-read-fail-'))
  try {
    const gone = join(parent, 'not-there')
    const missing = await readDesignSystemBundle(gone)
    assert.equal(missing.ok, false)
    if (!missing.ok) {
      assert.equal(missing.reason, 'missing')
      assert.equal(missing.path, gone)
    }

    const empty = join(parent, 'empty')
    mkdirSync(empty)
    const noManifest = await readDesignSystemBundle(empty)
    assert.equal(noManifest.ok, false)
    if (!noManifest.ok) assert.equal(noManifest.reason, 'no-manifest')

    const broken = join(parent, 'broken')
    mkdirSync(broken)
    writeFileSync(join(broken, 'design-system.json'), '{ not json')
    const invalid = await readDesignSystemBundle(broken)
    assert.equal(invalid.ok, false)
    if (!invalid.ok) {
      assert.equal(invalid.reason, 'invalid-manifest')
      assert.equal(invalid.path, broken)
    }

    // A file where a directory should be is "missing", not a crash.
    const notADir = join(parent, 'a-file')
    writeFileSync(notADir, 'x')
    const fileResult = await readDesignSystemBundle(notADir)
    assert.equal(fileResult.ok, false)
    if (!fileResult.ok) assert.equal(fileResult.reason, 'missing')

    const blank = await readDesignSystemBundle('')
    assert.equal(blank.ok, false)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

run('an unreadable manifest is unreadable, not "no manifest"', async () => {
  // Permission denied and absence are different problems with different fixes,
  // so they must not collapse into one row state. Skipped as root, where the
  // mode bits do not deny.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log('  (skipped: running as root, chmod does not deny)')
    return
  }
  const dir = exampleCopy()
  const manifestPath = join(dir, 'design-system.json')
  try {
    chmodSync(manifestPath, 0o000)
    const result = await readDesignSystemBundle(dir)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.reason, 'unreadable')
      assert.equal(result.path, dir)
    }
  } finally {
    chmodSync(manifestPath, 0o644)
    rmSync(dir, { recursive: true, force: true })
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
  console.log('bundle-read.test.ts: ok')
}

void main()
