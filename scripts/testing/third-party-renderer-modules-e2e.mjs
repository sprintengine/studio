#!/usr/bin/env node

// End-to-end acceptance harness for third-party `entry.renderer` loading
// (sprint task T2). Launches the real built app through Playwright `_electron`
// with an isolated profile (MULTICODE_USER_DATA_DIR) and an isolated module
// root (HOME override → ~/.multicode/modules), then drives the real flows:
//
//   Session 1: seed onboarding-complete app settings and reload so the store
//              hydrates from the seed (a fresh profile boots into onboarding);
//              trust the example + broken modules through the real
//              Settings → Modules switches; assert the untrusted module reads
//              blocked and the reserved-id folder is rejected.
//   Session 2: assert the trusted bundle evaluated (import-map React resolved,
//              command in the palette, marker global set), the broken bundle
//              has a per-module error without harming neighbors or the shell,
//              the untrusted bundle never evaluated, and the enable toggle
//              removes/restores contributions live without a reload.
//
// No mocks: trust state flows through the real trust store, bundles over the
// real IPC channel, registration through the real renderer host.
//
// Run after `npm run build`:
//   NODE_PATH=/tmp/multicode-playwright/node_modules node scripts/testing/third-party-renderer-modules-e2e.mjs

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { resolveMainWindow } from './newChatWorkspace.mjs'

const require = createRequire(import.meta.url)
const root = resolve(new URL('../..', import.meta.url).pathname)
const scratch = process.env.MULTICODE_PW_SCRATCH || '/tmp/multicode-third-party-renderer-e2e'
const homeDir = join(scratch, 'home')
const userDataDir = join(scratch, 'user-data')
const primaryModifier = process.platform === 'darwin' ? { metaKey: true } : { ctrlKey: true }

let failures = 0
function check(name, condition) {
  if (condition) {
    console.log(`ok - ${name}`)
  } else {
    failures += 1
    console.error(`not ok - ${name}`)
  }
}

// Progress marker so a hang is attributable to a step instead of reading as
// silence (Playwright awaits like firstWindow/reload have no native timeout).
function step(name) {
  console.log(`# ${name}`)
}

async function loadPlaywright() {
  try {
    return require('playwright')
  } catch {
    try {
      return require('playwright-core')
    } catch (error) {
      throw new Error(
        'Playwright is not available. Install it (e.g. npm --prefix /tmp/multicode-playwright install playwright) ' +
          `and re-run with NODE_PATH set. Original error: ${error instanceof Error ? error.message : error}`
      )
    }
  }
}

async function seedModules() {
  const modulesRoot = join(homeDir, '.multicode', 'modules')

  const write = async (id, manifest, rendererSource) => {
    const dir = join(modulesRoot, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    if (rendererSource !== undefined) await writeFile(join(dir, 'renderer.js'), rendererSource)
  }

  // Example module: exercises the shared-React import map, registerCommand,
  // and an evaluation marker the harness can observe directly.
  await write(
    'pw-example',
    {
      id: 'pw-example',
      displayName: 'Playwright Example',
      version: 1,
      summary: 'E2E example third-party renderer module.',
      defaultEnabled: true,
      source: 'third-party',
      entry: { renderer: 'renderer.js' },
    },
    [
      "import React from 'react'",
      "import { useState } from 'react'",
      "if (typeof React.createElement !== 'function' || typeof useState !== 'function') {",
      "  throw new Error('shared React runtime missing')",
      '}',
      'globalThis.__pwExampleRan = true',
      'export function registerRenderer(host) {',
      '  host.registerCommand({',
      "    id: 'hello',",
      "    title: 'Playwright Example Hello',",
      "    category: 'Playwright Example',",
      "    scopes: ['global'],",
      '    run: () => { globalThis.__pwExampleCommandRan = true },',
      '  })',
      '}',
      '',
    ].join('\n')
  )

  // Broken module: throws at import time; must yield a per-module error and
  // leave neighbors and the shell intact.
  await write(
    'pw-broken',
    {
      id: 'pw-broken',
      displayName: 'Broken Module',
      version: 1,
      defaultEnabled: true,
      source: 'third-party',
      entry: { renderer: 'renderer.js' },
    },
    "throw new Error('pw-broken exploded at import')\n"
  )

  // Untrusted module: never trusted; its bundle must never evaluate.
  await write(
    'pw-untrusted',
    {
      id: 'pw-untrusted',
      displayName: 'Untrusted Module',
      version: 1,
      defaultEnabled: true,
      source: 'third-party',
      entry: { renderer: 'renderer.js' },
    },
    'globalThis.__pwUntrustedRan = true\nexport function registerRenderer() {}\n'
  )

  // Reserved-id folder: discovery must reject it with an explicit error.
  await write('git', {
    id: 'git',
    displayName: 'Impostor Git',
    version: 1,
    source: 'third-party',
    entry: { renderer: 'renderer.js' },
  })
}

// Apps launched in the current session, closed in main()'s finally so a
// failed run never leaves an Electron holding the scratch profile (the
// leftover instance then wedges the next run's launch).
const liveApps = new Set()

async function closeLiveApps() {
  for (const app of liveApps) {
    try {
      await app.close()
    } catch {
      // Best-effort cleanup; the process exits right after.
    }
  }
  liveApps.clear()
}

async function launch(electron, electronPath) {
  step('launching electron')
  // When this harness runs from a terminal inside a Multicode dev session,
  // the inherited env carries the dev-server wiring (ELECTRON_RENDERER_URL,
  // NODE_ENV_ELECTRON_VITE). Passing those through makes the launched app
  // render from the live dev server instead of out/renderer — cross-talk with
  // the dev session and HMR reload hangs. Strip them so the built bundle runs.
  const env = { ...process.env }
  delete env.ELECTRON_RENDERER_URL
  delete env.NODE_ENV_ELECTRON_VITE
  delete env.ELECTRON_CLI_ARGS
  const app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out/main/index.js')],
    cwd: root,
    env: {
      ...env,
      HOME: homeDir,
      MULTICODE_USER_DATA_DIR: userDataDir,
      MULTICODE_ALLOW_MULTI_INSTANCE: '1',
      MULTICODE_DIAGNOSTICS: '1',
    },
  })
  liveApps.add(app)
  const proc = app.process()
  proc.stdout?.on('data', (chunk) => process.stdout.write(`[app] ${chunk}`))
  proc.stderr?.on('data', (chunk) => process.stderr.write(`[app] ${chunk}`))
  step('waiting for first window')
  const page = await resolveMainWindow(app)
  await page.waitForLoadState('domcontentloaded')
  step('window ready')
  return { app, page }
}

// Playwright's keyboard.press awaits the renderer's input ack and has no
// timeout; in this environment that await intermittently never resolves and
// wedges the whole run. Drive shortcuts as synthetic DOM keydown events
// instead — the renderer command dispatcher listens on window keydown and the
// app has no isTrusted checks — and open Settings through its real top-bar
// button. Clicks (CDP mouse path) have been reliable throughout.
async function dispatchKey(page, key, modifiers = {}) {
  await page.evaluate(
    ([eventKey, mods]) => {
      const target = document.activeElement ?? window
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: eventKey, bubbles: true, cancelable: true, ...mods })
      )
    },
    [key, modifiers]
  )
}

// Open Settings the way the real app menu does: the main process sends
// `app-menu:command` / `app.settings.open` to the window. A fresh profile has
// no workspace yet, so the top-bar gear button may not exist, and the menu
// accelerator (Cmd+,) is unreachable because keyboard.press wedges (above).
async function openModulesSettings(app, page) {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('app-menu:command', 'app.settings.open')
  })
  const modulesTab = page.locator('#settings-tab-modules')
  await modulesTab.waitFor({ state: 'visible', timeout: 10000 })
  await modulesTab.click()
  await page.locator('text=Third-party modules').waitFor({ state: 'visible', timeout: 10000 })
}

async function main() {
  const { _electron: electron } = await loadPlaywright()
  const electronPath = require('electron')

  await rm(scratch, { recursive: true, force: true })
  await mkdir(homeDir, { recursive: true })
  await mkdir(userDataDir, { recursive: true })
  await seedModules()

  // ── Session 1: trust through the real Settings → Modules switches ──
  {
    step('session 1 start')
    const { app, page } = await launch(electron, electronPath)
    // A fresh profile boots into onboarding. Seed the persisted-settings
    // envelope the store reads, then reload so the store hydrates from it —
    // seeding without the reload is lost when the live store next persists
    // its own (still-onboarding) state.
    step('seeding onboarding-complete settings')
    await page.evaluate(() => {
      window.localStorage.setItem(
        'multicode-app-settings',
        JSON.stringify({
          state: {
            appSettings: {
              modulesChosen: true,
              onboardingStep: 'complete',
              // The tip-of-the-day modal otherwise opens over Settings at every
              // session start and intercepts the harness clicks.
              learning: { showTipsOnStartup: false },
            },
          },
          version: 59,
        })
      )
    })
    step('reloading to hydrate from seed')
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(1200)
    step('opening modules settings')
    await openModulesSettings(app, page)

    const untrustedRow = page.locator('text=Blocked until trusted').first()
    await untrustedRow.waitFor({ state: 'visible', timeout: 10000 })
    check('untrusted modules read blocked before any trust', true)

    const rejectedNote = await page.locator('text=reserved built-in module id').count()
    check('reserved-id manifest is rejected with an explicit error', rejectedNote > 0)

    await page.locator('[aria-label="Trust Playwright Example"]').click()
    await page.locator('[aria-label="Trust Broken Module"][aria-checked="true"], [aria-label="Trust Playwright Example"][aria-checked="true"]').first().waitFor({ timeout: 10000 })
    await page.locator('[aria-label="Trust Broken Module"]').click()
    await page.locator('[aria-label="Trust Broken Module"][aria-checked="true"]').waitFor({ timeout: 10000 })
    check('example and broken modules trusted through the real switch', true)

    // Renderer entries are boot-loaded; a just-trusted module honestly reads
    // as next-launch.
    const readyCount = await page.locator('text=Renderer entry ready').count()
    check('just-trusted module reads "Renderer entry ready" (next launch)', readyCount >= 1)

    await app.close()
  }

  // ── Session 2: boot-loading, isolation, blocking, live toggle ──
  {
    step('session 2 start')
    const { app, page } = await launch(electron, electronPath)
    await page.waitForTimeout(1500)

    check(
      'trusted example bundle evaluated (marker global set)',
      (await page.evaluate(() => globalThis.__pwExampleRan)) === true
    )
    check(
      'untrusted bundle never evaluated',
      (await page.evaluate(() => globalThis.__pwUntrustedRan)) === undefined
    )
    check(
      'shell rendered despite the broken bundle (no renderer crash)',
      (await page.locator('#root *').count()) > 0
    )

    // Contribution appears: the module command is in the palette.
    await dispatchKey(page, 'k', primaryModifier)
    const paletteInput = page.locator('input[type="text"]:visible, input[placeholder]:visible').first()
    await paletteInput.waitFor({ state: 'visible', timeout: 10000 })
    await paletteInput.fill('Playwright Example')
    await page.waitForTimeout(300)
    check(
      'module command appears in the palette under its own module',
      (await page.locator('text=Playwright Example Hello').count()) > 0
    )
    await dispatchKey(page, 'Escape')

    // Per-module states in Settings → Modules.
    await openModulesSettings(app, page)
    check(
      'loaded module reads "Renderer entry loaded"',
      (await page.locator('text=Renderer entry loaded').count()) >= 1
    )
    check(
      'broken module reads "Renderer entry failed" with its error',
      (await page.locator('text=pw-broken exploded at import').count()) >= 1
    )
    check(
      'untrusted module still reads blocked',
      (await page.locator('text=Blocked until trusted').count()) >= 1
    )

    // Live disable: contribution gone everywhere without a reload.
    await page.locator('text=Enable contributions').first().waitFor({ state: 'visible', timeout: 10000 })
    const enableSwitch = page
      .locator('div', { hasText: 'Playwright Example' })
      .locator('[role="switch"][aria-checked="true"]')
      .last()
    await enableSwitch.click()
    await dispatchKey(page, 'Escape')
    await dispatchKey(page, 'k', primaryModifier)
    await paletteInput.waitFor({ state: 'visible', timeout: 10000 })
    await paletteInput.fill('Playwright Example')
    await page.waitForTimeout(300)
    check(
      'disabling the module removes its command without a reload',
      (await page.locator('text=Playwright Example Hello').count()) === 0
    )
    await dispatchKey(page, 'Escape')

    // Live re-enable: contribution restored.
    await openModulesSettings(app, page)
    const reEnableSwitch = page
      .locator('div', { hasText: 'Playwright Example' })
      .locator('[role="switch"][aria-checked="false"]')
      .last()
    await reEnableSwitch.click()
    await dispatchKey(page, 'Escape')
    await dispatchKey(page, 'k', primaryModifier)
    await paletteInput.waitFor({ state: 'visible', timeout: 10000 })
    await paletteInput.fill('Playwright Example')
    await page.waitForTimeout(300)
    check(
      're-enabling restores the command without a reload',
      (await page.locator('text=Playwright Example Hello').count()) > 0
    )

    await page.screenshot({ path: join(scratch, 'session2-final.png'), fullPage: true })
    await app.close()
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
  } else {
    console.log('\nthird-party renderer modules e2e passed')
  }
}

// Hard watchdog: a hung Playwright await (firstWindow, reload, …) must end the
// run with the last step marker on record, not park an Electron forever.
const watchdog = setTimeout(() => {
  console.error('not ok - harness watchdog expired (last step above is the hang point)')
  void closeLiveApps().finally(() => process.exit(1))
}, 240_000)
watchdog.unref()

main()
  .catch((error) => {
    failures += 1
    console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  })
  .finally(async () => {
    await closeLiveApps()
    process.exit(failures > 0 ? 1 : 0)
  })
