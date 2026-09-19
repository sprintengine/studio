import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BundleScriptFork } from './bundle-lint-run'
import { runDesignSystemBundleLint } from './bundle-lint-run'
import { test } from 'vitest'

test('bundle-lint-run', async () => {
  // Same node fork stand-in as library-registry.test.ts: the bundle's real
  // lint script runs under plain node with the production argv contract.
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

  function makeExampleCopy(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ds-lint-run-'))
    cpSync(exampleRoot, dir, { recursive: true })
    return dir
  }

  async function main(): Promise<void> {
    // Clean bundle lints ok.
    const clean = makeExampleCopy()
    try {
      assert.deepEqual(await runDesignSystemBundleLint(clean, nodeFork), { ok: true })
    } finally {
      rmSync(clean, { recursive: true, force: true })
    }
    console.log('ok - a clean example bundle lints ok')

    // A raw-hex violation surfaces as findings, never a throw or silent pass.
    const dirty = makeExampleCopy()
    try {
      writeFileSync(join(dirty, 'components', 'button', 'component.css'), '.button { color: #ff0000; }\n')
      const result = await runDesignSystemBundleLint(dirty, nodeFork)
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.equal(result.kind, 'findings')
        if (result.kind === 'findings') {
          assert.match(result.findings, /hex|token/i, 'findings carry the lint report')
        }
      }
    } finally {
      rmSync(dirty, { recursive: true, force: true })
    }
    console.log('ok - violations return the findings')

    // A bundle without its lint script is an error (not a complete bundle), and
    // the message explains that rather than pretending a pass.
    const bare = mkdtempSync(join(tmpdir(), 'ds-lint-bare-'))
    try {
      const result = await runDesignSystemBundleLint(bare, nodeFork)
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.equal(result.kind, 'error')
        if (result.kind === 'error') assert.match(result.message, /lint script/)
      }
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
    console.log('ok - a missing lint script is a typed error')

    console.log('bundle-lint-run.test.ts: ok')
  }

  const suiteRun = main()

  await suiteRun
})
