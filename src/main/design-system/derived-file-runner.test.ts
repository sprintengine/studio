import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BUNDLE_SCRIPT_ENV_ALLOWLIST, bundleScriptEnv } from './bundle-script-env'
import {
  discoverBundleDirs,
  regenerateBundleDerivedFiles,
  regenerateDesignSystemDerivedFiles,
  type BundleScriptFork,
} from './derived-file-runner'

// The production fork binding is Electron utilityProcess
// (utility-process-fork.ts); this test exercises the runner's orchestration
// with a plain child_process fork so it runs under node. Both spawn the same
// bundle scripts with the same argv contract.
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
  const root = mkdtempSync(join(tmpdir(), base))
  cpSync(exampleRoot, root, { recursive: true })
  return root
}

run('regenerates derived files for a bundle, tokens before the catalog that inlines them', async () => {
  const bundle = makeExampleCopy('ds-runner-ok-')
  try {
    rmSync(join(bundle, 'foundations', 'tokens.css'))
    rmSync(join(bundle, 'catalog', 'index.html'))
    const result = await regenerateBundleDerivedFiles(bundle, nodeFork)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(existsSync(join(bundle, 'foundations', 'tokens.css')), 'tokens.css was not regenerated')
    assert.ok(existsSync(join(bundle, 'catalog', 'index.html')), 'catalog/index.html was not regenerated')
    // Declaration order of the manifest derived map: the catalog generator
    // inlines tokens.css, so build-tokens must have run first.
    assert.deepEqual(
      result.runs.map((r) => r.script),
      ['scripts/build-tokens.mjs', 'scripts/build-catalog.mjs'],
    )
    const byScript = new Map(result.runs.map((r) => [r.script, r]))
    assert.equal(byScript.get('scripts/build-tokens.mjs')?.status, 'ok')
    assert.ok(byScript.get('scripts/build-tokens.mjs')?.stdout.includes('wrote foundations/tokens.css'))
    assert.equal(byScript.get('scripts/build-catalog.mjs')?.status, 'ok')
    assert.ok(byScript.get('scripts/build-catalog.mjs')?.stdout.includes('wrote catalog/index.html'))
  } finally {
    rmSync(bundle, { recursive: true, force: true })
  }
})

run('a generator named in the manifest but not yet stamped reports missing, not failure', async () => {
  const bundle = makeExampleCopy('ds-runner-missing-')
  try {
    const manifestPath = join(bundle, 'design-system.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.derived['docs/extra.html'] = 'scripts/build-extra.mjs'
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    const result = await regenerateBundleDerivedFiles(bundle, nodeFork)
    assert.equal(result.ok, true, JSON.stringify(result))
    const unstamped = result.runs.find((r) => r.script === 'scripts/build-extra.mjs')
    assert.equal(unstamped?.status, 'missing')
  } finally {
    rmSync(bundle, { recursive: true, force: true })
  }
})

run('surfaces a failing generator script with its exit code and stderr', async () => {
  const bundle = makeExampleCopy('ds-runner-fail-')
  try {
    writeFileSync(join(bundle, 'foundations', 'tokens.tokens.json'), '{ not json')
    const result = await regenerateBundleDerivedFiles(bundle, nodeFork)
    assert.equal(result.ok, false)
    assert.ok(result.message?.includes('scripts/build-tokens.mjs'), result.message)
    const failed = result.runs.find((r) => r.script === 'scripts/build-tokens.mjs')
    assert.equal(failed?.status, 'failed')
    assert.equal(failed?.exitCode, 2)
    assert.ok(failed?.stderr.includes('not valid JSON'), failed?.stderr)
  } finally {
    rmSync(bundle, { recursive: true, force: true })
  }
})

run('a manifest derived script resolving outside the bundle is refused before any fork', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'ds-runner-escape-'))
  try {
    // Bundle nested so ../../evil.mjs resolves to a real planted script whose
    // execution would be observable — the marker file must never appear.
    const bundle = join(outer, 'nest', 'bundle')
    mkdirSync(join(outer, 'nest'), { recursive: true })
    cpSync(exampleRoot, bundle, { recursive: true })
    const marker = join(outer, 'pwned.txt')
    writeFileSync(
      join(outer, 'evil.mjs'),
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'forked outside the bundle')\n`,
    )
    const manifestPath = join(bundle, 'design-system.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.derived = { x: '../../evil.mjs' }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    const result = await regenerateBundleDerivedFiles(bundle, nodeFork)
    assert.equal(result.ok, false)
    assert.ok(result.message?.includes('refused'), result.message)
    const refused = result.runs.find((r) => r.script === '../../evil.mjs')
    assert.equal(refused?.status, 'failed')
    assert.equal(refused?.exitCode, null)
    assert.ok(refused?.stderr.includes('bundle-relative'), refused?.stderr)
    assert.ok(!existsSync(marker), 'the escaping script must never be forked')

    // Absolute paths and non-.mjs entries are refused by the same guard.
    manifest.derived = { x: join(outer, 'evil.mjs'), y: 'scripts/build-tokens.js' }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    const absolute = await regenerateBundleDerivedFiles(bundle, nodeFork)
    assert.equal(absolute.ok, false)
    assert.ok(absolute.runs.every((r) => r.status === 'failed' && r.exitCode === null))
    assert.ok(!existsSync(marker))
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
})

run('bundle scripts see only the allowlisted env, never the full main-process env', async () => {
  const bundle = makeExampleCopy('ds-runner-env-')
  try {
    const printEnv = join(bundle, 'scripts', 'print-env.mjs')
    writeFileSync(printEnv, 'process.stdout.write(JSON.stringify(Object.keys(process.env)))\n')

    // The projection utilityProcess.fork receives (utility-process-fork.ts
    // passes bundleScriptEnv(process.env) as env) applied to a real forked
    // process: only allowlisted variables survive.
    const env = bundleScriptEnv({
      ...process.env,
      MULTICODE_FAKE_MAIN_SECRET: 'must-not-leak',
      AWS_SECRET_ACCESS_KEY: 'must-not-leak',
    })
    const child = spawn(process.execPath, [printEnv], { cwd: bundle, env })
    const stdout = await new Promise<string>((resolve, reject) => {
      let out = ''
      child.stdout.on('data', (chunk) => {
        out += String(chunk)
      })
      child.on('error', reject)
      child.on('close', () => resolve(out))
    })
    const keys = JSON.parse(stdout) as string[]
    assert.ok(!keys.includes('MULTICODE_FAKE_MAIN_SECRET'), JSON.stringify(keys))
    assert.ok(!keys.includes('AWS_SECRET_ACCESS_KEY'), JSON.stringify(keys))
    const allowed = new Set<string>(BUNDLE_SCRIPT_ENV_ALLOWLIST)
    // macOS injects __CF_USER_TEXT_ENCODING into every spawned process at the
    // libc level; it does not come from the projection under test.
    const platformInjected = /^__CF_/
    for (const key of keys) {
      assert.ok(
        allowed.has(key) || platformInjected.test(key),
        `unexpected env variable reached the bundle script: ${key}`,
      )
    }
    assert.ok(keys.includes('PATH'), 'the allowlist must keep PATH for the forked runtime')
  } finally {
    rmSync(bundle, { recursive: true, force: true })
  }
})

run('an unreadable or invalid manifest is an observable failure, not a silent skip', async () => {
  const bundle = mkdtempSync(join(tmpdir(), 'ds-runner-badmanifest-'))
  try {
    writeFileSync(join(bundle, 'design-system.json'), '{')
    const result = await regenerateBundleDerivedFiles(bundle, nodeFork)
    assert.equal(result.ok, false)
    assert.ok(result.message && result.message.length > 0)
    assert.equal(result.runs.length, 0)
  } finally {
    rmSync(bundle, { recursive: true, force: true })
  }
})

run('discovers the root itself as a bundle, or direct children carrying a manifest', async () => {
  const bundle = makeExampleCopy('ds-runner-discover-')
  const workspace = mkdtempSync(join(tmpdir(), 'ds-runner-workspace-'))
  try {
    assert.deepEqual(await discoverBundleDirs(bundle), [bundle])
    cpSync(bundle, join(workspace, 'design-system'), { recursive: true })
    mkdirSync(join(workspace, 'mockups'))
    assert.deepEqual(await discoverBundleDirs(workspace), [join(workspace, 'design-system')])
  } finally {
    rmSync(bundle, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})

run('a missing or non-directory root is an observable failure, not a silent ok', async () => {
  const missing = await regenerateDesignSystemDerivedFiles(
    join(tmpdir(), 'ds-runner-does-not-exist-xyzzy'),
    nodeFork,
  )
  assert.equal(missing.ok, false)
  assert.deepEqual(missing.bundles, [])
  assert.ok(missing.message?.includes('missing or unreadable'), missing.message)

  const filePath = join(mkdtempSync(join(tmpdir(), 'ds-runner-fileroot-')), 'not-a-dir.txt')
  try {
    writeFileSync(filePath, 'x')
    const fileRoot = await regenerateDesignSystemDerivedFiles(filePath, nodeFork)
    assert.equal(fileRoot.ok, false)
    assert.ok(fileRoot.message?.includes('not a directory'), fileRoot.message)
  } finally {
    rmSync(join(filePath, '..'), { recursive: true, force: true })
  }
})

run('a root without any bundle is a successful no-op (existing flows untouched)', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ds-runner-nobundle-'))
  try {
    mkdirSync(join(workspace, 'mockups'))
    const result = await regenerateDesignSystemDerivedFiles(workspace, nodeFork)
    assert.deepEqual(result, { ok: true, bundles: [] })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

run('regenerates every discovered bundle under a workspace root', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ds-runner-multi-'))
  try {
    cpSync(exampleRoot, join(workspace, 'design-system'), { recursive: true })
    rmSync(join(workspace, 'design-system', 'foundations', 'tokens.css'))
    const result = await regenerateDesignSystemDerivedFiles(workspace, nodeFork)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.bundles.length, 1)
    assert.ok(existsSync(join(workspace, 'design-system', 'foundations', 'tokens.css')))
  } finally {
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
  console.log('derived-file-runner.test.ts: ok')
}

void main()
