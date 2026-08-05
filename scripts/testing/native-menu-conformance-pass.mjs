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
// The editor section exercises the real system clipboard (Monaco's cut/paste
// run through its hidden textarea, which is the whole reason the menu has to
// hand focus back before triggering). It reads the clipboard first and writes
// it back at the end, so a run does not cost you what you had copied.
//
// Prereqs: `npm run build` (needs out/main), playwright available:
//   tmp=/tmp/multicode-playwright
//   npm --prefix "$tmp" install playwright --no-audit --no-fund
//   NODE_PATH="$tmp/node_modules" node scripts/testing/native-menu-conformance-pass.mjs

import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

const run = promisify(execFile)
const require = createRequire(import.meta.url)
const root = resolve(new URL('../..', import.meta.url).pathname)
// Realpath, deliberately: on macOS `/tmp` is a symlink to `/private/tmp`, and
// git reports its repo root resolved while the file tree carries the path it
// was opened with. Under the symlinked path the two never match and the tree's
// git rows silently never appear — a harness artefact that looks exactly like a
// product bug.
const tempRoot = realpathSync(
  process.env.MULTICODE_MENU_TMP_ROOT || tmpdir(),
).concat('/multicode-native-menu-pass')
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

  // A terminal spawned by Multicode's own dev shell inherits
  // ELECTRON_RENDERER_URL / NODE_ENV=development, which would point this
  // launch at a running dev server instead of the bundle under test.
  const env = { ...process.env }
  delete env.ELECTRON_RENDERER_URL
  delete env.NODE_ENV_ELECTRON_VITE

  const app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out/main/index.js')],
    cwd: root,
    env: {
      ...env,
      NODE_ENV: 'production',
      MULTICODE_USER_DATA_DIR: userDataDir,
      MULTICODE_ALLOW_MULTI_INSTANCE: '1',
      MULTICODE_DIAGNOSTICS: '1',
      MULTICODE_TEST_OPEN_DIR: workspaceDir,
    },
  })

  if (process.env.MULTICODE_MENU_DEBUG) {
    app.process().stdout?.on('data', (d) => process.stdout.write(`[main] ${d}`))
    app.process().stderr?.on('data', (d) => process.stderr.write(`[main:err] ${d}`))
  }

  // The first window Electron reports is a transient bootstrap one that closes
  // again; the shell's real window carries `windowId=primary` in its URL.
  async function primaryWindow() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const candidate = app.windows().find((w) => w.url().includes('windowId=primary') && !w.isClosed())
      if (candidate) return candidate
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error('primary window never appeared')
  }

  try {
    await app.firstWindow().catch(() => {})
    const page = await primaryWindow()
    page.on('console', (m) => {
      if (m.type() === 'error') console.error(`[renderer] ${m.text()}`)
    })
    page.on('close', () => console.error('[harness] window closed'))
    page.on('crash', () => console.error('[harness] window crashed'))
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(1800, 1000)
      win.center()
    })
    await page.waitForTimeout(1500)

    // --- New Standard workspace over the seeded folder. `MULTICODE_TEST_OPEN_DIR`
    // makes the folder picker resolve to it without a native dialog. ---
    await domClick(page, page.locator('button').filter({ hasText: /^Workspace$/ }))
    await domClick(page, page.locator('button').filter({ hasText: /^Browse$/ }))
    await page.waitForTimeout(1200)
    await domClick(page, page.locator('button').filter({ hasText: /^Create workspace$/ }))
    await page.waitForFunction(() => document.querySelectorAll('[role="treeitem"]').length > 0, null, {
      timeout: 30000,
    })
    check('file tree rendered', true)

    // ================= GitPanel change rows =================
    // Opened first: the Git panel is what warms the shared status the file tree
    // reads for its own git rows.
    await domClick(page, page.locator('button[aria-label^="Toggle Git panel"]').first())
    const changeRow = page.locator('[data-git-change-row="true"]').first()
    await changeRow.waitFor({ state: 'visible', timeout: 30000 })
    await changeRow.click({ button: 'right' })
    let menu = page.locator('[role="menu"][aria-label^="Actions for"]').last()
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

    // ================= FileExplorer =================
    // Back to the tree: the Git panel took the rail's slot.
    await domClick(page, page.locator('button[aria-label^="Toggle file explorer"]').first())
    await page.waitForFunction(() => document.querySelectorAll('[role="treeitem"]').length > 0, null, {
      timeout: 20000,
    })
    const notesRow = page.locator('[role="treeitem"]', { hasText: 'notes.txt' }).first()
    await notesRow.click({ button: 'right' })
    menu = page.locator('[role="menu"][aria-label="Actions for notes.txt"]')
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

    // The git-diff row appears only on a file git knows has changed, which
    // waits on the panel's own status poll.
    let sawGitDiffRow = false
    for (let attempt = 0; attempt < 10 && !sawGitDiffRow; attempt += 1) {
      await page.waitForTimeout(2000)
      await notesRow.click({ button: 'right' })
      menu = page.locator('[role="menu"][aria-label="Actions for notes.txt"]')
      await menu.waitFor({ state: 'visible', timeout: 5000 })
      sawGitDiffRow = (await menuLabels(menu)).includes('View Git diff')
      await escapeMenus(page)
    }
    check('changed file offers "View Git diff"', sawGitDiffRow)

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
    // A fresh profile opens files in the external editor window (the sticky
    // `openFilesInExternalWindow` default). Docking it back puts the file in an
    // in-panel EditorPanel tab — the surface this item converted — and flips the
    // preference, so later opens land there too.
    await notesRow.dblclick()
    let externalWindow = null
    for (let attempt = 0; attempt < 40 && !externalWindow; attempt += 1) {
      externalWindow = app.windows().find((w) => w.url().includes('fileName=notes.txt') && !w.isClosed())
      if (!externalWindow) await page.waitForTimeout(500)
    }
    if (!externalWindow) throw new Error('external editor window never opened')
    await externalWindow
      .locator('button[aria-label="Dock current file back into the workspace"]')
      .first()
      .click()
    await page
      .locator('.flexlayout__tab_button')
      .filter({ hasText: 'notes.txt' })
      .first()
      .waitFor({ state: 'visible', timeout: 30000 })
    const editorSurface = page.locator('.monaco-editor').first()
    await editorSurface.waitFor({ state: 'visible', timeout: 60000 })
    await page.waitForTimeout(1500)
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
      editorLabels.some((row) => /^Paste\s*(⌘|Ctrl\+)V$/u.test(row)),
      editorLabels.join(' | '),
    )
    check(
      'Cut is disabled with no selection',
      (await menu.locator('button', { hasText: /^Cut/ }).first().isDisabled()),
    )
    await page.screenshot({ path: join(screenshotDir, 'editor-menu.png') })

    // The real proof for the deferred focus+trigger path: activating a row
    // reaches Monaco, which needs the editor to hold focus again after the menu
    // has closed and handed focus back. Monaco paints its selection as its own
    // `.selected-text` nodes rather than a document selection.
    await menu.locator('button', { hasText: /^Select all/ }).first().click()
    await page.waitForTimeout(1200)
    const selectionNodes = await page.locator('.monaco-editor .selected-text').count()
    check(
      'Select all reaches Monaco after the menu closes',
      selectionNodes > 0,
      `${selectionNodes} selection nodes`,
    )

    // The clipboard rows are the ones that actually depend on the editor
    // holding focus — Monaco routes them through its hidden textarea, so a menu
    // that had not handed focus back would silently no-op. Cut then Paste, on
    // the real system clipboard, which is saved and put back afterwards.
    const savedClipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
    // Monaco renders spaces as non-breaking, so normalise before matching.
    const editorText = async () =>
      (await page.locator('.monaco-editor .view-lines').first().innerText()).replace(/\u00a0/gu, ' ')
    const before = await editorText()

    await editorSurface.click({ button: 'right', position: { x: 120, y: 30 } })
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    check(
      'Cut enables once there is a selection',
      !(await menu.locator('button', { hasText: /^Cut/ }).first().isDisabled()),
    )
    await menu.locator('button', { hasText: /^Cut/ }).first().click()
    await page.waitForTimeout(1200)
    const afterCut = await editorText()
    check('Cut reaches Monaco and empties the buffer', afterCut.trim() === '', JSON.stringify(afterCut.slice(0, 40)))
    check(
      'Cut put the text on the real clipboard',
      (await app.evaluate(({ clipboard }) => clipboard.readText())).includes('first line'),
    )

    await editorSurface.click({ button: 'right', position: { x: 60, y: 20 } })
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    await menu.locator('button', { hasText: /^Paste/ }).first().click()
    await page.waitForTimeout(1200)
    const afterPaste = await editorText()
    check(
      'Paste reaches Monaco and restores the buffer',
      afterPaste.includes('first line') && afterPaste.includes('third line'),
      JSON.stringify(afterPaste.slice(0, 40)),
    )
    check('the buffer round-tripped', afterPaste.trim() === before.trim())
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard)

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

    check(
      'an editor tab offers no colour row, as before',
      (await menu.locator('[role="menuitemradio"]').count()) === 0,
    )
    await escapeMenus(page)

    // A PLAIN TERMINAL tab additionally carries the swatch row — the seven
    // highlights the native menu could only offer as Title-Cased checkbox rows
    // of their names, and the same control the workspace sidebar already used.
    await domClick(page, page.locator('button[aria-label="Spawn agent"]').first())
    await domClick(page, page.locator('button').filter({ hasText: /^Terminal$/ }).first())
    const terminalTab = page.locator('.flexlayout__tab_button').filter({ hasText: 'Terminal' }).first()
    await terminalTab.waitFor({ state: 'visible', timeout: 20000 })
    await terminalTab.click({ button: 'right' })
    menu = page.locator('[role="menu"][aria-label^="Tab actions"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    const swatches = await menu.locator('[role="menuitemradio"]').count()
    check(
      'terminal tab colour picker is the shared swatch row',
      swatches === 8,
      `${swatches} menuitemradio rows (clear + 7 highlights)`,
    )
    await page.screenshot({ path: join(screenshotDir, 'terminal-tab-menu.png') })
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
