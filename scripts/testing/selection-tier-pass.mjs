#!/usr/bin/env node
// Live selection-tier pass for the design-system conformance epic (T18).
//
// `design-system/patterns/selection.html` allows one focused selection per
// surface: the pane the keyboard is driving paints `--bg-selected`, every other
// pane's remembered choice paints the quieter `--bg-selected-resting`. This
// harness measures that in the built Electron app rather than in the diff.
//
// It A/Bs in one session. `data-selection-pane` is what opts a list into the
// tier, so stripping the attributes reproduces exactly what shipped before —
// every pane at full strength — and putting them back gives the after. Both
// snapshots are computed style read off the rows the app actually painted.
//
// Prereqs: `npm run build` (needs out/main), playwright available:
//   tmp=/tmp/multicode-playwright
//   npm --prefix "$tmp" install playwright --no-audit --no-fund
//   NODE_PATH="$tmp/node_modules:$PWD/node_modules" \
//     node scripts/testing/selection-tier-pass.mjs
//
// Harness trap (recorded by the T15 pass, still true): this shell inherits
// ELECTRON_RENDERER_URL / NODE_ENV_ELECTRON_VITE from a running dev server. Left
// in the environment they make the built main process load the dev renderer from
// the main checkout instead of this branch's build. Both are stripped below.
//
// Screenshots + a JSON transcript land in $MULTICODE_SEL_OUT_DIR.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = resolve(new URL('../..', import.meta.url).pathname)
const tempRoot = process.env.MULTICODE_SEL_TMP_ROOT || '/tmp/multicode-selection-tier'
const workspaceDir = join(tempRoot, 'workspace')
const userDataDir = join(tempRoot, 'user-data')
const outDir = process.env.MULTICODE_SEL_OUT_DIR || join(tempRoot, 'out')

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const transcript = []

/* ------------------------------------------------------------------ *
 * Measurement (serialised into the renderer)
 * ------------------------------------------------------------------ *
 * A pane's tier is read from the rows it painted, not from its markup: the
 * selected row is found by the ARIA state it already carries, and its fill and
 * ink come back as computed sRGB so they can be compared with the resolved
 * token values on the same scale. */

const SNAPSHOT = `(() => {
  const SELECTED = '[aria-current="true"],[aria-current="page"],[aria-selected="true"]'
  const probe = document.createElement('span')
  probe.style.position = 'fixed'
  probe.style.opacity = '0'
  document.body.appendChild(probe)
  const resolve = (name) => {
    probe.style.backgroundColor = 'var(' + name + ')'
    const value = getComputedStyle(probe).backgroundColor
    return value === 'rgba(0, 0, 0, 0)' ? null : value
  }
  const tokens = {
    theme: document.documentElement.getAttribute('data-theme'),
    mode: document.documentElement.getAttribute('data-mode'),
    selected: resolve('--bg-selected'),
    resting: resolve('--bg-selected-resting'),
    textStrong: resolve('--text-strong'),
    textDefault: resolve('--text-default'),
  }
  probe.remove()

  const onScreen = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return false
    return getComputedStyle(el).visibility !== 'hidden'
  }

  // Both the marked panes and the ones this snapshot has switched off, so the
  // before/after pair reads as the same list of panes.
  const panes = Array.from(document.querySelectorAll('[data-selection-pane], [data-selection-pane-off]'))
    .filter(onScreen)
    .map((pane, index) => {
      const rows = Array.from(pane.querySelectorAll(SELECTED)).filter(onScreen)
      const named =
        pane.getAttribute('aria-label') || pane.getAttribute('id') || pane.getAttribute('role')
      return {
        index,
        tier: pane.getAttribute('data-selection-pane') || pane.getAttribute('data-selection-pane-off'),
        // Panes are identified for the reader by what they hold: an unlabelled
        // column means nothing, "Featured" says which list this is.
        label:
          named ||
          (rows[0] ? (rows[0].textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 22) : 'pane ' + index),
        focusWithin: pane.matches(':focus-within'),
        rows: rows.map((row) => {
          const style = getComputedStyle(row)
          // The title is the row's first truncating line; it carries the ink
          // lift that is the selection's second channel.
          const title = row.querySelector('.truncate') || row
          return {
            text: (row.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 34),
            fill: style.backgroundColor,
            titleInk: getComputedStyle(title).color,
          }
        }),
      }
    })

  // Every selected row on screen, pane-marked or not — this is what "exactly one
  // pane paints --bg-selected" has to be counted against.
  const painted = Array.from(document.querySelectorAll(SELECTED))
    .filter(onScreen)
    .filter((row) => getComputedStyle(row).backgroundColor === tokens.selected)
    .map((row) => (row.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 34))

  return { tokens, panes, paintedFullStrength: painted }
})()`

const STRIP_PANES = `(() => {
  const panes = Array.from(document.querySelectorAll('[data-selection-pane]'))
  for (const pane of panes) {
    pane.setAttribute('data-selection-pane-off', pane.getAttribute('data-selection-pane'))
    pane.removeAttribute('data-selection-pane')
  }
  return panes.length
})()`

const RESTORE_PANES = `(() => {
  const panes = Array.from(document.querySelectorAll('[data-selection-pane-off]'))
  for (const pane of panes) {
    pane.setAttribute('data-selection-pane', pane.getAttribute('data-selection-pane-off'))
    pane.removeAttribute('data-selection-pane-off')
  }
  return panes.length
})()`

function describe(snapshot) {
  const lines = []
  for (const pane of snapshot.panes) {
    lines.push(
      `    [${pane.tier}] ${pane.label}  focusWithin=${pane.focusWithin}` +
        (pane.rows.length === 0 ? '  (no selected row on screen)' : ''),
    )
    for (const row of pane.rows) {
      const tier =
        row.fill === snapshot.tokens.selected
          ? 'SELECTED'
          : row.fill === snapshot.tokens.resting
            ? 'resting'
            : 'other'
      lines.push(`        ${tier.padEnd(8)} fill=${row.fill} title=${row.titleInk}  "${row.text}"`)
    }
  }
  return lines.join('\n')
}

// The contract: at most one pane paints the full-strength fill, and it is the
// one holding focus (or the `primary` pane while focus sits outside them all).
function assertOneFocusedSelection(surface, snapshot) {
  const full = snapshot.panes.filter((pane) =>
    pane.rows.some((row) => row.fill === snapshot.tokens.selected),
  )
  const resting = snapshot.panes.filter((pane) =>
    pane.rows.some((row) => row.fill === snapshot.tokens.resting),
  )
  check(
    `${surface}: exactly one pane paints --bg-selected`,
    full.length === 1,
    `${full.length} full-strength [${full.map((p) => p.label).join(', ')}], ` +
      `${resting.length} resting [${resting.map((p) => p.label).join(', ')}]`,
  )
  const focused = snapshot.panes.find((pane) => pane.focusWithin)
  if (focused) {
    check(
      `${surface}: the full-strength pane is the one holding focus`,
      full.length === 1 && full[0].label === focused.label,
      `focus in "${focused.label}", full strength in "${full[0]?.label ?? '(none)'}"`,
    )
  }
  const restingInk = snapshot.panes
    .flatMap((pane) => pane.rows)
    .filter((row) => row.fill === snapshot.tokens.resting)
  check(
    `${surface}: every resting selection drops its title to --text-default`,
    restingInk.length > 0 && restingInk.every((row) => row.titleInk === snapshot.tokens.textDefault),
    `${restingInk.filter((r) => r.titleInk === snapshot.tokens.textDefault).length}/${restingInk.length} ` +
      `at ${snapshot.tokens.textDefault}` +
      (restingInk.length
        ? ''
        : ' — no resting row on screen, so the tier could not be observed'),
  )
  return full
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
      .filter((h) => {
        const r = h.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      })
      .map((h) => (h.textContent || '').trim())
      .join(' | '),
  )
}

async function finishOnboarding(page) {
  await click(page, page.locator('button').filter({ hasText: /^Get started$/ }))
  for (let i = 0; i < 20; i += 1) {
    const heads = await headings(page)
    if (!/Pick a theme|Set up an agent CLI|Add extensions|Bring over|Welcome/i.test(heads)) return true
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

// Focus a pane the way a person does: put focus on its selected row. Falls back
// to the container when the pane's rows are not themselves focusable. Panes are
// addressed by the index the snapshot gave them — most are unlabelled columns.
async function focusPane(page, index) {
  const ok = await page.evaluate((paneIndex) => {
    const onScreen = (el) => {
      const r = el.getBoundingClientRect()
      return r.width >= 1 && r.height >= 1
    }
    const pane = Array.from(document.querySelectorAll('[data-selection-pane]')).filter(onScreen)[
      paneIndex
    ]
    if (!pane) return false
    const row = pane.querySelector('[aria-current="true"],[aria-current="page"],[aria-selected="true"]')
    const target = row && typeof row.focus === 'function' ? row : pane
    if (!target.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) {
      target.setAttribute('tabindex', '-1')
    }
    target.focus()
    return pane.matches(':focus-within')
  }, index)
  await page.waitForTimeout(300)
  return ok
}

async function snapshot(page) {
  return page.evaluate(SNAPSHOT)
}

// The sprint board's Inbox is a list of `InboxRow`s, which is where the ink
// lift can be measured. The run is seeded deliberately inert: no
// `automation.json` (intent defaults to `manual`), every task left at `todo`, no
// locks, and it is only ever opened through the Sprints door — which has no
// resident workspace, so every spawn/resume path is disabled by construction.
const RUN_SLUG = 'selection-tier-demo'

async function seedSprintRun() {
  const runDir = join(workspaceDir, '.multi-code/sprintengine', RUN_SLUG)
  await mkdir(runDir, { recursive: true })
  const now = '2026-07-29T09:00:00.000Z'
  await writeFile(join(runDir, 'run.yaml'), `name: ${RUN_SLUG}\nschema_version: 4\nstatus: active\n`)
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
          name: 'Selection tier demo',
          goal: 'A seeded, inert run so the inbox has InboxRows to measure',
          status: 'active',
          schemaVersion: 4,
          rosterConfigured: true,
          configuredRoles: ['architect', 'developer', 'tester'],
          updatedAt: now,
        },
        tasks,
        roster: agents,
        workers: agents,
        // Two queued artifacts so the board's Inbox — a list of `InboxRow`s —
        // has a selected row and an unselected one to compare.
        artifacts: ['A1', 'A2'].map((id, index) => ({
          id,
          kind: 'design_notes',
          title: index === 0 ? 'Ramp notes for the settings pane' : 'Seam notes for the theme fold',
          path: `docs/notes-${id}.md`,
          status: 'ready_for_review',
          createdBy: 'developer-1',
          taskId: index === 0 ? 'T1' : 'T2',
          fingerprint: null,
          reviewHistory: [],
          recommendedTasks: [],
          createdAt: now,
          updatedAt: now,
        })),
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
    ['one', 'Selection tier item one', 'ready'],
    ['two', 'Selection tier item two', 'idea'],
    ['three', 'Selection tier item three', 'in_progress'],
  ]) {
    await writeFile(
      join(workspaceDir, `backlog/2026-07-29-sel-${slug}.md`),
      `---\nstatus: ${status}\n---\n\n# ${title}\n\nSeeded row for the T18 selection-tier pass.\n`,
    )
  }
  await seedSprintRun()
}

async function main() {
  const { _electron: electron } = require('playwright')
  const electronPath = require('electron')
  await seed()

  const env = { ...process.env }
  delete env.ELECTRON_RENDERER_URL
  delete env.NODE_ENV_ELECTRON_VITE
  delete env.NODE_ENV

  const app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out/main/index.js')],
    cwd: root,
    env: {
      ...env,
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
    // 1440x900 is the review's primary viewport. The window is sized so the web
    // contents land on it exactly, chrome included.
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.setContentSize(1440, 900)
      w.center()
    })
    await page.waitForTimeout(2000)

    const built = await page.evaluate(() => ({
      mode: document.documentElement.getAttribute('data-mode'),
      theme: document.documentElement.getAttribute('data-theme'),
    }))
    check(
      'the built renderer is the one under test (data-mode is stamped)',
      built.mode !== null,
      JSON.stringify(built),
    )

    await finishOnboarding(page)

    console.log('\n=== creating the workspace ===')
    await click(page, page.locator('button').filter({ hasText: /^New Workspace$/ }))
    await page.waitForTimeout(1200)
    await page.locator('input[placeholder="my-workspace"]').first().fill('T18 Selection Tier')
    await page.locator('input[placeholder="/path/to/workspace"]').first().fill(workspaceDir)
    await page.waitForTimeout(500)
    const created =
      (await click(page, page.locator('button').filter({ hasText: /^Skip the rest and create$/ }))) ||
      (await click(page, page.locator('button').filter({ hasText: /^(Create workspace|Create)$/ }).last()))
    await page.waitForTimeout(4000)
    check('a real workspace is created and open', created)
    await page.screenshot({ path: join(outDir, '00-workspace.png') })

    for (const theme of ['dark', 'light']) {
      console.log(`\n\n########## THEME: ${theme} ##########`)
      await page.evaluate((next) => {
        document.documentElement.setAttribute('data-theme', next)
        document.documentElement.setAttribute('data-mode', next)
      }, theme)
      await page.waitForTimeout(400)

      /* ---------------- Surface 1: the Extensions door ---------------- */
      console.log(`\n=== ${theme}: Extensions door ===`)
      await click(page, page.getByRole('button', { name: 'Extensions', exact: true }))
      await page.waitForTimeout(2500)

      await page.evaluate(STRIP_PANES)
      await page.waitForTimeout(200)
      const beforeDoor = await snapshot(page)
      console.log(`  BEFORE (panes off — what shipped):\n${describe(beforeDoor)}`)
      await page.screenshot({ path: join(outDir, `10-extensions-${theme}-before.png`) })
      await page.evaluate(RESTORE_PANES)
      await page.waitForTimeout(200)

      const afterDoor = await snapshot(page)
      console.log(`  AFTER (at rest, focus outside every pane):\n${describe(afterDoor)}`)
      await page.screenshot({ path: join(outDir, `11-extensions-${theme}-after.png`) })
      check(
        `${theme} Extensions: the fill shipped by every pane before the tier existed`,
        beforeDoor.paintedFullStrength.length >= 2,
        `${beforeDoor.paintedFullStrength.length} rows at ${beforeDoor.tokens.selected}: ` +
          beforeDoor.paintedFullStrength.join(' | '),
      )
      assertOneFocusedSelection(`${theme} Extensions (at rest)`, afterDoor)
      transcript.push({ theme, surface: 'extensions', before: beforeDoor, after: afterDoor })

      // Moving focus between panes moves which pane is full strength.
      const moved = []
      for (const pane of afterDoor.panes) {
        if (!(await focusPane(page, pane.index))) {
          console.log(`  focus → "${pane.label}": refused focus, skipped`)
          continue
        }
        const shot = await snapshot(page)
        const full = shot.panes.filter((p) => p.rows.some((r) => r.fill === shot.tokens.selected))
        console.log(`  focus → "${pane.label}":\n${describe(shot)}`)
        moved.push({ pane: pane.label, full: full.map((p) => p.label) })
        check(
          `${theme} Extensions: focus in "${pane.label}" makes it the one full-strength pane`,
          full.length === 1 && full[0].index === pane.index,
          `full strength: ${full.map((p) => p.label).join(', ') || '(none)'}`,
        )
        await page.screenshot({
          path: join(outDir, `12-extensions-${theme}-focus-${pane.label.replace(/\W+/g, '-')}.png`),
        })
      }
      transcript.push({ theme, surface: 'extensions-focus-walk', moved })
      await click(page, page.getByRole('button', { name: /^(Back|Close)$/ }))
      await page.keyboard.press('Escape')
      await page.waitForTimeout(1200)

      /* ---------------- Surface 2: the New-chat composer ---------------- */
      console.log(`\n=== ${theme}: New-chat composer ===`)
      await click(page, page.locator('button').filter({ hasText: /^New chat$/ }).first())
      await page.waitForTimeout(2500)

      await page.evaluate(STRIP_PANES)
      await page.waitForTimeout(200)
      const beforeComposer = await snapshot(page)
      console.log(`  BEFORE (panes off — what shipped):\n${describe(beforeComposer)}`)
      await page.screenshot({ path: join(outDir, `20-composer-${theme}-before.png`) })
      await page.evaluate(RESTORE_PANES)
      await page.waitForTimeout(200)

      const afterComposer = await snapshot(page)
      console.log(`  AFTER:\n${describe(afterComposer)}`)
      await page.screenshot({ path: join(outDir, `21-composer-${theme}-after.png`) })
      check(
        `${theme} composer: the fill shipped by every pane before the tier existed`,
        beforeComposer.paintedFullStrength.length >= 2,
        `${beforeComposer.paintedFullStrength.length} rows at ${beforeComposer.tokens.selected}: ` +
          beforeComposer.paintedFullStrength.join(' | '),
      )
      assertOneFocusedSelection(`${theme} composer`, afterComposer)
      transcript.push({ theme, surface: 'composer', before: beforeComposer, after: afterComposer })

      for (const pane of afterComposer.panes) {
        if (!(await focusPane(page, pane.index))) {
          console.log(`  focus → "${pane.label}": refused focus, skipped`)
          continue
        }
        const shot = await snapshot(page)
        const full = shot.panes.filter((p) => p.rows.some((r) => r.fill === shot.tokens.selected))
        console.log(`  focus → "${pane.label}":\n${describe(shot)}`)
        check(
          `${theme} composer: focus in "${pane.label}" makes it the one full-strength pane`,
          full.length === 1 && full[0].index === pane.index,
          `full strength: ${full.map((p) => p.label).join(', ') || '(none)'}`,
        )
        await page.screenshot({
          path: join(outDir, `22-composer-${theme}-focus-${pane.label.replace(/\W+/g, '-')}.png`),
        })
      }
      await page.keyboard.press('Escape')
      await page.waitForTimeout(1000)
    }

    /* ---------------- F8: the ink lift is a real step ---------------- */
    // Measured on a list of InboxRows: the unselected title has to sit below the
    // selected one, or "selection lifts its title" changes nothing.
    console.log('\n=== the ink lift on an InboxRow list ===')
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark')
      document.documentElement.setAttribute('data-mode', 'dark')
    })
    await click(page, page.getByRole('button', { name: 'Sprints', exact: true }))
    await page.waitForTimeout(2000)
    await click(page, page.getByRole('button', { name: /Selection tier demo/ }))
    await page.waitForTimeout(2000)
    await click(page, page.locator('button[role="tab"]').filter({ hasText: /Inbox/ }))
    await page.waitForTimeout(1500)
    await page.screenshot({ path: join(outDir, '30-sprint-inbox.png') })

    const READ_INBOX_ROWS = `(() => {
      const probe = document.createElement('span')
      probe.style.position = 'fixed'
      probe.style.opacity = '0'
      document.body.appendChild(probe)
      const resolve = (name) => {
        probe.style.color = 'var(' + name + ')'
        return getComputedStyle(probe).color
      }
      const tokens = { strong: resolve('--text-strong'), default: resolve('--text-default') }
      probe.remove()
      const rows = Array.from(document.querySelectorAll('button, div')).filter(
        (n) => typeof n.className === 'string' && n.className.includes('items-start gap-2 px-3 py-2'),
      )
      return {
        tokens,
        rows: rows.map((row) => {
          const title = row.querySelector('.truncate')
          return {
            text: (title?.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30),
            selected: row.getAttribute('aria-current') === 'true',
            titleInk: title ? getComputedStyle(title).color : null,
          }
        }),
      }
    })()`

    const inkBefore = await page.evaluate(READ_INBOX_ROWS)
    console.log('  InboxRow titles: ' + JSON.stringify(inkBefore))
    // Select a row that is not the selected one and re-read, so the lift is
    // observed as a change on the same list rather than across two screens.
    await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('button')).filter(
        (n) => typeof n.className === 'string' && n.className.includes('items-start gap-2 px-3 py-2'),
      )
      const target = rows.find((r) => r.getAttribute('aria-current') !== 'true')
      target?.click()
    })
    await page.waitForTimeout(800)
    const inkAfter = await page.evaluate(READ_INBOX_ROWS)
    console.log('  after selecting another row: ' + JSON.stringify(inkAfter))
    await page.screenshot({ path: join(outDir, '31-sprint-inbox-selected.png') })
    transcript.push({ surface: 'inbox-row-ink', before: inkBefore, after: inkAfter })

    const lifted = inkAfter.rows.filter((r) => r.selected)
    const unlifted = inkAfter.rows.filter((r) => !r.selected)
    check(
      'InboxRow: an unselected title reads --text-default',
      unlifted.length > 0 && unlifted.every((r) => r.titleInk === inkAfter.tokens.default),
      `${unlifted.filter((r) => r.titleInk === inkAfter.tokens.default).length}/${unlifted.length} at ${inkAfter.tokens.default}`,
    )
    check(
      'InboxRow: selecting a row lifts its title to --text-strong',
      lifted.length > 0 && lifted.every((r) => r.titleInk === inkAfter.tokens.strong),
      `${lifted.map((r) => `"${r.text}" ${r.titleInk}`).join(' | ')} vs --text-strong ${inkAfter.tokens.strong}`,
    )

    await writeFile(
      join(outDir, 'selection-tier-transcript.json'),
      JSON.stringify({ checks, transcript }, null, 2),
    )
    console.log(`\nArtifacts in ${outDir}`)
  } finally {
    await app.close()
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
