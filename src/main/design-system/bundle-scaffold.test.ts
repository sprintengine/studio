import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseDesignSystemManifest } from '../../shared/design-system/manifest'
import { kebabCaseBundleName, scaffoldDesignSystemBundle } from './bundle-scaffold'

// Scaffolds against the real repo templates (the same files the packaged app
// carries as extraResources), so template drift breaks this test instead of
// the wizard.
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

    const manifest = parseDesignSystemManifest(
      readFileSync(join(bundleDir, 'design-system.json'), 'utf8'),
    )
    assert.equal(manifest.name, 'caf-shift-trader', 'name is kebab-cased (non-ascii dropped)')
    assert.equal(manifest.summary, 'A warm, editorial system.', 'summary whitespace collapses')
    assert.deepEqual(manifest.contents.components, [], 'no sample content is seeded')
    assert.equal(manifest.derived['foundations/tokens.css'], 'scripts/build-tokens.mjs')
    assert.equal(manifest.derived['catalog/index.html'], 'scripts/build-catalog.mjs')
    assert.equal(manifest.provenance.authoredBy, 'multicode-design-wizard')
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
    assert.ok(
      !existsSync(join(workspace, 'design-system', 'design-system.json')),
      'no manifest is written on failure',
    )
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
