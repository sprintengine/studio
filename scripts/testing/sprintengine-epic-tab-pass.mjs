#!/usr/bin/env node
// Rendered pass for the Sprint → Epic tab (item 2028, task T5).
//
// The item's acceptance is explicit that the visual rules are measured on the
// RENDERED surface, not read off the source: no divider rule between the epic
// heading and its rows, rows that carry no border, exactly one chrome row above
// the canvas, and exactly one full-strength selection while a child is picked.
//
// It also carries MC-2047's acceptance for the pane this tab REUSES: no
// hairline inside the detail pane, no body heading outranking the pane's own
// title, no copy explaining a control, and an Epic section that names itself
// once. Same requirement, same reason — those are painted facts, and the four
// defects survived a review that read them off the source. They are measured
// here in both polarities and again on the Backlog door, which mounts the same
// component with different chrome around it.
//
// It drives the built app (out/main/index.js) with an isolated profile, seeds a
// scratch project holding a backlog epic + children and TWO sprint runs — one
// seeded from that epic, one seeded from a goal — and opens each through the
// Sprints door, which reads runs from disk by state path (no workspace wizard).
//
//   npm run build   (out/main + out/renderer)
//   NODE_PATH=/tmp/multicode-playwright/node_modules node <this file>

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { PANE_MEASURE, stampTheme } from './backlogDetailPaneMeasure.mjs'

const require = createRequire('/tmp/multicode-playwright/x.js')
const root = resolve(new URL('../..', import.meta.url).pathname)
// Resolved from the checkout under test. In a sprint worktree that walks up into
// the main checkout's node_modules (the worktree's own is empty).
const localRequire = createRequire(join(root, 'x.js'))
const tempRoot = process.env.EPIC_TAB_TMP || '/tmp/multicode-epic-tab'
const workspaceDir = join(tempRoot, 'project')
const userDataDir = join(tempRoot, 'user-data')
const outDir = join(tempRoot, 'out')

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const EPIC_SLUG = 'checkout-hardening'
// The child the pass selects (index 1) carries a prerequisite AND an attached
// mockup, so the pane is measured with Mockups and Dependencies POPULATED, not
// only in their empty state — a hairline under a section with content is the
// same defect, and the empty-state fix must not have hidden the populated path.
const SEEDED_MOCKUP = 'backlog/mockups/seeded-pane.html'
const CHILDREN = [
  ['2026-07-01-idempotency-keys', 'Idempotency keys on the refund endpoint', 'completed'],
  ['2026-07-02-webhook-retries', 'Retry failed webhook deliveries with backoff', 'in_progress'],
  ['2026-07-03-dead-letter-queue', 'Dead-letter queue for exhausted deliveries', 'ready'],
  // Added to the epic after the sprint started: no task points at it.
  ['2026-07-09-decline-codes', 'Surface decline codes to the buyer', 'idea'],
]
// Recorded as a member at launch, then moved/deleted: must render as unavailable.
const MOVED_CHILD = 'backlog/2026-07-04-partial-captures.md'

function taskFor(index, id, childPath, status, agent) {
  return {
    id,
    title: `Deliver ${childPath}`,
    role: 'developer',
    repo: 'primary',
    status,
    stateStatus: status,
    folderStatus: status === 'done' ? 'done' : status === 'in_progress' ? 'in_progress' : 'todo',
    boardColumn: status === 'done' ? 'done' : status === 'in_progress' ? 'in_progress' : 'todo',
    ownerAgentId: agent,
    dependsOn: index === 0 ? [] : [`T${index}`],
    ownedPaths: ['src'],
    acceptanceCriteria: ['Seeded fixture task.'],
    implementationNotes: [],
    backlogRef: { projectRelativePath: childPath },
    evidence: { summary: '', touchedFiles: [] },
    notes: [],
    comments: [],
    activity: [],
    startedAt: status === 'todo' ? null : '2026-07-30T19:00:00Z',
    completedAt: status === 'done' ? '2026-07-30T20:00:00Z' : null,
  }
}

const TASKS = [
  taskFor(0, 'T1', 'backlog/2026-07-01-idempotency-keys.md', 'done', null),
  taskFor(1, 'T2', 'backlog/2026-07-02-webhook-retries.md', 'in_progress', 'developer-1'),
  taskFor(2, 'T3', 'backlog/2026-07-03-dead-letter-queue.md', 'todo', null),
  taskFor(3, 'T4', MOVED_CHILD, 'todo', null),
  // A follow-up filed mid-run with no backlog item behind it: lives in Tasks,
  // never appears on the Epic tab.
  {
    ...taskFor(4, 'T5', 'unused', 'todo', null),
    title: 'Follow-up filed mid-run',
    backlogRef: undefined,
  },
]

function runRecord(slug, source, sourceBundle, goal) {
  return {
    schemaVersion: 4,
    id: slug,
    name: slug,
    goal,
    status: 'executing',
    rosterConfigured: true,
    configuredRoles: ['architect', 'developer'],
    rosterPolicy: { workerAssignment: 'per_task' },
    runner: {
      cliWatchPolling: 'disabled',
      pollIntervalSeconds: 10,
      idleBackoffSeconds: 30,
      maxBackoffSeconds: 120,
      stopWhenComplete: true,
    },
    updatedAt: '2026-07-30T21:00:00Z',
    creation: { source: 'folder_store', createdAt: '2026-07-30T19:00:00Z' },
    ...(source ? { source } : {}),
    ...(sourceBundle ? { sourceBundle } : {}),
  }
}

async function writeRun(slug, source, sourceBundle, goal) {
  const yaml = localRequire('js-yaml')
  const dir = join(workspaceDir, '.multi-code/sprintengine', slug)
  await mkdir(dir, { recursive: true })
  const run = runRecord(slug, source, sourceBundle, goal)
  const statePath = join(dir, 'run.yaml')
  await writeFile(
    statePath,
    yaml.dump(
      {
        ...run,
        roles: { developer: { count: 1 } },
        sprintengine: { name: slug, goal, status: 'executing', updatedAt: run.updatedAt },
        tasks: TASKS.map((task) => ({
          id: task.id,
          status: task.status,
          role: task.role,
          dependsOn: task.dependsOn,
          needsTriage: false,
        })),
        artifacts: [],
      },
      { lineWidth: 120 },
    ),
    'utf8',
  )
  await writeFile(
    join(dir, 'projection.json'),
    `${JSON.stringify(
      {
        ok: true,
        source: 'folder_store',
        projectionVersion: 1,
        generatedAt: run.updatedAt,
        updatedAt: run.updatedAt,
        statePath,
        planPath: join(dir, 'plan.md'),
        run,
        tasks: TASKS,
        roster: { 'developer-1': { role: 'developer', status: 'running', currentTaskId: 'T2', currentDispatch: null } },
        artifacts: [],
        activity: [],
        board: { columns: [{ key: 'in_progress', label: 'in_progress', tasks: ['T2'] }] },
        counts: { tasks: { todo: 3, in_progress: 1, done: 1 }, ready: 0, needsInput: 0, changesRequested: 0 },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await writeFile(join(dir, 'plan.md'), `# ${slug}\n\nScratch fixture plan.\n`, 'utf8')
  return statePath
}

async function seed() {
  await rm(tempRoot, { recursive: true, force: true })
  await mkdir(join(workspaceDir, 'backlog/epics'), { recursive: true })
  await mkdir(userDataDir, { recursive: true })
  await mkdir(outDir, { recursive: true })

  await writeFile(
    join(workspaceDir, `backlog/epics/${EPIC_SLUG}.md`),
    '---\ntype: epic\nstatus: in_progress\nid: 1841\n---\n\n# Checkout hardening\n\nHarden the checkout path end to end.\n',
  )
  await mkdir(join(workspaceDir, 'backlog/mockups'), { recursive: true })
  await writeFile(
    join(workspaceDir, SEEDED_MOCKUP),
    '<!doctype html><title>Seeded mockup</title><body><h1>Seeded mockup</h1></body>\n',
  )
  let id = 1842
  for (const [slug, title, status] of CHILDREN) {
    // The selected child (index 1) is the populated one: a resolved prerequisite
    // and an attached, on-disk mockup, so its Mockups and Dependencies sections
    // render ROWS when the pane is measured.
    const populated = slug === CHILDREN[1][0]
    const extraFields = populated
      ? `mockups: ${SEEDED_MOCKUP}\ndependsOn: ${CHILDREN[0][0]}\n`
      : ''
    await writeFile(
      join(workspaceDir, `backlog/${slug}.md`),
      // The trailing `# Body heading` is deliberate: the pane strips only the
      // LEADING title h1, so a second one exercises the top of the markdown
      // ramp against the pane's own title (MC-2047's heading-scale defect).
      `---\ntype: feature\nstatus: ${status}\nepic: ${EPIC_SLUG}\ndifficulty: m\ncriticality: high\n${extraFields}id: ${id}\n---\n\n# ${title}\n\n## Intent\n\nSeeded intent for ${title}.\n\n## Acceptance\n\n- The seeded criterion renders in the detail pane.\n\n# Body heading\n\nProse under a body h1.\n`,
    )
    id += 1
  }

  const epicSource = {
    kind: 'markdown',
    origin: 'reference',
    path: `backlog/epics/${EPIC_SLUG}.md`,
    // Deliberately NOT 'epic': this is what a run created from the Backlog
    // surface records, and the tab has to appear for it.
    planKind: 'unknown',
    capturedAt: '2026-07-30T19:00:00Z',
  }
  const bundle = [
    ...CHILDREN.map(([slug]) => ({
      kind: 'generic_context',
      origin: 'reference',
      path: `backlog/${slug}.md`,
      capturedAt: '2026-07-30T19:00:00Z',
    })),
    { kind: 'generic_context', origin: 'reference', path: MOVED_CHILD, capturedAt: '2026-07-30T19:00:00Z' },
  ]
  const epicRun = await writeRun('epic-seeded-sprint', epicSource, bundle, 'Checkout hardening, from its epic')
  const goalRun = await writeRun('goal-seeded-sprint', undefined, undefined, 'A sprint with no backlog seed at all')

  const now = new Date()
  await writeFile(
    join(userDataDir, 'multiauth-entitlements-cache.json'),
    JSON.stringify(
      {
        snapshot: {
          schemaVersion: 1,
          product: 'multicode',
          userId: 'epic-tab-pass',
          organizationId: 'epic-tab-pass-org',
          plan: { code: 'pro', status: 'active' },
          features: { 'multicode.sprintengine': true },
          limits: {},
          roles: [],
          sources: {},
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 86400000).toISOString(),
        },
        lastRefreshAt: now.toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  )
  return { epicRun, goalRun }
}

/* ------------------------------------------------------------------ *
 * Measurement, in the renderer
 * ------------------------------------------------------------------ */

// Everything the acceptance asks for, read off computed style — never markup.
const MEASURE = `(() => {
  const px = (v) => Number.parseFloat(v || '0') || 0
  const box = (el) => el.getBoundingClientRect()
  const epic = document.querySelector('section[aria-label="Epic"]')
  const tablists = Array.from(document.querySelectorAll('[role="tablist"]'))
  const tabs = tablists.map((list) =>
    Array.from(list.querySelectorAll('[role="tab"]')).map((t) => (t.textContent || '').trim()),
  )
  if (!epic) {
    return { present: false, tabs, tablistCount: tablists.length }
  }
  const heading = epic.querySelector('header')
  const list = epic.querySelector('ul[role="listbox"]')
  const rows = list ? Array.from(list.querySelectorAll('li[role="option"]')) : []
  const borderOf = (el) => {
    const s = getComputedStyle(el)
    return {
      top: px(s.borderTopWidth),
      right: px(s.borderRightWidth),
      bottom: px(s.borderBottomWidth),
      left: px(s.borderLeftWidth),
      radius: px(s.borderTopLeftRadius),
      background: s.backgroundColor,
    }
  }
  // Every element painted between the heading's bottom edge and the first row's
  // top edge — a divider rule would be one of these, or a border on either.
  const between = []
  if (heading && rows[0]) {
    const hb = box(heading)
    const rb = box(rows[0])
    for (const el of Array.from(epic.querySelectorAll('*'))) {
      const b = box(el)
      if (b.width < 8) continue
      if (b.top >= hb.bottom - 0.5 && b.bottom <= rb.top + 0.5 && b.height <= 4) {
        const s = getComputedStyle(el)
        between.push({
          tag: el.tagName,
          height: Math.round(b.height * 100) / 100,
          borderTop: px(s.borderTopWidth),
          borderBottom: px(s.borderBottomWidth),
          background: s.backgroundColor,
        })
      }
    }
  }
  // Chrome rows above the canvas: every horizontal band that sits above the
  // Epic section, overlaps it horizontally, and draws a bottom hairline. Read
  // document-wide (not scoped to a container that might itself be the band), and
  // nested bands with the same edge are one row, not two.
  const epicBox = box(epic)
  const chromeRows = []
  for (const el of Array.from(document.querySelectorAll('header, div, nav'))) {
    const b = box(el)
    const s = getComputedStyle(el)
    if (b.width < epicBox.width * 0.6) continue
    if (b.right < epicBox.left + 4 || b.left > epicBox.right - 4) continue
    if (b.bottom > epicBox.top + 1) continue
    if (b.height === 0 || b.height > 64) continue
    if (px(s.borderBottomWidth) === 0) continue
    // Doors paint OVER the workspace layers, which stay mounted: a band that
    // nothing at its own centre point resolves to is underneath the door and is
    // not on screen at all.
    const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2)
    const visible = Boolean(hit) && (el.contains(hit) || hit.contains(el))
    chromeRows.push({
      height: Math.round(b.height),
      top: Math.round(b.top),
      bottom: Math.round(b.bottom),
      visible,
      hasControls: Boolean(el.querySelector('[role="tab"], button')),
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90),
    })
  }
  // The app's own top bar (the door bar) sits at y=0 and is not the board's
  // chrome; every other visible band above the canvas is.
  const boardBands = chromeRows.filter((r) => r.visible && r.top > 0)
  const chromeBands = [...new Set(boardBands.filter((r) => r.hasControls).map((r) => r.bottom))]
  const noticeBands = boardBands.filter((r) => !r.hasControls)
  // Full-strength vs resting selection, document-wide.
  const rootFull = getComputedStyle(document.documentElement).getPropertyValue('--bg-selected').trim()
  const selected = Array.from(document.querySelectorAll('[aria-selected="true"], [aria-current="true"], [aria-current="page"]'))
    .filter((el) => box(el).width > 0 && box(el).height > 0)
    .map((el) => {
      const s = getComputedStyle(el)
      return {
        role: el.getAttribute('role') || el.tagName,
        fill: s.backgroundColor,
        rootFull,
        full: s.getPropertyValue('--bg-selected').trim(),
        resting: s.getPropertyValue('--bg-selected-resting').trim(),
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 50),
      }
    })
  return {
    present: true,
    tabs,
    tablistCount: tablists.length,
    headingBorders: heading ? borderOf(heading) : null,
    listBorders: list ? borderOf(list) : null,
    rows: rows.map((row) => ({
      borders: borderOf(row),
      selected: row.getAttribute('aria-selected') === 'true',
      disabled: row.getAttribute('aria-disabled') === 'true',
      text: (row.textContent || '').replace(/\\s+/g, ' ').trim(),
    })),
    between,
    chromeRows,
    chromeBands,
    noticeBands,
    selected,
    detailText: (document.querySelector('aside[aria-label="Backlog item"]')?.textContent || '')
      .replace(/\\s+/g, ' ')
      .trim()
      .slice(0, 400),
  }
})()`

// The pane's own anatomy (MC-2047) and the polarity stamp are the shared probe:
// the same measurement runs on the Horizon door from `horizon-chrome-rows-pass.mjs`,
// and one component measured two ways is how two surfaces disagree.

async function click(page, locator) {
  if ((await locator.count()) === 0) return false
  await locator.first().evaluate((el) => {
    el.focus?.()
    el.click()
  })
  await page.waitForTimeout(700)
  return true
}

async function headings(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('h1,h2,h3'))
      .filter((h) => h.getBoundingClientRect().width > 0)
      .map((h) => h.textContent?.trim())
      .join(' | '),
  )
}

async function finishOnboarding(page) {
  await click(page, page.locator('button').filter({ hasText: /^Get started$/ }))
  for (let i = 0; i < 20; i += 1) {
    const heads = await headings(page)
    if (!/Pick a theme|Set up an agent CLI|Add extensions|Bring over|Welcome|What’s included|What's included/i.test(heads)) return true
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

async function main() {
  const { _electron: electron } = require('playwright')
  const electronPath = localRequire('electron')
  const runs = await seed()
  console.log(`seeded: ${runs.epicRun}\n        ${runs.goalRun}`)

  const app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out/main/index.js')],
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: '',
      NODE_ENV: '',
      MULTICODE_USER_DATA_DIR: userDataDir,
      MULTICODE_ALLOW_MULTI_INSTANCE: '1',
      MULTICODE_TEST_OPEN_DIR: workspaceDir,
      MULTIAUTH_BASE_URL: 'http://127.0.0.1:9',
    },
  })

  const transcript = {
    epic: null,
    goal: null,
    pane: { epicDark: null, epicLight: null, doorDark: null, doorLight: null },
  }
  try {
    const page = await app.firstWindow()
    page.on('console', (m) => {
      if (m.type() === 'error') console.error(`[renderer] ${m.text()}`)
    })
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.setContentSize(1500, 940)
      w.center()
    })
    await page.waitForTimeout(2500)
    await finishOnboarding(page)

    console.log('\n=== creating the workspace on the scratch project ===')
    await click(page, page.locator('button').filter({ hasText: /^New Workspace$/ }))
    await page.waitForTimeout(1200)
    await page.locator('input[placeholder="my-workspace"]').first().fill('Epic tab pass')
    await page.locator('input[placeholder="/path/to/workspace"]').first().fill(workspaceDir)
    await page.waitForTimeout(500)
    const created =
      (await click(page, page.locator('button').filter({ hasText: /^Skip the rest and create$/ }))) ||
      (await click(page, page.locator('button').filter({ hasText: /^(Create workspace|Create)$/ }).last()))
    await page.waitForTimeout(4500)
    check('a workspace is open on the scratch project', created)
    await page.screenshot({ path: join(outDir, '00-workspace.png') })

    console.log('\n=== Sprints door ===')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.evaluate(() => {
        const button = Array.from(document.querySelectorAll('button')).find(
          (b) => (b.textContent || '').trim() === 'Sprints' || b.getAttribute('aria-label') === 'Sprints',
        )
        button?.focus()
        button?.click()
      })
      await page.waitForTimeout(700)
      await page.waitForTimeout(2000)
      const state = await page.evaluate(() => ({
        rail: Boolean(document.querySelector('[data-context-rail]')),
        surfaces: Array.from(document.querySelectorAll('section[aria-label]'))
          .filter((s) => s.getBoundingClientRect().width > 200)
          .map((s) => s.getAttribute('aria-label')),
        overlays: Array.from(document.querySelectorAll('.overlay-scrim, div.fixed.inset-0')).length,
        headings: Array.from(document.querySelectorAll('h1,h2,h3'))
          .filter((h) => h.getBoundingClientRect().width > 0)
          .map((h) => (h.textContent || '').trim())
          .slice(0, 10),
      }))
      console.log(`sprints door attempt ${attempt + 1}: ${JSON.stringify(state)}`)
      await page.screenshot({ path: join(outDir, `01-attempt-${attempt + 1}.png`) })
      if (state.rail) break
    }
    await page.waitForTimeout(1500)
    const railRows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-context-rail] *'))
        .filter((el) => el.children.length === 0 && (el.textContent || '').trim())
        .map((el) => (el.textContent || '').trim().slice(0, 40))
        .slice(0, 40),
    )
    console.log('rail rows:', JSON.stringify(railRows))
    await page.screenshot({ path: join(outDir, '01-sprints-door.png') })

    // Everything below drives the DOM directly: Playwright's own click routes
    // through a synthesized pointer that this shell's rows do not always
    // receive, while `el.click()` reaches React's handler every time.
    const domClick = async (selectorFn, arg) => {
      const hit = await page.evaluate(selectorFn, arg)
      await page.waitForTimeout(800)
      return hit
    }
    const clickRailRun = (runLabel) =>
      domClick((wanted) => {
        const rail = document.querySelector('[data-context-rail]')
        // The deepest clickable carrying the label: an outer <li> may only be a
        // layout wrapper, and clicking it reaches no handler.
        const candidates = Array.from(rail?.querySelectorAll('button, [role="option"], li') ?? []).filter(
          (el) => (el.textContent || '').includes(wanted),
        )
        const row = candidates[candidates.length - 1]
        if (!row) return false
        row.focus?.()
        row.click()
        return Boolean(row.textContent)
      }, runLabel)

    for (const [label, runLabel] of [['epic', 'epic-seeded-sprint'], ['goal', 'goal-seeded-sprint']]) {
      const opened = await clickRailRun(runLabel)
      await page
        .waitForFunction(
          (wanted) => {
            const bar = document.querySelector('section[aria-label="Sprints"]')
            return Boolean(bar) && (bar.textContent || '').includes(wanted)
          },
          runLabel,
          { timeout: 15000 },
        )
        .catch(() => {})
      await page.waitForTimeout(2500)
      check(`the ${label}-seeded run opens on the board`, opened, runLabel)
      if (label === 'epic') {
        const tabNames = await page.evaluate(() =>
          Array.from(document.querySelectorAll('[role="tab"]')).map((t) => (t.textContent || '').trim()),
        )
        check('the Epic tab is present for an epic-seeded run', tabNames.some((t) => /^Epic/.test(t)), JSON.stringify(tabNames))
        await domClick(() => {
          const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((t) =>
            /^Epic/.test((t.textContent || '').trim()),
          )
          tab?.click()
          return Boolean(tab)
        })
        await page.waitForTimeout(1500)
        // Pick the second child, then let the fills settle so nothing is read
        // mid-transition.
        await domClick(() => {
          const rows = Array.from(
            document.querySelectorAll('section[aria-label="Epic"] li[role="option"]:not([aria-disabled="true"])'),
          )
          rows[1]?.click()
          return rows.length
        })
        await page.waitForTimeout(1200)
        // The pane's own anatomy, in both polarities. BOTH are stamped: this
        // profile boots light, so reading "dark" as-found measured light twice
        // and called it two polarities. Each reading carries the polarity it was
        // taken in, and the assertions below check it.
        await stampTheme(page, 'dark', 'dark')
        transcript.pane.epicDark = await page.evaluate(PANE_MEASURE)
        await page.screenshot({ path: join(outDir, '02c-pane-dark.png') })
        await stampTheme(page, 'light', 'light')
        transcript.pane.epicLight = await page.evaluate(PANE_MEASURE)
        await page.screenshot({ path: join(outDir, '02d-pane-light.png') })
        await stampTheme(page, 'dark', 'dark')
      }
      const measured = await page.evaluate(MEASURE)
      transcript[label] = measured
      await page.screenshot({ path: join(outDir, `${label === 'epic' ? '02' : '03'}-${label}-board.png`) })
      if (label === 'epic') {
        await page.screenshot({ path: join(outDir, '02b-epic-clip.png'), clip: { x: 0, y: 0, width: 1500, height: 640 } })
        // The rail keeps listing runs while one is open, so the goal-seeded run
        // is one click away — the rail's Back row would leave the door entirely.
      }
    }

    // Same pane, second surface. MC-2047's fixes live in the shared component,
    // so the Backlog door has to read the same way — and unlike the Epic tab it
    // mounts the pane with no back affordance and no host band, which is where
    // a header change would show up differently if it were surface-local.
    console.log('\n=== Backlog door ===')
    await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('button')).find(
        (b) => (b.textContent || '').trim() === 'Backlog' || b.getAttribute('aria-label') === 'Backlog',
      )
      button?.focus()
      button?.click()
    })
    await page.waitForTimeout(2500)
    await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[role="option"], [role="row"]')).filter(
        (el) => el.getBoundingClientRect().width > 120,
      )
      rows[0]?.click()
    })
    await page.waitForTimeout(1500)
    await stampTheme(page, 'dark', 'dark')
    transcript.pane.doorDark = await page.evaluate(PANE_MEASURE)
    await page.screenshot({ path: join(outDir, '04-backlog-door-dark.png') })
    await stampTheme(page, 'light', 'light')
    transcript.pane.doorLight = await page.evaluate(PANE_MEASURE)
    await page.screenshot({ path: join(outDir, '05-backlog-door-light.png') })
  } finally {
    await writeFile(join(outDir, 'transcript.json'), `${JSON.stringify(transcript, null, 2)}\n`, 'utf8')
    await app.close()
  }

  /* ---- assertions over what was painted ------------------------------- */
  const m = transcript.epic
  if (!m || !m.present) {
    check('the Epic section rendered', false, JSON.stringify(m).slice(0, 600))
  } else {
    check(
      'exactly one chrome row sits above the canvas',
      m.chromeBands.length === 1,
      `chrome=${JSON.stringify(m.chromeBands)} notices=${JSON.stringify(m.noticeBands)} all=${JSON.stringify(m.chromeRows)}`,
    )
    check('the board has exactly one tablist', m.tablistCount === 1, JSON.stringify(m.tabs))
    check(
      'no rule between the epic heading and its rows',
      m.headingBorders.bottom === 0 && m.listBorders.top === 0 && m.between.length === 0,
      `heading=${JSON.stringify(m.headingBorders)} list=${JSON.stringify(m.listBorders)} between=${JSON.stringify(m.between)}`,
    )
    check(
      'every row carries no border and a radius',
      m.rows.length > 0
        && m.rows.every((r) => r.borders.top === 0 && r.borders.right === 0 && r.borders.bottom === 0 && r.borders.left === 0)
        && m.rows.every((r) => r.borders.radius > 0),
      JSON.stringify(m.rows.map((r) => r.borders)),
    )
    const hex = (value) => {
      const rgb = /rgba?\((\d+), ?(\d+), ?(\d+)/.exec(value)
      return rgb ? `#${[rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : value
    }
    const full = m.selected.filter((s) => hex(s.fill).toLowerCase() === (s.rootFull || '').toLowerCase())
    check(
      'exactly one full-strength selection is on screen',
      full.length === 1,
      JSON.stringify(m.selected),
    )
    const unmapped = m.rows.find((r) => /decline codes/i.test(r.text))
    check(
      'the child with no task renders with an empty mapping cell',
      Boolean(unmapped) && !/→ task/.test(unmapped.text),
      unmapped ? unmapped.text : 'row missing',
    )
    check(
      'each delivered child shows its task mapping',
      m.rows.filter((r) => /→ task \d/.test(r.text)).length >= 3,
      m.rows.map((r) => r.text).join(' || '),
    )
    const unavailable = m.rows.find((r) => r.disabled)
    check(
      'the moved item renders as unavailable with its path, and the rest still render',
      Boolean(unavailable) && /partial-captures/.test(unavailable.text) && m.rows.length >= 5,
      unavailable ? unavailable.text : 'no unavailable row',
    )
    check(
      'the selected child’s intent and acceptance render in the shared detail pane',
      /Seeded intent/.test(m.detailText) && /criterion renders/.test(m.detailText),
      m.detailText.slice(0, 200),
    )
  }

  /* ---- the detail pane's own anatomy (MC-2047) ------------------------- */
  for (const [surface, mode, pane] of [
    ['Epic tab, dark', 'dark', transcript.pane.epicDark],
    ['Epic tab, light', 'light', transcript.pane.epicLight],
    ['Backlog door, dark', 'dark', transcript.pane.doorDark],
    ['Backlog door, light', 'light', transcript.pane.doorLight],
  ]) {
    if (!pane || !pane.present) {
      check(`the detail pane rendered on the ${surface}`, false, JSON.stringify(pane).slice(0, 300))
      continue
    }
    // Guards the reading itself: a pass that measured one polarity twice and
    // reported two is worse than no polarity coverage at all.
    check(
      `the ${surface} reading was taken in that polarity`,
      pane.mode === mode,
      `theme=${pane.theme} mode=${pane.mode}`,
    )
    check(
      `no hairline rules inside the detail pane — ${surface}`,
      pane.rules.length === 0,
      JSON.stringify(pane.rules),
    )
    check(
      `no body heading outranks the pane title — ${surface}`,
      pane.titleSize > 0
        && pane.headings.length > 0
        && pane.headings.every((h) => h.size <= pane.titleSize),
      `title=${pane.titleSize} headings=${JSON.stringify(pane.headings)}`,
    )
    check(
      `no copy explains a control in the detail pane — ${surface}`,
      !pane.copy.mockups && !pane.copy.prerequisites && !pane.copy.epicChildren,
      JSON.stringify(pane.copy),
    )
    check(
      `the Epic section states its name once — ${surface}`,
      pane.epicSectionPresent && pane.epicLabels === 1,
      `section=${pane.epicSectionPresent} labels=${pane.epicLabels}`,
    )
  }

  // The Epic tab selects the seeded child that HAS a mockup and a prerequisite,
  // so its two readings above were taken over populated sections. Without this
  // the whole no-hairline claim could quietly narrow to the empty state.
  const populated = transcript.pane.epicDark
  check(
    'the measured pane had populated Mockups and Dependencies sections',
    Boolean(populated) && populated.rows?.mockups > 0 && populated.rows?.dependencies > 0,
    JSON.stringify(populated?.rows),
  )

  const goal = transcript.goal
  if (goal) {
    check('a goal-seeded run shows no Epic section', goal.present === false || goal.tabs.flat().every((t) => !/^Epic/.test(t)), JSON.stringify(goal.tabs))
    check('its chrome row is the unchanged one', goal.tablistCount === 1, JSON.stringify(goal.tabs))
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Artifacts in ${outDir}`)
  if (failed.length > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})
