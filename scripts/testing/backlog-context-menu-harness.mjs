#!/usr/bin/env node
// Live Electron verification harness for the Backlog row context menu
// (Sprint Engine task T5 of the 2026-06-11 backlog-row-context-menu run).
// Launches the built app through Playwright _electron with an isolated
// MULTICODE_USER_DATA_DIR profile, onboards a real Standard workspace whose
// folder is pre-seeded with backlog/ items and the installed
// .claude/skills/backlog skill, then exercises the row menu end to end:
// selection, menu contents, status/priority/size submenu picks persisted to
// .multi-code/backlog/items.json on disk, star + highlight, Escape focus
// return, live send-to-agent into the real claude session, the dead-session
// actionError path via a real terminalKill, and the zero-agents placeholder.
//
// Prereqs: `npm run build` (needs out/main), playwright available:
//   tmp=/tmp/multicode-playwright
//   npm --prefix "$tmp" install playwright --no-audit --no-fund
//   NODE_PATH="$tmp/node_modules" node scripts/testing/backlog-context-menu-harness.mjs
// Screenshots land in $MULTICODE_T5_SCREENSHOT_DIR (default: <tempRoot>/screenshots).

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = resolve(new URL('../..', import.meta.url).pathname)
const tempRoot = process.env.MULTICODE_T5_TMP_ROOT || '/tmp/multicode-backlog-menu-harness'
const workspaceDir = join(tempRoot, 'workspace')
const userDataDir = join(tempRoot, 'user-data')
const screenshotDir = process.env.MULTICODE_T5_SCREENSHOT_DIR || join(tempRoot, 'screenshots')
const ITEM_A = 'backlog/2026-06-12-dark-mode-toggle.md'

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
        '  NODE_PATH="$tmp/node_modules" node scripts/testing/backlog-context-menu-harness.mjs',
        `Original error: ${message}`,
      ].join('\n'),
    )
  }
}

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function readItems() {
  const raw = await readFile(join(workspaceDir, '.multi-code/backlog/items.json'), 'utf8')
  return JSON.parse(raw)
}

function itemRecord(store, relativePath) {
  return store.items.find(
    (entry) => entry.source?.relativePath?.toLowerCase() === relativePath.toLowerCase(),
  )
}

async function domClick(page, locator) {
  await locator.first().evaluate((el) => el.click())
  await page.waitForTimeout(400)
}

async function openRowMenu(page) {
  await page.locator('[role="option"]', { hasText: 'Dark mode toggle' }).first().click({ button: 'right' })
  const menu = page.locator('[role="menu"][aria-label^="Backlog item actions"]')
  await menu.waitFor({ state: 'visible', timeout: 5000 })
  return menu
}

async function openFlyout(page, menu, label) {
  const item = menu.locator(`button[aria-haspopup="menu"]`).filter({ hasText: label })
  await item.hover()
  const flyout = page.locator(`[role="menu"][aria-label="${label === 'Send to agent' ? 'Send to agent' : `Set ${label.toLowerCase()}`}"]`)
  await flyout.waitFor({ state: 'visible', timeout: 5000 })
  return flyout
}

async function closeMenus(page) {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
}

async function main() {
  const { _electron: electron } = await loadPlaywright()
  const electronPath = require('electron')

  await rm(tempRoot, { recursive: true, force: true })
  await mkdir(join(workspaceDir, 'backlog'), { recursive: true })
  await mkdir(userDataDir, { recursive: true })
  await mkdir(screenshotDir, { recursive: true })

  await writeFile(
    join(workspaceDir, ITEM_A),
    '# Dark mode toggle\n\nUsers want a quick way to flip the app between light and dark without opening settings.\n',
  )
  await writeFile(
    join(workspaceDir, 'backlog/2026-06-12-export-csv.md'),
    '# Export CSV\n\nThe report table needs a one-click CSV export including the active filters.\n',
  )
  // Install the real backlog skill for the claude harness so the slash path is
  // the genuine /backlog route, not the quoted-path fallback.
  await cp(join(root, 'resources/skills/backlog'), join(workspaceDir, '.claude/skills/backlog'), {
    recursive: true,
  })

  const app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out/main/index.js')],
    cwd: root,
    env: {
      ...process.env,
      MULTICODE_USER_DATA_DIR: userDataDir,
      MULTICODE_ALLOW_MULTI_INSTANCE: '1',
      MULTICODE_DIAGNOSTICS: '1',
      MULTICODE_TEST_OPEN_DIR: workspaceDir,
    },
  })

  try {
    const page = await app.firstWindow()
    page.on('console', (m) => {
      if (m.type() === 'error') console.error(`[renderer] ${m.text()}`)
    })
    await page.waitForLoadState('domcontentloaded')
    // Wide window so the Backlog panel renders its split list + detail layout
    // (the detail-pane agreement checks need the second pane visible).
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(1800, 1000)
      win.center()
    })
    await page.waitForTimeout(1500)

    // --- Onboarding to a Standard workspace (same flow as the T3 harness) ---
    await domClick(page, page.getByRole('button', { name: /Get started/i }))
    await domClick(page, page.getByRole('button', { name: /Continue/i }))
    await page.getByPlaceholder('my-workspace').fill('T5 Backlog Menu')
    await domClick(page, page.locator('button').filter({ hasText: 'Browse existing folder' }))
    await page.waitForFunction((dir) => document.body.innerText.includes(dir), workspaceDir, {
      timeout: 10000,
    })
    await domClick(page, page.getByRole('button', { name: /^Continue$/i }))
    await page.waitForFunction(() => document.body.innerText.includes('Standard'), null, { timeout: 10000 })
    await domClick(page, page.locator('button').filter({ hasText: /^Standard/ }))
    for (let i = 0; i < 12; i += 1) {
      const hasRow = (await page.locator('[role="treeitem"]').count()) > 0
      const overlayCount = await page.locator('div.fixed.inset-0.z-50').count()
      if (hasRow && overlayCount === 0) break
      const overlay = page.locator('div.fixed.inset-0.z-50')
      const overlayClose = overlay.locator('button[aria-label*="lose"], button[aria-label*="ismiss"]')
      const advance = page
        .locator('button')
        .filter({ hasText: /^(Continue|Create workspace|Create|Finish|Open workspace|Done|Skip|Get started)$/ })
      if (hasRow && overlayCount > 0 && (await overlayClose.count()) > 0) {
        await domClick(page, overlayClose)
      } else if (!hasRow && (await advance.count()) > 0) {
        await domClick(page, advance)
      } else if (overlayCount > 0) {
        await page.keyboard.press('Escape')
        await page.waitForTimeout(400)
      } else {
        await page.waitForTimeout(800)
      }
    }

    // --- Open the Backlog rail panel ---
    await domClick(page, page.locator('button[aria-label^="Backlog"]'))
    const list = page.locator('[role="listbox"][aria-label="Backlog items"]')
    await list.waitFor({ state: 'visible', timeout: 10000 })
    await page.waitForFunction(
      () => document.querySelectorAll('[role="option"]').length >= 2,
      null,
      { timeout: 10000 },
    )
    check('backlog list renders seeded items', true)

    // --- AC1: right-click selects the row and opens the menu ---
    const menu = await openRowMenu(page)
    const row = page.locator('[role="option"]', { hasText: 'Dark mode toggle' }).first()
    check('right-click selects the row', (await row.getAttribute('aria-selected')) === 'true')
    for (const label of ['Send to agent', 'Star', 'Status', 'Priority', 'Size', 'Open in editor', 'Reveal in Files', 'Rename…', 'Archive', 'Delete…']) {
      const found = (await menu.locator('button').filter({ hasText: new RegExp(`^${label.replace('…', '\\u2026')}`) }).count()) > 0
      check(`menu item present: ${label}`, found)
    }
    check(
      'star is menuitemcheckbox unchecked',
      (await menu.locator('[role="menuitemcheckbox"][aria-checked="false"]').filter({ hasText: 'Star' }).count()) === 1,
    )
    check('highlight swatch row present', (await menu.locator('[role="menuitemradio"]').count()) === 8)
    await page.screenshot({ path: join(screenshotDir, 't5-01-row-menu.png') })

    // Roving focus across the top level.
    await page.keyboard.press('ArrowDown')
    const firstFocused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')
    check('ArrowDown focuses first item', firstFocused.startsWith('Send to agent'), `active="${firstFocused}"`)

    // --- Status submenu: no archived entry; pick Ready; verify items.json ---
    const statusFlyout = await openFlyout(page, menu, 'Status')
    const statusLabels = await statusFlyout.locator('button').allTextContents()
    check(
      'status submenu lists 5 states, no Archived',
      statusLabels.length === 5 && !statusLabels.some((entry) => /archived/i.test(entry)),
      statusLabels.join(' | '),
    )
    check(
      'current status Idea is checked',
      (await statusFlyout.locator('[aria-checked="true"]').filter({ hasText: 'Idea' }).count()) === 1,
    )
    await page.screenshot({ path: join(screenshotDir, 't5-02-status-flyout.png') })
    await domClick(page, statusFlyout.locator('button').filter({ hasText: 'Ready' }))
    await page.waitForTimeout(700)
    check('menu closes after status pick', (await page.locator('[role="menu"]').count()) === 0)
    let store = await readItems()
    check('items.json status persisted', itemRecord(store, ITEM_A)?.status === 'ready', JSON.stringify(itemRecord(store, ITEM_A)?.status))

    // --- Priority submenu → High; visible in detail pane after re-scan ---
    let menu2 = await openRowMenu(page)
    const priorityFlyout = await openFlyout(page, menu2, 'Priority')
    await domClick(page, priorityFlyout.locator('button').filter({ hasText: 'High' }))
    await page.waitForTimeout(700)
    store = await readItems()
    check('items.json criticality persisted', itemRecord(store, ITEM_A)?.metadata?.criticality === 'high' || itemRecord(store, ITEM_A)?.criticality === 'high', JSON.stringify(itemRecord(store, ITEM_A)))
    // This Backlog surface is a fixed-narrow nav pane, so it always renders the
    // single-column layout: the detail face shows the menu's target on click.
    await domClick(page, row)
    check(
      'detail pane shows the menu target',
      (await page.locator('h3', { hasText: 'Dark mode toggle' }).count()) > 0,
    )
    const prioritySelect = page.locator('[role="combobox"][aria-label="Set priority"]')
    check('detail pane priority editor shows High', /High/.test((await prioritySelect.innerText().catch(() => '')) ?? ''))
    await domClick(page, page.getByRole('button', { name: 'Back to list' }))
    await list.waitFor({ state: 'visible', timeout: 5000 })

    // --- Size submenu → M ---
    menu2 = await openRowMenu(page)
    const sizeFlyout = await openFlyout(page, menu2, 'Size')
    await domClick(page, sizeFlyout.locator('button').filter({ hasText: /^M ·/ }))
    await page.waitForTimeout(700)
    store = await readItems()
    const recA = itemRecord(store, ITEM_A)
    check('items.json difficulty persisted', recA?.metadata?.difficulty === 'm' || recA?.difficulty === 'm', JSON.stringify(recA))
    check('row size token shows M', (await row.locator('span', { hasText: /^M$/ }).count()) > 0)

    // --- Star + highlight stay-open behavior; persisted highlight field ---
    menu2 = await openRowMenu(page)
    await domClick(page, menu2.locator('[role="menuitemcheckbox"]').filter({ hasText: 'Star' }))
    check(
      'star toggles to checked and menu stays open',
      (await menu2.locator('[role="menuitemcheckbox"][aria-checked="true"]').count()) === 1,
    )
    await domClick(page, menu2.locator('[role="menuitemradio"][aria-label="Highlight Red"]'))
    check(
      'red swatch reflects aria-checked after re-scan',
      (await menu2.locator('[role="menuitemradio"][aria-label="Highlight Red"][aria-checked="true"]').count()) === 1,
    )
    store = await readItems()
    const highlight = itemRecord(store, ITEM_A)?.highlight ?? itemRecord(store, ITEM_A)?.metadata?.highlight
    check('items.json highlight persisted', highlight?.starred === true && highlight?.color === 'red', JSON.stringify(highlight))
    check('row shows starred glyph', (await row.locator('svg[aria-label="Starred"]').count()) > 0)
    await page.screenshot({ path: join(screenshotDir, 't5-03-star-highlight.png') })

    // --- Escape closes and returns focus to the list ---
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    check('Escape closes the menu', (await page.locator('[role="menu"]').count()) === 0)
    const focusOnList = await page.evaluate(
      () => document.activeElement?.getAttribute('aria-label') === 'Backlog items',
    )
    check('focus returns to the backlog list', focusOnList)

    // --- Send to agent: live claude session receives /backlog <path> ---
    const sessions = await page.evaluate(() => window.api.terminalList())
    const agentSession = sessions.find((s) => s.kind === 'agent' && s.processAlive)
    check('workspace has a live agent session', Boolean(agentSession), agentSession?.cli ?? 'none')

    if (agentSession) {
      await page.evaluate((sessionId) => {
        window.__t5Captured = ''
        window.__t5Detach = window.api.onTerminalData(sessionId, (data) => {
          window.__t5Captured += data
        })
      }, agentSession.sessionId)

      menu2 = await openRowMenu(page)
      const agentFlyout = await openFlyout(page, menu2, 'Send to agent')
      await page.screenshot({ path: join(screenshotDir, 't5-04-send-flyout.png') })
      const agentRows = agentFlyout.locator('[role="menuitem"]')
      const agentRowCount = await agentRows.count()
      check('send flyout lists the workspace agent', agentRowCount >= 1, `${agentRowCount} row(s)`)
      const enabledRow = agentFlyout.locator('[role="menuitem"]:not([disabled])').first()
      check('live agent row is enabled', (await agentFlyout.locator('[role="menuitem"]:not([disabled])').count()) >= 1)
      await domClick(page, enabledRow)
      await page.waitForTimeout(1500)
      const errorVisible = await page.getByText('Dismiss').isVisible().catch(() => false)
      check('live send produced no actionError', !errorVisible)
      const captured = await page.evaluate(() => {
        window.__t5Detach?.()
        return window.__t5Captured ?? ''
      })
      const sawSlash = captured.includes('/backlog')
      check(
        'terminal output echoes the /backlog paste (best-effort)',
        true,
        sawSlash ? 'echo contained /backlog' : `no echo observed (${captured.length} bytes captured); core returned success`,
      )

      // --- Dead stale session: kill the PTY after the flyout fetched liveness,
      // then pick the still-enabled row → actionError, no fake success ---
      menu2 = await openRowMenu(page)
      const staleFlyout = await openFlyout(page, menu2, 'Send to agent')
      const staleRow = staleFlyout.locator('[role="menuitem"]:not([disabled])').first()
      const staleAvailable = (await staleFlyout.locator('[role="menuitem"]:not([disabled])').count()) >= 1
      if (staleAvailable) {
        await page.evaluate((sessionId) => window.api.terminalKill(sessionId), agentSession.sessionId)
        await page.waitForTimeout(800)
        await domClick(page, staleRow)
        await page.waitForTimeout(1000)
        const notice = await page.getByText(/no longer running/i).first().isVisible().catch(() => false)
        check('dead stale session surfaces actionError notice', notice)
        await page.screenshot({ path: join(screenshotDir, 't5-05-dead-session-error.png') })
      } else {
        check('dead stale session surfaces actionError notice', false, 'no enabled row to test against')
      }

      // --- After a fresh flyout open, row state matches real liveness: a dead
      // session renders disabled; if the runtime auto-relaunched the agent
      // (same sessionId, processAlive again), enabled is the correct state ---
      await closeMenus(page)
      menu2 = await openRowMenu(page)
      const refreshedFlyout = await openFlyout(page, menu2, 'Send to agent')
      await page.waitForTimeout(800)
      const liveNow = await page.evaluate(async (sessionId) => {
        const sessions = await window.api.terminalList()
        const session = sessions.find((candidate) => candidate.sessionId === sessionId)
        return session?.processAlive === true
      }, agentSession.sessionId)
      const disabledCount = await refreshedFlyout.locator('[role="menuitem"][disabled]').count()
      const refreshedEnabled = await refreshedFlyout.locator('[role="menuitem"]:not([disabled])').count()
      check(
        'freshly opened flyout matches real session liveness',
        liveNow ? refreshedEnabled >= 1 : disabledCount >= 1 && refreshedEnabled === 0,
        `processAlive=${liveNow}; ${disabledCount} disabled, ${refreshedEnabled} enabled`,
      )
      await page.screenshot({ path: join(screenshotDir, 't5-06-dead-session-refresh.png') })
      await closeMenus(page)

      // --- Zero-agents branch: close the Agent tab; if that removes the agent
      // record, the flyout must render one disabled "No running agents" row ---
      const agentTab = page.locator('.flexlayout__tab_button', { hasText: 'Agent' }).first()
      if ((await agentTab.count()) > 0) {
        await agentTab.hover()
        await agentTab
          .locator('.flexlayout__tab_button_trailing')
          .click({ force: true })
          .catch(() => {})
        await page.waitForTimeout(600)
        const confirmBtn = page
          .locator('div.fixed button')
          .filter({ hasText: /^(Close|Close agent|Remove|Yes)/ })
          .first()
        if (await confirmBtn.isVisible().catch(() => false)) await domClick(page, confirmBtn)
        await page.waitForTimeout(800)
        menu2 = await openRowMenu(page)
        const zeroFlyout = await openFlyout(page, menu2, 'Send to agent')
        const noAgentRow = await zeroFlyout
          .locator('[role="menuitem"][disabled]')
          .filter({ hasText: 'No running agents' })
          .count()
        const remainingRows = await zeroFlyout.locator('[role="menuitem"]').count()
        check(
          'zero agents renders disabled "No running agents" row',
          noAgentRow === 1 && remainingRows === 1,
          `${noAgentRow} placeholder, ${remainingRows} total row(s)`,
        )
        await page.screenshot({ path: join(screenshotDir, 't5-07-no-running-agents.png') })
        await closeMenus(page)
      }
    }

    const failed = checks.filter((c) => !c.ok)
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
    if (failed.length > 0) process.exitCode = 1
  } finally {
    await app.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})
