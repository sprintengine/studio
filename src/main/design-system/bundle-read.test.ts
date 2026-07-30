import assert from 'node:assert/strict'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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

run('the full view: specimen, manifest-ordered groups, real component previews', async () => {
  const dir = exampleCopy()
  try {
    const result = await readDesignSystemBundle(dir)
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const { view } = result

    // Specimen: emitted from the SOURCE, with the bundle's own palette.
    assert.match(view.specimen.tokensCss, /^\/\* GENERATED FILE/, 'the emitted block')
    assert.ok(view.specimen.ramp.length > 0, 'a colour ramp')
    for (const swatch of view.specimen.ramp) {
      assert.ok(swatch.light.startsWith('#') || swatch.light.startsWith('rgb'), swatch.light)
    }

    // Groups mirror the manifest, in manifest order, and an empty one is absent.
    const declared = Object.entries(view.manifest.contents)
      .filter(([, value]) => Array.isArray(value) && value.length > 0)
      .map(([key]) => key)
    assert.deepEqual(view.groups.map((group) => group.key), declared)
    for (const group of view.groups) {
      assert.equal(group.count, group.entries.length)
      assert.ok(!/^[A-Z ]+$/.test(group.label), `sentence case, not shouting: ${group.label}`)
    }

    // Components render their REAL markup — not a placeholder, not an icon.
    assert.ok(view.components.length > 0, 'the example ships components')
    for (const component of view.components) {
      assert.ok(component.stages.length > 0, `${component.name} has at least one stage`)
      assert.ok(
        component.stages.some((stage) => stage.html.includes('<')),
        `${component.name} carries real markup`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

run('a group the manifest declares that we did not anticipate still renders', async () => {
  const dir = exampleCopy()
  try {
    const manifestPath = join(dir, 'design-system.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>
    manifest.contents.motionRules = ['ease-standard', 'ease-entrance']
    manifest.contents.patterns = []
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const result = await readDesignSystemBundle(dir)
    assert.equal(result.ok, true)
    if (!result.ok) return
    const keys = result.view.groups.map((group) => group.key)
    assert.ok(keys.includes('motionRules'), 'an unanticipated group renders')
    assert.ok(!keys.includes('patterns'), 'and a group declared empty is not drawn')
    const motion = result.view.groups.find((group) => group.key === 'motionRules')
    assert.equal(motion?.count, 2)
    assert.equal(motion?.label, 'MotionRules', 'label derives from the key, not a lookup table')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

run('a bundle-relative asset is inlined; one escaping the bundle is refused', async () => {
  const dir = exampleCopy()
  try {
    const componentDir = join(dir, 'components', 'button')
    writeFileSync(join(componentDir, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeFileSync(
      join(componentDir, 'component.css'),
      '.a{background:url("mark.svg")}.b{background:url("../../../../etc/passwd")}' +
        '.c{background:url("http://evil/x.png")}',
    )
    const result = await readDesignSystemBundle(dir)
    assert.equal(result.ok, true)
    if (!result.ok) return
    const button = result.view.components.find((component) => component.name === 'button')
    assert.ok(button)
    assert.match(button.css, /url\("data:image\/svg\+xml;base64,/, 'the in-bundle asset inlined')
    assert.ok(!button.css.includes('etc/passwd'), 'the escaping ref never became a data URI')
    assert.ok(!button.css.includes('http://evil'), 'and neither did the remote one')
    // Both are REPORTED, so the tile can say something could not be loaded.
    assert.ok(button.unresolvedRefs.length >= 2, button.unresolvedRefs.join(', '))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

run('opening a system spawns no process and writes nothing', async () => {
  const dir = exampleCopy()
  try {
    // The read-only contract, asserted two ways. First: the module's CODE (with
    // comments stripped, so prose about not spawning does not trip it) references
    // nothing that can spawn a process or write a file. A future edit that forks
    // a bundle script fails here rather than in production.
    const source = readFileSync(join(process.cwd(), 'src/main/design-system/bundle-read.ts'), 'utf8')
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    for (const forbidden of [
      'child_process',
      'utilityProcess',
      'spawn',
      'execFile',
      'fork(',
      'writeFile',
      'mkdir',
      'rmdir',
      'unlink',
      'rename',
      'appendFile',
    ]) {
      assert.ok(!code.includes(forbidden), `bundle-read must not reference ${forbidden} in code`)
    }
    // And it imports only the read half of fs/promises.
    const fsImport = /import \{([^}]*)\} from 'fs\/promises'/.exec(code)
    assert.ok(fsImport, 'the module imports from fs/promises')
    const imported = fsImport[1].split(',').map((name) => name.trim()).filter(Boolean)
    assert.deepEqual(imported.sort(), ['readFile', 'readdir', 'stat'], 'read-only fs surface')

    // Second: nothing on disk changed across a read.
    const before = snapshot(dir)
    await readDesignSystemBundle(dir)
    assert.deepEqual(snapshot(dir), before, 'the bundle folder is byte-identical after a read')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

run('a 100-component bundle reads in one call, and the payload stays linear', async () => {
  // The density acceptance is measured, not assumed. This covers the READ half
  // (one IPC call, payload size); the render half is measured in the app.
  const dir = exampleCopy()
  try {
    const componentsDir = join(dir, 'components')
    const template = join(componentsDir, 'button')
    const manifestPath = join(dir, 'design-system.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>
    const names: string[] = [...manifest.contents.components]
    for (let index = names.length; index < 100; index += 1) {
      const name = `generated-${String(index).padStart(3, '0')}`
      cpSync(template, join(componentsDir, name), { recursive: true })
      names.push(name)
    }
    manifest.contents.components = names
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const started = process.hrtime.bigint()
    const result = await readDesignSystemBundle(dir)
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.view.components.length, 100)

    const bytes = Buffer.byteLength(JSON.stringify(result.view), 'utf8')
    const perComponent = bytes / 100
    console.log(
      `  measured: 100 components read in ${elapsedMs.toFixed(0)}ms, ` +
        `payload ${(bytes / 1024).toFixed(0)}KiB (${perComponent.toFixed(0)}B/component)`,
    )
    // The token block is carried ONCE, not per component — the whole reason the
    // payload is FRAGMENTS rather than composed documents. Composing per
    // component in the reader would repeat it a hundred times; the renderer does
    // that composition instead, per visible tile.
    const serialised = JSON.stringify(result.view)
    const header = '/* GENERATED FILE'
    const occurrences = serialised.split(JSON.stringify(header).slice(1, -1)).length - 1
    assert.equal(occurrences, 1, 'the emitted token block appears exactly once in the payload')
    // And the payload is linear in real authored content, not quadratic.
    assert.ok(perComponent < 40_000, `${perComponent.toFixed(0)}B per component is out of budget`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Every file under a directory, with its bytes — for an unchanged-after check. */
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
