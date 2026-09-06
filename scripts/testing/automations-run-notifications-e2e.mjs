#!/usr/bin/env node
// End-to-end validation for Automations scheduled-run notifications.
//
// Covers: a timer failed/blocked run raises a source-'automations' notification
// (manual + completed runs stay silent), and the notification's Open action
// opens the global Automations SCREEN overlay (not a workspace — Automations is
// no longer a workspace type). Re-validate this with a live run after changing
// the run-notification or Automations-screen wiring.
//
// Run after `npm run build`:
//   tmp=/tmp/multicode-playwright
//   npm --prefix "$tmp" install playwright --no-audit --no-fund
//   NODE_PATH="$tmp/node_modules" node scripts/testing/automations-run-notifications-e2e.mjs

import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { createWorkspaceThroughNewChat, resolveMainWindow } from './newChatWorkspace.mjs'

const require = createRequire(import.meta.url)
const root = resolve(new URL('../..', import.meta.url).pathname)
const userDataDir = process.env.MULTICODE_AUTOMATIONS_E2E_PROFILE || '/tmp/multicode-automations-run-notifications-profile'
const workspaceDir = process.env.MULTICODE_AUTOMATIONS_E2E_WORKSPACE || '/tmp/multicode-t13-scheduled-run-workspace'
const screenshotPath = process.env.MULTICODE_AUTOMATIONS_E2E_SCREENSHOT || '/tmp/multicode-automations-run-notifications.png'
const runEventChannel = 'automations:run-event'

function loadPlaywright() {
  try {
    return require('playwright')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      [
        'Playwright is unavailable. Install it or run with NODE_PATH=/tmp/multicode-playwright/node_modules.',
        '  tmp=/tmp/multicode-playwright',
        '  npm --prefix "$tmp" install playwright --no-audit --no-fund',
        '  NODE_PATH="$tmp/node_modules" node scripts/testing/automations-run-notifications-e2e.mjs',
        `Original error: ${message}`,
      ].join('\n'),
    )
  }
}

async function domClick(page, locator) {
  await locator.first().evaluate((el) => {
    if (el instanceof HTMLElement) el.click()
  })
  await page.waitForTimeout(250)
}

async function waitForBodyText(page, text, timeout = 10000) {
  await page.waitForFunction(
    (expected) => document.body.innerText.includes(expected),
    text,
    { timeout },
  ).catch(async (error) => {
    const body = await page.locator('body').innerText().catch(() => '')
    throw new Error(`Timed out waiting for body text "${text}". Body preview: ${body.slice(0, 3000)}\n${error.message}`)
  })
}

async function readPersistedState(page, key) {
  return page.evaluate((storageKey) => {
    const raw = window.localStorage.getItem(storageKey)
    return raw ? JSON.parse(raw).state : null
  }, key)
}

async function readWorkspaceRegistry(page) {
  return readPersistedState(page, 'multicode-workspaces')
}

async function readNotifications(page) {
  const state = await readPersistedState(page, 'multicode-notifications')
  return state?.notifications ?? []
}

function decodeRunRef(notification) {
  assert.equal(notification.navigationTarget?.kind, 'run')
  assert.equal(typeof notification.navigationTarget.ref, 'string')
  return JSON.parse(notification.navigationTarget.ref)
}

async function waitForWorkspace(page, predicate, message, arg = null) {
  await page.waitForFunction(
    ({ predicateSource, predicateArg }) => {
      const raw = window.localStorage.getItem('multicode-workspaces')
      if (!raw) return false
      const state = JSON.parse(raw).state
      const fn = new Function('state', 'arg', `return (${predicateSource})(state, arg)`)
      return Boolean(fn(state, predicateArg))
    },
    { predicateSource: predicate.toString(), predicateArg: arg },
    { timeout: 10000 },
  ).catch(async (error) => {
    const state = await readWorkspaceRegistry(page).catch(() => null)
    throw new Error(`${message}. Workspace registry: ${JSON.stringify(state, null, 2)}\n${error.message}`)
  })
}

async function waitForNotificationCount(page, count, message) {
  await page.waitForFunction(
    (expectedCount) => {
      const raw = window.localStorage.getItem('multicode-notifications')
      if (!raw) return expectedCount === 0
      const notifications = JSON.parse(raw).state?.notifications ?? []
      return notifications.filter((notification) => notification.source === 'automations').length === expectedCount
    },
    count,
    { timeout: 10000 },
  ).catch(async (error) => {
    const notifications = await readNotifications(page).catch(() => [])
    throw new Error(`${message}. Notifications: ${JSON.stringify(notifications, null, 2)}\n${error.message}`)
  })
}

async function createStandardWorkspace(page) {
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1000)
  const startupTipClose = page.getByRole('button', { name: /^Close$/i })
  if (await startupTipClose.count()) {
    await domClick(page, startupTipClose)
  }
  // Through New chat — the product's one door (MC-2436); Browse… resolves to
  // MULTICODE_TEST_OPEN_DIR. The chat is a solo workspace on the folder.
  await createWorkspaceThroughNewChat(page, { folder: workspaceDir })

  await waitForWorkspace(
    page,
    (state, expectedWorkspaceDir) => state.workspaces.some((workspace) =>
      workspace.folderPath === expectedWorkspaceDir
    ),
    'The New chat workspace was not persisted',
    workspaceDir,
  )

  const registry = await readWorkspaceRegistry(page)
  const workspace = registry.workspaces.find((candidate) => candidate.folderPath === workspaceDir)
  assert.ok(workspace, 'the New chat workspace exists on the folder')
  return workspace
}

async function installRendererProbes(page) {
  await page.evaluate(() => {
    window.__t13AutomationRunEvents = []
    window.__t13UnsubscribeAutomationRunEvents?.()
    window.__t13UnsubscribeAutomationRunEvents = window.api.onAutomationRunEvent((event) => {
      window.__t13AutomationRunEvents.push(event)
    })
  })
}

async function sendRunEvent(electronApp, event) {
  await electronApp.evaluate(
    ({ BrowserWindow }, payload) => {
      const windows = BrowserWindow.getAllWindows()
      const primary = windows.find((candidate) => candidate.webContents.getURL().includes('windowId=primary')) ?? windows[0]
      if (!primary) throw new Error('No Electron BrowserWindow is available.')
      primary.webContents.send(payload.channel, payload.event)
    },
    { channel: runEventChannel, event },
  )
}

async function waitForProbeEvent(page, runId) {
  await page.waitForFunction(
    (expectedRunId) => window.__t13AutomationRunEvents.some((event) => event.runId === expectedRunId),
    runId,
    { timeout: 10000 },
  )
}

async function main() {
  const { _electron: electron } = loadPlaywright()
  const electronPath = require('electron')
  const appEnv = { ...process.env }
  // This script validates the freshly built renderer in `out/renderer`. Agent
  // terminals may inherit ELECTRON_RENDERER_URL from a dev server; keeping it
  // would silently test whichever renderer is currently served on that port.
  delete appEnv.ELECTRON_RENDERER_URL

  await rm(userDataDir, { recursive: true, force: true })
  await rm(workspaceDir, { recursive: true, force: true })
  await mkdir(userDataDir, { recursive: true })
  await mkdir(workspaceDir, { recursive: true })

  const app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out/main/index.js')],
    cwd: root,
    env: {
      ...appEnv,
      MULTICODE_USER_DATA_DIR: userDataDir,
      MULTICODE_ALLOW_MULTI_INSTANCE: '1',
      MULTICODE_DIAGNOSTICS: '1',
      MULTICODE_TEST_OPEN_DIR: workspaceDir,
    },
  })

  try {
    const page = await resolveMainWindow(app)
    await page.waitForLoadState('domcontentloaded')
    if (page.url().startsWith('http://localhost:')) {
      throw new Error(`Expected built file renderer, got dev-server URL: ${page.url()}`)
    }
    const standardWorkspace = await createStandardWorkspace(page)
    await installRendererProbes(page)

    const registryBeforeEvents = await readWorkspaceRegistry(page)
    assert.equal(
      registryBeforeEvents.workspaces.filter((workspace) => workspace.mode === 'automations').length,
      0,
      'test starts with no automations control-center workspace open',
    )

    const failedEvent = {
      automationId: 't13-auto',
      runId: 't13-run-failed',
      workspaceId: standardWorkspace.id,
      definitionName: 'T13 Nightly QA',
      status: 'failed',
      trigger: 'timer',
    }
    await sendRunEvent(app, failedEvent)
    await waitForProbeEvent(page, failedEvent.runId)
    await waitForNotificationCount(page, 1, 'timer failed event should create one automations notification')

    let automationNotifications = (await readNotifications(page)).filter((notification) => notification.source === 'automations')
    assert.equal(automationNotifications[0].level, 'error')
    assert.equal(automationNotifications[0].workspaceId, standardWorkspace.id)
    assert.equal(automationNotifications[0].title, 'Automation failed: T13 Nightly QA')
    assert.deepEqual(
      decodeRunRef(automationNotifications[0]),
      { automationId: 't13-auto', runId: 't13-run-failed', folderPath: workspaceDir },
    )

    const manualEvent = { ...failedEvent, runId: 't13-run-manual', trigger: 'manual' }
    await sendRunEvent(app, manualEvent)
    await waitForProbeEvent(page, manualEvent.runId)
    await page.waitForTimeout(800)
    automationNotifications = (await readNotifications(page)).filter((notification) => notification.source === 'automations')
    assert.equal(automationNotifications.length, 1, 'manual run event must not create a duplicate notification')

    const completedEvent = { ...failedEvent, runId: 't13-run-completed', status: 'completed' }
    await sendRunEvent(app, completedEvent)
    await waitForProbeEvent(page, completedEvent.runId)
    await page.waitForTimeout(800)
    automationNotifications = (await readNotifications(page)).filter((notification) => notification.source === 'automations')
    assert.equal(automationNotifications.length, 1, 'completed timer event stays silent')

    const blockedEvent = { ...failedEvent, runId: 't13-run-blocked', status: 'blocked' }
    await sendRunEvent(app, blockedEvent)
    await waitForProbeEvent(page, blockedEvent.runId)
    await waitForNotificationCount(page, 2, 'timer blocked event should create a second automations notification')
    automationNotifications = (await readNotifications(page)).filter((notification) => notification.source === 'automations')
    assert.equal(automationNotifications[0].level, 'warning')
    assert.equal(automationNotifications[0].title, 'Automation blocked: T13 Nightly QA')
    assert.deepEqual(
      decodeRunRef(automationNotifications[0]),
      { automationId: 't13-auto', runId: 't13-run-blocked', folderPath: workspaceDir },
    )

    await domClick(page, page.getByRole('button', { name: /^Notifications$/i }))
    await waitForBodyText(page, 'Automation blocked: T13 Nightly QA')
    await domClick(page, page.getByRole('button', { name: /^Open$/i }).first())

    // Automations is now a global SCREEN (overlay), not a workspace. The run
    // notification's Open opens that overlay dialog scoped to the run's project —
    // it must NOT create or reveal an automations workspace.
    const automationsDialog = page.getByRole('dialog').filter({ hasText: 'New automation' })
    await automationsDialog.waitFor({ state: 'visible', timeout: 10000 })

    const afterOpenRegistry = await readWorkspaceRegistry(page)
    assert.equal(
      afterOpenRegistry.workspaces.filter((workspace) => workspace.mode === 'automations').length,
      0,
      'Open opens the Automations screen overlay and never creates an automations workspace',
    )
    assert.equal(
      afterOpenRegistry.activeWorkspaceId,
      standardWorkspace.id,
      'the underlying active workspace is unchanged when the overlay opens',
    )

    await page.screenshot({ path: screenshotPath, fullPage: true })
    console.log(JSON.stringify({
      ok: true,
      userDataDir,
      workspaceDir,
      screenshotPath,
      standardWorkspaceId: standardWorkspace.id,
      automationsNotificationCount: automationNotifications.length,
      observedRunEventCount: await page.evaluate(() => window.__t13AutomationRunEvents.length),
    }, null, 2))
  } finally {
    await app.close()
  }
}

main().catch((error) => {
  console.error(`AUTOMATIONS RUN NOTIFICATIONS E2E FAILED: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
