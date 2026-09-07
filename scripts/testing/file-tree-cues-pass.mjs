#!/usr/bin/env node

// Drives the real app to the File Explorer and reads the three row cues off the
// DOM: the test wash, the generated/excluded wash, and the gitignored dim. The
// tree is opened on THIS checkout, so the rows are the repo's own — `out/` and
// `node_modules` are genuinely ignored, and `src/main/automations` genuinely
// holds a `.test.ts` beside most of its sources.
//
// The row exposes `data-row-wash` / `data-row-ignored` for exactly this: the
// cues are colour, and colour is what a screenshot cannot assert on.

import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createWorkspaceThroughNewChat, newChatLaunchEnv, resolveMainWindow } from './newChatWorkspace.mjs'

const require = createRequire(import.meta.url)
const root = resolve(new URL('../..', import.meta.url).pathname)
const userDataDir = process.env.MULTICODE_PW_USER_DATA || '/tmp/multicode-file-tree-cues-user-data'
const outDir = process.env.MULTICODE_PW_OUT || '/tmp/file-tree-cues'
const folder = process.env.MULTICODE_TEST_OPEN_DIR || root

const ROW = '[data-file-explorer-row="true"]'

async function domClick(locator) {
  await locator.first().evaluate((el) => {
    if (el instanceof HTMLElement) el.click()
  })
}

// The Files entry lives behind the pane strip's "Open in the pane" trigger, so
// the trigger opens first; clicking a hidden button silently does nothing,
// which is what made an earlier version of this pass flap between 318 rows and
// zero.
async function openFilesPane(page) {
  const rows = page.locator(ROW)
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if ((await rows.count()) > 0) return true
    for (const label of ['Open in the pane', 'Open pane']) {
      const trigger = page.locator('[aria-label="' + label + '"]')
      if ((await trigger.count()) > 0) {
        await domClick(trigger).catch(() => {})
        await page.waitForTimeout(400)
      }
    }
    const files = page.locator('button').filter({ hasText: /^Files/ }).first()
    if ((await files.count()) > 0) await domClick(files).catch(() => {})
    await page.waitForTimeout(900)
  }
  return (await rows.count()) > 0
}

// Matched on the row's own name span, not on its textContent: a folder that git
// has something to say about also renders a trailing status letter, so `^src$`
// against the whole row misses exactly the folders worth opening.
async function expandFolder(page, name) {
  const handle = await page.evaluateHandle(
    ([rowSelector, folderName]) =>
      Array.from(document.querySelectorAll(rowSelector)).find((el) => {
        const label = Array.from(el.querySelectorAll('span')).find((s) => s.textContent?.trim() === folderName)
        return Boolean(label) && Boolean(el.querySelector('button[aria-label="Expand folder"]'))
      }) ?? null,
    [ROW, name]
  )
  const element = handle.asElement()
  if (!element) return false
  await element.evaluate((el) => {
    const chevron = el.querySelector('button[aria-label="Expand folder"]')
    if (chevron instanceof HTMLElement) chevron.click()
  })
  await page.waitForTimeout(700)
  return true
}

// Right-click a folder row, walk into "Mark directory as", pick a role.
async function markDirectoryAs(page, folderName, roleLabel) {
  const handle = await page.evaluateHandle(
    ([rowSelector, name]) =>
      Array.from(document.querySelectorAll(rowSelector)).find((el) =>
        Array.from(el.querySelectorAll('span')).some((s) => s.textContent?.trim() === name)
      ) ?? null,
    [ROW, folderName]
  )
  const element = handle.asElement()
  if (!element) return 'row not found'

  const box = await element.boundingBox()
  if (!box) return 'row not visible'
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  await page.waitForTimeout(600)

  const flyout = page.getByRole('menuitem', { name: 'Mark directory as' })
  if ((await flyout.count()) === 0) return 'flyout missing'
  await flyout.first().hover()
  await page.waitForTimeout(500)

  const role = page.getByRole('menuitem', { name: roleLabel })
  if ((await role.count()) === 0) return 'role row missing'
  await role.first().evaluate((el) => {
    if (el instanceof HTMLElement) el.click()
  })
  await page.waitForTimeout(600)
  return 'marked ' + folderName + ' as ' + roleLabel
}

async function main() {
  const { _electron: electron } = await require('playwright')
  const electronPath = require('electron')

  await rm(userDataDir, { recursive: true, force: true })
  await mkdir(userDataDir, { recursive: true })
  await mkdir(outDir, { recursive: true })

  // ELECTRON_RENDERER_URL is what electron-vite exports while `npm run dev` is
  // running, and the main process prefers it over the built files. Inheriting
  // it from the launching shell points this pass at whatever checkout owns that
  // dev server — for a worktree, the parent repo — so the app comes up without
  // any of the changes under test and every assertion quietly reads the wrong
  // build. Strip it, and NODE_ENV_ELECTRON_VITE with it.
  const { ELECTRON_RENDERER_URL, NODE_ENV_ELECTRON_VITE, ...cleanEnv } = process.env

  const app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out/main/index.js')],
    cwd: root,
    env: {
      ...cleanEnv,
      ...newChatLaunchEnv(folder),
      MULTICODE_USER_DATA_DIR: userDataDir,
      MULTICODE_ALLOW_MULTI_INSTANCE: '1',
    },
  })

  try {
    const page = await resolveMainWindow(app)
    await createWorkspaceThroughNewChat(page, { folder })
    await page.waitForTimeout(1500)

    if (!(await openFilesPane(page))) {
      await page.screenshot({ path: join(outDir, 'failed-no-tree.png') })
      throw new Error('The Files pane never rendered a tree.')
    }
    // The ignore answers arrive one IPC round trip after the listing.
    await page.waitForTimeout(2500)
    await page.screenshot({ path: join(outDir, '01-root.png') })

    // The pane menu stays open over the tree, and the update toasts sit on top
    // of the rows worth photographing.
    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      document.querySelectorAll('[aria-label^="Dismiss"], [aria-label="Close"]').forEach((el) => {
        if (el instanceof HTMLElement) el.click()
      })
    })
    await page.waitForTimeout(500)

    for (const folderName of ['src', 'main', 'automations']) {
      await expandFolder(page, folderName)
    }
    await page.waitForTimeout(2000)

    // Put the test rows in frame.
    await page.evaluate((rowSelector) => {
      const row = Array.from(document.querySelectorAll(rowSelector))
        .find((el) => (el.textContent || '').includes('.test.ts'))
      row?.scrollIntoView({ block: 'center' })
    }, ROW)
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(outDir, '02-tests.png') })

    // A tight crop of a test row beside its source twin, so the notched tile
    // and the wash can actually be judged rather than squinted at.
    const testRow = await page.evaluateHandle((rowSelector) => {
      const rows = Array.from(document.querySelectorAll(rowSelector))
      return rows.find((el) => (el.textContent || '').includes('engine.test.ts')) ?? null
    }, ROW)
    const testEl = testRow.asElement()
    if (testEl) {
      const box = await testEl.boundingBox()
      if (box) {
        await page.screenshot({
          path: join(outDir, '02b-glyph-zoom.png'),
          clip: { x: box.x, y: box.y - 6, width: 260, height: 76 },
          scale: 'device',
        })
        // The same crop in dark, which is where the user's reference shots live.
        // <html> carries data-theme AND data-mode (appTheme.ts); setting only
        // the first leaves every mode-scoped token on its light value.
        await page.evaluate(() => {
          document.documentElement.setAttribute('data-theme', 'dark')
          document.documentElement.setAttribute('data-mode', 'dark')
        })
        await page.waitForTimeout(400)
        await page.screenshot({
          path: join(outDir, '02c-glyph-zoom-dark.png'),
          clip: { x: box.x, y: box.y - 6, width: 260, height: 76 },
          scale: 'device',
        })
        await page.screenshot({ path: join(outDir, '02d-tree-dark.png') })
      }
    }

    // The precedence rule the CSS comment stakes a claim on: hover outranks the
    // wash. Driven with the REAL mouse — a dispatched mouseover never sets
    // :hover, so a scripted version of this check passes without testing
    // anything. Compare the computed background at rest against the same row
    // under the pointer.
    const testRowLocator = page.locator(ROW).filter({ hasText: 'engine.test.ts' }).first()
    const bgOf = () => testRowLocator.evaluate((el) => getComputedStyle(el).backgroundColor)
    const restBg = await bgOf()
    await testRowLocator.hover()
    await page.waitForTimeout(300)
    const hoverBg = await bgOf()
    await page.mouse.move(10, 10)
    await page.waitForTimeout(300)
    console.log('PRECEDENCE:', JSON.stringify({
      restBg,
      hoverBg,
      hoverOverridesWash: restBg !== hoverBg,
    }))

    // Mark a folder as generated, and photograph what that does to its subtree.
    const marked = await markDirectoryAs(page, 'scripts', 'Generated sources root')
    await page.waitForTimeout(1200)
    await page.evaluate((rowSelector) => {
      const row = Array.from(document.querySelectorAll(rowSelector))
        .find((el) => Array.from(el.querySelectorAll('span')).some((s) => s.textContent?.trim() === 'scripts'))
      row?.scrollIntoView({ block: 'center' })
    }, ROW)
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(outDir, '03-marked.png') })
    console.log('MARKED:', marked)

    const dump = await page.evaluate(
      (rowSelector) =>
        Array.from(document.querySelectorAll(rowSelector)).map((el) => ({
          name: (el.textContent || '').trim().slice(0, 32),
          wash: el.getAttribute('data-row-wash'),
          ignored: el.getAttribute('data-row-ignored') === 'true',
        })),
      ROW
    )

    const scripts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script[src]')).map((s) => s.getAttribute('src'))
    )

    console.log(
      JSON.stringify(
        {
          bundle: scripts,
          total: dump.length,
          washedTest: dump.filter((r) => r.wash === 'test').map((r) => r.name).slice(0, 8),
          washedGenerated: dump.filter((r) => r.wash === 'generated').map((r) => r.name).slice(0, 8),
          ignoredRows: dump.filter((r) => r.ignored).map((r) => r.name).slice(0, 12),
          counts: {
            test: dump.filter((r) => r.wash === 'test').length,
            generated: dump.filter((r) => r.wash === 'generated').length,
            ignored: dump.filter((r) => r.ignored).length,
          },
          outDir,
        },
        null,
        2
      )
    )
  } finally {
    await app.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
})
