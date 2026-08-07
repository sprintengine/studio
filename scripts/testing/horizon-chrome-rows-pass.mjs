#!/usr/bin/env node
// Rendered pass for MC-2067: the Horizon door must spend ONE chrome row before
// its content.
//
// The item's acceptance is measured on the running app, at the owner's window
// size — "one chrome row above the horizon's content" is a geometry claim, and
// reading it off the source is exactly how three stacked bands survived a
// density sweep. So this drives the built main process against THIS worktree's
// renderer and measures bands, not class names.
//
// A band is a distinct vertical run of laid-out, text-bearing chrome. The
// failure this pass exists to catch had three of them before any content:
//   1. the door bar (name · Saved · options · Make active) — the one that stays
//   2. `MC-1713 · 9d ago`, then the item title, then a stranded `⋯` — three
//      sub-bands inside the detail header alone
//   3. `Children 29`, then `3 of 29 done`, then a progress bar
//
// Two traps inherited from `context-rail-door-pass.mjs`, both still live:
//   • The BUILT renderer hides Horizon — it is on DEV_ONLY_MODULE_IDS, gated by
//     `import.meta.env.DEV`. Measuring the Horizon door off `out/renderer`
//     measures nothing at all, so this serves this worktree's renderer from its
//     own vite dev server and points ELECTRON_RENDERER_URL at it. Any inherited
//     value (a user's own dev server, on another checkout) is overwritten.
//   • A programmatic `.click()` does not focus its target; a real pointer click
//     does. Rail rows are driven through `activate` for that reason.
//
// The horizon itself is seeded on disk rather than built through the UI: the
// home project is a main-owned scalar (`<userData>/roadmap-home.json`) and the
// plan is a markdown file in that project, so both are seedable and neither
// needs the create/track/drag flow this pass is not measuring.
//
// Prereqs: `npm run build` (out/main + out/preload), playwright available:
//   tmp=/tmp/multicode-playwright
//   npm --prefix "$tmp" install playwright --no-audit --no-fund
//   NODE_PATH="$tmp/node_modules:$PWD/node_modules" \
//     node scripts/testing/horizon-chrome-rows-pass.mjs
//
// Screenshots + a JSON transcript land in $MULTICODE_HORIZON_OUT_DIR.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = resolve(new URL('../..', import.meta.url).pathname)
const tempRoot = process.env.MULTICODE_HORIZON_TMP_ROOT || '/tmp/multicode-horizon-chrome'
const workspaceDir = join(tempRoot, 'workspace')
const userDataDir = join(tempRoot, 'user-data')
const outDir = process.env.MULTICODE_HORIZON_OUT_DIR || join(tempRoot, 'out')
const rendererPort = Number(process.env.MULTICODE_HORIZON_RENDERER_PORT || 5397)
// The owner's screenshot was taken on a full-height window; the complaint is
// that the chrome took "roughly a third of the viewport height", so the pass
// measures at a real window size rather than a tall synthetic one.
const WINDOW = { width: 1440, height: 900 }

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const transcript = {}

/* ------------------------------------------------------------------ *
 * The measurement, in the renderer
 * ------------------------------------------------------------------ */

// Chrome bands above the horizon's content, read as geometry.
//
// `bandsOf` clusters an element's text-bearing leaves by their vertical extent:
// two leaves that overlap vertically are one band, two that do not are two. That
// is the reader's own test — "how many lines of chrome do I scroll past" — and
// it cannot be satisfied by moving a `border-b` or renaming a class.
const MEASURE = `(() => {
  const surface = document.querySelector('section[aria-label="Horizon"]')
  const laidOut = (node) => {
    if (!node) return false
    const r = node.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && node.offsetParent !== null
  }
  // Leaves that actually paint something a reader counts as a line: text, or a
  // control. A wrapper whose whole content is one child is not its own band.
  const leavesOf = (node) => {
    const out = []
    const walk = (el) => {
      if (!laidOut(el)) return
      const kids = Array.from(el.children)
      const own = Array.from(el.childNodes).some(
        (n) => n.nodeType === 3 && (n.textContent || '').trim().length > 0,
      )
      if (kids.length === 0 || own) { out.push(el); return }
      for (const kid of kids) walk(kid)
    }
    walk(node)
    return out
  }
  const bandsOf = (node) => {
    if (!node) return []
    const rects = leavesOf(node)
      .map((el) => ({
        top: Math.round(el.getBoundingClientRect().top),
        bottom: Math.round(el.getBoundingClientRect().bottom),
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
      }))
      .sort((a, b) => a.top - b.top)
    const bands = []
    for (const rect of rects) {
      const last = bands[bands.length - 1]
      // Overlapping vertical extents are the same visual line. A 2px slack
      // absorbs baseline nudges (the glyph's mt-0.5) without merging rows.
      if (last && rect.top < last.bottom - 2) {
        last.bottom = Math.max(last.bottom, rect.bottom)
        last.texts.push(rect.text)
      } else {
        bands.push({ top: rect.top, bottom: rect.bottom, texts: [rect.text] })
      }
    }
    return bands
  }

  // Every laid-out h2, placed. The door's bar is PORTALED into the app's top
  // strip, so it is in neither the surface region nor the rail column; the
  // rail's own track headings are h2s too, and are not bars.
  const surfaceTop = surface ? surface.getBoundingClientRect().top : 0
  const headings = Array.from(document.querySelectorAll('h2'))
    .filter(laidOut)
    .map((h) => ({
      el: h,
      text: (h.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
      inRail: h.closest('[data-context-rail]') !== null,
      inSurface: h.closest('section[aria-label="Horizon"]') !== null,
      // The app's top strip is the band ABOVE the surface region. A heading
      // elsewhere in the shell (the workspace region's own landmark) is not a
      // bar over this door and must not be counted as one.
      aboveSurface: h.getBoundingClientRect().bottom <= surfaceTop + 2,
    }))
  const barHeadings = headings.filter((h) => !h.inRail && !h.inSurface && h.aboveSurface)
  const barTitle = barHeadings[0] ? barHeadings[0].el : null
  const barRow = barTitle ? barTitle.parentElement : null

  const header = surface ? surface.querySelector('header') : null
  const title = header ? header.querySelector('h3') : null
  const moreActions = header
    ? header.querySelector('button[aria-label="More actions"]')
    : null
  const childrenHeading = surface
    ? Array.from(surface.querySelectorAll('h4')).find((h) => (h.textContent || '').trim().startsWith('Children'))
    : null
  const childrenSection = childrenHeading ? childrenHeading.closest('section') : null
  const meter = childrenSection
    ? childrenSection.querySelector('[role="img"][aria-label$="complete"]')
    : null
  const firstChildRow = childrenSection ? childrenSection.querySelector('ul li') : null

  const rect = (node) => {
    if (!laidOut(node)) return null
    const r = node.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }
  }
  const sameBand = (a, b) => {
    if (!a || !b) return false
    return a.top < b.bottom - 2 && b.top < a.bottom - 2
  }

  const titleRect = rect(title)
  const moreRect = rect(moreActions)
  const headingRect = rect(childrenHeading)
  const meterRect = rect(meter)
  const surfaceText = (surface ? surface.textContent || '' : '').replace(/\\s+/g, ' ')

  return {
    hasSurface: Boolean(surface),
    barRow: rect(barRow),
    barText: barRow ? (barRow.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : null,
    header: rect(header),
    headerBands: bandsOf(header).map((b) => ({ top: b.top, bottom: b.bottom, texts: b.texts })),
    titleRect,
    moreRect,
    titleAndMoreShareARow: sameBand(titleRect, moreRect),
    titleWidth: title ? Math.round(title.getBoundingClientRect().width) : 0,
    paneWidth: header ? Math.round(header.getBoundingClientRect().width) : 0,
    // The crumb: id and relative time. They must be ON the title's line now.
    crumbOnTitleRow: (() => {
      if (!header || !titleRect) return false
      const crumb = Array.from(header.querySelectorAll('span')).find((s) =>
        /^([A-Za-z]{2,8}-\\d+|[\\w.-]+\\.md)$/.test((s.textContent || '').trim()),
      )
      return sameBand(titleRect, rect(crumb))
    })(),
    childrenHeadingRect: headingRect,
    childrenMeterRect: meterRect,
    childrenMeterLabel: meter ? meter.getAttribute('aria-label') : null,
    childrenHeadingAndMeterShareARow: sameBand(headingRect, meterRect),
    childrenSectionBandsAboveFirstRow: (() => {
      if (!childrenSection || !firstChildRow) return null
      const top = firstChildRow.getBoundingClientRect().top
      return bandsOf(childrenSection).filter((b) => b.bottom <= top + 2).length
    })(),
    // The three-ways-one-thing readout the item names. A count chip beside the
    // heading and a "N of M done" sentence both have to be gone.
    saysDoneSentence: / of \\d+ done/.test(surfaceText),
    // Announced, not merely visible: the save state is a live region.
    saveLiveRegion: (() => {
      const live = Array.from(document.querySelectorAll('[aria-live="polite"]')).filter(laidOut)
      return live.map((el) => (el.textContent || '').trim()).filter(Boolean)
    })(),
    makeActive: Boolean(
      Array.from(document.querySelectorAll('button')).find(
        (b) => laidOut(b) && (b.textContent || '').trim() === 'Make active',
      ),
    ),
    // A door renders its bar through a PORTAL into the host strip; a bar
    // rendered inline as well is the two-stacked-bars regression this item's
    // trap names. The rail is portaled into the SIDEBAR column and carries its
    // own track headings, so it is excluded — those are rail rows, not bars.
    headings: headings.map(({ el, ...rest }) => rest),
    barHeadings: barHeadings.map(({ el, ...rest }) => rest),
    // The inline fallback bar renders INSIDE the surface region; the portaled
    // one does not. Both at once is the two-stacked-bars failure the item's
    // trap names.
    surfaceHasInlineBar: headings.some((h) => h.inSurface),
  }
})()`

// The same measurement, aimed at whichever door mounts the shared pane.
const measureFor = (label) => MEASURE.replaceAll('section[aria-label="Horizon"]', `section[aria-label="${label}"]`)

/* ------------------------------------------------------------------ *
 * Seeding
 * ------------------------------------------------------------------ */

const EPIC_SLUG = 'post-merge-hardening'
const CHILD_COUNT = 29
const DONE_COUNT = 3

async function seed() {
  await rm(tempRoot, { recursive: true, force: true })
  await mkdir(join(workspaceDir, 'backlog/epics'), { recursive: true })
  await mkdir(join(workspaceDir, 'backlog/roadmaps'), { recursive: true })
  await mkdir(userDataDir, { recursive: true })
  await mkdir(outDir, { recursive: true })

  await writeFile(
    join(workspaceDir, `backlog/epics/${EPIC_SLUG}.md`),
    '---\ntype: epic\nstatus: in_progress\ncolor: purple\n---\n\n'
      + '# Post-merge hardening: July 15–20 landings\n\n'
      + 'The owner’s screenshot: a horizon step that is an epic with a large child set.\n',
  )
  // 29 children, 3 completed — the exact roll-up the screenshot shows.
  for (let i = 0; i < CHILD_COUNT; i += 1) {
    const status = i < DONE_COUNT ? 'completed' : 'ready'
    await writeFile(
      join(workspaceDir, `backlog/2026-07-1${i % 10}-hardening-${i}.md`),
      `---\nstatus: ${status}\nepic: ${EPIC_SLUG}\n---\n\n# Hardening item ${i + 1}\n\nSeeded child for the MC-2067 chrome-row pass.\n`,
    )
  }
  // The plan: one track holding the epic as its single step. `status: idea` is a
  // DRAFT, which is the state the owner's screenshot was in — its bar carries
  // "Make active", the acceptance criterion that must survive the condense.
  await writeFile(
    join(workspaceDir, 'backlog/roadmaps/2026-08-06-mc-2067.md'),
    '---\ntype: roadmap\nstatus: idea\nadvance: approve\nmerge: manual\n---\n\n'
      + `## Hardening\n- backlog/epics/${EPIC_SLUG}.md\n`,
  )
  // The home project — a main-owned scalar, so the door finds the plan without
  // the create flow.
  await writeFile(
    join(userDataDir, 'roadmap-home.json'),
    `${JSON.stringify({ path: workspaceDir }, null, 2)}\n`,
  )
}

/* ------------------------------------------------------------------ *
 * This worktree's renderer, on its own port
 * ------------------------------------------------------------------ */

async function startRenderer() {
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const tailwindcss = (await import('@tailwindcss/vite')).default
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

// Poll for a live window on the renderer under test. `firstWindow()` answers with
// whatever opened first, which during boot can be a window the shell then closes.
async function resolveRendererPage(app, rendererUrl) {
  const deadline = Date.now() + 30_000
  let last = null
  for (;;) {
    for (const candidate of app.windows()) {
      if (candidate.isClosed()) continue
      last = candidate
      let url = ''
      try {
        url = candidate.url()
      } catch {
        continue
      }
      if (url.startsWith(rendererUrl)) return candidate
    }
    if (Date.now() > deadline) {
      if (last && !last.isClosed()) return last
      throw new Error('no renderer window opened within 30s')
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

async function main() {
  const { _electron: electron } = require('playwright')
  const electronPath = require('electron')
  await seed()
  const renderer = await startRenderer()
  const rendererUrl = `http://localhost:${rendererPort}`
  console.log(`renderer dev server (this worktree): ${rendererUrl}`)

  // Boot is flaky in a way that has nothing to do with what this measures: the
  // shell sometimes tears down its first window while playwright is holding it,
  // and every later call then fails with "target page has been closed". Relaunch
  // rather than report a product failure that is really a harness one.
  const launch = () =>
    electron.launch({
      executablePath: electronPath,
      args: [join(root, 'out/main/index.js')],
      cwd: root,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: rendererUrl,
        MULTICODE_USER_DATA_DIR: userDataDir,
        MULTICODE_ALLOW_MULTI_INSTANCE: '1',
        MULTICODE_TEST_OPEN_DIR: workspaceDir,
      },
    })

  let app = null
  let page = null
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    app = await launch()
    try {
      page = await resolveRendererPage(app, rendererUrl)
      page.on('console', (m) => {
        if (m.type() === 'error') console.error(`[renderer] ${m.text()}`)
      })
      await page.waitForLoadState('domcontentloaded')
      await app.evaluate(({ BrowserWindow }, size) => {
        const w = BrowserWindow.getAllWindows()[0]
        if (!w) return
        w.setContentSize(size.width, size.height)
        w.center()
      }, WINDOW)
      await page.waitForTimeout(3000)
      // Survived the settle with a live window: this attempt is the run.
      if (!page.isClosed()) break
      throw new Error('window closed during boot settle')
    } catch (bootError) {
      console.log(`boot attempt ${attempt} failed: ${bootError.message}`)
      await app.close().catch(() => undefined)
      app = null
      page = null
      if (attempt === 4) throw bootError
      // A fresh profile each time: a half-written one is a plausible cause.
      await seed()
    }
  }

  try {

    await finishOnboarding(page)

    console.log('\n=== creating the workspace ===')
    await click(page, page.locator('button').filter({ hasText: /^New Workspace$/ }))
    await page.waitForTimeout(1200)
    await page.locator('input[placeholder="my-workspace"]').first().fill('MC-2067 Horizon')
    await page.locator('input[placeholder="/path/to/workspace"]').first().fill(workspaceDir)
    await page.waitForTimeout(500)
    const created =
      (await click(page, page.locator('button').filter({ hasText: /^Skip the rest and create$/ }))) ||
      (await click(page, page.locator('button').filter({ hasText: /^(Create workspace|Create)$/ }).last()))
    await page.waitForTimeout(4000)
    check('a real workspace is created and open', created)

    console.log('\n=== opening the Horizon door ===')
    await activate(page.getByRole('button', { name: 'Horizon', exact: true }))
    await page.waitForTimeout(4000)

    // Select the epic step in the plan, so the detail pane shows the case the
    // owner screenshotted. The step title is TRUNCATED in the rail, so match on
    // its stable prefix — and take the innermost row, never the track heading
    // above it (which also contains the step's text).
    const stepSelected = await page.evaluate(() => {
      const rail = document.querySelector('[data-context-rail]')
      if (!rail) return false
      const rows = Array.from(rail.querySelectorAll('button,[role="option"]')).filter((el) =>
        /Post-merge hardeni/.test(el.textContent || ''),
      )
      // Innermost = the one containing no other candidate.
      const row = rows.find((el) => !rows.some((other) => other !== el && el.contains(other)))
      if (!row) return false
      row.focus()
      row.click()
      return true
    })
    check('the seeded epic is a selectable step in the horizon plan', stepSelected)
    await page.waitForTimeout(2500)

    const m = await page.evaluate(measureFor('Horizon'))
    transcript.measured = m
    console.log(JSON.stringify(m, null, 2))
    await page.screenshot({ path: join(outDir, 'horizon-epic-step.png') })

    /* ---- MC-2067 acceptance ------------------------------------------ */
    check('the Horizon surface is on screen with a selected step', m.hasSurface && Boolean(m.header))
    check(
      'exactly one bar: the door bar rides the app strip and the surface renders none of its own',
      m.barHeadings?.length === 1 && m.surfaceHasInlineBar === false,
      JSON.stringify(m.barHeadings),
    )
    check(
      'the detail header is ONE chrome row',
      Array.isArray(m.headerBands) && m.headerBands.length === 1,
      `${m.headerBands?.length} bands: ${JSON.stringify(m.headerBands?.map((b) => b.texts))}`,
    )
    check(
      'the item id and its time ride the title’s own line',
      m.crumbOnTitleRow,
      JSON.stringify({ title: m.titleRect, crumbOnTitleRow: m.crumbOnTitleRow }),
    )
    check(
      'the overflow menu sits inline with the title it acts on, not stranded on a row of its own',
      m.titleAndMoreShareARow,
      JSON.stringify({ title: m.titleRect, more: m.moreRect }),
    )
    check(
      'the children roll-up is one line: the meter sits beside the Children heading',
      m.childrenHeadingAndMeterShareARow,
      JSON.stringify({ heading: m.childrenHeadingRect, meter: m.childrenMeterRect }),
    )
    check(
      'the roll-up says done/total once — no count chip, no “N of M done” sentence, no second bar',
      m.saysDoneSentence === false && m.childrenSectionBandsAboveFirstRow === 1,
      `saysDoneSentence=${m.saysDoneSentence} bandsAboveFirstChild=${m.childrenSectionBandsAboveFirstRow} meter=${m.childrenMeterLabel}`,
    )
    check(
      'the save state is still announced (a live region), not merely condensed away',
      Array.isArray(m.saveLiveRegion) && m.saveLiveRegion.length > 0,
      JSON.stringify(m.saveLiveRegion),
    )
    check('“Make active” is still reachable on the door bar', m.makeActive)

    /* ---- the SHARED pane, on the other door it re-skins ---------------- */
    // The header this condenses is `BacklogDetail`, which the Backlog door
    // mounts too. A fold that reads well on Horizon and strands the Backlog
    // door is not a fix, so the same measurement runs there — with the epic
    // selected, so the children roll-up is in frame as well.
    console.log('\n=== the same pane on the Backlog door ===')
    const leftHorizon = await page.evaluate(() => {
      const rail = document.querySelector('[data-context-rail]')
      const back = rail
        ? Array.from(rail.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Back')
        : null
      if (!back) return false
      back.focus()
      back.click()
      return true
    })
    await page.waitForTimeout(1500)
    check('the Horizon door can be left through its rail’s Back row', leftHorizon)

    await activate(page.getByRole('button', { name: 'Backlog', exact: true }))
    await page.waitForTimeout(3000)
    const backlogItemSelected = await page.evaluate(() => {
      const rail = document.querySelector('[data-context-rail]')
      if (!rail) return false
      const rows = Array.from(rail.querySelectorAll('button,[role="option"]')).filter((el) =>
        /Post-merge hardeni/.test(el.textContent || ''),
      )
      const row = rows.find((el) => !rows.some((other) => other !== el && el.contains(other)))
      if (!row) return false
      row.focus()
      row.click()
      return true
    })
    check('the same epic is selectable on the Backlog door', backlogItemSelected)
    await page.waitForTimeout(2000)
    const b = await page.evaluate(measureFor('Backlog'))
    transcript.backlogDoor = b
    await page.screenshot({ path: join(outDir, 'backlog-door-epic.png') })
    check(
      'the Backlog door gets the same one-row header, not a stranded menu of its own',
      Boolean(b.header) && b.headerBands?.length === 1 && b.titleAndMoreShareARow && b.crumbOnTitleRow,
      `${b.headerBands?.length} bands: ${JSON.stringify(b.headerBands?.map((r) => r.texts))}`,
    )
    check(
      'the Backlog door’s children roll-up is the same one line',
      b.childrenHeadingAndMeterShareARow && b.saysDoneSentence === false,
      `meter=${b.childrenMeterLabel} saysDoneSentence=${b.saysDoneSentence}`,
    )

    /* ---- the narrow floor --------------------------------------------- */
    // Folding metadata onto the title's line spends horizontal room to buy
    // vertical room. That trade has a floor, and the shared pane's is the
    // workspace panel in split mode (`SPLIT_MIN_WIDTH` 600, list 44% capped at
    // 420 → a detail pane of ~336px). Squeeze the window until the door's canvas
    // is about that wide and record what the title actually keeps: a condense
    // that leaves the title unreadable is not a fix either.
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      if (w) w.setContentSize(560, 900)
    })
    await page.waitForTimeout(1500)
    const narrow = await page.evaluate(measureFor('Backlog'))
    transcript.narrow = narrow
    await page.screenshot({ path: join(outDir, 'backlog-door-narrow.png') })
    check(
      'squeezed to the window’s own minimum the header stays one row and the title keeps most of it',
      narrow.headerBands?.length === 1 && narrow.titleWidth >= narrow.paneWidth * 0.5,
      `title=${narrow.titleWidth}px of paneWidth=${narrow.paneWidth}px, bands=${narrow.headerBands?.length}`,
    )

    await writeFile(join(outDir, 'transcript.json'), `${JSON.stringify({ checks, transcript }, null, 2)}\n`)
  } finally {
    await app.close().catch(() => undefined)
    await renderer.close().catch(() => undefined)
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  console.log(`artifacts: ${outDir}`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
