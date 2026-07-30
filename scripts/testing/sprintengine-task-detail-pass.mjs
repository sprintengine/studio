#!/usr/bin/env node
// Rendered pass for the Sprint task detail pane (item 2029, task T6).
//
// The item's acceptance is explicit that the anatomy is measured on the
// RENDERED surface, not read off the source: exactly one stream with no filter
// chips, the compose box above the newest entry, a distinct lifecycle glyph per
// entry kind, a bar on Diff and none on Tokens, an unmeasured token source that
// reads as unmeasured rather than 0, no description or acceptance criteria
// anywhere on the pane, and zero divider rules inside it.
//
// It drives the built app (out/main/index.js) with an isolated profile, seeds a
// scratch project holding a backlog epic + child and a sprint run whose task
// carries activity, comments, diff evidence, owned modules and a backlog
// pointer, plus a run event log with a commit and a pull request. The run is
// opened through the Sprints door, which reads runs from disk by state path.
//
//   npm run build   (out/main + out/renderer)
//   NODE_PATH=/tmp/multicode-playwright/node_modules node <this file>

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire('/tmp/multicode-playwright/x.js')
const root = resolve(new URL('../..', import.meta.url).pathname)
// Resolved from the checkout under test. In a sprint worktree that walks up into
// the main checkout's node_modules (the worktree's own is empty).
const localRequire = createRequire(join(root, 'x.js'))
const tempRoot = process.env.TASK_DETAIL_TMP || '/tmp/multicode-task-detail'
const workspaceDir = join(tempRoot, 'project')
const userDataDir = join(tempRoot, 'user-data')
const outDir = join(tempRoot, 'out')

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const RUN_SLUG = 'task-detail-sprint'
const EPIC_SLUG = 'checkout-hardening'
const CHILD_PATH = 'backlog/2026-07-02-webhook-retries.md'
const TASK_ID = 'T2'
const TASK_TITLE = 'Retry failed webhook deliveries with backoff'
const DESCRIPTION_MARKER = 'DESCRIPTION-SHOULD-NOT-RENDER'
const ACCEPTANCE_MARKER = 'ACCEPTANCE-SHOULD-NOT-RENDER'

const ACTIVITY = [
  ['ACT-001', '2026-07-30T14:02:00Z', 'claim', 'developer-1', 'developer-1 claimed T2.', {}],
  ['ACT-002', '2026-07-30T14:31:00Z', 'comment', 'developer-1', 'Retry loop was swallowing the 5xx before it reached the scheduler.', { commentId: 'C-1', commentType: 'user_note' }],
  ['ACT-003', '2026-07-30T14:36:00Z', 'evidence', 'developer-1', 'developer-1 logged evidence for T2.', {}],
  ['ACT-004', '2026-07-30T14:44:00Z', 'status_change', 'developer-1', 'developer-1 published T2 to review.', { status: 'review' }],
  ['ACT-005', '2026-07-30T14:48:00Z', 'feedback', 'developer-1', 'developer-1 recorded feedback.', {}],
  ['ACT-006', '2026-07-30T15:04:00Z', 'comment', 'user', 'Check the cap is configurable before this lands.', { commentId: 'C-2', commentType: 'user_note' }],
].map(([id, timestamp, type, actor, message, extra]) => ({ id, timestamp, type, actor, message, ...extra }))

const EVENTS = [
  { id: 'EVT-001', timestamp: '2026-07-30T14:45:00Z', type: 'task_changes_committed', actor: 'developer-1', message: 'developer-1 committed Sprint Engine changes for T2: abc1234.' },
  // Another task's commit: must not appear on T2's timeline.
  { id: 'EVT-002', timestamp: '2026-07-30T14:46:00Z', type: 'task_changes_committed', actor: 'developer-3', message: 'developer-3 committed Sprint Engine changes for T21: def5678.' },
  { id: 'EVT-003', timestamp: '2026-07-30T14:52:00Z', type: 'run_pull_request_opened', actor: 'sprintengine', message: 'Opened pull request for sprint/task-detail: https://example.test/pr/206.' },
]

const TASKS = [
  {
    id: TASK_ID,
    title: TASK_TITLE,
    description: DESCRIPTION_MARKER,
    role: 'developer',
    repo: 'payments-api',
    status: 'review',
    stateStatus: 'review',
    folderStatus: 'review',
    boardColumn: 'review',
    ownerAgentId: null,
    lastImplementedByAgentId: 'developer-1',
    dependsOn: ['T1'],
    ownedPaths: ['src/webhooks', 'src/queue'],
    acceptanceCriteria: [ACCEPTANCE_MARKER],
    implementationNotes: ['Seeded implementation note.'],
    backlogRef: { projectRelativePath: CHILD_PATH, displayKey: 'MC-1843' },
    evidence: {
      summary: 'Retry loop fixed; dead-letter row written on exhaustion.',
      touchedFiles: ['src/webhooks/delivery.ts'],
      commandsRan: ['npm run typecheck'],
      results: ['typecheck clean'],
      diffs: [
        { path: 'src/webhooks/delivery.ts', status: 'modified', additions: 100, deletions: 30, hunks: [], binary: false, truncated: false },
        { path: 'src/queue/backoff.ts', status: 'added', additions: 47, deletions: 10, hunks: [], binary: false, truncated: false },
      ],
    },
    notes: [],
    comments: [
      { id: 'C-1', actor: 'developer-1', source: 'agent', type: 'user_note', body: 'Retry loop was swallowing the 5xx before it reached the scheduler.', createdAt: '2026-07-30T14:31:00Z' },
      { id: 'C-2', actor: 'user', source: 'user', type: 'user_note', body: 'Check the cap is configurable before this lands.', createdAt: '2026-07-30T15:04:00Z' },
    ],
    activity: ACTIVITY,
    startedAt: '2026-07-30T14:02:00Z',
    completedAt: null,
  },
  {
    id: 'T1',
    title: 'Idempotency keys on the refund endpoint',
    role: 'developer',
    repo: 'payments-api',
    status: 'done',
    stateStatus: 'done',
    folderStatus: 'done',
    boardColumn: 'done',
    ownerAgentId: null,
    dependsOn: [],
    ownedPaths: ['src/refunds'],
    acceptanceCriteria: [],
    implementationNotes: [],
    evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
    notes: [],
    comments: [],
    activity: [],
    startedAt: '2026-07-30T13:00:00Z',
    completedAt: '2026-07-30T13:40:00Z',
  },
]

function runRecord() {
  return {
    schemaVersion: 4,
    id: RUN_SLUG,
    name: RUN_SLUG,
    goal: 'Checkout hardening, from its epic',
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
    creation: { source: 'folder_store', createdAt: '2026-07-30T13:00:00Z' },
    source: {
      kind: 'markdown',
      origin: 'reference',
      path: `backlog/epics/${EPIC_SLUG}.md`,
      planKind: 'epic',
      capturedAt: '2026-07-30T13:00:00Z',
    },
    sourceBundle: [
      { kind: 'generic_context', origin: 'reference', path: CHILD_PATH, capturedAt: '2026-07-30T13:00:00Z', epicChild: true },
    ],
  }
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
  await writeFile(
    join(workspaceDir, CHILD_PATH),
    `---\ntype: feature\nstatus: in_progress\nepic: ${EPIC_SLUG}\nid: 1843\n---\n\n# Retry failed webhook deliveries with backoff\n\n## Intent\n\nSeeded intent lives on the ITEM, never on the task card.\n`,
  )

  const yaml = localRequire('js-yaml')
  const dir = join(workspaceDir, '.multi-code/sprintengine', RUN_SLUG)
  await mkdir(dir, { recursive: true })
  const run = runRecord()
  const statePath = join(dir, 'run.yaml')
  await writeFile(
    statePath,
    yaml.dump(
      {
        ...run,
        roles: { developer: { count: 1 } },
        sprintengine: { name: RUN_SLUG, goal: run.goal, status: 'executing', updatedAt: run.updatedAt },
        tasks: TASKS.map((task) => ({
          id: task.id,
          status: task.status,
          role: task.role,
          dependsOn: task.dependsOn,
          needsTriage: false,
        })),
        artifacts: [],
      },
      { lineWidth: 200 },
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
        roster: { 'developer-1': { role: 'developer', status: 'idle', currentTaskId: null, currentDispatch: null } },
        artifacts: [],
        activity: EVENTS,
        events: EVENTS,
        board: {
          columns: [
            { key: 'review', label: 'review', tasks: [TASK_ID] },
            { key: 'done', label: 'done', tasks: ['T1'] },
          ],
        },
        counts: { tasks: { review: 1, done: 1 }, ready: 0, needsInput: 0, changesRequested: 0 },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await writeFile(join(dir, 'plan.md'), `# ${RUN_SLUG}\n\nScratch fixture plan.\n`, 'utf8')

  const now = new Date()
  await writeFile(
    join(userDataDir, 'multiauth-entitlements-cache.json'),
    JSON.stringify(
      {
        snapshot: {
          schemaVersion: 1,
          product: 'multicode',
          userId: 'task-detail-pass',
          organizationId: 'task-detail-pass-org',
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
  return statePath
}

/* ------------------------------------------------------------------ *
 * Measurement, in the renderer
 * ------------------------------------------------------------------ */

// Everything the acceptance asks for, read off computed style — never markup.
const MEASURE = `(() => {
  const px = (v) => Number.parseFloat(v || '0') || 0
  const box = (el) => el.getBoundingClientRect()
  const pane = document.querySelector('[data-sprintengine-task-detail]')
  if (!pane) return { present: false }
  const paneBox = box(pane)
  const visible = (el) => {
    const b = box(el)
    if (b.width <= 0 || b.height <= 0) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0
  }

  // A DIVIDER RULE is a horizontal hairline that separates content: a border on
  // the top or bottom edge of a wide element. Control outlines (a button, a
  // field, the pointer row) are borders on all four edges of a small box, and a
  // tone bar on an exception callout is a border on one VERTICAL edge — neither
  // is a divider, and the mockup carries both.
  const rules = []
  for (const el of Array.from(pane.querySelectorAll('*'))) {
    if (!visible(el)) continue
    const s = getComputedStyle(el)
    const top = px(s.borderTopWidth)
    const bottom = px(s.borderBottomWidth)
    if (top === 0 && bottom === 0) continue
    const transparent = (side) => /rgba\\(0, 0, 0, 0\\)|transparent/.test(side)
    const paints =
      (top > 0 && !transparent(s.borderTopColor)) || (bottom > 0 && !transparent(s.borderBottomColor))
    if (!paints) continue
    const b = box(el)
    // A box that also draws both vertical edges is an outlined control, not a rule.
    if (px(s.borderLeftWidth) > 0 && px(s.borderRightWidth) > 0) continue
    if (b.width < paneBox.width * 0.5) continue
    rules.push({
      tag: el.tagName,
      cls: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : String(el.className || '')).slice(0, 90),
      width: Math.round(b.width),
      top,
      bottom,
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    })
  }

  // The stream. Compose is the pane's textarea; entries are the timeline's rows.
  const lists = Array.from(pane.querySelectorAll('ol'))
  const timeline = lists.length > 0 ? lists[lists.length - 1] : null
  const rows = timeline ? Array.from(timeline.children).filter((el) => el.tagName === 'LI') : []
  const composer = pane.querySelector('textarea')
  const firstRow = rows[0] || null

  // Every glyph the stream paints, by accessible name — the shape vocabulary.
  const glyphs = rows.map((row) => {
    const glyph = row.querySelector('svg')
    return {
      // Decorative by design: the actor and verb beside it name the entry, so
      // the glyph is compared by SHAPE, which is what a reader distinguishes.
      hidden: glyph ? glyph.getAttribute('aria-hidden') === 'true' : null,
      tone: glyph ? getComputedStyle(glyph).color : null,
      shape: glyph ? Array.from(glyph.children).map((c) => c.tagName + ':' + (c.getAttribute('d') || c.getAttribute('r') || '')).join('|') : null,
      text: (row.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 110),
    }
  })

  // Readouts, found by their label word, then measured for a bar/sparkline.
  const readout = (label) => {
    const holder = Array.from(pane.querySelectorAll('div, button')).find((el) => {
      const first = el.firstElementChild
      return first && (first.textContent || '').trim().replace(/\\s*›$/, '') === label && visible(el)
    })
    if (!holder) return null
    const marks = Array.from(holder.querySelectorAll('[role="img"]'))
    return {
      text: (holder.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
      marks: marks.map((m) => ({
        label: m.getAttribute('aria-label'),
        bars: m.children.length,
        height: Math.round(box(m).height),
      })),
    }
  }

  const tabs = Array.from(pane.querySelectorAll('[role="tab"]')).map((t) => (t.textContent || '').trim())
  const groups = Array.from(pane.querySelectorAll('[role="group"]')).map((g) => g.getAttribute('aria-label'))
  const buttons = Array.from(pane.querySelectorAll('button')).map((b) => (b.textContent || '').trim())

  return {
    present: true,
    paneWidth: Math.round(paneBox.width),
    rules,
    tabs,
    groups,
    buttons,
    rowCount: rows.length,
    glyphs,
    composeTop: composer ? Math.round(box(composer).top) : null,
    composeVisible: composer ? visible(composer) : false,
    firstRowTop: firstRow ? Math.round(box(firstRow).top) : null,
    elapsed: readout('Elapsed'),
    diff: readout('Diff'),
    tokens: readout('Tokens'),
    facts: Array.from(pane.querySelectorAll('dt')).map((dt) => ({
      term: (dt.textContent || '').trim(),
      value: (dt.nextElementSibling?.textContent || '').trim(),
    })),
    pointer: (() => {
      const el = Array.from(pane.querySelectorAll('button, div')).find((n) =>
        /open →/.test(n.textContent || '') && visible(n),
      )
      return el ? { tag: el.tagName, text: (el.textContent || '').replace(/\\s+/g, ' ').trim() } : null
    })(),
    text: (pane.textContent || '').replace(/\\s+/g, ' ').trim(),
  }
})()`

async function headings(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('h1,h2,h3'))
      .filter((h) => h.getBoundingClientRect().width > 0)
      .map((h) => h.textContent?.trim())
      .join(' | '),
  )
}

async function click(page, locator) {
  if ((await locator.count()) === 0) return false
  await locator.first().evaluate((el) => {
    el.focus?.()
    el.click()
  })
  await page.waitForTimeout(700)
  return true
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
  const statePath = await seed()
  console.log(`seeded: ${statePath}`)

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

  // "Every field written to the run store before this change is still written
  // after it" — a rendering change must not write to the store at all. The task
  // JSON is snapshotted here and compared byte for byte once the app has opened
  // the run, rendered the pane, and closed.
  const projectionPath = join(workspaceDir, '.multi-code/sprintengine', RUN_SLUG, 'projection.json')
  const taskJsonBefore = JSON.stringify(JSON.parse(await readFile(projectionPath, 'utf8')).tasks)

  let measured = null
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
    await page.locator('input[placeholder="my-workspace"]').first().fill('Task detail pass')
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
      await page.waitForTimeout(2500)
      const hasRail = await page.evaluate(() => Boolean(document.querySelector('[data-context-rail]')))
      if (hasRail) break
    }
    await page.screenshot({ path: join(outDir, '01-sprints-door.png') })

    const opened = await page.evaluate((wanted) => {
      const rail = document.querySelector('[data-context-rail]')
      const candidates = Array.from(rail?.querySelectorAll('button, [role="option"], li') ?? []).filter((el) =>
        (el.textContent || '').includes(wanted),
      )
      const row = candidates[candidates.length - 1]
      if (!row) return false
      row.focus?.()
      row.click()
      return true
    }, RUN_SLUG)
    await page.waitForTimeout(3000)
    check('the seeded run opens on the board', opened, RUN_SLUG)
    await page.screenshot({ path: join(outDir, '02-board.png') })

    // The door opens a run on its Inbox; the task cards live on Tasks.
    await page.evaluate(() => {
      const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((t) =>
        /^Tasks/.test((t.textContent || '').trim()),
      )
      tab?.click()
    })
    await page.waitForTimeout(2000)
    await page.screenshot({ path: join(outDir, '02b-tasks.png') })

    // Select the task. The card is whatever element most tightly wraps the id
    // and title; the click handler may sit on it or on an ancestor, so walk up
    // until the detail pane appears.
    let selected = false
    for (let level = 0; level < 5 && !selected; level += 1) {
      await page.evaluate(
        ({ wanted, level: depth }) => {
          const named = Array.from(document.querySelectorAll('*')).filter((el) => {
            const text = (el.textContent || '').trim()
            const b = el.getBoundingClientRect()
            return (
              b.width > 60
              && b.height > 20
              && b.height < 200
              && text.includes(wanted)
            )
          })
          let node = named[named.length - 1]
          for (let i = 0; i < depth && node?.parentElement; i += 1) node = node.parentElement
          node?.focus?.()
          node?.click()
        },
        { wanted: TASK_TITLE, level },
      )
      await page.waitForTimeout(900)
      selected = await page.evaluate(() => Boolean(document.querySelector('[data-sprintengine-task-detail]')))
    }
    await page.waitForTimeout(1500)
    check('the task detail pane opens', selected)
    await page.screenshot({ path: join(outDir, '03-task-detail.png') })

    measured = await page.evaluate(MEASURE)
  } finally {
    await writeFile(join(outDir, 'transcript.json'), `${JSON.stringify(measured, null, 2)}\n`, 'utf8')
    await app.close()
  }

  const taskJsonAfter = JSON.stringify(JSON.parse(await readFile(projectionPath, 'utf8')).tasks)
  check(
    'every field the run store carried is still there after the pane rendered',
    taskJsonBefore === taskJsonAfter,
    `${taskJsonBefore.length} bytes before, ${taskJsonAfter.length} after`,
  )

  /* ---- assertions over what was painted ------------------------------- */
  const m = measured
  if (!m || !m.present) {
    check('the task detail pane rendered', false, JSON.stringify(m).slice(0, 600))
  } else {
    check(
      'zero divider rules inside the pane',
      m.rules.length === 0,
      JSON.stringify(m.rules).slice(0, 800),
    )
    check(
      'the pane has no filter chips and no tabs',
      m.tabs.length === 0
        && !m.groups.some((g) => /filter/i.test(g || ''))
        && !['All', 'Reviews', 'Status', 'Evidence'].every((label) => m.buttons.includes(label)),
      `tabs=${JSON.stringify(m.tabs)} groups=${JSON.stringify(m.groups)}`,
    )
    check(
      'the compose box sits above the newest entry',
      m.composeVisible && m.firstRowTop !== null && m.composeTop < m.firstRowTop,
      `compose=${m.composeTop} firstRow=${m.firstRowTop}`,
    )
    check(
      'every timeline entry carries a lifecycle glyph, decorative beside its own words',
      m.rowCount > 0 && m.glyphs.every((g) => g.shape) && m.glyphs.every((g) => g.hidden),
      `rows=${m.rowCount} distinctShapes=${new Set(m.glyphs.map((g) => g.shape)).size}`,
    )
    const kinds = {
      comment: m.glyphs.find((g) => /Check the cap is configurable/.test(g.text)),
      status: m.glyphs.find((g) => /published for review/i.test(g.text)),
      review: m.glyphs.find((g) => /logged feedback/i.test(g.text)),
      pr: m.glyphs.find((g) => /pull request/i.test(g.text)),
    }
    const found = Object.entries(kinds).filter(([, g]) => g)
    const shapes = new Set(found.map(([, g]) => g.shape))
    check(
      'comments, status changes, review passes and PR events each carry a DISTINCT glyph',
      found.length === 4 && shapes.size === 4,
      JSON.stringify(Object.fromEntries(found.map(([k, g]) => [k, `${g.tone} ${String(g.shape).slice(0, 44)}`]))),
    )
    check(
      'a run pull request the task committed into appears on its timeline, and another task’s commit does not',
      Boolean(kinds.pr) && !/T21/.test(m.text),
      kinds.pr ? kinds.pr.text : 'no PR entry',
    )
    check(
      'Elapsed renders with a sparkline',
      Boolean(m.elapsed) && m.elapsed.marks.some((mark) => /activity/i.test(mark.label || '') && mark.bars > 1),
      JSON.stringify(m.elapsed),
    )
    check(
      'Diff renders +adds −dels with an add/delete ratio bar',
      Boolean(m.diff) && /\+147/.test(m.diff.text) && /40/.test(m.diff.text)
        && m.diff.marks.some((mark) => /added/.test(mark.label || '') && mark.bars === 2),
      JSON.stringify(m.diff),
    )
    check(
      'Tokens renders as a number with NO bar, and an unmeasured source reads as unmeasured, never 0',
      Boolean(m.tokens) && m.tokens.marks.length === 0 && /unmeasured/i.test(m.tokens.text)
        && !/Tokens\s*0\b/.test(m.tokens.text),
      JSON.stringify(m.tokens),
    )
    check(
      'the three execution facts render',
      ['Repo', 'Modules', 'After'].every((term) => m.facts.some((f) => f.term === term))
        && m.facts.some((f) => f.term === 'Modules' && /webhooks/.test(f.value) && /queue/.test(f.value))
        && m.facts.some((f) => f.term === 'Repo' && /payments-api/.test(f.value))
        && m.facts.some((f) => f.term === 'After' && /T1/.test(f.value)),
      JSON.stringify(m.facts),
    )
    check(
      'the header points at the backlog item with an open affordance',
      Boolean(m.pointer) && /MC-1843/.test(m.pointer.text) && m.pointer.tag === 'BUTTON',
      JSON.stringify(m.pointer),
    )
    check(
      'no description and no acceptance criteria appear anywhere on the pane',
      !m.text.includes(DESCRIPTION_MARKER) && !m.text.includes(ACCEPTANCE_MARKER),
      m.text.slice(0, 200),
    )
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Artifacts in ${outDir}`)
  if (failed.length > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})
