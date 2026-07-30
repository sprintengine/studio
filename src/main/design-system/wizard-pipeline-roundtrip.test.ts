import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseDesignSystemManifest } from '../../shared/design-system/manifest'
import { scaffoldDesignSystemBundle } from './bundle-scaffold'
import { runDesignSystemBundleLint } from './bundle-lint-run'
import { regenerateBundleDerivedFiles, type BundleScriptFork } from './derived-file-runner'
import {
  listDesignSystemLibrary,
  readDesignSystemLibraryEntry,
} from './library-registry'

// Layer 1 of the Design Wizard verification harness (MC-1506): the whole
// design-system pipeline a real designer run rides, minus the agent. It scaffolds
// the bundle skeleton from the shipped templates, overlays the known-good example
// bundle's authored sources as if an agent had written them, then walks
// lint -> derived-file regeneration -> library read-back against the real
// production functions. Runs offline with no agent CLI: a green run proves
// scaffold, schema, lint, derived files, and library reading still compose end
// to end. The app-local release pipeline this used to walk was removed
// 2026-07-30, so the library is staged by copy — which is what import does.
//
// Deliberately NOT here (see backlog/2026-07-07-wizard-verification-harness.md):
// driving a live agent (nondeterministic, needs subscription auth on runners).
// Layer 2 is the stage-signal contract net; layer 3 the manual review checklist.

// The production fork binding is Electron utilityProcess; the harness runs the
// bundle's real lint + generator scripts under a plain child_process fork (same
// argv contract), mirroring library-registry.test.ts so the two can never drift.
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

const templatesDir = join(process.cwd(), 'resources', 'design-system', 'templates')
const exampleRoot = join(process.cwd(), 'resources', 'design-system', 'example')

// The authored sources an agent produces — tokens, principles, components,
// patterns, glyphs. Derived output (foundations/tokens.css, catalog/index.html)
// is deliberately NOT overlaid: the harness proves the derived step actually
// generates it, so copying stale copies would hide a regeneration regression.
const AUTHORED_OVERLAY: ReadonlyArray<readonly [string, boolean]> = [
  ['foundations/tokens.tokens.json', true],
  ['foundations/principles.md', true],
  ['components', false],
  ['patterns', false],
  ['glyphs', false],
]

const DERIVED_FILES = ['foundations/tokens.css', 'catalog/index.html'] as const

const tests: Array<{ name: string; body: () => Promise<void> }> = []

function run(name: string, body: () => Promise<void>): void {
  tests.push({ name, body })
}

// Copy the example bundle's authored sources onto a scaffolded bundle, standing
// in for the designer agent's writes.
function overlayAuthoredContent(bundleDir: string): void {
  for (const [relativePath] of AUTHORED_OVERLAY) {
    cpSync(join(exampleRoot, relativePath), join(bundleDir, relativePath), { recursive: true })
  }
}

async function scaffoldBundle(prefix: string, name: string): Promise<{ workspace: string; bundleDir: string }> {
  const workspace = mkdtempSync(join(tmpdir(), prefix))
  const result = await scaffoldDesignSystemBundle({
    workspaceRoot: workspace,
    name,
    summary: 'Verification-harness system: exercises the design-system pipeline offline.',
    templatesDir,
  })
  if (!result.ok || result.bundleDir === undefined) {
    assert.fail(`scaffold failed: ${result.message ?? 'no bundle directory returned'}`)
  }
  return { workspace, bundleDir: result.bundleDir }
}

run('round-trip: scaffold -> overlay -> lint -> derive -> library read-back', async () => {
  const { workspace, bundleDir } = await scaffoldBundle('ds-rt-happy-', 'wizard-roundtrip')
  const root = mkdtempSync(join(tmpdir(), 'ds-rt-lib-'))
  try {
    // Scaffold produced the governance skeleton and a parseable manifest, but no
    // authored sources and no derived files — the agent has not written yet.
    for (const script of ['lint.mjs', 'build-tokens.mjs', 'build-catalog.mjs']) {
      assert.equal(
        readFileSync(join(bundleDir, 'scripts', script), 'utf8'),
        readFileSync(join(templatesDir, 'scripts', script), 'utf8'),
        `scaffolded scripts/${script} must match the template verbatim (drift guard)`,
      )
    }
    const scaffoldManifest = parseDesignSystemManifest(readFileSync(join(bundleDir, 'design-system.json'), 'utf8'))
    assert.equal(scaffoldManifest.name, 'wizard-roundtrip')
    assert.equal(scaffoldManifest.version, '0.1.0')
    assert.ok(!existsSync(join(bundleDir, 'foundations', 'tokens.tokens.json')), 'no authored tokens yet')
    for (const derived of DERIVED_FILES) {
      assert.ok(!existsSync(join(bundleDir, derived)), `no derived ${derived} before the pipeline runs`)
    }

    // The agent authors: overlay the example's real sources.
    overlayAuthoredContent(bundleDir)
    for (const derived of DERIVED_FILES) {
      assert.ok(!existsSync(join(bundleDir, derived)), `overlay must not carry derived ${derived}`)
    }

    // Lint gate over the authored bundle — the author's contribution gate, and
    // the same script the studio's validating preview forks.
    const lint = await runDesignSystemBundleLint(bundleDir, nodeFork)
    assert.equal(lint.ok, true, JSON.stringify(lint))

    // Derived-file regeneration runs the bundle's own generators (tokens before
    // the catalog that inlines them) and must produce both files from scratch.
    const regen = await regenerateBundleDerivedFiles(bundleDir, nodeFork)
    assert.equal(regen.ok, true, JSON.stringify(regen.runs))
    for (const derived of DERIVED_FILES) {
      assert.ok(existsSync(join(bundleDir, derived)), `derived ${derived} produced by its generator`)
    }
    const catalog = readFileSync(join(bundleDir, 'catalog', 'index.html'), 'utf8')
    assert.ok(catalog.includes('ds-embed-component-button'), 'catalog embeds the overlaid button component')

    // Stage the finished bundle into a library root the way an import does —
    // a plain copy, since nothing in the app writes the library any more — and
    // read it back through the production reader.
    const entryDir = join(root, 'wizard-roundtrip', '1.0.0')
    mkdirSync(join(root, 'wizard-roundtrip'), { recursive: true })
    cpSync(bundleDir, entryDir, { recursive: true })
    const staged = parseDesignSystemManifest(readFileSync(join(entryDir, 'design-system.json'), 'utf8'))
    staged.version = '1.0.0'
    writeFileSync(join(entryDir, 'design-system.json'), `${JSON.stringify(staged, null, 2)}\n`)

    const readBack = await readDesignSystemLibraryEntry(root, 'wizard-roundtrip', '1.0.0')
    assert.equal(readBack.ok, true, readBack.ok ? '' : readBack.message)
    if (readBack.ok) {
      assert.equal(readBack.manifest.name, 'wizard-roundtrip')
      assert.equal(readBack.manifest.version, '1.0.0')
    }
    const listed = await listDesignSystemLibrary(root)
    assert.deepEqual(listed.rejected, [])
    assert.deepEqual(
      listed.entries.map((entry) => entry.version),
      ['1.0.0'],
      'library lists the staged bundle',
    )
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

run('gate bites: a corrupted token in the overlay fails at lint with findings', async () => {
  const { workspace, bundleDir } = await scaffoldBundle('ds-rt-gate-', 'wizard-gate')
  const root = mkdtempSync(join(tmpdir(), 'ds-rt-lib-'))
  try {
    overlayAuthoredContent(bundleDir)

    // Corrupt a token: strip a leaf token's mandatory $description. The lint's
    // token-metadata guard has no escape hatch, so this is an unambiguous
    // violation regardless of which token it lands on.
    const tokensPath = join(bundleDir, 'foundations', 'tokens.tokens.json')
    const tokensDoc = JSON.parse(readFileSync(tokensPath, 'utf8')) as Record<string, unknown>
    const corrupted = corruptFirstTokenDescription(tokensDoc)
    assert.equal(corrupted, true, 'test fixture must contain at least one token to corrupt')
    writeFileSync(tokensPath, `${JSON.stringify(tokensDoc, null, 2)}\n`)

    // The clean gate now bites: lint reports findings, not a runner error.
    const lint = await runDesignSystemBundleLint(bundleDir, nodeFork)
    assert.equal(lint.ok, false)
    if (!lint.ok) {
      assert.equal(lint.kind, 'findings')
      if (lint.kind === 'findings') {
        assert.ok(lint.findings.includes('missing-token-description'), lint.findings)
      }
    }

    // The lint is the author's contribution gate: it reports, and the author
    // fixes. Nothing in the app copies a bundle anywhere on the strength of it.
    assert.ok(!existsSync(join(root, 'wizard-gate')), 'nothing is written into the library root')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

// Walk a DTCG token document to the first leaf token (a node carrying $value)
// and blank its $description. Returns whether a token was found and corrupted.
function corruptFirstTokenDescription(node: unknown): boolean {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return false
  const record = node as Record<string, unknown>
  if ('$value' in record) {
    record.$description = ''
    return true
  }
  for (const child of Object.values(record)) {
    if (corruptFirstTokenDescription(child)) return true
  }
  return false
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
  console.log('wizard-pipeline-roundtrip.test.ts: ok')
}

void main()
