import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseDesignSystemManifest } from '../../shared/design-system/manifest'
import { kebabCaseBundleName, scaffoldDesignSystemBundle, seedDesignSystemBundle } from './bundle-scaffold'

// Scaffolds against the real repo templates (the same files the packaged app
// carries as extraResources), so template drift breaks this test instead of a
// real authoring run.
const templatesDir = join(process.cwd(), 'resources', 'design-system', 'templates')

const tests: Array<{ name: string; body: () => Promise<void> }> = []

function run(name: string, body: () => Promise<void>): void {
  tests.push({ name, body })
}

run('stamps the full bundle layout with templates verbatim and a parseable manifest', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ds-scaffold-ok-'))
  try {
    const result = await scaffoldDesignSystemBundle({
      workspaceRoot: workspace,
      name: 'Café Shift Trader!',
      summary: '  A warm,\n editorial   system. ',
      templatesDir,
    })
    assert.equal(result.ok, true, result.message)
    assert.equal(result.alreadyExisted, undefined)
    const bundleDir = join(workspace, 'design-system')
    assert.equal(result.bundleDir, bundleDir)

    for (const dir of ['foundations', 'components', 'patterns', 'glyphs', 'assets', 'catalog']) {
      assert.ok(existsSync(join(bundleDir, dir)), `missing authored-content dir: ${dir}`)
    }
    for (const file of ['USAGE.md', 'AGENTS.md']) {
      assert.equal(
        readFileSync(join(bundleDir, file), 'utf8'),
        readFileSync(join(templatesDir, file), 'utf8'),
        `${file} must be stamped verbatim from the template`,
      )
    }
    for (const script of ['build-tokens.mjs', 'lint.mjs']) {
      assert.equal(
        readFileSync(join(bundleDir, 'scripts', script), 'utf8'),
        readFileSync(join(templatesDir, 'scripts', script), 'utf8'),
        `scripts/${script} must be stamped verbatim from the template`,
      )
    }

    const manifest = parseDesignSystemManifest(readFileSync(join(bundleDir, 'design-system.json'), 'utf8'))
    assert.equal(manifest.name, 'caf-shift-trader', 'name is kebab-cased (non-ascii dropped)')
    assert.equal(manifest.summary, 'A warm, editorial system.', 'summary whitespace collapses')
    assert.deepEqual(manifest.contents.components, [], 'no sample content is seeded')
    assert.equal(manifest.derived['foundations/tokens.css'], 'scripts/build-tokens.mjs')
    assert.equal(manifest.derived['catalog/index.html'], 'scripts/build-catalog.mjs')
    assert.equal(manifest.provenance.authoredBy, 'multicode')
    assert.ok(
      !existsSync(join(bundleDir, 'foundations', 'tokens.tokens.json')),
      'tokens are designer-authored, never scaffolded',
    )
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

run('an existing bundle is resumed, never overwritten', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ds-scaffold-existing-'))
  try {
    const bundleDir = join(workspace, 'design-system')
    mkdirSync(bundleDir, { recursive: true })
    writeFileSync(join(bundleDir, 'design-system.json'), '{"sentinel": true}')
    const result = await scaffoldDesignSystemBundle({
      workspaceRoot: workspace,
      name: 'x',
      summary: 'y',
      templatesDir,
    })
    assert.equal(result.ok, true)
    assert.equal(result.alreadyExisted, true)
    assert.equal(
      readFileSync(join(bundleDir, 'design-system.json'), 'utf8'),
      '{"sentinel": true}',
      'existing manifest is untouched',
    )
    assert.ok(!existsSync(join(bundleDir, 'USAGE.md')), 'no templates stamped over an existing bundle')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

run('missing templates are an observable failure, not a silent skip', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ds-scaffold-notemplates-'))
  try {
    const result = await scaffoldDesignSystemBundle({
      workspaceRoot: workspace,
      name: 'x',
      summary: 'y',
      templatesDir: join(workspace, 'does-not-exist'),
    })
    assert.equal(result.ok, false)
    assert.ok(result.message && result.message.length > 0)
    assert.ok(!existsSync(join(workspace, 'design-system', 'design-system.json')), 'no manifest is written on failure')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

run('an empty workspace root is rejected', async () => {
  const result = await scaffoldDesignSystemBundle({
    workspaceRoot: '   ',
    name: 'x',
    summary: 'y',
    templatesDir,
  })
  assert.equal(result.ok, false)
})

run('bundle names kebab-case with a stable fallback', async () => {
  assert.equal(kebabCaseBundleName('My Design System'), 'my-design-system')
  assert.equal(kebabCaseBundleName('--Weird__ Name!! '), 'weird-name')
  assert.equal(kebabCaseBundleName('!!!'), 'design-system')
})

run('seeding from an existing system copies it and gives it its OWN identity', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ds-seed-'))
  try {
    const source = join(parent, 'source')
    cpSync(join(process.cwd(), 'resources', 'design-system', 'example'), source, { recursive: true })
    // The source carries release-era provenance the copy must NOT inherit.
    const sourceManifestPath = join(source, 'design-system.json')
    const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8')) as Record<string, any>
    sourceManifest.version = '4.5.6'
    sourceManifest.provenance = { sourceLibraryId: 'somewhere-else', releasedAt: '2020-01-01T00:00:00.000Z' }
    sourceManifest.xVendorField = { keep: true }
    writeFileSync(sourceManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`)

    const target = join(parent, 'my-new-system')
    const result = await seedDesignSystemBundle({
      sourceDir: source,
      targetDir: target,
      name: 'My New System',
      summary: 'Seeded from the example.',
      templatesDir,
    })
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    assert.equal(result.bundleDir, target)

    const manifest = parseDesignSystemManifest(readFileSync(join(target, 'design-system.json'), 'utf8'))
    assert.equal(manifest.name, 'my-new-system', 'kebab-cased into its own name')
    assert.equal(manifest.version, '1.0.0', 'a new system starts at 1.0.0')
    assert.deepEqual(
      manifest.provenance,
      {},
      'the source’s provenance describes the SOURCE — inheriting it would claim a history this system does not have',
    )
    assert.deepEqual(
      (manifest as Record<string, unknown>).xVendorField,
      { keep: true },
      'unknown manifest fields survive the copy',
    )
    // The authored content really came across.
    assert.ok(existsSync(join(target, 'components')), 'components came with it')
    assert.ok(existsSync(join(target, 'foundations', 'tokens.tokens.json')), 'and the tokens')
    // The SOURCE is untouched.
    const sourceAfter = JSON.parse(readFileSync(sourceManifestPath, 'utf8')) as Record<string, unknown>
    assert.equal(sourceAfter.version, '4.5.6', 'the system it was seeded from is unchanged')
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

run('the seeded bundle passes its OWN scripts/lint.mjs immediately', async () => {
  // The author's contribution gate, firing once on a bundle we just wrote — not
  // the viewer linting someone else's folder. If a seeded bundle could not pass
  // its own lint, we would be handing the user a system that cannot be
  // contributed to.
  const parent = mkdtempSync(join(tmpdir(), 'ds-seed-lint-'))
  try {
    const source = join(parent, 'source')
    cpSync(join(process.cwd(), 'resources', 'design-system', 'example'), source, { recursive: true })
    const target = join(parent, 'lintable')
    const seeded = await seedDesignSystemBundle({
      sourceDir: source,
      targetDir: target,
      name: 'lintable',
      summary: 'Seeded.',
      templatesDir,
    })
    assert.equal(seeded.ok, true, seeded.ok ? '' : seeded.message)

    const lint = spawnSync(process.execPath, [join(target, 'scripts', 'lint.mjs'), target], {
      encoding: 'utf8',
    })
    assert.equal(lint.status, 0, `seeded bundle failed its own lint:\n${lint.stdout}${lint.stderr}`)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

run('an empty system scaffolds from the shipped templates and lints clean', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ds-seed-empty-'))
  try {
    const target = join(parent, 'blank-system')
    const result = await seedDesignSystemBundle({
      sourceDir: null,
      targetDir: target,
      name: 'Blank System',
      summary: 'From nothing.',
      templatesDir,
    })
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    assert.equal(result.bundleDir, target, 'the bundle IS the folder the user chose')
    const manifest = parseDesignSystemManifest(readFileSync(join(target, 'design-system.json'), 'utf8'))
    assert.equal(manifest.name, 'blank-system')
    // 0.1.0, not 1.0.0: an empty system keeps the scaffold's own "new and
    // unreleased" convention. Only a SEEDED copy resets to 1.0.0, and only
    // because it must not inherit the version of the system it came from.
    assert.equal(manifest.version, '0.1.0')
    for (const script of ['lint.mjs', 'build-tokens.mjs', 'build-catalog.mjs']) {
      assert.ok(existsSync(join(target, 'scripts', script)), `stamped scripts/${script}`)
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

run('a failed seed leaves NOTHING on disk; an existing bundle is never overwritten', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ds-seed-fail-'))
  try {
    // Source that is not a bundle: refused before anything is created.
    const notABundle = join(parent, 'not-a-bundle')
    mkdirSync(notABundle)
    const target = join(parent, 'never-created')
    const refused = await seedDesignSystemBundle({
      sourceDir: notABundle,
      targetDir: target,
      name: 'nope',
      summary: '',
      templatesDir,
    })
    assert.equal(refused.ok, false)
    assert.equal(existsSync(target), false, 'nothing was created for a refused seed')

    // A folder that already holds a bundle is reported, never overwritten.
    const existing = join(parent, 'existing')
    cpSync(join(process.cwd(), 'resources', 'design-system', 'example'), existing, { recursive: true })
    const before = readFileSync(join(existing, 'design-system.json'), 'utf8')
    const conflict = await seedDesignSystemBundle({
      sourceDir: null,
      targetDir: existing,
      name: 'clobber',
      summary: '',
      templatesDir,
    })
    assert.equal(conflict.ok, true)
    assert.equal(conflict.alreadyExisted, true, 'reported as already there')
    assert.equal(
      readFileSync(join(existing, 'design-system.json'), 'utf8'),
      before,
      'the existing bundle is byte-identical',
    )

    // A target the user already had keeps its contents when the seed fails.
    const userFolder = join(parent, 'user-folder')
    mkdirSync(userFolder)
    writeFileSync(join(userFolder, 'notes.md'), 'mine\n')
    const failed = await seedDesignSystemBundle({
      sourceDir: join(parent, 'does-not-exist'),
      targetDir: userFolder,
      name: 'x',
      summary: '',
      templatesDir,
    })
    assert.equal(failed.ok, false)
    assert.equal(readFileSync(join(userFolder, 'notes.md'), 'utf8'), 'mine\n', 'the user’s file survives')

    // And no name is a refusal, not an unnamed bundle.
    assert.equal(
      (
        await seedDesignSystemBundle({
          sourceDir: null,
          targetDir: join(parent, 'x'),
          name: '  ',
          summary: '',
          templatesDir,
        })
      ).ok,
      false,
    )
  } finally {
    rmSync(parent, { recursive: true, force: true })
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
  console.log('bundle-scaffold.test.ts: ok')
}

void main()
