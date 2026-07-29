#!/usr/bin/env node
// Live Backlog selection pass for the design-system conformance epic (T19).
//
// F1 of docs/reviews/design-system-conformance-ui.md: on a Backlog row that
// carries an identity colour — an epic's hue or a hand-set highlight — the row
// tint was painted instead of the selection fill, so clicking the row moved it
// by 1.06:1 where a plain row moves 1.27:1, and in grayscale it did not move at
// all. This harness measures the step in the built Electron app, on the rows the
// app actually painted, rather than in the diff.
//
// It A/Bs in one session on the same row. The old paint is reconstructed by
// putting the identity fill class back on the selected row and taking the
// token fill off — exactly the two classes the fix swapped — so "before" and
// "after" are the same element, same list, same click.
//
// Prereqs: `npm run build` (needs out/main), playwright available:
//   tmp=/tmp/multicode-playwright
//   npm --prefix "$tmp" install playwright --no-audit --no-fund
//   NODE_PATH="$tmp/node_modules:$PWD/node_modules" \
//     node scripts/testing/backlog-selection-pass.mjs
//
// Harness trap (recorded by the T13/T15/T18 passes, still true): this shell
// inherits ELECTRON_RENDERER_URL / NODE_ENV_ELECTRON_VITE from a running dev
// server. Left in the environment they make the built main process load the dev
// renderer from the main checkout instead of this branch's build. Both are
// stripped below.
//
// Screenshots + a JSON transcript land in $MULTICODE_BACKLOG_SEL_OUT_DIR.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = resolve(new URL('../..', import.meta.url).pathname)
const tempRoot = process.env.MULTICODE_BACKLOG_SEL_TMP_ROOT || '/tmp/multicode-backlog-selection'
const workspaceDir = join(tempRoot, 'workspace')
const userDataDir = join(tempRoot, 'user-data')
const outDir = process.env.MULTICODE_BACKLOG_SEL_OUT_DIR || join(tempRoot, 'out')

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const transcript = []

/* ------------------------------------------------------------------ *
 * Measurement, serialised into the renderer
 * ------------------------------------------------------------------ */

// Contrast is WCAG 2.1 relative luminance, the same scale the T13 review used.
// A row's fill is its *effective* background: an unselected plain row paints
// nothing, so the step has to be measured against the surface showing through it.
// The tint is a \`color-mix(in oklab, …)\`, and getComputedStyle hands that back
// as a raw \`oklab(L a b)\` string. Read naively it is not on the same scale as a
// token's \`rgb()\` and every contrast number computed from it is fiction — the
// trap the T13 review recorded. Every fill below goes through a 1×1 canvas
// first, so a tinted row and a token are compared as sRGB.
const MEASURE_LIB = `
  const swatchCanvas = document.createElement('canvas')
  swatchCanvas.width = swatchCanvas.height = 1
  const swatchCtx = swatchCanvas.getContext('2d', { willReadFrequently: true })
  const toSrgb = (value) => {
    if (!value || /^rgba?\\(/.test(value)) return value
    swatchCtx.fillStyle = '#000000'
    swatchCtx.fillStyle = value
    swatchCtx.fillRect(0, 0, 1, 1)
    const d = swatchCtx.getImageData(0, 0, 1, 1).data
    return 'rgb(' + d[0] + ', ' + d[1] + ', ' + d[2] + ')'
  }
  const parse = (value) => (value.match(/[\\d.]+/g) || ['0','0','0']).slice(0, 3).map(Number)
  const chan = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
  const luminance = (rgb) => 0.2126 * chan(rgb[0]) + 0.7152 * chan(rgb[1]) + 0.0722 * chan(rgb[2])
  const contrast = (a, b) => {
    const la = luminance(parse(a)), lb = luminance(parse(b))
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  }
  // What \`filter: grayscale(1)\` leaves: the luma-weighted grey. Two fills that
  // land on the same grey are indistinguishable with colour removed.
  const grayscale = (value) => {
    const [r, g, b] = parse(value)
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return 'rgb(' + [y, y, y].map((c) => Math.round(c)).join(', ') + ')'
  }
  const effectiveFill = (el) => {
    let node = el
    while (node) {
      const bg = getComputedStyle(node).backgroundColor
      if (bg && bg !== 'transparent' && !/rgba\\(0, 0, 0, 0\\)/.test(bg)) return toSrgb(bg)
      node = node.parentElement
    }
    return 'rgb(0, 0, 0)'
  }
  const rowOf = (needle) =>
    Array.from(document.querySelectorAll('li[role="option"]')).find((li) =>
      (li.textContent || '').includes(needle),
    ) || null
  const describeRow = (li) => li && ({
    text: (li.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40),
    selected: li.getAttribute('aria-selected') === 'true',
    fill: effectiveFill(li),
    ownFill: toSrgb(getComputedStyle(li).backgroundColor),
    bar: toSrgb(getComputedStyle(li).borderLeftColor),
    barWidth: getComputedStyle(li).borderLeftWidth,
  })
`

// One row's resting → selected step. `needle` picks the row by its title; the
// row is read at rest, clicked, and read again, so the pair is one row and one
// click rather than two rows compared across the list.
const stepScript = (needle) => `(() => {
  ${MEASURE_LIB}
  const li = rowOf(${JSON.stringify(needle)})
  if (!li) return { error: 'row not found: ' + ${JSON.stringify(needle)} }
  const resting = describeRow(li)
  li.click()
  return { resting }
})()`

const readSelectedScript = (needle, neighbourNeedle) => `(() => {
  ${MEASURE_LIB}
  const li = rowOf(${JSON.stringify(needle)})
  const neighbour = ${neighbourNeedle ? `rowOf(${JSON.stringify(neighbourNeedle)})` : 'null'}
  if (!li) return { error: 'row not found' }
  const selected = describeRow(li)
  return {
    selected,
    neighbour: neighbour ? describeRow(neighbour) : null,
  }
})()`

// Reconstruct the shipped-before paint on the same selected row: the identity
// fill class back on, the selection token off. `swap` names the highlight class
// the old code would have painted (utils/highlight.ts `swatch.bg`).
//
// The swap and the read are separate steps on purpose. The row carries
// `transition-colors`, so a computed style read in the same turn as the class
// change returns the colour it is transitioning *from* — which silently reports
// the before and after as identical.
const swapPaintScript = (needle, swap) => `(() => {
  const li = Array.from(document.querySelectorAll('li[role="option"]')).find((n) =>
    (n.textContent || '').includes(${JSON.stringify(needle)}),
  )
  if (!li) return false
  li.classList.remove('bg-[color:var(--bg-selected)]')
  li.classList.add(${JSON.stringify(swap)})
  return li.className
})()`

const restorePaintScript = (needle, swap) => `(() => {
  const li = Array.from(document.querySelectorAll('li[role="option"]')).find((n) =>
    (n.textContent || '').includes(${JSON.stringify(needle)}),
  )
  if (!li) return false
  li.classList.remove(${JSON.stringify(swap)})
  li.classList.add('bg-[color:var(--bg-selected)]')
  return true
})()`

const readRowScript = (needle) => `(() => {
  ${MEASURE_LIB}
  const li = rowOf(${JSON.stringify(needle)})
  return li ? describeRow(li) : { error: 'row not found' }
})()`

const tokensScript = `(() => {
  ${MEASURE_LIB}
  const probe = document.createElement('span')
  probe.style.position = 'fixed'
  probe.style.opacity = '0'
  document.body.appendChild(probe)
  const token = (name) => {
    probe.style.backgroundColor = 'var(' + name + ')'
    return getComputedStyle(probe).backgroundColor
  }
  const out = {
    theme: document.documentElement.getAttribute('data-theme'),
    mode: document.documentElement.getAttribute('data-mode'),
    selected: token('--bg-selected'),
    resting: token('--bg-selected-resting'),
    surface: token('--bg-surface'),
  }
  probe.remove()
  return out
})()`

function ratio(a, b) {
  const parse = (value) => (value.match(/[\d.]+/g) || ['0', '0', '0']).slice(0, 3).map(Number)
  const chan = (c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const lum = (rgb) => 0.2126 * chan(rgb[0]) + 0.7152 * chan(rgb[1]) + 0.0722 * chan(rgb[2])
  const la = lum(parse(a))
  const lb = lum(parse(b))
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function grayOf(value) {
  const parse = (v) => (v.match(/[\d.]+/g) || ['0', '0', '0']).slice(0, 3).map(Number)
  const [r, g, b] = parse(value)
  const y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
  return `rgb(${y}, ${y}, ${y})`
}

/* ------------------------------------------------------------------ *
 * App driving
 * ------------------------------------------------------------------ */

async function click(page, locator) {
  if ((await locator.count()) === 0) return false
  await locator.first().evaluate((el) => el.click())
  await page.waitForTimeout(700)
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

/* ------------------------------------------------------------------ *
 * Seed: one coloured epic with members, plus plain rows to compare against
 * ------------------------------------------------------------------ */

const EPIC_SLUG = 'tinted-epic'
const MEMBER = 'Member row inside the tinted epic'
const MEMBER_2 = 'Second member of the tinted epic'
const PLAIN = 'Plain row with no colour at all'
const PLAIN_2 = 'Second plain row with no colour'
const HAND_SET = 'Row the user highlighted by hand'

async function seed() {
  await rm(tempRoot, { recursive: true, force: true })
  await mkdir(join(workspaceDir, 'backlog/epics'), { recursive: true })
  await mkdir(userDataDir, { recursive: true })
  await mkdir(outDir, { recursive: true })
  await writeFile(
    join(workspaceDir, `backlog/epics/${EPIC_SLUG}.md`),
    `---\ntype: epic\nstatus: in_progress\ncolor: purple\n---\n\n# Tinted epic\n\nAn epic with an identity colour, so its members carry the full-row tint.\n`,
  )
  const items = [
    [`${EPIC_SLUG}-one`, MEMBER, `epic: ${EPIC_SLUG}\n`],
    [`${EPIC_SLUG}-two`, MEMBER_2, `epic: ${EPIC_SLUG}\n`],
    ['plain-one', PLAIN, ''],
    ['plain-two', PLAIN_2, ''],
    ['hand-set', HAND_SET, ''],
  ]
  for (const [slug, title, extra] of items) {
    await writeFile(
      join(workspaceDir, `backlog/2026-07-29-${slug}.md`),
      `---\nstatus: ready\n${extra}---\n\n# ${title}\n\nSeeded row for the T19 Backlog selection pass.\n`,
    )
  }
}

/* ------------------------------------------------------------------ *
 * The pass
 * ------------------------------------------------------------------ */

// Select `needle`, measure the resting → selected step, then reconstruct the
// pre-fix paint on the same row and measure that step too.
async function measureRow(page, { label, needle, neighbour, oldFillClass }) {
  const rest = await page.evaluate(stepScript(needle))
  if (rest.error) {
    check(`${label}: row is on screen`, false, rest.error)
    return null
  }
  await page.waitForTimeout(500)
  const now = await page.evaluate(readSelectedScript(needle, neighbour))
  if (now.error || !now.selected.selected) {
    check(`${label}: the click selected the row`, false, JSON.stringify(now))
    return null
  }
  const after = ratio(rest.resting.fill, now.selected.fill)
  const result = {
    label,
    resting: rest.resting.fill,
    selected: now.selected.fill,
    bar: now.selected.bar,
    barWidth: now.selected.barWidth,
    neighbour: now.neighbour ? now.neighbour.fill : null,
    afterStep: after,
    grayscaleStep: now.neighbour ? ratio(grayOf(now.selected.fill), grayOf(now.neighbour.fill)) : null,
  }
  if (oldFillClass) {
    const swapped = await page.evaluate(swapPaintScript(needle, oldFillClass))
    await page.waitForTimeout(600)
    const before = await page.evaluate(readRowScript(needle))
    await page.evaluate(restorePaintScript(needle, oldFillClass))
    await page.waitForTimeout(600)
    if (!swapped || before.error) {
      check(`${label}: the pre-fix paint could be reconstructed`, false, JSON.stringify({ swapped, before }))
    } else {
      result.beforeSelected = before.fill
      result.beforeStep = ratio(rest.resting.fill, before.fill)
      result.beforeGrayscaleStep = now.neighbour
        ? ratio(grayOf(before.fill), grayOf(now.neighbour.fill))
        : null
    }
  }
  console.log(`  ${label}: ${result.resting} -> ${result.selected}  step ${result.afterStep.toFixed(3)}:1` +
    (result.beforeStep ? `   (before the fix: -> ${result.beforeSelected}  step ${result.beforeStep.toFixed(3)}:1)` : '') +
    (result.grayscaleStep ? `   grayscale vs neighbour ${result.grayscaleStep.toFixed(3)}:1` : ''))
  return result
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
    await page.locator('input[placeholder="my-workspace"]').first().fill('T19 Backlog Selection')
    await page.locator('input[placeholder="/path/to/workspace"]').first().fill(workspaceDir)
    await page.waitForTimeout(500)
    const created =
      (await click(page, page.locator('button').filter({ hasText: /^Skip the rest and create$/ }))) ||
      (await click(page, page.locator('button').filter({ hasText: /^(Create workspace|Create)$/ }).last()))
    await page.waitForTimeout(4000)
    check('a real workspace is created and open', created)

    console.log('\n=== opening the Backlog door ===')
    await click(page, page.getByRole('button', { name: 'Backlog', exact: true }))
    await page.waitForTimeout(2500)
    const rowCount = await page.locator('li[role="option"]').count()
    check('the Backlog door lists the seeded rows', rowCount >= 5, `${rowCount} rows`)
    await page.screenshot({ path: join(outDir, '00-backlog-door.png') })

    // A hand-set highlight, set the way a user sets one: right-click the row,
    // pick a swatch. This is the second `litFill` case and must select the same
    // way an epic member does.
    console.log('\n=== hand-setting a highlight through the context menu ===')
    const handRow = page.locator('li[role="option"]').filter({ hasText: HAND_SET }).first()
    await handRow.click({ button: 'right' })
    await page.waitForTimeout(700)
    const picked = await click(page, page.getByRole('menuitemradio', { name: 'Highlight Blue' }))
    await page.waitForTimeout(900)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    check('a hand-set highlight can be applied from the row menu', picked)

    for (const theme of ['dark', 'light']) {
      console.log(`\n\n########## THEME: ${theme} ##########`)
      await page.evaluate((next) => {
        document.documentElement.setAttribute('data-theme', next)
        document.documentElement.setAttribute('data-mode', next)
      }, theme)
      await page.waitForTimeout(500)
      const tokens = await page.evaluate(tokensScript)
      console.log(`  tokens: ${JSON.stringify(tokens)}`)

      const plain = await measureRow(page, { label: `${theme} plain row`, needle: PLAIN, neighbour: PLAIN_2 })
      await page.screenshot({ path: join(outDir, `10-${theme}-plain-selected.png`) })
      const epic = await measureRow(page, {
        label: `${theme} epic-member row`,
        needle: MEMBER,
        neighbour: MEMBER_2,
        oldFillClass: 'highlight-bg-purple',
      })
      await page.screenshot({ path: join(outDir, `11-${theme}-epic-selected.png`) })
      const hand = await measureRow(page, {
        label: `${theme} hand-highlighted row`,
        needle: HAND_SET,
        neighbour: MEMBER_2,
        oldFillClass: 'highlight-bg-blue',
      })
      await page.screenshot({ path: join(outDir, `12-${theme}-hand-selected.png`) })

      // The grayscale frame the review called out: with colour removed, the
      // selected row still has to read as the picked one.
      await page.evaluate(() => {
        document.documentElement.style.filter = 'grayscale(1)'
      })
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(outDir, `13-${theme}-grayscale.png`) })
      await page.evaluate(() => {
        document.documentElement.style.filter = ''
      })
      await page.waitForTimeout(300)

      transcript.push({ theme, tokens, plain, epic, hand })
      if (!plain || !epic || !hand) continue

      // The acceptance bar: the lit row's step is within 10% of a plain row's.
      // The A/B is only worth reading if the reconstructed old paint actually
      // reproduces F1 — otherwise the "before" column is measuring the fix.
      check(
        `${theme}: the reconstructed pre-fix paint reproduces the defect`,
        (epic.beforeStep ?? 9) <= 1.1 && (epic.beforeGrayscaleStep ?? 9) <= 1.1,
        `pre-fix the epic row stepped ${epic.beforeStep?.toFixed(3)}:1 (${epic.beforeGrayscaleStep?.toFixed(3)}:1 in grayscale) ` +
          `to ${epic.beforeSelected}`,
      )
      const drift = Math.abs(epic.afterStep - plain.afterStep) / plain.afterStep
      check(
        `${theme}: the epic-member row's selection step matches a plain row's within 10%`,
        drift <= 0.1,
        `epic ${epic.afterStep.toFixed(3)}:1 vs plain ${plain.afterStep.toFixed(3)}:1 (${(drift * 100).toFixed(1)}% apart; ` +
          `before the fix the epic row stepped ${epic.beforeStep?.toFixed(3)}:1)`,
      )
      const handDrift = Math.abs(hand.afterStep - epic.afterStep) / epic.afterStep
      check(
        `${theme}: a hand-set highlight selects the same as an epic member — the fix is not epic-only`,
        handDrift <= 0.1 && hand.selected === epic.selected,
        `hand ${hand.afterStep.toFixed(3)}:1 at ${hand.selected} vs epic ${epic.afterStep.toFixed(3)}:1 at ${epic.selected}`,
      )
      check(
        `${theme}: the selected epic row is distinguishable from its unselected neighbour in grayscale`,
        (epic.grayscaleStep ?? 1) >= 1.1,
        `${epic.grayscaleStep?.toFixed(3)}:1 with colour removed (before the fix: ${epic.beforeGrayscaleStep?.toFixed(3)}:1)`,
      )
      check(
        `${theme}: the 3px epic identity bar still renders on the selected row`,
        epic.barWidth === '3px' && !/rgba\(0, 0, 0, 0\)/.test(epic.bar),
        `${epic.barWidth} ${epic.bar}`,
      )
      // The tint is not removed, only outranked: an unpicked member still carries it.
      check(
        `${theme}: an unselected epic member still carries the full-row tint`,
        epic.neighbour !== tokens.surface && epic.neighbour !== epic.selected,
        `neighbour ${epic.neighbour}, plain surface ${tokens.surface}`,
      )
    }


    // The resting tier reaches the Backlog list too: a selected row in a pane
    // that is not driving the keyboard drops to --bg-selected-resting. Painting
    // the token instead of a baked tint is what makes an epic row obey it.
    console.log('\n=== the resting tier on a lit row ===')
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark')
      document.documentElement.setAttribute('data-mode', 'dark')
    })
    await page.waitForTimeout(400)
    const restingTier = await page.evaluate(`(() => {
      ${MEASURE_LIB}
      const li = rowOf(${JSON.stringify(MEMBER)})
      if (!li) return { error: 'row not found' }
      li.click()
      const pane = li.closest('[data-selection-pane]')
      return { pane: pane ? pane.getAttribute('data-selection-pane') : null }
    })()`)
    await page.waitForTimeout(500)
    const tierFills = await page.evaluate(`(() => {
      ${MEASURE_LIB}
      const probe = document.createElement('span')
      probe.style.position = 'fixed'
      probe.style.opacity = '0'
      document.body.appendChild(probe)
      const token = (name) => { probe.style.backgroundColor = 'var(' + name + ')'; return getComputedStyle(probe).backgroundColor }
      const out = { selected: token('--bg-selected'), resting: token('--bg-selected-resting') }
      probe.remove()
      const li = rowOf(${JSON.stringify(MEMBER)})
      return { ...out, fill: li ? effectiveFill(li) : null }
    })()`)
    console.log(`  pane=${JSON.stringify(restingTier)} fills=${JSON.stringify(tierFills)}`)
    check(
      'a selected epic row paints a selection token, so the resting tier can reach it',
      tierFills.fill === tierFills.selected || tierFills.fill === tierFills.resting,
      `row ${tierFills.fill}, --bg-selected ${tierFills.selected}, --bg-selected-resting ${tierFills.resting}`,
    )
    transcript.push({ surface: 'resting-tier', restingTier, tierFills })

    /* ---------------- The epic group header row ---------------- */
    // Headers only render with the Group axis on, which is why the T13 review
    // never saw this row: the door's header painted --accent-primary-soft when
    // selected, spending the brand accent on being chosen.
    console.log('\n=== the epic group header row ===')
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark')
      document.documentElement.setAttribute('data-mode', 'dark')
    })
    await page.waitForTimeout(400)
    await click(page, page.getByRole('button', { name: /^Filter and sort/ }))
    await page.waitForTimeout(700)
    const groupedOn = await click(page, page.getByRole('menuitemradio', { name: 'By epic', exact: true }))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1500)
    // A header is a `role="option"` that owns the collapse chevron; the epic's
    // own item row carries a timestamp instead. Distinguishing them matters:
    // measuring the item row here would report a pass for a row this fix does
    // not touch.
    const header = await page.evaluate(`(() => {
      ${MEASURE_LIB}
      const probe = document.createElement('span')
      probe.style.position = 'fixed'
      probe.style.opacity = '0'
      document.body.appendChild(probe)
      const token = (name) => { probe.style.backgroundColor = 'var(' + name + ')'; return toSrgb(getComputedStyle(probe).backgroundColor) }
      const tokens = { selected: token('--bg-selected'), accentSoft: token('--accent-primary-soft'), accent: token('--accent-primary') }
      probe.remove()
      const li = Array.from(document.querySelectorAll('li[role="option"]')).find(
        (n) => (n.textContent || '').includes('Tinted epic') && n.querySelector('[aria-expanded]'),
      )
      if (!li) return { error: 'no group header on screen', tokens }
      li.id = 't19-group-header'
      li.click()
      return { tokens, text: (li.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40) }
    })()`)
    await page.waitForTimeout(800)
    const headerAfter = await page.evaluate(`(() => {
      ${MEASURE_LIB}
      const li = document.getElementById('t19-group-header')
      return li ? describeRow(li) : { error: 'header lost' }
    })()`)
    console.log(`  group header: ${JSON.stringify(header)} -> ${JSON.stringify(headerAfter)}`)
    await page.screenshot({ path: join(outDir, '20-dark-group-header-selected.png') })
    check(
      'the Group axis is on, so an epic group header renders',
      groupedOn && !header.error && !headerAfter.error,
      `${header.error || headerAfter.error || `header "${header.text}"`}`,
    )
    if (!header.error && !headerAfter.error) {
      check(
        'a selected epic group header paints the neutral selection fill, never the accent',
        headerAfter.fill === header.tokens.selected,
        `header ${headerAfter.fill}, --bg-selected ${header.tokens.selected}, --accent-primary-soft ${header.tokens.accentSoft}`,
      )
      check(
        'the group header keeps the epic hue in its 3px bar',
        headerAfter.barWidth === '3px' && !/rgba\(0, 0, 0, 0\)/.test(headerAfter.bar),
        `${headerAfter.barWidth} ${headerAfter.bar}`,
      )
    }
    transcript.push({ surface: 'group-header', header, headerAfter })

    await writeFile(
      join(outDir, 'backlog-selection-transcript.json'),
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
