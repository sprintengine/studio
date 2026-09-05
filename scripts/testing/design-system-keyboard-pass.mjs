#!/usr/bin/env node
// Live keyboard-accessibility pass for the design-system conformance epic (T15).
//
// The seam test proves the four contracts hold in a composed jsdom tree; jsdom
// has no cascade, so it can only read class names. This harness is the other
// half: it drives the built Electron app with real Tab keypresses and reads
// *computed* style off `document.activeElement`, so it observes what a person
// using the keyboard would actually see.
//
// The one thing that must not be got wrong here is "is a ring actually
// painted?". Tailwind's ring utilities compile to a two-layer `box-shadow`, and
// the unfocused layer is present but transparent and zero-sized:
//
//   rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px
//
// so `boxShadow !== 'none'` reports a ring on every ring-classed element whether
// focused or not. `ringFromBoxShadow` below requires a layer that is both
// non-transparent and non-zero-sized.
//
// Prereqs: `npm run build` (needs out/main), playwright available:
//   tmp=/tmp/multicode-playwright
//   npm --prefix "$tmp" install playwright --no-audit --no-fund
//   NODE_PATH="$tmp/node_modules:$PWD/node_modules" \
//     node scripts/testing/design-system-keyboard-pass.mjs
// Screenshots + a JSON transcript land in $MULTICODE_KB_OUT_DIR.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createWorkspaceThroughNewChat, resolveMainWindow } from './newChatWorkspace.mjs'

const require = createRequire(import.meta.url)
const root = resolve(new URL('../..', import.meta.url).pathname)
const tempRoot = process.env.MULTICODE_KB_TMP_ROOT || '/tmp/multicode-keyboard-pass'
const workspaceDir = join(tempRoot, 'workspace')
const userDataDir = join(tempRoot, 'user-data')
const outDir = process.env.MULTICODE_KB_OUT_DIR || join(tempRoot, 'out')

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const transcript = []

/* ------------------------------------------------------------------ *
 * Focus measurement (serialised into the renderer)
 * ------------------------------------------------------------------ */

const DESCRIBE = `(() => {
  function ringFromBoxShadow(boxShadow) {
    if (!boxShadow || boxShadow === 'none') return false
    const layers = []
    let depth = 0, cur = ''
    for (const ch of boxShadow) {
      if (ch === '(') depth += 1
      if (ch === ')') depth -= 1
      if (ch === ',' && depth === 0) { layers.push(cur); cur = '' } else cur += ch
    }
    if (cur.trim()) layers.push(cur)
    return layers.some((layer) => {
      const colour = layer.match(/rgba?\\(([^)]+)\\)/)
      let alpha = 1
      if (colour) {
        const parts = colour[1].split(/[,\\s/]+/).filter(Boolean)
        if (parts.length >= 4) alpha = parseFloat(parts[3])
      }
      if (!(alpha > 0)) return false
      const lengths = (layer.replace(/rgba?\\([^)]*\\)/, '').match(/-?\\d*\\.?\\d+px/g) || []).map(parseFloat)
      return lengths.some((n) => n !== 0)
    })
  }

  const el = document.activeElement
  if (!el || el === document.body) return { none: true }
  const style = getComputedStyle(el)
  const ringPainted =
    ringFromBoxShadow(style.boxShadow) ||
    (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth || '0') > 0)
  let focusVisible = false
  try { focusVisible = el.matches(':focus-visible') } catch (e) { focusVisible = false }
  const rect = el.getBoundingClientRect()

  // A ring is not the only honest focus indicator — a control may shift its
  // border or fill instead. Before calling a stop invisible, compare the focused
  // computed style against the same element unfocused. Focus is restored
  // immediately so the walk continues from the same place.
  const PROPS = ['boxShadow', 'outlineStyle', 'outlineWidth', 'outlineColor',
                 'borderColor', 'borderWidth', 'backgroundColor', 'color']
  function snapshot(node) {
    const s = getComputedStyle(node)
    const out = {}
    for (const p of PROPS) out[p] = s[p]
    return out
  }
  let focusDelta = []
  if (!ringPainted && typeof el.blur === 'function' && typeof el.focus === 'function') {
    try {
      const focused = snapshot(el)
      el.blur()
      const blurred = snapshot(el)
      el.focus()
      focusDelta = PROPS.filter((p) => focused[p] !== blurred[p])
    } catch (e) { focusDelta = [] }
  }
  const focusIndicated = ringPainted || focusDelta.length > 0

  // Hover-reveal check: nearest \`.group\` row, then descendants that start
  // hidden. If focus does not reveal them, a keyboard user cannot reach them.
  let reveal = null
  const row = el.closest('[class*="group"]')
  if (row) {
    // Only actions count. A decorative \`aria-hidden\` affordance (a drag
    // hairline, an icon that swaps on hover) revealing on hover alone is not an
    // accessibility defect — nothing is being withheld from the keyboard.
    const cands = Array.from(row.querySelectorAll('*')).filter((n) => {
      const c = n.getAttribute('class') || ''
      const hiddenByDefault =
        /(^|\\s)(opacity-0|invisible)(\\s|$)/.test(c) || /group-hover[^:]*:(opacity|visible)/.test(c)
      if (!hiddenByDefault) return false
      if (n.closest('[aria-hidden="true"]')) return false
      const actionable =
        /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(n.tagName) ||
        n.hasAttribute('role') ||
        n.querySelector('button, a, input, select, textarea, [role]')
      return Boolean(actionable)
    })
    if (cands.length) {
      const shown = cands.filter((n) => {
        const s = getComputedStyle(n)
        return s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0.01
      })
      reveal = {
        hidden: cands.length,
        visibleNow: shown.length,
        declaresFocusReveal: cands.every((n) =>
          /(group-focus-within[^:]*:|focus-within:|focus-visible:)/.test(n.getAttribute('class') || '')),
        sample: (cands[0].getAttribute('aria-label') || cands[0].textContent || '').trim().slice(0, 40),
      }
    }
  }

  const activeDescId = el.getAttribute('aria-activedescendant')
  let activeDesc = null
  if (activeDescId) {
    const node = document.getElementById(activeDescId)
    if (node) {
      const s = getComputedStyle(node)
      activeDesc = {
        id: activeDescId,
        text: (node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40),
        background: s.backgroundColor,
        selected: node.getAttribute('aria-selected'),
      }
    }
  }

  // Which surface this stop is actually inside — guards against a walk that
  // silently measures leftover chrome instead of the surface under test.
  const container = el.closest('[role="tabpanel"], section[aria-label], aside[aria-label], [role="dialog"]')
  const containerLabel = container
    ? (container.getAttribute('aria-label') || container.id || container.tagName)
    : ''

  return {
    tag: el.tagName,
    role: el.getAttribute('role') || '',
    label: el.getAttribute('aria-label') || (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 50),
    container: containerLabel,
    focusVisible,
    ringPainted,
    focusIndicated,
    focusDelta,
    boxShadow: (style.boxShadow || 'none').slice(0, 90),
    outline: style.outlineStyle + ' ' + style.outlineWidth,
    offscreen: rect.width === 0 || rect.height === 0,
    reveal,
    activeDesc,
  }
})()`

async function describeActive(page) {
  return page.evaluate(DESCRIBE)
}

async function tabWalk(page, surface, steps) {
  const stops = []
  console.log(`\n--- ${surface}: ${steps} Tab presses ---`)
  for (let i = 0; i < steps; i += 1) {
    await page.keyboard.press('Tab')
    await page.waitForTimeout(90)
    const s = await describeActive(page)
    s.index = i + 1
    stops.push(s)
    if (s.none) { console.log(`  ${String(i + 1).padStart(2)}  (nothing focused)`); continue }
    console.log(
      `  ${String(i + 1).padStart(2)}  ${s.tag}${s.role ? '/' + s.role : ''} "${s.label}" in[${s.container}]` +
        `  focusVisible=${s.focusVisible} ringPainted=${s.ringPainted} focusIndicated=${s.focusIndicated}` +
        (s.focusDelta && s.focusDelta.length ? ` via[${s.focusDelta.join(',')}]` : '') +
        (s.activeDesc ? `  activedescendant="${s.activeDesc.text}" bg=${s.activeDesc.background}` : '') +
        (s.reveal ? `  reveal(hidden=${s.reveal.hidden},visible=${s.reveal.visibleNow},focusReveal=${s.reveal.declaresFocusReveal})` : ''),
    )
  }
  transcript.push({ surface, stops })
  return stops
}

// A walk only counts if it actually entered the surface under test.
function assertReachedSurface(surface, stops, matcher) {
  const inside = stops.filter((s) => !s.none && matcher(s))
  check(
    `${surface}: the keyboard walk actually reaches this surface`,
    inside.length > 0,
    `${inside.length}/${stops.length} stop(s) inside; containers seen: ` +
      [...new Set(stops.filter((s) => !s.none).map((s) => s.container || '(none)'))].join(', ').slice(0, 160),
  )
  return inside
}

function assertRings(surface, stops) {
  const landed = stops.filter((s) => !s.none && !s.offscreen)
  const invisible = landed.filter((s) => !s.focusIndicated)
  check(
    `${surface}: focus is visible at every keyboard stop`,
    landed.length > 0 && invisible.length === 0,
    `${landed.length} stop(s); ${invisible.length} with no visible focus indicator` +
      (invisible.length
        ? ` → ${[...new Set(invisible.map((s) => `${s.tag}/${s.role} "${s.label}"`))].join(' | ')}`
        : ''),
  )
  return invisible
}

function assertReveal(surface, stops) {
  const withReveal = stops.filter((s) => s.reveal)
  if (!withReveal.length) {
    check(`${surface}: hover-revealed row actions reach the keyboard`, true, 'no hover-revealed actions on this surface')
    return
  }
  const broken = withReveal.filter((s) => s.reveal.visibleNow === 0 && !s.reveal.declaresFocusReveal)
  check(
    `${surface}: hover-revealed row actions reach the keyboard`,
    broken.length === 0,
    `${withReveal.length} stop(s) inside a row with hidden actions; ${broken.length} left hidden with no focus reveal`,
  )
}

/* ------------------------------------------------------------------ *
 * App driving
 * ------------------------------------------------------------------ */

async function click(page, locator) {
  if ((await locator.count()) === 0) return false
  await locator.first().evaluate((el) => el.click())
  await page.waitForTimeout(800)
  return true
}

async function headings(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('h1,h2,h3'))
      .filter((h) => { const r = h.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
      .map((h) => (h.textContent || '').trim())
      .join(' | '),
  )
}

// The onboarding wizard stays mounted underneath an opened door, so its controls
// stay in the tab order and would pollute every walk. It has to actually finish.
async function finishOnboarding(page) {
  await click(page, page.locator('button').filter({ hasText: /^Get started$/ }))
  for (let i = 0; i < 20; i += 1) {
    const heads = await headings(page)
    if (!/Pick a theme|Set up an agent CLI|Add extensions|Bring over|Welcome/i.test(heads)) {
      console.log(`  onboarding finished after ${i} step(s); headings now: ${heads.slice(0, 90)}`)
      return true
    }
    console.log(`  onboarding step ${i}: ${heads.slice(0, 90)}`)
    const advanced =
      (await click(page, page.locator('button').filter({ hasText: /^Continue$/ }).last())) ||
      (await click(page, page.locator('button').filter({ hasText: /^Skip for now$/ }))) ||
      (await click(page, page.locator('button').filter({ hasText: /^(Done|Finish|Start)$/ })))
    if (!advanced) { await page.keyboard.press('Escape'); await page.waitForTimeout(400) }
  }
  console.log('  !! onboarding did not finish')
  return false
}

async function resetFocusToTop(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    window.scrollTo(0, 0)
  })
  await page.waitForTimeout(200)
}

// Enter the surface the way a keyboard user does once they have tabbed into it:
// put focus on its container, then Tab onward from there. Without this, a walk
// from the document top spends all its stops on the app rail.
async function enterSurface(page, selector) {
  const ok = await page.evaluate((sel) => {
    const node = document.querySelector(sel)
    if (!node) return false
    if (!node.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(node.tagName)) {
      node.setAttribute('tabindex', '-1')
    }
    node.focus()
    return document.activeElement === node || node.contains(document.activeElement)
  }, selector)
  await page.waitForTimeout(300)
  console.log(`  entered ${selector}: ${ok}`)
  return ok
}

// The sprint board needs a run on disk. It is seeded deliberately inert: no
// `automation.json` (intent defaults to `manual`), every task left at `todo`, no
// locks, and the run is only ever opened through the Sprints door — which has no
// resident workspace, so every spawn/resume path is disabled by construction.
// Nothing here can launch an agent process.
const RUN_SLUG = 'keyboard-pass-demo'

async function seedSprintRun() {
  const runDir = join(workspaceDir, '.multi-code/sprintengine', RUN_SLUG)
  await mkdir(runDir, { recursive: true })
  const now = new Date('2026-07-29T09:00:00Z').toISOString()

  await writeFile(join(runDir, 'run.yaml'), `name: ${RUN_SLUG}\nschema_version: 4\nstatus: active\n`)

  const roles = ['architect', 'developer', 'tester']
  const tasks = [
    { id: 'T1', title: 'Wire the settings pane', role: 'developer', status: 'todo', dependsOn: [] },
    { id: 'T2', title: 'Fold the ramp into the theme', role: 'developer', status: 'todo', dependsOn: ['T1'] },
    { id: 'T3', title: 'Cover the seam with a test', role: 'tester', status: 'todo', dependsOn: ['T1'] },
    { id: 'T4', title: 'Plan the execution graph', role: 'architect', status: 'todo', dependsOn: [] },
  ]
  const agents = {
    architect: { role: 'architect', status: 'idle', currentTaskId: null, currentDispatch: null, ownedTaskIds: ['T4'], lastOwnedTaskId: 'T4' },
    'developer-1': { role: 'developer', status: 'idle', currentTaskId: null, currentDispatch: null, ownedTaskIds: ['T1'], lastOwnedTaskId: 'T1' },
    'tester-1': { role: 'tester', status: 'idle', currentTaskId: null, currentDispatch: null, ownedTaskIds: ['T3'], lastOwnedTaskId: 'T3' },
  }

  await writeFile(
    join(runDir, 'projection.json'),
    JSON.stringify(
      {
        ok: true,
        projectionVersion: 1,
        generatedAt: now,
        updatedAt: now,
        statePath: join(runDir, 'run.yaml'),
        run: {
          id: RUN_SLUG,
          name: 'Keyboard pass demo',
          goal: 'A seeded, inert run so the board has task rows to tab through',
          status: 'active',
          schemaVersion: 4,
          rosterConfigured: true,
          configuredRoles: roles,
          updatedAt: now,
        },
        tasks,
        roster: agents,
        workers: agents,
        artifacts: [],
        activity: [],
        locks: {},
      },
      null,
      2,
    ),
  )
}

async function seed() {
  await rm(tempRoot, { recursive: true, force: true })
  await mkdir(join(workspaceDir, 'backlog'), { recursive: true })
  await mkdir(userDataDir, { recursive: true })
  await mkdir(outDir, { recursive: true })
  for (const [slug, title, status] of [
    ['one', 'Keyboard pass item one', 'ready'],
    ['two', 'Keyboard pass item two', 'idea'],
    ['three', 'Keyboard pass item three', 'in_progress'],
  ]) {
    await writeFile(
      join(workspaceDir, `backlog/2026-07-29-kb-${slug}.md`),
      `---\nstatus: ${status}\n---\n\n# ${title}\n\nSeeded row for the T15 keyboard pass.\n`,
    )
  }
  await seedSprintRun()
}

async function main() {
  const { _electron: electron } = require('playwright')
  const electronPath = require('electron')
  await seed()

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
    const page = await resolveMainWindow(app)
    page.on('console', (m) => { if (m.type() === 'error') console.error(`[renderer] ${m.text()}`) })
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]; w.setSize(1800, 1100); w.center()
    })
    await page.waitForTimeout(2000)

    console.log('=== onboarding ===')
    const onboarded = await finishOnboarding(page)
    check('onboarding completes so its controls leave the tab order', onboarded)
    await page.screenshot({ path: join(outDir, '00-shell.png') })

    // Without a real workspace every door renders its empty state, and the
    // first-run panel keeps its switches in the tab order — a walk then measures
    // the onboarding chrome instead of the surface under test.
    console.log('\n=== creating the workspace ===')
    // Through New chat — the product's one door (MC-2436). The folder is
    // adopted via Browse…, which MULTICODE_TEST_OPEN_DIR (set on the launch
    // above) resolves without a native dialog.
    const created = await createWorkspaceThroughNewChat(page, { folder: workspaceDir })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: join(outDir, '02-workspace-open.png') })

    const wsState = await page.evaluate(() => ({
      treeitems: document.querySelectorAll('[role="treeitem"]').length,
      firstRunSwitches: document.querySelectorAll('[role="switch"]').length,
      heads: Array.from(document.querySelectorAll('h1,h2,h3')).map((h) => (h.textContent || '').trim()).join(' | '),
    }))
    console.log('  workspace state: ' + JSON.stringify(wsState))
    check(
      'a real workspace is created and open',
      created && wsState.treeitems > 0,
      `treeitems=${wsState.treeitems} leftoverSwitches=${wsState.firstRunSwitches} heads="${wsState.heads.slice(0, 60)}"`,
    )

    /* ---------------- Surface 1: Backlog ---------------- */
    console.log('\n=== SURFACE 1: Backlog ===')
    await click(page, page.getByRole('button', { name: 'Backlog', exact: true }))
    await page.waitForTimeout(2000)
    await page.screenshot({ path: join(outDir, '10-backlog.png') })

    const backlogList = await page.evaluate(() => {
      const ul = document.querySelector('ul[role="listbox"]')
      return ul
        ? { label: ul.getAttribute('aria-label'), options: ul.querySelectorAll('[role="option"]').length, tabIndex: ul.tabIndex }
        : null
    })
    console.log('  listbox: ' + JSON.stringify(backlogList))
    check('Backlog surface renders its listbox with rows', Boolean(backlogList && backlogList.options > 0), JSON.stringify(backlogList))

    await resetFocusToTop(page)
    await enterSurface(page, 'section[aria-label="Backlog"], aside[aria-label="Backlog list"]')
    const backlogStops = await tabWalk(page, 'Backlog', 22)
    const backlogInside = assertReachedSurface('Backlog', backlogStops, (s) => /backlog/i.test(s.container))
    assertRings('Backlog', backlogInside.length ? backlogInside : backlogStops)
    assertReveal('Backlog', backlogInside.length ? backlogInside : backlogStops)
    await page.screenshot({ path: join(outDir, '11-backlog-focused.png') })

    // The rows are driven by aria-activedescendant, so the selection contract
    // has to be observed by arrowing inside the listbox, not by tabbing to rows.
    // Focus the listbox itself: rows are driven by aria-activedescendant, which
    // is only set once a row is active, so it cannot be the thing we look for.
    const onList = backlogStops.find((s) => s.role === 'listbox')
    if (onList) {
      await enterSurface(page, 'ul[role="listbox"]')
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(250)
      const after = await describeActive(page)
      console.log('  after ArrowDown: ' + JSON.stringify(after.activeDesc))
      check(
        'Backlog: arrow keys move the active row and it is visually filled',
        Boolean(after.activeDesc && after.activeDesc.background && after.activeDesc.background !== 'rgba(0, 0, 0, 0)'),
        `activedescendant="${after.activeDesc?.text}" bg=${after.activeDesc?.background}`,
      )
      await page.screenshot({ path: join(outDir, '12-backlog-arrowed.png') })

      // Backlog row actions are a right-click context menu. Shift+F10 is the
      // keyboard equivalent; if nothing opens, the actions have no keyboard route.
      await page.keyboard.press('Shift+F10')
      await page.waitForTimeout(700)
      const menuOpen = await page.locator('[role="menu"]').count()
      check(
        'Backlog: row actions have a keyboard route (Shift+F10 opens the row menu)',
        menuOpen > 0,
        menuOpen > 0 ? 'menu opened' : 'no [role=menu] appeared — row actions are pointer-only',
      )
      if (menuOpen > 0) { await page.keyboard.press('Escape'); await page.waitForTimeout(300) }
      await page.screenshot({ path: join(outDir, '13-backlog-shift-f10.png') })
    } else {
      check('Backlog: arrow keys move the active row and it is visually filled', false, 'never focused the listbox')
    }

    /* ---------------- Surface 2: the Sprint board ---------------- */
    console.log('\n=== SURFACE 2: Sprint board ===')
    await click(page, page.getByRole('button', { name: 'Sprints', exact: true }))
    await page.waitForTimeout(2000)
    await page.screenshot({ path: join(outDir, '20-sprints-door.png') })

    // Select the seeded run from the rail, then move to the Tasks tab.
    await click(page, page.getByRole('button', { name: /Keyboard pass demo/ }))
    await page.waitForTimeout(1800)
    await page.screenshot({ path: join(outDir, '21-run-selected.png') })

    // Tab labels carry a trailing count, so match loosely.
    await click(page, page.locator('button[role="tab"]').filter({ hasText: /Tasks/ }))
    await page.waitForTimeout(1500)
    // Kanban is the layout with the TaskCard rows this epic touched.
    await click(page, page.locator('[role="group"][aria-label="Tasks layout"] button').filter({ hasText: /Board/ }))
    await page.waitForTimeout(1500)
    await page.screenshot({ path: join(outDir, '22-board-kanban.png') })

    const boardPresent = await page.evaluate(() => ({
      tablist: Boolean(document.querySelector('[role="tablist"][aria-label="Sprint view"]')),
      cards: document.querySelectorAll('[data-task-card="card"]').length,
      nodes: document.querySelectorAll('[data-task-graph-node]').length,
      lanes: document.querySelectorAll('section[aria-label$=" lane"]').length,
      heads: Array.from(document.querySelectorAll('h1,h2,h3')).map((h) => (h.textContent || '').trim()).join(' | '),
    }))
    console.log('  board probe: ' + JSON.stringify(boardPresent))
    check(
      'Sprint board renders task rows',
      boardPresent.cards + boardPresent.nodes > 0,
      `tablist=${boardPresent.tablist} cards=${boardPresent.cards} graphNodes=${boardPresent.nodes} lanes=${boardPresent.lanes}`,
    )

    await resetFocusToTop(page)
    await enterSurface(page, '#sprintengine-view-panel-tasks')
    const boardStops = await tabWalk(page, 'Sprint board', 30)
    // Task cards sit inside `section[aria-label="<Column> lane"]`, so the lane is
    // the nearest labelled container, not the panel.
    const boardInside = assertReachedSurface('Sprint board', boardStops, (s) =>
      /sprint|tasks|kanban|lane/i.test(s.container))
    assertRings('Sprint board', boardInside.length ? boardInside : boardStops)
    assertReveal('Sprint board', boardInside.length ? boardInside : boardStops)
    await page.screenshot({ path: join(outDir, '23-board-focused.png') })

    /* ---------------- Surface 3: the roster table ---------------- */
    // The run-time roster is the board's "Agents" tab: the surface that actually
    // carries hover-revealed row actions (Open terminal, ⋮ actions).
    console.log('\n=== SURFACE 3: roster table (board → Agents) ===')
    await click(page, page.locator('button[role="tab"]').filter({ hasText: /Agents/ }))
    await page.waitForTimeout(1800)
    await page.screenshot({ path: join(outDir, '30-roster.png') })

    const rosterPresent = await page.evaluate(() => ({
      bands: document.querySelectorAll('#sprintengine-view-panel-roster section[aria-label]').length,
      agentLists: document.querySelectorAll('#sprintengine-view-panel-roster ol[aria-label$=" agents"]').length,
      rows: document.querySelectorAll('#sprintengine-view-panel-roster ol[aria-label$=" agents"] > li').length,
      hoverHidden: document.querySelectorAll('#sprintengine-view-panel-roster [class*="opacity-0"]').length,
    }))
    console.log('  roster probe: ' + JSON.stringify(rosterPresent))
    check('roster table renders role bands with agent rows', rosterPresent.rows > 0, JSON.stringify(rosterPresent))

    await resetFocusToTop(page)
    await enterSurface(page, '#sprintengine-view-panel-roster')
    const rosterStops = await tabWalk(page, 'Roster table', 30)
    const rosterInside = assertReachedSurface('Roster table', rosterStops, (s) =>
      /roster|agents/i.test(s.container))
    assertRings('Roster table', rosterInside.length ? rosterInside : rosterStops)
    assertReveal('Roster table', rosterInside.length ? rosterInside : rosterStops)
    await page.screenshot({ path: join(outDir, '31-roster-focused.png') })

    // The roster rows are the surface with the most hover-revealed actions, so
    // check them head-on: focus each hidden action and confirm it paints.
    const rosterReveal = await page.evaluate(() => {
      const panel = document.querySelector('#sprintengine-view-panel-roster')
      if (!panel) return { error: 'no roster panel' }
      const hidden = Array.from(panel.querySelectorAll('button[class*="opacity-0"]'))
      return {
        total: hidden.length,
        results: hidden.map((btn) => {
          const before = parseFloat(getComputedStyle(btn).opacity || '1')
          btn.focus()
          const after = parseFloat(getComputedStyle(btn).opacity || '1')
          const focused = document.activeElement === btn
          btn.blur()
          return {
            label: btn.getAttribute('aria-label') || (btn.textContent || '').trim().slice(0, 30),
            before,
            after,
            focusable: focused,
            revealedOnFocus: focused && after > 0.01,
          }
        }),
      }
    })
    console.log('  roster hidden-action reveal: ' + JSON.stringify(rosterReveal, null, 1))
    if (rosterReveal.total > 0) {
      const broken = rosterReveal.results.filter((r) => !r.revealedOnFocus)
      check(
        'roster row actions that hide until hover are revealed by keyboard focus',
        broken.length === 0,
        `${rosterReveal.total} hidden action(s); ${broken.length} not revealed on focus` +
          (broken.length ? ` → ${broken.map((b) => `"${b.label}" focusable=${b.focusable} opacity ${b.before}→${b.after}`).join(' | ')}` : ''),
      )
    } else {
      check('roster row actions that hide until hover are revealed by keyboard focus', true, 'no hidden row actions present in this run state')
    }
    await page.screenshot({ path: join(outDir, '32-roster-reveal.png') })

    await writeFile(join(outDir, 'transcript.json'), JSON.stringify({ checks, transcript }, null, 2))
    const failed = checks.filter((c) => !c.ok)
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
    console.log(`evidence: ${outDir}`)
    if (failed.length) {
      console.log('\nFAILING:')
      for (const f of failed) console.log(`  - ${f.name} — ${f.detail}`)
      process.exitCode = 1
    }
  } finally {
    await app.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})
