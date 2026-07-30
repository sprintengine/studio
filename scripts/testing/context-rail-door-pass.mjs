#!/usr/bin/env node
// Live pass for item 1993's first rule, door by door (T19).
//
// The rule is absolute: "no app state shows two navigation columns left of
// content, anywhere". T7 landed the substrate and T12's nuclear review found the
// two doors-side states where the product still broke it — Backlog painted its
// work list beside the projects rail, and three doors gated the rail prop on
// having data, so an empty or still-loading door kept the projects rail up.
//
// A rendered unit test can prove the DECLARATION (globalDoorsIntegration §8).
// Only the running app can prove the CONSEQUENCE: that the projects rail is
// actually off screen, that there is exactly one navigation column left of the
// canvas, and that Back and Escape put the projects rail back with its scroll
// position and the door's own row focused. That is what this measures, for each
// of the six doors, in three states: populated, empty, and still loading.
//
// Two traps, both learned the hard way:
//
//   • The BUILT renderer hides Horizon and Reviews — both are on
//     DEV_ONLY_MODULE_IDS, gated by `import.meta.env.DEV`. Measuring "all six
//     doors" off `out/renderer` silently measures four. So this serves THIS
//     worktree's renderer from a vite dev server on its own port and points
//     ELECTRON_RENDERER_URL at it. Any inherited ELECTRON_RENDERER_URL (from the
//     user's own dev server, on the main checkout) is overwritten, never trusted.
//   • "Still loading" is a state you have to catch, not wait for. The door is
//     opened and read in the SAME turn, before any IPC resolves, and the read is
//     a DOM measurement rather than a screenshot so it cannot miss the frame.
//
// Prereqs: `npm run build` (out/main + out/preload), playwright available:
//   tmp=/tmp/multicode-playwright
//   npm --prefix "$tmp" install playwright --no-audit --no-fund
//   NODE_PATH="$tmp/node_modules:$PWD/node_modules" \
//     node scripts/testing/context-rail-door-pass.mjs
//
// Screenshots + a JSON transcript land in $MULTICODE_T19_OUT_DIR.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = resolve(new URL('../..', import.meta.url).pathname)
const tempRoot = process.env.MULTICODE_T19_TMP_ROOT || '/tmp/multicode-t19-context-rail'
const workspaceDir = join(tempRoot, 'workspace')
const userDataDir = join(tempRoot, 'user-data')
const outDir = process.env.MULTICODE_T19_OUT_DIR || join(tempRoot, 'out')
const rendererPort = Number(process.env.MULTICODE_T19_RENDERER_PORT || 5399)

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const transcript = { doors: [], backNav: [], noWorkspace: [] }

/* ------------------------------------------------------------------ *
 * The measurement, in the renderer
 * ------------------------------------------------------------------ */

// One navigation column, or two? Read as geometry and visibility, not as a
// class name: the projects rail stays MOUNTED while a door owns the column (the
// door's trigger row has to survive for Back to focus it), so "is it in the DOM"
// answers nothing. What matters is whether it is laid out — `offsetParent` is
// null for a `display:none` subtree — and how many navigation columns sit left of
// the canvas.
const MEASURE = `(() => {
  const railColumn = document.querySelector('[data-context-rail]')
  const projectsTree = document.querySelector('nav[role="tree"]')
  const surface = document.querySelector('section[aria-label]')
  const laidOut = (node) => Boolean(node) && node.offsetParent !== null && node.getBoundingClientRect().width > 0
  // Every navigation column on screen: the door's rail column, the projects
  // tree, and any inline aside a surface rendered for itself. A door that
  // portals its rail into the host column and ALSO draws its own aside is the
  // two-column failure in its other form.
  const surfaceAside = document.querySelector('section[aria-label] aside')
  const columns = [
    laidOut(projectsTree) ? 'projects-tree' : null,
    laidOut(railColumn) ? 'context-rail' : null,
    laidOut(surfaceAside) ? 'surface-inline-aside' : null,
  ].filter(Boolean)
  const railRows = railColumn
    ? railColumn.querySelectorAll('[role="option"],[role="listitem"],li').length
    : 0
  const back = railColumn
    ? Array.from(railColumn.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Back')
    : null
  return {
    surfaceLabel: surface ? surface.getAttribute('aria-label') : null,
    navColumns: columns,
    railActive: railColumn ? railColumn.getAttribute('data-context-rail-active') : null,
    railRows,
    railHasBack: Boolean(back),
    // Scoped to the SURFACE: the sidebar chrome's own nav-history arrow is also
    // called "Back", sits in the fixed brand row that does not participate in the
    // swap, and means "the place I was before" rather than "out of this door".
    // Counting it document-wide reported a door chevron on every screen.
    barChevrons: surface ? surface.querySelectorAll('button[aria-label="Back"]').length : 0,
    projectsTreeLaidOut: laidOut(projectsTree),
    projectsTreeMounted: Boolean(projectsTree),
    canvasText: (surface ? surface.textContent || '' : '').replace(/\\s+/g, ' ').trim().slice(0, 180),
  }
})()`

const DOORS = [
  ['Automations', 'automations'],
  ['Sprints', 'sprints'],
  ['Backlog', 'backlog'],
  ['Extensions', 'extensions'],
  ['Horizon', 'roadmap'],
  ['Reviews', 'reviews'],
]

async function seedPopulated() {
  await mkdir(join(workspaceDir, 'backlog/epics'), { recursive: true })
  await writeFile(
    join(workspaceDir, 'backlog/epics/rail-epic.md'),
    '---\ntype: epic\nstatus: in_progress\ncolor: purple\n---\n\n# Context rail epic\n\nAn epic with an identity colour, so its members carry the row tint.\n',
  )
  const rows = [
    ['one', 'Fold the work list into the one rail', 'epic: rail-epic\n'],
    ['two', 'Declare rail presence per door', 'epic: rail-epic\n'],
    ['three', 'A plain row with no epic and no colour', ''],
    ['four', 'Back and Escape restore the projects rail', ''],
  ]
  for (const [slug, title, extra] of rows) {
    await writeFile(
      join(workspaceDir, `backlog/2026-07-30-rail-${slug}.md`),
      `---\nstatus: ready\n${extra}---\n\n# ${title}\n\nSeeded row for the T19 context-rail pass.\n`,
    )
  }
}

async function seed() {
  await rm(tempRoot, { recursive: true, force: true })
  await mkdir(workspaceDir, { recursive: true })
  await mkdir(userDataDir, { recursive: true })
  await mkdir(outDir, { recursive: true })
  await seedPopulated()
}

/* ------------------------------------------------------------------ *
 * This worktree's renderer, on its own port
 * ------------------------------------------------------------------ */

async function startRenderer() {
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const tailwindcss = (await import('@tailwindcss/vite')).default
  // The renderer half of electron.vite.config.ts, standalone: same root, same
  // plugins, same alias. Served from THIS worktree so the dev-only doors
  // (Horizon, Reviews) register and all six can actually be measured.
  const server = await createServer({
    configFile: false,
    root: join(root, 'src/renderer'),
    resolve: { alias: { '@renderer': join(root, 'src/renderer/src') } },
    plugins: [react(), tailwindcss()],
    server: { port: rendererPort, strictPort: true },
  })
  await server.listen()
  return server
}

/* ------------------------------------------------------------------ *
 * Driving
 * ------------------------------------------------------------------ */

async function click(page, locator) {
  if ((await locator.count()) === 0) return false
  await locator.first().evaluate((el) => el.click())
  await page.waitForTimeout(700)
  return true
}

// A programmatic `.click()` does NOT focus its target, but a real pointer click
// does (mousedown moves focus first). Every "focus returns to the trigger" claim
// depends on the trigger having had focus when the door opened, so a door opened
// without focusing its row measures nothing: `useSurfaceTriggerFocus` captures
// whatever WAS focused, and Back honestly returns there. The first run of this
// pass reported focus landing on a terminal input for exactly that reason.
async function activate(locator) {
  await locator.first().evaluate((el) => {
    el.focus()
    el.click()
  })
}

async function headings(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('h1,h2,h3'))
      .filter((h) => {
        const r = h.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      })
      .map((h) => h.textContent?.trim())
      .join(' | '),
  )
}

async function finishOnboarding(page) {
  await click(page, page.locator('button').filter({ hasText: /^Get started$/ }))
  for (let i = 0; i < 20; i += 1) {
    const heads = await headings(page)
    // "What's included" (the module opt-in step) is part of the run, and it
    // FOCUS-TRAPS: leaving it open means every later Escape belongs to it, not to
    // the door under it. The first run of this pass reported five doors with no
    // keyboard exit for exactly that reason — the modal was still on screen.
    if (!/Pick a theme|Set up an agent CLI|Add extensions|Bring over|Welcome|What’s included|What's included/i.test(heads)) {
      return true
    }
    const advanced =
      (await click(page, page.locator('button').filter({ hasText: /^Continue$/ }).last())) ||
      (await click(page, page.locator('button').filter({ hasText: /^Skip for now$/ }))) ||
      (await click(page, page.locator('button').filter({ hasText: /^(Done|Finish|Start)$/ })))
    if (!advanced) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
    }
  }
  return false
}

// A door's trigger row in the projects rail.
function doorTrigger(page, label) {
  return page.getByRole('button', { name: label, exact: true })
}

// Open a door and read it TWICE: while it is still loading, and once it has
// resolved.
//
// The loading read is the fiddly one. Reading in the same microtask as the click
// is too early to mean anything — the surface has not rendered at all yet, and
// rail presence is REPORTED BY the surface, so the honest answer does not exist
// until the door has mounted. (That one-commit settle is the load-bearing timing
// documented at WorkspaceManager's rail slot.) So this waits only for the
// surface region to appear and reads immediately after, which is the first frame
// on which the question can be answered — long before the door's own IPC has
// come back. `stillLoadingEvidence` records what the canvas was saying then, so
// the claim "this was the loading state" is checkable rather than asserted.
async function openAndMeasure(page, label) {
  const trigger = doorTrigger(page, label)
  if ((await trigger.count()) === 0) return { missing: true }
  await activate(trigger)
  await page.waitForFunction(
    () => {
      const surface = document.querySelector('section[aria-label]')
      const rail = document.querySelector('[data-context-rail]')
      return Boolean(surface) && Boolean(rail)
    },
    undefined,
    { timeout: 5000 },
  )
  const loading = await page.evaluate(MEASURE)
  await page.waitForTimeout(2500)
  const settled = await page.evaluate(MEASURE)
  return { loading, settled }
}

async function leaveDoor(page, how) {
  if (how === 'escape') {
    await page.keyboard.press('Escape')
  } else {
    const back = page
      .locator('[data-context-rail] button')
      .filter({ hasText: /^Back$/ })
    if ((await back.count()) === 0) return false
    await activate(back)
  }
  await page.waitForTimeout(900)
  // Confirm it actually left. A door that stays open hides every trigger row in
  // the projects rail, so the next leg would time out on a display:none button
  // and report "no trigger found" — a harness failure wearing a product failure's
  // clothes, which is what the first run of this pass produced.
  return page.evaluate(() => {
    const tree = document.querySelector('nav[role="tree"]')
    return Boolean(tree) && tree.offsetParent !== null
  })
}

function assertOneColumn(where, m) {
  check(
    `${where}: exactly one navigation column left of the canvas`,
    m.navColumns.length === 1 && m.navColumns[0] === 'context-rail',
    `columns=${JSON.stringify(m.navColumns)} railActive=${m.railActive} rows=${m.railRows}`,
  )
  check(
    `${where}: the projects rail is off screen but still mounted`,
    m.projectsTreeLaidOut === false && m.projectsTreeMounted === true,
    `laidOut=${m.projectsTreeLaidOut} mounted=${m.projectsTreeMounted}`,
  )
  check(
    `${where}: Back is the rail's pinned row and the canvas carries no chevron`,
    m.railHasBack === true && m.barChevrons === 0,
    `railBack=${m.railHasBack} barChevrons=${m.barChevrons}`,
  )
}

async function main() {
  const { _electron: electron } = require('playwright')
  const electronPath = require('electron')
  await seed()
  const renderer = await startRenderer()
  const rendererUrl = `http://localhost:${rendererPort}`
  console.log(`renderer dev server (this worktree): ${rendererUrl}`)

  const app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out/main/index.js')],
    cwd: root,
    env: {
      ...process.env,
      // Overwritten, never inherited: an ambient value points at the user's own
      // dev server on the main checkout, which would measure another tree.
      ELECTRON_RENDERER_URL: rendererUrl,
      MULTICODE_USER_DATA_DIR: userDataDir,
      MULTICODE_ALLOW_MULTI_INSTANCE: '1',
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
      const w = BrowserWindow.getAllWindows()[0]
      w.setContentSize(1440, 900)
      w.center()
    })
    await page.waitForTimeout(3000)

    const boot = await page.evaluate(() => ({
      mode: document.documentElement.getAttribute('data-mode'),
      url: location.href,
    }))
    check(
      'the renderer under test is this worktree, served in dev (so the dev-only doors register)',
      boot.mode !== null && boot.url.startsWith(rendererUrl),
      JSON.stringify(boot),
    )

    await finishOnboarding(page)

    console.log('\n=== creating the workspace ===')
    await click(page, page.locator('button').filter({ hasText: /^New Workspace$/ }))
    await page.waitForTimeout(1200)
    await page.locator('input[placeholder="my-workspace"]').first().fill('T19 Context rail')
    await page.locator('input[placeholder="/path/to/workspace"]').first().fill(workspaceDir)
    await page.waitForTimeout(500)
    const created =
      (await click(page, page.locator('button').filter({ hasText: /^Skip the rest and create$/ }))) ||
      (await click(page, page.locator('button').filter({ hasText: /^(Create workspace|Create)$/ }).last()))
    await page.waitForTimeout(4000)
    check('a real workspace is created and open', created)

    /* ---- 1993 AC1, door by door, loading and resolved ------------------- */
    console.log('\n\n############ every door, while loading and once resolved ############')
    for (const [label, id] of DOORS) {
      console.log(`\n=== ${label} door ===`)
      const measured = await openAndMeasure(page, label)
      if (measured.missing) {
        check(`the ${label} door has a trigger row in the projects rail`, false, 'no trigger found')
        continue
      }
      transcript.doors.push({ door: id, label, ...measured })
      console.log(`  loading:  ${JSON.stringify(measured.loading)}`)
      console.log(`  resolved: ${JSON.stringify(measured.settled)}`)
      assertOneColumn(`${label} (still loading)`, measured.loading)
      assertOneColumn(`${label} (resolved)`, measured.settled)
      await page.screenshot({ path: join(outDir, `door-${id}.png`) })
      check(`${label}: the rail's Back row leaves the door`, await leaveDoor(page, 'back'))
    }

    /* ---- Backlog: populated, then empty -------------------------------- */
    console.log('\n\n############ Backlog: populated, then empty ############')
    await openAndMeasure(page, 'Backlog')
    const rowCount = await page.locator('[data-context-rail] li[role="option"]').count()
    check('the Backlog rail lists the seeded rows', rowCount >= 4, `${rowCount} rows in the rail`)
    // Select one, so the canvas shows the item detail rather than the prompt.
    await activate(page.locator('[data-context-rail] li[role="option"]'))
    await page.waitForTimeout(1200)
    const populated = await page.evaluate(MEASURE)
    transcript.doors.push({ door: 'backlog', label: 'Backlog (populated, item selected)', settled: populated })
    assertOneColumn('Backlog (populated, item selected)', populated)
    check(
      'the Backlog canvas is the item detail, full width beside the one rail',
      populated.canvasText.length > 0 && !populated.canvasText.includes('Select an item to preview'),
      populated.canvasText.slice(0, 120),
    )
    await page.screenshot({ path: join(outDir, 'backlog-populated.png') })

    // A rail row's right-click menu. The row moved hosts — it lives in a portal
    // into the sidebar's column now, not in the door's own canvas — so the menu
    // it opens and the Escape that closes it are worth one live check rather than
    // an assumption. Escape must close the MENU and leave the door open: an
    // overlay on a door owns the key first (`escapeLeavesSurface`).
    await page.locator('[data-context-rail] li[role="option"]').first().dispatchEvent('contextmenu')
    await page.waitForTimeout(800)
    const rowMenu = await page.evaluate(() => {
      const menu = document.querySelector('[role="menu"]')
      return {
        open: Boolean(menu),
        items: menu ? menu.querySelectorAll('[role="menuitem"],button').length : 0,
      }
    })
    check('a rail row still opens its row menu on right-click', rowMenu.open && rowMenu.items > 0, JSON.stringify(rowMenu))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(800)
    const afterMenuEscape = await page.evaluate(MEASURE)
    const menuClosed = await page.evaluate(() => document.querySelector('[role="menu"]') === null)
    check(
      'Escape closes that menu and leaves the door open',
      menuClosed && afterMenuEscape.navColumns.length === 1 && afterMenuEscape.navColumns[0] === 'context-rail',
      `menuClosed=${menuClosed} columns=${JSON.stringify(afterMenuEscape.navColumns)}`,
    )

    // Empty: a search no item can match. The rail keeps New + the lens; the
    // canvas says why it is empty.
    await page.evaluate(() => {
      const input = Array.from(document.querySelectorAll('[data-context-rail] input[type="search"]'))[0]
      if (!input) throw new Error('no search field in the Backlog rail')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'zzzznothingmatchesthis')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.waitForTimeout(1200)
    const emptyBacklog = await page.evaluate(MEASURE)
    transcript.doors.push({ door: 'backlog', label: 'Backlog (empty)', settled: emptyBacklog })
    assertOneColumn('Backlog (empty)', emptyBacklog)
    check(
      'the empty Backlog says why, inside the door',
      emptyBacklog.canvasText.includes('Nothing matches this view'),
      emptyBacklog.canvasText.slice(0, 140),
    )
    check(
      'and its rail keeps New item and the search that emptied it',
      (await page.locator('[data-context-rail] button').filter({ hasText: /^New item$/ }).count()) === 1 &&
        (await page.locator('[data-context-rail] input[type="search"]').count()) === 1,
    )
    await page.screenshot({ path: join(outDir, 'backlog-empty.png') })

    // Dark, populated. The rail's sticky head paints `--rail-ground`, which in
    // this column is the SIDEBAR's ground rather than the door-panel tone — get
    // that wrong and rows show through the seam as they scroll under it. Dark is
    // where that seam is visible, so it is measured as well as photographed.
    await page.evaluate(() => {
      const input = Array.from(document.querySelectorAll('[data-context-rail] input[type="search"]'))[0]
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.waitForTimeout(800)
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark')
      document.documentElement.setAttribute('data-mode', 'dark')
    })
    await page.waitForTimeout(800)
    await activate(page.locator('[data-context-rail] li[role="option"]'))
    await page.waitForTimeout(1000)
    const seam = await page.evaluate(() => {
      const column = document.querySelector('[data-context-rail]')
      const head = column ? column.querySelector('.sticky') : null
      if (!head || !column) return null
      const read = (node, prop) => getComputedStyle(node).getPropertyValue(prop).trim()
      return {
        railGround: read(column, '--rail-ground'),
        headBg: getComputedStyle(head).backgroundColor,
        columnBg: getComputedStyle(column.parentElement).backgroundColor,
      }
    })
    check(
      'dark: the rail head paints the column it sits on, not the door-panel tone',
      seam !== null && seam.headBg === seam.columnBg,
      JSON.stringify(seam),
    )
    transcript.seam = seam
    await page.screenshot({ path: join(outDir, 'backlog-populated-dark.png') })

    // AC2's "one focused selection". The rail's list declares itself the door's
    // PRIMARY pane, which means it holds the full-strength fill while focus sits
    // outside every pane and rests only when another PANE takes it. That claim has
    // to be re-measured now the list lives INSIDE the app sidebar's own aside —
    // which is itself marked `data-selection-pane="auto"`, so a nested pane could
    // be governed by its ancestor's rule instead of its own.
    const tierTokens = await page.evaluate(() => {
      const read = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
      return { selected: read('--bg-selected'), resting: read('--bg-selected-resting') }
    })
    const rowFill = async () =>
      page.evaluate(() => {
        const row = document.querySelector('[data-context-rail] li[aria-selected="true"]')
        return row ? getComputedStyle(row).backgroundColor : null
      })
    await page.evaluate(() => {
      const list = document.querySelector('[data-context-rail] ul[role="listbox"]')
      if (list) list.focus()
    })
    await page.waitForTimeout(700)
    const fillWithRailFocus = await rowFill()
    // Focus somewhere that is not a selection pane at all: the door's own region.
    await page.evaluate(() => {
      const region = document.querySelector('section[aria-label]')
      if (region) {
        region.setAttribute('tabindex', '-1')
        region.focus()
      }
    })
    await page.waitForTimeout(700)
    const fillFocusOutsideEveryPane = await rowFill()
    transcript.selectionTier = { tierTokens, fillWithRailFocus, fillFocusOutsideEveryPane }
    console.log(`  selection tier: rail-focused ${fillWithRailFocus} · focus outside every pane ${fillFocusOutsideEveryPane}`)
    check(
      'the rail row is the door\'s one focused selection while the rail holds focus',
      fillWithRailFocus !== null && fillWithRailFocus !== 'rgba(0, 0, 0, 0)',
      `${fillWithRailFocus} (tokens ${JSON.stringify(tierTokens)})`,
    )
    check(
      'and it KEEPS that fill while focus sits outside every selection pane (primary, not auto)',
      fillFocusOutsideEveryPane === fillWithRailFocus,
      `railFocused=${fillWithRailFocus} outside=${fillFocusOutsideEveryPane}`,
    )

    /* ---- the pane inventory the tier fix turns on ----------------------- */
    // Two facts worth pinning, both consequences of "one rail, ever":
    //
    //  1. The sidebar aside carries `data-selection-pane="auto"` with no door open
    //     and NONE while a door owns its column. That is the fix above, read as
    //     the attribute rather than as a colour.
    //  2. A door surface therefore has exactly ONE selection pane. Which is the
    //     point — one focused selection per screen — but it also means the tier's
    //     "another pane took focus" case has no witness on a door, so the T24
    //     design-system pass's `resting-selected` leg is no longer measurable
    //     THERE (it navigated between doors through sidebar rows, which only
    //     worked while Backlog was the door that did not replace the sidebar).
    console.log('\n\n############ selection panes, with and without a door ############')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(900)
    const panesNoDoor = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-selection-pane]')).map((p) => ({
        pane: p.getAttribute('data-selection-pane'),
        label: (p.getAttribute('aria-label') || p.tagName).slice(0, 28),
        laidOut: p.offsetParent !== null,
      })),
    )
    check(
      'with no door open the sidebar aside is still the `auto` selection pane',
      panesNoDoor.some((p) => p.label === 'Workspaces' && p.pane === 'auto'),
      JSON.stringify(panesNoDoor),
    )
    await activate(doorTrigger(page, 'Backlog'))
    await page.waitForTimeout(2500)
    const panesInDoor = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-selection-pane]')).map((p) => ({
        pane: p.getAttribute('data-selection-pane'),
        label: (p.getAttribute('aria-label') || p.tagName).slice(0, 28),
        laidOut: p.offsetParent !== null,
      })),
    )
    transcript.panes = { noDoor: panesNoDoor, inDoor: panesInDoor }
    console.log(`  no door: ${JSON.stringify(panesNoDoor)}\n  in door: ${JSON.stringify(panesInDoor)}`)
    check(
      'while a door owns the column the aside is no longer a pane — the rail inside it is',
      !panesInDoor.some((p) => p.label === 'Workspaces'),
      JSON.stringify(panesInDoor),
    )
    // "Laid out" is not "reachable": the workspace card's own pane (the file
    // explorer) is still mounted behind the door and still has a box, but the
    // door paints over it, so `.focus()` on a control in there does not take.
    // Reachability is the fact that matters, and it is what makes the tier's
    // "another pane took focus" case unwitnessable on a door surface.
    const reachablePanes = await page.evaluate(() => {
      const out = []
      for (const pane of document.querySelectorAll('[data-selection-pane]')) {
        // The pane element ITSELF is the tab stop on a roving-focus listbox (the
        // Backlog rail's <ul tabindex=0>), so it is a candidate too — querying
        // only descendants reported the rail as unreachable.
        const control = [pane, ...pane.querySelectorAll('button, a[href], input, [tabindex]:not([tabindex="-1"])')].find((n) => {
          if (n.tabIndex < 0) return false
          const r = n.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && !n.disabled
        })
        if (!control) continue
        control.focus()
        if (pane.contains(document.activeElement)) {
          out.push(pane.getAttribute('aria-label') || pane.tagName)
        }
      }
      return out
    })
    transcript.reachablePanes = reachablePanes
    check(
      'and exactly one of them is REACHABLE — the door has one focusable selection pane',
      reachablePanes.length === 1,
      `reachable=${JSON.stringify(reachablePanes)} of ${JSON.stringify(panesInDoor.map((p) => p.label))}`,
    )

    // That reachability probe deliberately parked focus outside the surface, so
    // Escape is not the door's any more — leave by the rail's Back row.
    check('the pane probe leaves the door by its Back row', await leaveDoor(page, 'back'))

    /* ---- Back + Escape, from Backlog and from an empty door ------------ */
    console.log('\n\n############ Back and Escape restore the projects rail ############')
    // "Scroll position preserved" is only a real claim against a tree that can
    // scroll, and 0 → 0 on a tree that fits proves nothing. Shrink the window until
    // the tree overflows; the check below then compares a genuinely non-zero offset,
    // and says so in its detail either way rather than quietly passing on a
    // degenerate case.
    // "Scroll position preserved" needs a tree that can actually scroll, and this
    // fixture's one project cannot fill even a 300px window — a 0 → 0 result would
    // pass while proving nothing. So the precondition is created deliberately: an
    // inline max-height makes the real scrollport overflow. Everything after that
    // is the product's own path — hiding the nav drops its offset to zero, and the
    // effect keyed on the rail's activation puts `treeScrollTopRef` back before the
    // restored rail paints. Stated plainly because it is a staged precondition, not
    // a natural one.
    const treeBox = await page.evaluate(() => {
      const tree = document.querySelector('nav[role="tree"]')
      if (!tree) return null
      tree.style.maxHeight = '48px'
      return { scrollHeight: tree.scrollHeight, clientHeight: tree.clientHeight, staged: true }
    })
    await page.waitForTimeout(400)
    console.log(`  projects tree box: ${JSON.stringify(treeBox)}`)
    transcript.treeBox = treeBox
    check(
      'the projects tree overflows, so scroll preservation is a real measurement',
      treeBox !== null && treeBox.scrollHeight > treeBox.clientHeight,
      JSON.stringify(treeBox),
    )
    for (const [label, how] of [
      ['Backlog', 'back'],
      ['Backlog', 'escape'],
      ['Automations', 'back'],
      ['Automations', 'escape'],
    ]) {
      // Leave whatever door the previous leg left open: while a door owns the
      // column its trigger row is display:none, and a click on a hidden row is a
      // 30-second locator timeout, not a failure anyone can read. The rail's Back
      // row, not Escape — Escape only belongs to the door while focus is inside
      // it, so it is not a reliable way to guarantee a clean start.
      await leaveDoor(page, 'back')
      // Scroll the projects tree, so "scroll position preserved" is measurable
      // rather than trivially true at zero.
      const before = await page.evaluate(() => {
        const tree = document.querySelector('nav[role="tree"]')
        if (!tree) return null
        tree.scrollTop = Math.min(24, Math.max(0, tree.scrollHeight - tree.clientHeight))
        tree.dispatchEvent(new Event('scroll', { bubbles: false }))
        return { scrollTop: tree.scrollTop, scrollable: tree.scrollHeight > tree.clientHeight }
      })
      await activate(doorTrigger(page, label))
      await page.waitForTimeout(2500)
      const inDoor = await page.evaluate(MEASURE)
      const left = await leaveDoor(page, how)
      const after = await page.evaluate(() => {
        const tree = document.querySelector('nav[role="tree"]')
        const active = document.activeElement
        return {
          treeLaidOut: Boolean(tree) && tree.offsetParent !== null,
          scrollTop: tree ? tree.scrollTop : null,
          railColumnLaidOut: Boolean(
            document.querySelector('[data-context-rail]')
              && document.querySelector('[data-context-rail]').offsetParent !== null,
          ),
          focusLabel: active ? (active.getAttribute('aria-label') || active.textContent || '').trim().slice(0, 40) : null,
          focusIsDoorTrigger: Boolean(
            active && active.closest('nav[role="tree"], [role="tree"]') === null && active.tagName === 'BUTTON',
          ),
        }
      })
      transcript.backNav.push({ door: label, how, before, inDoor, after })
      console.log(`  ${label} via ${how}: ${JSON.stringify(after)}`)
      check(
        `${label} via ${how}: the projects rail comes back and the door's rail goes`,
        left && after.treeLaidOut === true && after.railColumnLaidOut === false,
        JSON.stringify(after),
      )
      check(
        `${label} via ${how}: the projects rail keeps its scroll position`,
        before === null || after.scrollTop === before.scrollTop,
        `before=${before ? before.scrollTop : 'n/a'} after=${after.scrollTop} (scrollable=${before ? before.scrollable : 'n/a'})`,
      )
      check(
        `${label} via ${how}: focus lands back on the door's own trigger`,
        after.focusLabel === label,
        `focus=${JSON.stringify(after.focusLabel)}`,
      )
    }

    await writeFile(join(outDir, 'transcript.json'), `${JSON.stringify(transcript, null, 2)}\n`)
  } finally {
    await app.close()
  }

  /* ---- the no-workspace state, on a fresh profile --------------------- */
  // 1993's rule says "anywhere", and a first-run profile with no project open is
  // the state that used to be worst: no rows to escape through, so a door that
  // kept the projects rail kept a rail with nothing in it. A second launch on a
  // second profile is the honest way to reach it — closing the workspace inside
  // the first run leaves its scan watchers and its history behind.
  console.log('\n\n############ the no-workspace state, fresh profile ############')
  const freshUserData = join(tempRoot, 'user-data-fresh')
  await mkdir(freshUserData, { recursive: true })
  const fresh = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out/main/index.js')],
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: rendererUrl,
      MULTICODE_USER_DATA_DIR: freshUserData,
      MULTICODE_ALLOW_MULTI_INSTANCE: '1',
    },
  })
  try {
    const page = await fresh.firstWindow()
    page.on('console', (m) => {
      if (m.type() === 'error') console.error(`[renderer] ${m.text()}`)
    })
    await page.waitForLoadState('domcontentloaded')
    await fresh.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.setContentSize(1440, 900)
      w.center()
    })
    await page.waitForTimeout(3000)
    await finishOnboarding(page)
    const noWorkspace = await page.evaluate(
      () => document.querySelectorAll('nav[role="tree"] [role="treeitem"]').length,
    )
    check('the fresh profile really has no project open', noWorkspace === 0, `${noWorkspace} tree rows`)
    for (const [label, id] of DOORS) {
      const measured = await openAndMeasure(page, label)
      if (measured.missing) {
        check(`no-workspace: the ${label} door has a trigger row`, false, 'no trigger found')
        continue
      }
      transcript.noWorkspace.push({ door: id, label, ...measured })
      console.log(`  ${label}: ${JSON.stringify(measured.settled)}`)
      assertOneColumn(`${label} (no project open)`, measured.settled)
      await page.screenshot({ path: join(outDir, `no-workspace-${id}.png`) })
      // Where the keyboard actually is, so a failed Escape names its cause
      // instead of just failing: Escape only belongs to the door when focus is
      // inside its canvas region or its rail column, and nothing overlaying it.
      const focusBeforeEscape = await page.evaluate(() => {
        const a = document.activeElement
        if (!a) return null
        return {
          tag: a.tagName,
          label: (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 40),
          inRail: Boolean(a.closest('[data-context-rail]')),
          inSurface: Boolean(a.closest('section[aria-label]')),
          inOverlay: Boolean(a.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]')),
        }
      })
      const leftByEscape = await leaveDoor(page, 'escape')
      check(
        `no-workspace: Escape leaves the ${label} door`,
        leftByEscape,
        `focus before Escape: ${JSON.stringify(focusBeforeEscape)}`,
      )
      if (!leftByEscape) check(`no-workspace: the ${label} door's Back row leaves it`, await leaveDoor(page, 'back'))
    }
    await writeFile(join(outDir, 'transcript.json'), `${JSON.stringify(transcript, null, 2)}\n`)
  } finally {
    await fresh.close()
    await renderer.close()
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  await writeFile(join(outDir, 'checks.json'), `${JSON.stringify(checks, null, 2)}\n`)
  if (failed.length > 0) {
    for (const f of failed) console.log(`FAILED: ${f.name} — ${f.detail}`)
    process.exit(1)
  }
  console.log(`screenshots + transcript: ${outDir}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})
