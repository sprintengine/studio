#!/usr/bin/env node
// End-to-end proof for the third-party renderer module pipeline (T2 keystone):
// a real unsigned example module is installed into an isolated module root,
// trusted through the real Settings → Modules UI, and after a relaunch its
// entry.renderer bundle loads in the live renderer and contributes a command
// that appears in the palette and executes. A deliberately broken bundle rides
// along to prove per-module failure isolation, and the enable toggle is
// exercised live to prove no-reload enablement reactivity. No mocks anywhere:
// real discovery, real trust store, real IPC serving, real blob-URL import.
//
// Prereqs: `npm run build` (needs out/main), playwright available (see
// electron-playwright-smoke.mjs for the NODE_PATH recipe).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = resolve(new URL('../..', import.meta.url).pathname)
const primaryKey = process.platform === 'darwin' ? 'Meta' : 'Control'

const GOOD_ID = 'example-e2e'
const GOOD_NAME = 'Example E2E'
const BROKEN_ID = 'example-broken'
const BROKEN_NAME = 'Example Broken'
const PALETTE_ROW = 'Example E2E: Hello'

async function loadPlaywright() {
  try {
    return require('playwright')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      [
        'Playwright is not available to this Node process.',
        'Install it locally, or run:',
        '  tmp=/tmp/multicode-playwright',
        '  npm --prefix "$tmp" install playwright --no-audit --no-fund',
        '  NODE_PATH="$tmp/node_modules" node scripts/testing/third-party-module-e2e.mjs',
        `Original error: ${message}`,
      ].join('\n'),
    )
  }
}

async function writeModules(moduleRoot) {
  const good = join(moduleRoot, GOOD_ID)
  await mkdir(good, { recursive: true })
  await writeFile(
    join(good, 'manifest.json'),
    JSON.stringify({
      id: GOOD_ID,
      displayName: GOOD_NAME,
      version: 1,
      summary: 'E2E fixture: contributes one palette command.',
      entry: { renderer: 'renderer.js' },
    }),
  )
  await writeFile(
    join(good, 'renderer.js'),
    [
      'export function registerRenderer(host) {',
      '  host.registerCommand({',
      "    id: 'hello',",
      "    title: 'Hello',",
      `    category: '${GOOD_NAME}',`,
      "    scopes: ['global'],",
      '    run() { globalThis.__exampleE2eRan = true },',
      '  })',
      '}',
    ].join('\n'),
  )

  const broken = join(moduleRoot, BROKEN_ID)
  await mkdir(broken, { recursive: true })
  await writeFile(
    join(broken, 'manifest.json'),
    JSON.stringify({
      id: BROKEN_ID,
      displayName: BROKEN_NAME,
      version: 1,
      summary: 'E2E fixture: bundle throws at import time.',
      entry: { renderer: 'renderer.js' },
    }),
  )
  await writeFile(join(broken, 'renderer.js'), "throw new Error('deliberately broken bundle')\n")
}

async function launchApp(electron, env) {
  const electronPath = require('electron')
  const app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out/main/index.js')],
    cwd: root,
    env: { ...process.env, ...env },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

// A fresh profile boots into onboarding; the e2e is about the module pipeline,
// so mark module selection as already done through the same persisted-settings
// envelope the store writes, then reload to hydrate from it.
async function skipOnboarding(page) {
  await page.evaluate(() => {
    localStorage.setItem(
      'multicode-app-settings',
      JSON.stringify({ state: { appSettings: { modulesChosen: true }, sidebarCollapsed: false }, version: 59 }),
    )
  })
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1200)
}

async function openModulesSettings(page) {
  await page.keyboard.press(`${primaryKey}+Comma`)
  await page.getByRole('tab', { name: 'Modules' }).click()
  await page.getByText('Third-party modules').first().waitFor({ timeout: 10_000 })
}

async function closeOverlays(page) {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
}

async function openPaletteAndSearch(page, query) {
  await page.keyboard.press(`${primaryKey}+KeyK`)
  const input = page.getByPlaceholder('Type a command or search...')
  await input.waitFor({ timeout: 5_000 })
  await input.fill(query)
  await page.waitForTimeout(300)
}

function moduleRow(page, displayName) {
  return page
    .locator('div.flex.flex-col.gap-2')
    .filter({ has: page.getByText(displayName, { exact: true }) })
}

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  const mark = ok ? 'ok' : 'FAIL'
  console.log(`${mark} - ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) process.exitCode = 1
}

async function main() {
  const { _electron: electron } = await loadPlaywright()
  const userDataDir = await mkdtemp(join(tmpdir(), 'mc-tpm-e2e-profile-'))
  const moduleRoot = await mkdtemp(join(tmpdir(), 'mc-tpm-e2e-modules-'))
  const env = {
    MULTICODE_USER_DATA_DIR: userDataDir,
    MULTICODE_USER_MODULE_ROOT: moduleRoot,
    MULTICODE_ALLOW_MULTI_INSTANCE: '1',
    MULTICODE_DIAGNOSTICS: '1',
  }

  await writeModules(moduleRoot)

  // ── Session 1: discovery shows untrusted modules; trust them via the UI ──
  {
    const { app, page } = await launchApp(electron, env)
    try {
      await skipOnboarding(page)

      // AC3 (behavioral half): before trust, the renderer never evaluated the
      // bundle — its command is absent from the palette.
      await openPaletteAndSearch(page, GOOD_NAME)
      check(
        'untrusted module contributes nothing',
        (await page.getByText(PALETTE_ROW).count()) === 0,
      )
      await closeOverlays(page)

      await openModulesSettings(page)
      const goodRow = moduleRow(page, GOOD_NAME)
      await goodRow.first().waitFor({ timeout: 10_000 })
      // AC3 (status half): the untrusted module's blocked state is visible.
      check(
        'untrusted module shows its trust status',
        (await goodRow.getByText('Unsigned', { exact: true }).count()) > 0,
      )

      await goodRow.getByRole('switch', { name: `Trust ${GOOD_NAME}` }).click()
      await goodRow.getByText('Renderer entry ready').waitFor({ timeout: 10_000 })
      check('trusting via UI marks the renderer entry ready for next launch', true)

      const brokenRow = moduleRow(page, BROKEN_NAME)
      await brokenRow.getByRole('switch', { name: `Trust ${BROKEN_NAME}` }).click()
      await brokenRow.getByText('Renderer entry ready').waitFor({ timeout: 10_000 })
    } finally {
      await app.close()
    }
  }

  // ── Session 2: trusted entries load at boot; contribution is live ─────────
  {
    const { app, page } = await launchApp(electron, env)
    try {
      await page.waitForTimeout(1500)

      // AC1: the contribution appears in the palette and executes its handler.
      await openPaletteAndSearch(page, GOOD_NAME)
      await page.getByText(PALETTE_ROW).first().waitFor({ timeout: 10_000 })
      check('trusted module command appears in the palette', true)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(300)
      check(
        'module handler executed',
        await page.evaluate(() => globalThis.__exampleE2eRan === true),
      )

      // AC4: the broken bundle records a per-module error; the shell and the
      // healthy neighbor are unaffected (the palette assertion above already
      // proved the neighbor).
      await openModulesSettings(page)
      const goodRow = moduleRow(page, GOOD_NAME)
      check(
        'loaded module reports Renderer entry loaded',
        (await goodRow.getByText('Renderer entry loaded').count()) > 0,
      )
      const brokenRow = moduleRow(page, BROKEN_NAME)
      check(
        'broken bundle reports a per-module load error',
        (await brokenRow.getByText('Renderer entry failed').count()) > 0,
      )
      check(
        'broken bundle error message is surfaced',
        (await brokenRow.getByText(/deliberately broken bundle/).count()) > 0,
      )

      // AC2: toggling the module off removes the contribution without a
      // reload; re-enabling restores it.
      await goodRow.getByRole('switch', { name: 'Enable contributions' }).click()
      await page.waitForTimeout(300)
      await closeOverlays(page)
      await openPaletteAndSearch(page, GOOD_NAME)
      check(
        'disabling the module removes its palette command without reload',
        (await page.getByText(PALETTE_ROW).count()) === 0,
      )
      await closeOverlays(page)

      await openModulesSettings(page)
      await moduleRow(page, GOOD_NAME).getByRole('switch', { name: 'Enable contributions' }).click()
      await page.waitForTimeout(300)
      await closeOverlays(page)
      await openPaletteAndSearch(page, GOOD_NAME)
      await page.getByText(PALETTE_ROW).first().waitFor({ timeout: 5_000 })
      check('re-enabling restores the palette command without reload', true)
    } finally {
      await app.close()
    }
  }

  await rm(userDataDir, { recursive: true, force: true })
  await rm(moduleRoot, { recursive: true, force: true })

  const failed = checks.filter((entry) => !entry.ok)
  console.log(
    JSON.stringify(
      { ok: failed.length === 0, checks: checks.length, failed: failed.map((entry) => entry.name) },
      null,
      2,
    ),
  )
  if (failed.length > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exit(1)
})
