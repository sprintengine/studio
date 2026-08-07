#!/usr/bin/env node
// Rendered pass for MC-2066: the team is a first-class choice ON the horizon
// step.
//
// Why this runs the app instead of asserting class names: the defect was
// `opacity-0 … group-hover/step:opacity-100` on the step's roster chip, and
// "legible without pointing at it" is a COMPUTED-STYLE claim. A source-level
// assertion cannot tell a visible chip from one that is painted at zero alpha,
// nor from one a later hover rule takes back — which is exactly how the control
// that decides who does the work ended up invisible at rest.
//
// What it measures, with no pointer anywhere near the rows:
//   1. every step row carries a laid-out team chip at full opacity;
//   2. an OVERRIDE reads differently from an INHERITANCE without hover (and the
//      difference is not carried by colour alone — the override is a bordered
//      chip), while both name their tier in their accessible name;
//   3. selecting a step puts a Team band in the detail pane that says what the
//      choice MEANS — for No roles, which agent and how many at once.
//
// Seeding mirrors `horizon-chrome-rows-pass.mjs` (same door, same traps): the
// home project is a main-owned scalar and the plan is a markdown file, so
// neither needs the create/drag flow this pass is not measuring. The BUILT
// renderer hides Horizon (DEV_ONLY_MODULE_IDS), so this serves THIS worktree's
// renderer from its own vite dev server, and a programmatic `.click()` does not
// focus its target — rail rows are driven through `activate`.
//
// Saved rosters live in renderer settings, which this pass does not seed, so the
// override case uses the built-in "No roles" as a step-level override: it is a
// real override (the entry carries `@roster=`) that resolves to a real team, and
// it proves the tone comes from the ABSENCE of an override rather than from the
// label — the two rows here read the same words and must not read the same way.
//
// Prereqs: `npm run build` (out/main + out/preload), playwright available:
//   tmp=/tmp/multicode-playwright
//   npm --prefix "$tmp" install playwright --no-audit --no-fund
//   NODE_PATH="$tmp/node_modules:$PWD/node_modules" \
//     node scripts/testing/horizon-step-team-pass.mjs
//
// Screenshots + a JSON transcript land in $MULTICODE_HORIZON_TEAM_OUT_DIR.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = resolve(new URL('../..', import.meta.url).pathname)
const tempRoot = process.env.MULTICODE_HORIZON_TEAM_TMP_ROOT || '/tmp/multicode-horizon-step-team'
const workspaceDir = join(tempRoot, 'workspace')
const userDataDir = join(tempRoot, 'user-data')
const outDir = process.env.MULTICODE_HORIZON_TEAM_OUT_DIR || join(tempRoot, 'out')
const rendererPort = Number(process.env.MULTICODE_HORIZON_TEAM_RENDERER_PORT || 5398)
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

// Every step row's team chip, as the pixels have it: is it laid out, what alpha
// is it painted at, and what does it say it is. The chip is a sibling of the row
// button (one click target per row), so it is found by its accessible name
// rather than by walking the row.
const MEASURE_ROWS = `(() => {
  const rail = document.querySelector('[data-context-rail]')
  if (!rail) return { hasRail: false, chips: [] }
  const chips = Array.from(rail.querySelectorAll('button[aria-label^="Team for "]')).map((el) => {
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return {
      label: el.getAttribute('aria-label'),
      text: (el.textContent || '').trim(),
      opacity: Number(style.opacity),
      borderTopWidth: Math.round(parseFloat(style.borderTopWidth) || 0),
      color: style.color,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      laidOut: rect.width > 0 && rect.height > 0 && el.offsetParent !== null,
    }
  })
  const steps = Array.from(rail.querySelectorAll('[data-step="true"]')).length
  return { hasRail: true, steps, chips }
})()`

// The detail pane's Team band: the label, what the band says the choice means,
// and where it sits relative to the item title (it is header content, above the
// body, or it is not "beside the step" at all).
const MEASURE_BAND = `(() => {
  const surface = document.querySelector('section[aria-label="Horizon"]')
  if (!surface) return { hasSurface: false }
  const picker = surface.querySelector('button[aria-label^="Team for "]')
  const band = picker ? picker.closest('div.flex.flex-col') : null
  const title = surface.querySelector('header h3')
  const rect = (node) => {
    if (!node) return null
    const r = node.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }
  }
  return {
    hasSurface: true,
    hasPicker: Boolean(picker),
    pickerLabel: picker ? picker.getAttribute('aria-label') : null,
    bandText: band ? (band.textContent || '').replace(/\\s+/g, ' ').trim() : null,
    bandRect: rect(band),
    titleRect: rect(title),
  }
})()`

/* ------------------------------------------------------------------ *
 * The seed
 * ------------------------------------------------------------------ */

async function seed() {
  await rm(tempRoot, { recursive: true, force: true })
  await mkdir(join(workspaceDir, 'backlog/roadmaps'), { recursive: true })
  await mkdir(userDataDir, { recursive: true })
  await mkdir(outDir, { recursive: true })

  for (const [slug, title] of [
    ['inherits-the-horizon', 'A step that inherits the horizon’s team'],
    ['names-its-own-team', 'A step that names its own team'],
  ]) {
    await writeFile(
      join(workspaceDir, `backlog/2026-08-06-${slug}.md`),
      `---\nstatus: ready\ntype: feature\n---\n\n# ${title}\n\nSeeded step for the MC-2066 team pass.\n`,
    )
  }
  // One track, two steps: the first inherits (no annotation at all), the second
  // carries an explicit `@roster=`. Same resolved team name, different tier —
  // the case the tone must not read off the label.
  await writeFile(
    join(workspaceDir, 'backlog/roadmaps/2026-08-06-mc-2066.md'),
    '---\ntype: roadmap\nstatus: idea\nadvance: approve\nmerge: manual\n---\n\n'
      + '## Delivery\n'
      + '- backlog/2026-08-06-inherits-the-horizon.md\n'
      + '- backlog/2026-08-06-names-its-own-team.md @roster=No roles\n',
  )
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
    await new Promise((r) => setTimeout(r, 500))
  }
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

async function main() {
  const { _electron: electron } = require('playwright')
  const electronPath = require('electron')
  await seed()
  const renderer = await startRenderer()
  const rendererUrl = `http://localhost:${rendererPort}`
  console.log(`renderer dev server (this worktree): ${rendererUrl}`)

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
      if (!page.isClosed()) break
      throw new Error('window closed during boot settle')
    } catch (bootError) {
      console.log(`boot attempt ${attempt} failed: ${bootError.message}`)
      await app.close().catch(() => undefined)
      app = null
      page = null
      if (attempt === 4) throw bootError
      await seed()
    }
  }

  try {
    await finishOnboarding(page)

    console.log('\n=== creating the workspace ===')
    await click(page, page.locator('button').filter({ hasText: /^New Workspace$/ }))
    await page.waitForTimeout(1200)
    await page.locator('input[placeholder="my-workspace"]').first().fill('MC-2066 Horizon')
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

    // Park the pointer far from the plan, so nothing below is a hover artefact.
    await page.mouse.move(WINDOW.width - 4, WINDOW.height - 4)
    await page.waitForTimeout(400)

    const rows = await page.evaluate(MEASURE_ROWS)
    transcript.rows = rows
    console.log(JSON.stringify(rows, null, 2))
    await page.screenshot({ path: join(outDir, 'horizon-steps-at-rest.png') })

    check('the plan renders the seeded steps', rows.hasRail && rows.steps === 2, `steps=${rows.steps}`)
    check(
      'every step carries a team chip, laid out and fully opaque, with no pointer on the row',
      rows.chips.length === rows.steps
        && rows.chips.every((chip) => chip.laidOut && chip.opacity === 1 && chip.width > 0),
      JSON.stringify(rows.chips.map((c) => ({ text: c.text, opacity: c.opacity, w: c.width }))),
    )
    const inherited = rows.chips.find((c) => /\(inherited from this horizon\)$/.test(c.label || ''))
    const overridden = rows.chips.find((c) => /\(set for this step\)$/.test(c.label || ''))
    check(
      'the two tiers are named where a screen reader can hear them',
      Boolean(inherited && overridden),
      JSON.stringify(rows.chips.map((c) => c.label)),
    )
    check(
      'and they differ in the pixels too — the override is a bordered chip, not a colour swap',
      Boolean(inherited && overridden)
        && overridden.borderTopWidth > 0
        && inherited.borderTopWidth === 0
        && inherited.text === overridden.text,
      JSON.stringify({
        inherited: { text: inherited?.text, border: inherited?.borderTopWidth, color: inherited?.color },
        overridden: { text: overridden?.text, border: overridden?.borderTopWidth, color: overridden?.color },
      }),
    )

    console.log('\n=== selecting a step ===')
    const stepSelected = await page.evaluate(() => {
      const rail = document.querySelector('[data-context-rail]')
      if (!rail) return false
      const row = Array.from(rail.querySelectorAll('button[data-step-row="true"]')).find((el) =>
        /inherits the horizon/.test(el.textContent || ''),
      )
      if (!row) return false
      row.focus()
      row.click()
      return true
    })
    check('the step is selectable', stepSelected)
    await page.waitForTimeout(2500)

    const band = await page.evaluate(MEASURE_BAND)
    transcript.band = band
    console.log(JSON.stringify(band, null, 2))
    await page.screenshot({ path: join(outDir, 'horizon-step-team-band.png') })

    check(
      'the selected step carries a Team band with its own picker',
      band.hasPicker && /^Team for /.test(band.pickerLabel || ''),
      band.pickerLabel ?? 'none',
    )
    check(
      'the band says what NO ROLES means: which agent, and how many at once',
      /[Oo]ne agent per task/.test(band.bandText || '')
        && /up to \d+ at once/.test(band.bandText || ''),
      band.bandText ?? 'none',
    )
    check(
      'and it sits with the step, under its title rather than buried in the body',
      Boolean(band.bandRect && band.titleRect) && band.bandRect.top >= band.titleRect.top,
      JSON.stringify({ title: band.titleRect, band: band.bandRect }),
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
