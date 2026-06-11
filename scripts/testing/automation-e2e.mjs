#!/usr/bin/env node
// End-to-end acceptance run for the app-automation MCP server (T10):
//   Phase A — fresh profile, setting off (default): nothing listens.
//   Phase B — setting enabled: the external client (scripts/automation-demo.mjs)
//   performs create-workspace → launch-agent → read-status against the running
//   app, and a screenshot captures the created workspace/agent in the UI.
//
// Run after `npm run build`:
//   NODE_PATH=/tmp/multicode-playwright/node_modules node scripts/testing/automation-e2e.mjs

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const userDataDir = process.env.MULTICODE_AUTOMATION_E2E_PROFILE || '/tmp/multicode-automation-e2e-profile'
const screenshotPath = process.env.MULTICODE_AUTOMATION_E2E_SCREENSHOT || '/tmp/multicode-automation-e2e.png'
const agentCli = process.env.MULTICODE_AUTOMATION_E2E_CLI || 'claude-code'

function loadPlaywright() {
  try {
    return require('playwright')
  } catch {
    throw new Error(
      'Playwright is unavailable. Install it or run with NODE_PATH=/tmp/multicode-playwright/node_modules.'
    )
  }
}

async function launchApp(electron) {
  const electronPath = require('electron')
  const app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out/main/index.js')],
    cwd: root,
    env: {
      ...process.env,
      MULTICODE_USER_DATA_DIR: userDataDir,
      MULTICODE_ALLOW_MULTI_INSTANCE: '1',
    },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)
  return { app, page }
}

async function runDemo(args) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [join(root, 'scripts/automation-demo.mjs'), '--user-data-dir', userDataDir, ...args],
      { timeout: 90_000 }
    )
    return { code: 0, output: `${stdout}${stderr}` }
  } catch (error) {
    return { code: error.code ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

async function main() {
  const { _electron: electron } = loadPlaywright()

  rmSync(userDataDir, { recursive: true, force: true })
  mkdirSync(userDataDir, { recursive: true })

  // ── Phase A: default (disabled) — nothing listens ─────────────────────────
  console.log('## Phase A: automation disabled by default')
  {
    const { app } = await launchApp(electron)
    try {
      if (existsSync(join(userDataDir, 'automation-server-info.json'))) {
        throw new Error('Discovery file exists with the setting off — the server must not start by default.')
      }
      console.log('phase A: no automation-server-info.json with default settings — OK')
      const demo = await runDemo(['--list-only'])
      if (demo.code === 0) {
        throw new Error('External client connected while the setting is off.')
      }
      console.log(`phase A: external client cannot connect (exit ${demo.code}) — OK`)
    } finally {
      await app.close()
    }
  }

  // ── Phase B: enable the persisted setting, relaunch, drive the demo ───────
  console.log('## Phase B: automation enabled')
  writeFileSync(join(userDataDir, 'automation-settings.json'), JSON.stringify({ enabled: true }, null, 2))
  {
    const { app, page } = await launchApp(electron)
    try {
      if (!existsSync(join(userDataDir, 'automation-server-info.json'))) {
        throw new Error('Discovery file missing with the setting enabled — the server did not start.')
      }
      console.log('phase B: automation-server-info.json present — server is listening')

      const demo = await runDemo(['--cli', agentCli])
      console.log(demo.output)
      if (demo.code !== 0 || !demo.output.includes('AUTOMATION DEMO OK')) {
        throw new Error(`automation-demo failed with exit ${demo.code}`)
      }

      // Let the created workspace/agent terminal render, then capture the UI.
      await page.waitForTimeout(3000)
      await page.screenshot({ path: screenshotPath, fullPage: true })
      console.log(`phase B: screenshot written to ${screenshotPath}`)

      const bodyText = await page.locator('body').innerText()
      if (!bodyText.includes('Automation Demo')) {
        throw new Error('Created workspace name is not visible in the UI.')
      }
      console.log('phase B: created workspace is visible in the UI — OK')
    } finally {
      await app.close()
    }
  }

  console.log('AUTOMATION E2E OK')
}

main().catch((error) => {
  console.error(`AUTOMATION E2E FAILED: ${error.message}`)
  process.exit(1)
})
