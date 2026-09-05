// The one way a Playwright pass gets itself a workspace (MC-2436).
//
// The New workspace hub and its creation wizard are gone
// (new-chat-is-the-only-way-in / retire-the-new-workspace-hub, 2026-09-04):
// New chat is the only door into a workspace, so a pass that used to walk
// the hub's wizard (name the workspace, browse, skip the rest) now does what
// a person does — opens New chat, picks the folder, and starts. Every pass under scripts/testing/ goes through this file, so a
// change to the door is one edit here rather than nine.
//
// How the folder is chosen: the selector's Browse… row opens the OS folder
// dialog, which Playwright cannot drive. Main resolves that dialog to
// `MULTICODE_TEST_OPEN_DIR` in an unpackaged build (`menu-dialog-ipc.ts`), so
// the pass sets that env on the Electron launch — every pass already did, for
// the wizard's own Browse — and the helper only presses the row.
//
// What is started: a plain Terminal, not an agent. A CLI agent needs a binary
// the test machine may not hold (and the door routes a CLI-less launch to the
// install card instead of creating anything), whereas a shell is always
// there. The result is a solo-chat workspace on the folder with one terminal
// pane, which is a workspace in every sense the doors, the rail, the sidebar
// and the panes care about.

import { basename } from 'node:path'

const DOOR_START = 'Start agent'
const MORE_OPTIONS = 'More launch options'

/**
 * The env a pass must add to its `electron.launch` for Browse… to land on the
 * folder without a native dialog. Merged, not replaced, so a pass keeps its
 * own variables.
 */
export function newChatLaunchEnv(folder) {
  return { MULTICODE_TEST_OPEN_DIR: folder }
}

async function domClick(locator) {
  await locator.first().evaluate((el) => {
    if (el instanceof HTMLElement) el.click()
  })
}

async function waitForCount(page, locator, predicate, timeout, what) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const count = await locator.count().catch(() => 0)
    if (predicate(count)) return true
    await page.waitForTimeout(150)
  }
  const body = await page.locator('body').innerText().catch(() => '')
  throw new Error(`Timed out waiting for ${what}. Body preview: ${body.slice(0, 1500)}`)
}

/**
 * The app's main window, not whatever opened first. Boot shows a splash
 * window that the shell closes on reveal, and Playwright's `firstWindow()`
 * hands back that splash — every pass then died on its first wait with
 * "Target page, context or browser has been closed". The primary window is
 * the one whose URL names it (`windowId=primary`, window-factory.ts).
 */
export async function resolveMainWindow(app, { timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    for (const candidate of app.windows()) {
      if (candidate.isClosed()) continue
      let url = ''
      try {
        url = candidate.url()
      } catch {
        continue
      }
      if (url.includes('windowId=primary')) return candidate
    }
    if (Date.now() > deadline) throw new Error('The app opened no primary window within the wait.')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/** True while the New chat door is on screen: its Start control is the door's one primary. */
export async function newChatDoorOpen(page) {
  return (await page.getByRole('button', { name: DOOR_START }).count()) > 0
}

/**
 * Open the New chat door if it is not already open. On a fresh profile the
 * door auto-opens once the first-run card is out of the way; otherwise the
 * sidebar's wordmark (aria-label "New chat") or the empty stage's button
 * opens it.
 */
export async function openNewChat(page, { timeout = 15000 } = {}) {
  if (await newChatDoorOpen(page)) return
  const opener = page.getByRole('button', { name: 'New chat', exact: true })
  if ((await opener.count()) > 0) await domClick(opener)
  await waitForCount(page, page.getByRole('button', { name: DOOR_START }), (n) => n > 0, timeout, 'the New chat door')
}

/**
 * Create a workspace on `folder` the way the product does: New chat → project
 * selector → Browse… (resolved by MULTICODE_TEST_OPEN_DIR) → ⋯ → Terminal →
 * Start. Resolves true once the door has closed and the sidebar lists a row;
 * throws with the page's text when a step cannot be found, so a pass fails
 * at the door with a reason rather than at its first assertion.
 *
 * `folder` must be the same directory the launch env points at — the helper
 * checks the selector adopted it by name.
 */
export async function createWorkspaceThroughNewChat(page, { folder, timeout = 30000 } = {}) {
  if (!folder) throw new Error('createWorkspaceThroughNewChat needs the folder MULTICODE_TEST_OPEN_DIR points at.')
  await page.waitForLoadState('domcontentloaded')
  await openNewChat(page, { timeout })

  // The scope line's project control: "Choose a project" on a profile with
  // nothing open, or the current project's name. Either way it opens the
  // selector whose sources lead with Browse….
  // A machine remembered from earlier in the session would put the door on
  // that machine's project list; a pass wants This Mac.
  const machineTrigger = page.locator('[data-machine-trigger="true"]')
  if ((await machineTrigger.count()) > 0 && !/^This Mac/.test(((await machineTrigger.first().textContent()) ?? '').trim())) {
    await domClick(machineTrigger)
    const thisMac = page.getByRole('menuitemradio', { name: /^This Mac/ })
    await waitForCount(page, thisMac, (n) => n > 0, timeout, 'the machine list')
    await domClick(thisMac)
  }
  const folderName = basename(folder)
  const trigger = page.locator('[data-project-trigger="true"]')
  await waitForCount(page, trigger, (n) => n > 0, timeout, 'the door’s project control')
  const adopted = async () => new RegExp(`^${escapeRegExp(folderName)}(\\s|·|$)`).test(((await trigger.first().textContent()) ?? '').trim())
  if (!(await adopted())) {
    await domClick(trigger)
    const browse = page.getByRole('menuitem', { name: /^Browse…/ })
    await waitForCount(page, browse, (n) => n > 0, timeout, 'the project selector’s Browse… row')
    await domClick(browse)
    const deadline = Date.now() + timeout
    while (!(await adopted())) {
      if (Date.now() > deadline) throw new Error(`The selector never adopted "${folderName}" — is MULTICODE_TEST_OPEN_DIR set to ${folder}?`)
      await page.waitForTimeout(150)
    }
  }

  // A plain shell, from the ⋯ surface. Never Escape here: the door itself
  // listens for it and would close. If the pick left the menu open, the
  // trigger toggles it shut.
  const more = page.getByRole('button', { name: MORE_OPTIONS })
  await domClick(more)
  const terminalRow = page.getByRole('menuitemradio', { name: /^Terminal/ })
  await waitForCount(page, terminalRow, (n) => n > 0, timeout, 'the Terminal row under ⋯')
  await domClick(terminalRow)
  await page.waitForTimeout(300)
  if ((await terminalRow.count()) > 0) await domClick(more)
  await waitForCount(page, terminalRow, (n) => n === 0, timeout, 'the ⋯ menu to close')

  await domClick(page.getByRole('button', { name: DOOR_START }))
  await waitForCount(page, page.getByRole('button', { name: DOOR_START }), (n) => n === 0, timeout, 'the door to close after Start')
  await waitForCount(page, page.locator('[role="treeitem"]'), (n) => n > 0, timeout, 'the new workspace’s sidebar row')
  return true
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
