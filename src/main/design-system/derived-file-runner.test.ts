import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

run('regenerates derived files for a bundle, reporting unstamped generators as missing', async () => {
  const bundle = makeExampleCopy('ds-runner-ok-')
  try {
    rmSync(join(bundle, 'foundations', 'tokens.css'))
    const result = await regenerateBundleDerivedFiles(bundle, nodeFork)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(existsSync(join(bundle, 'foundations', 'tokens.css')), 'tokens.css was not regenerated')
    const byScript = new Map(result.runs.map((r) => [r.script, r]))
    assert.equal(byScript.get('scripts/build-tokens.mjs')?.status, 'ok')
    assert.ok(byScript.get('scripts/build-tokens.mjs')?.stdout.includes('wrote foundations/tokens.css'))
    // The example manifest already names the catalog generator; it lands with
    // the catalog task, so today it must surface as missing — not as failure.
    assert.equal(byScript.get('scripts/build-catalog.mjs')?.status, 'missing')
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
