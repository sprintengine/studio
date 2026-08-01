#!/usr/bin/env node

// T12 real-app drive validation of the landed module platform
// (sprint module-extraction-marketplace). Drives the BUILT app through
// Playwright `_electron` with an isolated profile, an isolated module root,
// and ELECTRON_RENDERER_URL explicitly blank — the built renderer, never a
// dev server. Five checkpoints from the task card:
//
//   1a. Absence UX: a workspace whose mode's module is not installed renders
//       the explicit "isn't installed" surface with the module name and a
//       working install affordance routing to the extensions browse surface.
//   1b. A layout tab whose owning module is missing (and matches a
//       marketplace `module` entry) shows the upgraded surface too.
//   2.  Uninstall guard: distrusting a module with an open dependent
//       workspace lists that workspace in the confirmation dialog.
//   3.  Module surfacing: the Modules category renders in the extensions
//       browse surface with module-led card copy; a module-only plugin has
//       no launch affordance.
//   4.  Creation step: a registered type with a creationStep renders the
//       step pane, the entered value reaches the created workspace, and a
//       throwing step degrades to zero-config with the error surface.
//   5.  Supervisor mount: a third-party type's supervisor mounts and
//       observes session state via watchAgentSessions; its deriveRunGlyph
//       renders in the sidebar.
//
// The bundled marketplace index has no `module` entries yet, so the harness
// serves a fixture registry over a local self-signed HTTPS server via the
// documented MULTICODE_MARKETPLACE_REGISTRY_URL override, and pre-seeds the
// registry cache file so the offline/stale path also serves the fixture.
//
// Run after `npm run build`:
//   NODE_PATH=/tmp/multicode-playwright/node_modules node scripts/testing/module-platform-drive.mjs

import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile, readFile, copyFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = resolve(new URL('../..', import.meta.url).pathname)
const scratch = process.env.MULTICODE_PW_SCRATCH || '/tmp/multicode-t12-module-platform'
const homeDir = join(scratch, 'home')
const userDataDir = join(scratch, 'user-data')
const modulesFull = join(scratch, 'modules-full')
const modulesNoWidgets = join(scratch, 'modules-no-widgets')
const modulesEmpty = join(scratch, 'modules-empty')
const outDir = process.env.MULTICODE_T12_OUT_DIR || join(scratch, 'out')
const wsDeckDir = join(scratch, 'ws', 'deck-one')
const wsCrashDir = join(scratch, 'ws', 'crash-one')
const certDir = join(scratch, 'cert')

let registryPort = 0
const registryUrl = () => `https://127.0.0.1:${registryPort}/marketplace.json`

let failures = 0
const checks = []
function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail })
  if (condition) {
    console.log(`ok - ${name}`)
  } else {
    failures += 1
    console.error(`not ok - ${name}${detail ? ` (${detail})` : ''}`)
  }
}

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
        'Playwright is not available. Install it (npm --prefix /tmp/multicode-playwright install playwright) ' +
          `and re-run with NODE_PATH set. Original error: ${error instanceof Error ? error.message : error}`
      )
    }
  }
}

// ── Fixture registry ────────────────────────────────────────────────────────

const REGISTRY_FIXTURE = {
  schemaVersion: 1,
  plugins: [
    {
      id: 'pw-deck',
      name: 'Playwright Deck',
      publisher: { name: 'T12 Harness', verified: false },
      summary: 'Forecast board workspaces for the module platform drive.',
      category: 'Productivity',
      icon: 'icons/pw-deck.svg',
      latest: 1,
      source: 'https://example.invalid/plugins/pw-deck',
      provides: ['module'],
    },
    {
      id: 'pw-widgets',
      name: 'Playwright Widgets',
      publisher: { name: 'T12 Harness', verified: false },
      summary: 'Gauge panels that other workspaces embed.',
      category: 'Productivity',
      icon: 'icons/pw-widgets.svg',
      latest: 1,
      source: 'https://example.invalid/plugins/pw-widgets',
      provides: ['module'],
    },
    {
      // Contrast entry: a connector-kind plugin keeps its launch affordance,
      // proving the module rows specifically drop it.
      id: 'pw-skill-pack',
      name: 'Playwright Skill Pack',
      publisher: { name: 'T12 Harness', verified: false },
      summary: 'A skills bundle used as the launch-affordance contrast.',
      category: 'Productivity',
      icon: 'icons/pw-skill-pack.svg',
      latest: 1,
      source: 'https://example.invalid/plugins/pw-skill-pack',
      provides: ['skills'],
    },
  ],
}

async function startRegistryServer() {
  await mkdir(certDir, { recursive: true })
  const keyPath = join(certDir, 'key.pem')
  const certPath = join(certDir, 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '2',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' })
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)])
  const server = createServer({ key, cert }, (req, res) => {
    if (req.url && req.url.startsWith('/marketplace.json')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(REGISTRY_FIXTURE))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  registryPort = server.address().port
  return server
}

// Pre-seed the registry cache so even a refused TLS handshake serves the
// fixture through the documented offline/stale-cache path.
async function seedRegistryCache() {
  await mkdir(userDataDir, { recursive: true })
  await writeFile(
    join(userDataDir, 'marketplace-registry-cache.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        registryUrl: registryUrl(),
        fetchedAt: new Date().toISOString(),
        marketplace: REGISTRY_FIXTURE,
      },
      null,
      2
    )
  )
}

// ── Fixture modules ─────────────────────────────────────────────────────────

const PW_DECK_RENDERER = `
import React from 'react'
const { createElement: h, useEffect } = React

export function registerRenderer(host) {
  function ForecastPanel({ workspaceId }) {
    return h('div', { style: { padding: '12px', color: 'var(--text-muted)' } },
      'Forecast ready · workspace ' + workspaceId)
  }

  // Global supervisor: proves the mount, then observes real session state for
  // the workspace the harness names via watchAgentSessions (initial snapshot +
  // change events through the real terminal-sessions store).
  function DeckSupervisor() {
    useEffect(() => {
      globalThis.__pwDeckSupervisorMounted = true
      console.log('[pw-deck] supervisor mounted')
      let off = null
      const timer = setInterval(() => {
        const target = globalThis.__pwTargetWorkspaceId
        if (!target || off) return
        try {
          off = host.watchAgentSessions(target, (sessions) => {
            const entry = {
              at: new Date().toISOString(),
              workspaceId: target,
              sessionCount: sessions.length,
              liveCount: sessions.filter((s) => s.isLive).length,
              kinds: sessions.map((s) => s.kind),
            }
            const log = globalThis.__pwDeckSessionObservations || (globalThis.__pwDeckSessionObservations = [])
            log.push(entry)
            console.log('[pw-deck] supervisor observed sessions ' + JSON.stringify(entry))
          })
          globalThis.__pwDeckWatchAttached = true
        } catch (error) {
          globalThis.__pwDeckWatchError = String((error && error.message) || error)
        }
      }, 250)
      return () => {
        clearInterval(timer)
        if (off) off()
      }
    }, [])
    return null
  }

  function CityStep({ value, setValue }) {
    return h('input', {
      value: typeof value === 'string' ? value : '',
      placeholder: 'City to forecast',
      onChange: (event) => setValue(event.target.value),
    })
  }

  function CrashStep() {
    throw new Error('pw-crash creation step exploded')
  }

  host.registerPanel('pw-deck.forecast', ForecastPanel)

  host.registerWorkspaceType({
    id: 'pw-deck',
    label: 'Playwright Deck',
    description: 'Forecast board driven by the T12 harness.',
    icon: () => null,
    creationStep: {
      id: 'forecast-city',
      heading: 'Which city?',
      description: 'The forecast opens on this city.',
      Component: CityStep,
      isReady: (value) => typeof value === 'string' && value.trim().length > 0,
      blockedHint: 'Name a city to forecast.',
    },
    createTemplate: (context) => {
      const city =
        context && typeof context.stepValue === 'string' && context.stepValue.trim()
          ? context.stepValue.trim()
          : null
      return {
        id: 'pw-deck-board',
        name: 'Deck board',
        description: 'Forecast beside a gauge.',
        previewSlots: [
          { x: 4, y: 4, w: 144, h: 102, type: 'editor', label: 'Forecast' },
          { x: 152, y: 4, w: 144, h: 102, type: 'editor', label: 'Gauge' },
        ],
        layout: {
          global: { tabSetEnableDrop: true, tabEnableClose: true },
          layout: {
            type: 'row',
            children: [
              {
                type: 'tabset',
                weight: 50,
                children: [
                  { type: 'tab', name: city ? 'Forecast: ' + city : 'Forecast', component: 'pw-deck.forecast' },
                ],
              },
              {
                type: 'tabset',
                weight: 50,
                children: [{ type: 'tab', name: 'Gauge', component: 'pw-widgets.gauge' }],
              },
            ],
          },
        },
      }
    },
    supervisors: [{ Component: DeckSupervisor, scope: 'global' }],
    deriveRunGlyph: () => ({ state: 'in_progress', live: false, label: '2 scheduled today' }),
  })

  host.registerWorkspaceType({
    id: 'pw-crash',
    label: 'Crash Deck',
    description: 'Creation step throws on purpose.',
    icon: () => null,
    creationStep: {
      id: 'crash-step',
      heading: 'Crash step config',
      Component: CrashStep,
      isReady: () => true,
    },
    createTemplate: () => ({
      id: 'pw-crash-board',
      name: 'Crash board',
      description: 'Zero-config fallback board.',
      previewSlots: [{ x: 4, y: 4, w: 292, h: 102, type: 'editor', label: 'Board' }],
      layout: {
        global: { tabSetEnableDrop: true, tabEnableClose: true },
        layout: {
          type: 'row',
          children: [
            {
              type: 'tabset',
              weight: 100,
              children: [{ type: 'tab', name: 'Crash board', component: 'pw-deck.forecast' }],
            },
          ],
        },
      },
    }),
  })
}
`

const PW_WIDGETS_RENDERER = `
import React from 'react'
const { createElement: h } = React

export function registerRenderer(host) {
  host.registerPanel('pw-widgets.gauge', function GaugePanel() {
    return h('div', { style: { padding: '12px', color: 'var(--text-muted)' } }, 'Gauge ready')
  })
}
`

async function writeModule(dir, id, displayName, summary, rendererSource) {
  const moduleDir = join(dir, id)
  await mkdir(moduleDir, { recursive: true })
  await writeFile(
    join(moduleDir, 'manifest.json'),
    JSON.stringify(
      {
        id,
        displayName,
        version: 1,
        summary,
        defaultEnabled: true,
        source: 'third-party',
        entry: { renderer: 'renderer.js' },
      },
      null,
      2
    )
  )
  await writeFile(join(moduleDir, 'renderer.js'), rendererSource)
}

async function seedModules() {
  await writeModule(modulesFull, 'pw-deck', 'Playwright Deck', 'Forecast board workspaces for the module platform drive.', PW_DECK_RENDERER)
  await writeModule(modulesFull, 'pw-widgets', 'Playwright Widgets', 'Gauge panels that other workspaces embed.', PW_WIDGETS_RENDERER)
  await writeModule(modulesNoWidgets, 'pw-deck', 'Playwright Deck', 'Forecast board workspaces for the module platform drive.', PW_DECK_RENDERER)
  await mkdir(modulesEmpty, { recursive: true })
}

// ── App control ─────────────────────────────────────────────────────────────

const liveApps = new Set()
async function closeLiveApps() {
  for (const app of liveApps) {
    try {
      await app.close()
    } catch {
      // Best-effort; the process exits right after.
    }
  }
  liveApps.clear()
}

async function launch(electron, electronPath, { moduleRoot, testOpenDir }) {
  step(`launching electron (moduleRoot=${moduleRoot.split('/').pop()})`)
  const env = { ...process.env }
  delete env.NODE_ENV_ELECTRON_VITE
  delete env.ELECTRON_CLI_ARGS
  const app = await electron.launch({
    executablePath: electronPath,
    // --ignore-certificate-errors covers a Chromium-net-backed fetch;
    // NODE_TLS_REJECT_UNAUTHORIZED covers a Node/undici-backed fetch. The
    // pre-seeded cache covers both failing.
    args: [join(root, 'out/main/index.js'), '--ignore-certificate-errors'],
    cwd: root,
    env: {
      ...env,
      // Acceptance requires the built renderer: explicitly blank, never
      // inherited from a dev session.
      ELECTRON_RENDERER_URL: '',
      // Never override HOME: pointing HOME at an empty dir wedges the app
      // under Playwright on macOS (every CDP evaluate times out; verified
      // 6/6 ok without vs 0/6 with). Module-root isolation comes from
      // MULTICODE_USER_MODULE_ROOT, profile isolation from
      // MULTICODE_USER_DATA_DIR — real HOME is never written by this drive.
      MULTICODE_USER_DATA_DIR: userDataDir,
      MULTICODE_USER_MODULE_ROOT: moduleRoot,
      MULTICODE_ALLOW_MULTI_INSTANCE: '1',
      MULTICODE_DIAGNOSTICS: '1',
      MULTICODE_MARKETPLACE_REGISTRY_URL: registryUrl(),
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      ...(testOpenDir ? { MULTICODE_TEST_OPEN_DIR: testOpenDir } : {}),
    },
  })
  liveApps.add(app)
  const proc = app.process()
  proc.stdout?.on('data', (chunk) => process.stdout.write(`[app] ${chunk}`))
  proc.stderr?.on('data', (chunk) => process.stderr.write(`[app] ${chunk}`))
  step('waiting for first window')
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.on('console', (message) => {
    const text = message.text()
    if (text.includes('[pw-deck]') || text.includes('[modules]')) console.log(`[renderer] ${text}`)
  })
  step('window ready')
  return { app, page }
}

// The built app very occasionally quits cleanly within seconds of boot in
// this environment (clean exit code 0, no error output). Retry the launch
// once or twice rather than failing the whole drive on that flake.
async function launchSettled(electron, electronPath, options, settleMs = 2000) {
  for (let attempt = 1; ; attempt += 1) {
    const { app, page } = await launch(electron, electronPath, options)
    await page.waitForTimeout(settleMs).catch(() => {})
    if (!page.isClosed()) return { app, page }
    // The boot sometimes closes the first window and opens a fresh one
    // (window restore). Adopt a surviving window before treating the launch
    // as a quit.
    const survivor = app.windows().find((win) => !win.isClosed())
    if (survivor) {
      step('first window was replaced at boot — adopting the new window')
      await survivor.waitForLoadState('domcontentloaded').catch(() => {})
      await survivor.waitForTimeout(1000).catch(() => {})
      if (!survivor.isClosed()) return { app, page: survivor }
    }
    step(`app quit within ${settleMs}ms of boot (attempt ${attempt}) — relaunching`)
    liveApps.delete(app)
    try {
      await app.close()
    } catch {
      // Already gone.
    }
    if (attempt >= 3) throw new Error('app kept quitting right after boot (3 attempts)')
  }
}

// keyboard.press awaits a renderer ack that intermittently never resolves in
// this environment (see third-party-renderer-modules-e2e.mjs); drive shortcuts
// as synthetic DOM keydown events and open Settings via the app-menu channel.
async function dispatchKey(page, key, modifiers = {}) {
  await page.evaluate(
    ([eventKey, mods]) => {
      const target = document.activeElement ?? window
      target.dispatchEvent(new KeyboardEvent('keydown', { key: eventKey, bubbles: true, cancelable: true, ...mods }))
    },
    [key, modifiers]
  )
}

// No onboarding seed: at HEAD a fresh profile boots straight into the
// workspace hub with the full sidebar (verified via the smoke script's body
// preview). Seeding the old version-59 settings envelope actually makes the
// app quit moments after boot, so the drive runs against genuine
// fresh-profile state and dismisses any overlay with Escape instead.

// Settings opens through its real top-bar button (aria-label "Settings").
// Neither Playwright keyboard.press nor a synthetic keydown reaches the
// settings command in the built app, and `app.evaluate` must be avoided (the
// main-inspector session drops and the call hangs without a timeout).

// Dismiss any boot-time overlay (tip-of-the-day and similar): the drive never
// seeds settings, so first boots with restorable state can open a modal over
// the shell that intercepts clicks.
async function dismissOverlays(page) {
  for (let i = 0; i < 4; i++) {
    const scrim = page.locator('.overlay-scrim')
    if ((await scrim.count()) === 0) return
    const text = (await scrim.first().innerText().catch(() => '')).slice(0, 120).replace(/\n/g, ' | ')
    step(`dismissing overlay: ${text}`)
    const closer = scrim
      .locator('button:has-text("Got it"), button:has-text("Close"), button:has-text("Skip"), button:has-text("OK"), button:has-text("Dismiss"), [aria-label="Close"]')
      .first()
    if ((await closer.count()) > 0) {
      await closer.click().catch(() => {})
    } else {
      await dispatchKey(page, 'Escape')
    }
    await page.waitForTimeout(500)
  }
}

async function openModulesSettings(_app, page) {
  step('opening modules settings')
  await page.locator('[aria-label="Settings"]').first().click()
  const modulesTab = page.locator('#settings-tab-modules')
  await modulesTab.waitFor({ state: 'visible', timeout: 10000 })
  await modulesTab.click()
  await page.locator('text=Third-party modules').first().waitFor({ state: 'visible', timeout: 10000 })
}

async function shot(page, name) {
  const path = join(outDir, `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  console.log(`# screenshot ${path}`)
}

// ── Sessions ────────────────────────────────────────────────────────────────

async function sessionTrust(electron, electronPath) {
  step('SESSION A: trust the fixture modules')
  const { app, page } = await launchSettled(electron, electronPath, { moduleRoot: modulesFull }, 2500)
  // A fresh profile auto-opens the workspace hub; Settings opens over it.
  await dispatchKey(page, 'Escape')
  await page.waitForTimeout(300)
  await openModulesSettings(app, page)
  await page.locator('[aria-label="Trust Playwright Deck"]').click()
  await page.locator('[aria-label="Trust Playwright Deck"][aria-checked="true"]').waitFor({ timeout: 10000 })
  await page.locator('[aria-label="Trust Playwright Widgets"]').click()
  await page.locator('[aria-label="Trust Playwright Widgets"][aria-checked="true"]').waitFor({ timeout: 10000 })
  check('A: fixture modules trusted through the real switches', true)
  await shot(page, 'a-modules-trusted')
  await app.close()
  liveApps.delete(app)
}

async function findWorkspaceId(page, mode) {
  return page.evaluate((wanted) => {
    const raw = window.localStorage.getItem('multicode-workspaces')
    if (!raw) return null
    const seen = new Set()
    const stack = [JSON.parse(raw)]
    while (stack.length > 0) {
      const value = stack.pop()
      if (!value || typeof value !== 'object' || seen.has(value)) continue
      seen.add(value)
      if (typeof value.id === 'string' && value.mode === wanted) return value.id
      for (const key of Object.keys(value)) stack.push(value[key])
    }
    return null
  }, mode)
}

// Reach the new-workspace hub page for a module type. When no workspaces
// exist the hub is already open (auto-opens); otherwise go through the
// sidebar's New… popover. Either way, the type is picked from the hub rail.
async function createWorkspaceOfType(page, { typeLabel, name, folder }) {
  const nameInput = page.locator('input[placeholder="my-workspace"]')
  if ((await nameInput.count()) === 0) {
    await page.locator('[aria-label="New…"]').click()
    const menuItem = page.locator(`text=New ${typeLabel.toLowerCase()}`).first()
    await menuItem.waitFor({ state: 'visible', timeout: 10000 })
    await menuItem.click()
  }
  await nameInput.waitFor({ state: 'visible', timeout: 10000 })
  const railEntry = page.getByRole('button', { name: typeLabel }).first()
  if ((await railEntry.count()) > 0) {
    await railEntry.click()
  } else {
    await page.locator(`text=${typeLabel}`).first().click()
  }
  await page.waitForTimeout(400)
  await nameInput.fill(name)
  const folderInput = page.locator('input[placeholder="/path/to/workspace"]')
  await folderInput.fill(folder)
  await folderInput.blur()
  await page.waitForTimeout(400)
}

async function sessionDrive(electron, electronPath) {
  step('SESSION B: creation step, supervisor, glyph, distrust guard')
  const { app, page } = await launchSettled(electron, electronPath, {
    moduleRoot: modulesFull,
    testOpenDir: wsDeckDir,
  }, 2500)

  // ── Checkpoint 4 (happy path): creation step pane + value reaches workspace
  step('creating a Playwright Deck workspace')
  await createWorkspaceOfType(page, { typeLabel: 'Playwright Deck', name: 'Deck One', folder: wsDeckDir })
  await page.locator('button:has-text("Continue")').click()
  const stepHeading = page.locator('h3:has-text("Which city?")')
  await stepHeading.waitFor({ state: 'visible', timeout: 10000 })
  check('4: module creation step pane renders with its own heading', true)
  const blockedHint = await page.locator('text=Name a city to forecast.').count()
  const createButton = page.locator('button:has-text("Create")').last()
  const disabledBeforeValue = await createButton.isDisabled()
  check('4: create is blocked with the blockedHint until the step is ready', blockedHint > 0 && disabledBeforeValue)
  await shot(page, 'b-cp4-step-pane-blocked')
  await page.locator('input[placeholder="City to forecast"]').fill('Dublin')
  await page.waitForTimeout(300)
  check('4: entering a value unblocks create', !(await createButton.isDisabled()))
  await createButton.click()
  const forecastTab = page.locator('text=Forecast: Dublin').first()
  await forecastTab.waitFor({ state: 'visible', timeout: 15000 })
  check('4: entered step value reached the created workspace (tab "Forecast: Dublin")', true)
  check('4: forecast panel rendered', (await page.locator('text=Forecast ready').count()) > 0)
  await shot(page, 'b-cp4-created-workspace')

  // Baseline for 1b: the gauge tab renders while pw-widgets is installed.
  const gaugeTab = page.locator('text=Gauge').first()
  await gaugeTab.click()
  await page.locator('text=Gauge ready').first().waitFor({ state: 'visible', timeout: 10000 })
  check('baseline: pw-widgets gauge panel renders while installed', true)

  // ── Checkpoint 5: supervisor mounted + observes session state; glyph
  step('checking supervisor mount and session observation')
  check(
    '5: global supervisor mounted at boot',
    (await page.evaluate(() => globalThis.__pwDeckSupervisorMounted)) === true
  )
  const workspaceId = await findWorkspaceId(page, 'pw-deck')
  check('5: created workspace persisted with mode pw-deck', typeof workspaceId === 'string', String(workspaceId))
  await page.evaluate((id) => {
    globalThis.__pwTargetWorkspaceId = id
  }, workspaceId)
  await page.waitForTimeout(1500)
  const observations = await page.evaluate(() => globalThis.__pwDeckSessionObservations ?? null)
  const watchError = await page.evaluate(() => globalThis.__pwDeckWatchError ?? null)
  check(
    '5: supervisor observed session state through watchAgentSessions',
    Array.isArray(observations) && observations.length > 0,
    watchError ? `watch error: ${watchError}` : `observations: ${JSON.stringify(observations)}`
  )
  const glyph = page.locator('[role="img"][aria-label*="2 scheduled today"]')
  check('5: deriveRunGlyph renders in the sidebar row', (await glyph.count()) > 0)
  await shot(page, 'b-cp5-supervisor-glyph')

  // ── Checkpoint 2: distrust guard lists the dependent workspace
  step('driving the distrust guard')
  await openModulesSettings(app, page)
  await page.locator('[aria-label="Trust Playwright Deck"]').click()
  const dialog = page.locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: 'Stop trusting this module?' })
  await dialog.waitFor({ state: 'visible', timeout: 10000 })
  check('2: distrust confirmation appears for a module with dependent workspaces', true)
  check(
    '2: confirmation lists the dependent workspace by name',
    (await dialog.locator('text=Deck One').count()) > 0
  )
  check(
    '2: confirmation states the module-not-installed consequence',
    (await dialog.locator('text=module not installed').count()) > 0
  )
  await shot(page, 'b-cp2-distrust-guard')
  await dialog.locator('button:has-text("Cancel")').click()
  await page.waitForTimeout(300)
  check(
    '2: cancel keeps the module trusted',
    (await page.locator('[aria-label="Trust Playwright Deck"][aria-checked="true"]').count()) > 0
  )

  await app.close()
  liveApps.delete(app)
}

async function sessionMissingTab(electron, electronPath) {
  step('SESSION C: missing-tab surface + throwing creation step')
  const { app, page } = await launchSettled(electron, electronPath, {
    moduleRoot: modulesNoWidgets,
    testOpenDir: wsCrashDir,
  }, 2500)

  await dismissOverlays(page)

  // ── Checkpoint 1b: layout tab with a missing owning module
  step('selecting Deck One with pw-widgets absent')
  const deckRow = page.locator('text=Deck One').first()
  await deckRow.waitFor({ state: 'visible', timeout: 10000 })
  await deckRow.click()
  await page.locator('text=Forecast: Dublin').first().waitFor({ state: 'visible', timeout: 10000 })
  const gaugeTab = page.locator('text=Gauge').first()
  await gaugeTab.click()
  const missingNote = page.locator('[role="note"][aria-label="Module not installed"]')
  await missingNote.waitFor({ state: 'visible', timeout: 10000 })
  check(
    '1b: missing-module tab shows the upgraded surface with the module name',
    (await missingNote.locator('text=Playwright Widgets isn’t installed').count()) > 0
  )
  check(
    '1b: upgraded tab surface carries the install affordance',
    (await missingNote.locator('button:has-text("Find it in Connectors")').count()) > 0
  )
  await shot(page, 'c-cp1b-missing-tab-surface')

  // ── Checkpoint 4 (degrade): throwing creation step
  step('creating a Crash Deck workspace')
  await createWorkspaceOfType(page, { typeLabel: 'Crash Deck', name: 'Crash One', folder: wsCrashDir })
  await page.locator('button:has-text("Continue")').click()
  const degradeCopy = page
    .locator('text=This step hit an error and was skipped — the workspace is created with its default setup.')
    .first()
  await degradeCopy.waitFor({ state: 'visible', timeout: 10000 })
  check('4: throwing step degrades to the error surface with the exact copy', true)
  await shot(page, 'c-cp4-throwing-step-degrade')
  const createButton = page.locator('button:has-text("Create")').last()
  check('4: create stays available after the degrade (zero-config)', !(await createButton.isDisabled()))
  await createButton.click()
  await page.locator('text=Crash board').first().waitFor({ state: 'visible', timeout: 15000 })
  check('4: degraded create produced the zero-config workspace without a crash', true)
  await shot(page, 'c-cp4-zero-config-created')

  await app.close()
  liveApps.delete(app)
}

async function sessionAbsence(electron, electronPath) {
  step('SESSION D: workspace absence surface + module surfacing')
  const { app, page } = await launchSettled(electron, electronPath, { moduleRoot: modulesEmpty }, 2500)

  await dismissOverlays(page)

  // ── Checkpoint 1a: workspace whose mode's module is not installed
  step('selecting Deck One with all fixture modules absent')
  const deckRow = page.locator('text=Deck One').first()
  await deckRow.waitFor({ state: 'visible', timeout: 10000 })
  await deckRow.click()
  // Both restored workspaces (pw-deck and pw-crash modes) render absence
  // notes; assert on Deck One's specifically.
  const absenceNote = page
    .locator('[role="note"][aria-label="Module not installed"]')
    .filter({ hasText: 'Pw-deck' })
    .first()
  await absenceNote.waitFor({ state: 'visible', timeout: 10000 })
  check(
    '1a: absence surface names the module',
    (await absenceNote.locator('text=Pw-deck isn’t installed').count()) > 0
  )
  check(
    '1a: absence surface keeps the data-safe promise copy',
    (await absenceNote.locator('text=Your work here is safe on disk').count()) > 0
  )
  const installButton = absenceNote.locator('button:has-text("Find it in Connectors")')
  check('1a: install affordance present', (await installButton.count()) > 0)
  await shot(page, 'd-cp1a-absence-surface')

  step('routing through the install affordance')
  await installButton.click()
  await page.waitForTimeout(2500)
  await shot(page, 'd-cp1a-routed-to-browse')
  const modulesHeading = page.locator('text=Capability modules').first()
  if ((await modulesHeading.count()) === 0) {
    // The deep link lands on the extensions browse surface; the Modules
    // category is one rail row in.
    const modulesRailRow = page.getByRole('button', { name: /^Modules/ }).first()
    await modulesRailRow.waitFor({ state: 'visible', timeout: 10000 })
    await modulesRailRow.click()
  }
  await modulesHeading.waitFor({ state: 'visible', timeout: 15000 })
  check('1a: install affordance routes to the extensions browse surface', true)

  // ── Checkpoint 3: module surfacing in the browse surface
  step('asserting module-led cards in the browse surface')
  const deckCard = page.locator('text=Playwright Deck').first()
  await deckCard.waitFor({ state: 'visible', timeout: 10000 })
  check('3: module entry renders in the Modules category', true)
  check(
    '3: card copy is module-led (manifest summary verbatim)',
    (await page.locator('text=Forecast board workspaces for the module platform drive.').count()) > 0
  )
  const registryState = await page.evaluate(async () => {
    const result = await window.api.readMarketplaceRegistry()
    return { ok: result.ok, state: result.state, source: result.source ?? null, stale: result.stale ?? null }
  })
  console.log(`# registry read state: ${JSON.stringify(registryState)}`)
  // Scope to the module card row itself — the app sidebar legitimately has a
  // global "New chat" button, so a page-wide count proves nothing.
  const deckCardRow = page
    .locator('div')
    .filter({ has: page.getByText('Playwright Deck', { exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'Get' }) })
    .last()
  check(
    '3: module-only row shows no launch affordance (no "New chat" on the card)',
    (await deckCardRow.getByRole('button', { name: 'New chat' }).count()) === 0
  )
  check('3: module row keeps the Get affordance', (await deckCardRow.getByRole('button', { name: 'Get' }).count()) > 0)
  await shot(page, 'd-cp3-modules-canvas')

  await app.close()
  liveApps.delete(app)
  return registryState
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { _electron: electron } = await loadPlaywright()
  const electronPath = require('electron')

  await rm(scratch, { recursive: true, force: true })
  await mkdir(homeDir, { recursive: true })
  await mkdir(outDir, { recursive: true })
  await mkdir(wsDeckDir, { recursive: true })
  await mkdir(wsCrashDir, { recursive: true })
  await seedModules()
  const server = await startRegistryServer()
  await seedRegistryCache()
  console.log(`# fixture registry at ${registryUrl()}`)

  let registryState = null
  try {
    await sessionTrust(electron, electronPath)
    await sessionDrive(electron, electronPath)
    await sessionMissingTab(electron, electronPath)
    registryState = await sessionAbsence(electron, electronPath)
  } finally {
    await closeLiveApps()
    server.close()
  }

  const report = {
    ok: failures === 0,
    env: {
      ELECTRON_RENDERER_URL: '',
      MULTICODE_MARKETPLACE_REGISTRY_URL: registryUrl(),
      MULTICODE_USER_DATA_DIR: userDataDir,
      moduleRoots: { A: modulesFull, B: modulesFull, C: modulesNoWidgets, D: modulesEmpty },
    },
    registryState,
    checks,
  }
  await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
  } else {
    console.log('\nmodule platform drive passed')
  }
}

const watchdog = setTimeout(() => {
  console.error('not ok - harness watchdog expired (last step above is the hang point)')
  void closeLiveApps().finally(() => process.exit(1))
}, 480_000)
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
