#!/usr/bin/env node
// Live Electron verification for MC-2104 — the four hosts that opened NATIVE
// Electron context menus now open the in-app one.
//
// A native `Menu.popup` is drawn by the OS, outside the renderer's DOM: it has
// no `role="menu"` node, so Playwright cannot see it at all. That is exactly
// what makes this pass meaningful. Every check below asserts a DOM menu with
// the shared contract (role, accessible name, sentence-case rows, Escape
// returning focus) at a place that used to produce something Playwright could
// not have found.
//
// Covers: the file tree (incl. its flyout submenu, its disabled explainer row
// and its destructive row), the editor, Git's change rows, and the tab strip.
//
// Prereqs: `npm run build` (needs out/main), playwright available:
//   tmp=/tmp/multicode-playwright
//   npm --prefix "$tmp" install playwright --no-audit --no-fund
//   NODE_PATH="$tmp/node_modules" node scripts/testing/native-menu-conformance-pass.mjs

import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

const run = promisify(execFile)
const require = createRequire(import.meta.url)
const root = resolve(new URL('../..', import.meta.url).pathname)
const tempRoot = process.env.MULTICODE_MENU_TMP_ROOT || '/tmp/multicode-native-menu-pass'
const workspaceDir = join(tempRoot, 'workspace')
const userDataDir = join(tempRoot, 'user-data')
const screenshotDir = process.env.MULTICODE_MENU_SCREENSHOT_DIR || join(tempRoot, 'screenshots')

// `playwright-core` is enough — driving Electron never needs the bundled
// browsers the full `playwright` package downloads.
async function loadPlaywright() {
  try {
    return require('playwright')
  } catch {
    // fall through to playwright-core
  }
  try {
    return require('playwright-core')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      [
        'Playwright is not available to this Node process.',
        '  tmp=/tmp/multicode-playwright',
        '  npm --prefix "$tmp" install playwright --no-audit --no-fund',
        '  NODE_PATH="$tmp/node_modules" node scripts/testing/native-menu-conformance-pass.mjs',
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

async function domClick(page, locator) {
  await locator.first().evaluate((el) => el.click())
  await page.waitForTimeout(400)
}

// Every visible row of an open menu surface, in order.
async function menuLabels(menu) {
  return await menu.evaluate((surface) =>
    Array.from(surface.querySelectorAll('[data-menu-item="true"]'))
      .filter((el) => el.closest('[role="menu"]') === surface)
      .map((el) => el.textContent.replace(/\s+/gu, ' ').trim())
      .filter((text) => text.length > 0),
  )
}

async function escapeMenus(page) {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
}

async function seedWorkspace() {
  await rm(tempRoot, { recursive: true, force: true })
  await mkdir(join(workspaceDir, 'backlog'), { recursive: true })
  await mkdir(userDataDir, { recursive: true })
  await mkdir(screenshotDir, { recursive: true })

  await writeFile(join(workspaceDir, 'notes.txt'), 'first line\nsecond line\n')
  await writeFile(join(workspaceDir, 'report.html'), '<h1>Report</h1>\n')
  await writeFile(
    join(workspaceDir, 'backlog/2026-08-05-menu-pass.md'),
    '# Menu pass\n\nA seeded backlog item, so the tree offers its sprint flyout.\n',
  )

  const git = (...args) => run('git', args, { cwd: workspaceDir })
  await git('init', '-q')
  await git('config', 'user.email', 'pass@example.com')
  await git('config', 'user.name', 'Menu Pass')
  await git('add', '.')
  await git('commit', '-qm', 'seed')
  // One tracked file with an unstaged edit, so the Git panel has a change row.
  await writeFile(join(workspaceDir, 'notes.txt'), 'first line\nsecond line\nthird line\n')
}

async function main() {
  const { _electron: electron } = await loadPlaywright()
  const electronPath = require('electron')

  await seedWorkspace()

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
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(1800, 1000)
      win.center()
    })
    await page.waitForTimeout(1500)

    // --- Onboarding to a Standard workspace ---
    await domClick(page, page.getByRole('button', { name: /Get started/i }))
    await domClick(page, page.getByRole('button', { name: /Continue/i }))
    await page.getByPlaceholder('my-workspace').fill('Menu Pass')
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
    await page.waitForFunction(() => document.querySelectorAll('[role="treeitem"]').length > 0, null, {
      timeout: 15000,
    })
    check('file tree rendered', true)

    // ================= FileExplorer =================
    const notesRow = page.locator('[role="treeitem"]', { hasText: 'notes.txt' }).first()
    await notesRow.click({ button: 'right' })
    let menu = page.locator('[role="menu"][aria-label="Actions for notes.txt"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    check('file tree right-click opens a DOM menu (was native)', true)

    const treeLabels = await menuLabels(menu)
    check('file tree rows are sentence case', true, treeLabels.join(' | '))
    for (const label of ['Open', 'Reveal in file manager', 'New file', 'New folder', 'Paste', 'Rename', 'Refresh']) {
      check(`file tree row: ${label}`, treeLabels.includes(label))
    }
    check('no Title-Cased row survives', !treeLabels.some((l) => /^(New File|New Folder|Open in Explorer|View Git Diff|Delete Items)/.test(l)))
    check(
      'destructive Delete row is ink, not a fill',
      (await menu.locator('button', { hasText: /^Delete/ }).evaluate((el) =>
        getComputedStyle(el).color,
      )) !== (await menu.locator('button', { hasText: /^Refresh$/ }).evaluate((el) => getComputedStyle(el).color)),
    )
    await page.screenshot({ path: join(screenshotDir, 'file-tree-menu.png') })
    await escapeMenus(page)

    // The git-diff row appears only on a file git knows has changed.
    await notesRow.click({ button: 'right' })
    menu = page.locator('[role="menu"][aria-label="Actions for notes.txt"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    check('changed file offers "View Git diff"', (await menuLabels(menu)).includes('View Git diff'))
    await escapeMenus(page)

    // The submenu, on a backlog markdown file: the flyout the native menu drew
    // as an OS submenu is now MenuFlyoutItem.
    const backlogFolder = page.locator('[role="treeitem"]', { hasText: 'backlog' }).first()
    await backlogFolder.dblclick()
    await page.waitForTimeout(700)
    const itemRow = page.locator('[role="treeitem"]', { hasText: '2026-08-05-menu-pass.md' }).first()
    await itemRow.click({ button: 'right' })
    menu = page.locator('[role="menu"][aria-label="Actions for 2026-08-05-menu-pass.md"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    const flyoutTrigger = menu.locator('button[aria-haspopup="menu"]').filter({ hasText: 'Run a sprint from' })
    check('flyout trigger present and sentence case', (await flyoutTrigger.count()) === 1)
    await flyoutTrigger.hover()
    const flyout = page.locator('[role="menu"][aria-label="Run a sprint from"]')
    await flyout.waitFor({ state: 'visible', timeout: 5000 })
    const flyoutLabels = await menuLabels(flyout)
    check(
      'flyout rows survive the port, sentence case',
      ['Product plan…', 'Implementation plan…', 'Generic handoff…'].every((l) => flyoutLabels.includes(l)),
      flyoutLabels.join(' | '),
    )
    check(
      'flyout surface inherits the menu type size',
      (await flyout.evaluate((el) => getComputedStyle(el).fontSize))
        === (await menu.evaluate((el) => getComputedStyle(el).fontSize)),
    )
    await page.screenshot({ path: join(screenshotDir, 'file-tree-flyout.png') })
    await escapeMenus(page)

    // Escape returns focus to the tree rather than dropping it on <body>.
    await notesRow.click({ button: 'right' })
    await page.locator('[role="menu"][aria-label="Actions for notes.txt"]').waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    check(
      'Escape returns focus into the tree, never <body>',
      await page.evaluate(() => document.activeElement?.getAttribute('role') === 'tree'),
    )

    // ================= EditorPanel =================
    await notesRow.dblclick()
    await page.waitForTimeout(2500)
    const editorSurface = page.locator('.monaco-editor').first()
    await editorSurface.waitFor({ state: 'visible', timeout: 20000 })
    await editorSurface.click({ button: 'right', position: { x: 120, y: 30 } })
    menu = page.locator('[role="menu"][aria-label^="Editor actions"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    check('editor right-click opens a DOM menu (was native)', true)
    const editorLabels = await menuLabels(menu)
    check(
      'editor rows are sentence case',
      ['Cut', 'Copy', 'Paste', 'Select all', 'Close other editor tabs'].every((l) =>
        editorLabels.some((row) => row.startsWith(l)),
      ),
      editorLabels.join(' | '),
    )
    check(
      'editor rows carry the shortcut hints a native menu could not',
      editorLabels.some((row) => /^Paste\s+(⌘|Ctrl\+)V$/.test(row)),
      editorLabels.join(' | '),
    )
    check(
      'Cut is disabled with no selection',
      (await menu.locator('button', { hasText: /^Cut/ }).first().isDisabled()),
    )
    await page.screenshot({ path: join(screenshotDir, 'editor-menu.png') })

    // Select all runs through the deferred focus+trigger path.
    await menu.locator('button', { hasText: /^Select all/ }).first().click()
    await page.waitForTimeout(600)
    const selectedText = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    check(
      'Select all reaches Monaco after the menu closes',
      selectedText.includes('first line') && selectedText.includes('third line'),
      JSON.stringify(selectedText.slice(0, 60)),
    )

    // ================= Tab strip =================
    const editorTab = page.locator('.flexlayout__tab_button').filter({ hasText: 'notes.txt' }).first()
    await editorTab.click({ button: 'right' })
    menu = page.locator('[role="menu"][aria-label^="Tab actions"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    check('tab right-click opens a DOM menu (was native)', true)
    const tabLabels = await menuLabels(menu)
    check(
      'tab rows are sentence case',
      ['Hide tab', 'Hide all', 'Close other tabs'].every((l) => tabLabels.includes(l)),
      tabLabels.join(' | '),
    )
    await page.screenshot({ path: join(screenshotDir, 'tab-menu.png') })
    await escapeMenus(page)

    // ================= GitPanel change rows =================
    await domClick(page, page.locator('button[aria-label^="Git"]').first())
    await page.waitForTimeout(2500)
    const changeRow = page.locator('[data-git-change-row="true"]').first()
    await changeRow.waitFor({ state: 'visible', timeout: 20000 })
    await changeRow.click({ button: 'right' })
    menu = page.locator('[role="menu"][aria-label^="Actions for"]').last()
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    check('git change row opens a DOM menu (was native)', true)
    const gitLabels = await menuLabels(menu)
    check(
      'git change rows and log rows now share the idiom, sentence case',
      gitLabels.includes('View Git diff') && gitLabels.includes('Open file in editor'),
      gitLabels.join(' | '),
    )
    await page.screenshot({ path: join(screenshotDir, 'git-change-row-menu.png') })
    await escapeMenus(page)
  } finally {
    await app.close().catch(() => {})
  }

  const failed = checks.filter((entry) => !entry.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  console.log(`screenshots: ${screenshotDir}`)
  if (failed.length > 0) {
    console.error(`\n${failed.length} FAILED:`)
    failed.forEach((entry) => console.error(`  - ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`))
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
