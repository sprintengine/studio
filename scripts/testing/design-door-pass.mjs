#!/usr/bin/env node
// Whole-flow validation of the Design door in the RUNNING APP (epic
// `design-door`, item T6).
//
// The unit suites in T1–T5 each prove their own seam. None of them proves the
// flow a person actually walks, and two acceptance criteria demand a measured
// number rather than an assertion: the 100-component density, and a stale
// `foundations/tokens.css` still rendering the right colours. That is what this
// measures, against real folders on disk.
//
// Two traps, both inherited from the context-rail pass and both real:
//
//   • The BUILT renderer gates dev-only modules behind `import.meta.env.DEV`.
//     Measuring off `out/renderer` can silently measure a different app. This
//     serves THIS worktree's renderer from its own vite dev server and points
//     ELECTRON_RENDERER_URL at it, overwriting any inherited value.
//   • The folder picker is a native dialog. `MULTICODE_TEST_OPEN_DIR` overrides
//     it, and because the handler reads `process.env` at call time we can
//     RETARGET it between steps from the main process — which is what lets one
//     run point at several different folders.
//
// Prereqs: `npm run build` (out/main + out/preload), playwright available:
//   tmp=/tmp/multicode-playwright
//   npm --prefix "$tmp" install playwright --no-audit --no-fund
//   NODE_PATH="$tmp/node_modules:$PWD/node_modules" \
//     node scripts/testing/design-door-pass.mjs
//
// Screenshots + a JSON transcript land in $MULTICODE_T6_OUT_DIR.

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = resolve(new URL('../..', import.meta.url).pathname)
const tempRoot = process.env.MULTICODE_T6_TMP_ROOT || '/tmp/multicode-t6-design-door'
const workspaceDir = join(tempRoot, 'workspace')
const userDataDir = join(tempRoot, 'user-data')
const clonedRepo = join(tempRoot, 'cloned-repo')
const clonedBundle = join(clonedRepo, 'design-system')
const bigBundle = join(tempRoot, 'big-system')
const outDir = process.env.MULTICODE_T6_OUT_DIR || join(tempRoot, 'out')
const rendererPort = Number(process.env.MULTICODE_T6_RENDERER_PORT || 5401)

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const measured = {}
const shots = []
/** Registered during this pass, so the run can forget them before it exits. */
const registeredPaths = []
const measuredOnOpen = { value: -1 }

/**
 * Leave the user's real library as we found it.
 *
 * This pass cannot isolate `~/.multicode` (overriding HOME hangs Electron's
 * renderer before it becomes evaluable — measured), so it registers into the
 * real registry and removes exactly its own entries afterwards.
 */
async function forgetWhatWeRegistered() {
  const registryPath = join(homedir(), '.multicode', 'design-systems.json')
  const raw = await readFile(registryPath, 'utf8').catch(() => null)
  if (!raw) return
  try {
    const registry = JSON.parse(raw)
    const before = registry.entries?.length ?? 0
    registry.entries = (registry.entries ?? []).filter(
      (entry) => !String(entry.path ?? '').startsWith(tempRoot),
    )
    if (registry.entries.length !== before) {
      await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`)
      console.log(`cleanup: forgot ${before - registry.entries.length} registration(s) from this pass`)
    }
  } catch {
    // A registry we cannot parse is not ours to rewrite.
  }
}

async function shot(page, name) {
  const file = join(outDir, `${name}.png`)
  await page.screenshot({ path: file })
  shots.push(file)
  return file
}

/* ------------------------------------------------------------------ *
 * Fixtures: real folders, on disk, outside our storage
 * ------------------------------------------------------------------ */

async function seed() {
  await rm(tempRoot, { recursive: true, force: true })
  await mkdir(workspaceDir, { recursive: true })
  await mkdir(userDataDir, { recursive: true })
  await mkdir(outDir, { recursive: true })

  // "A repo they have cloned": this repo's OWN design system, at a path that has
  // nothing to do with our storage.
  await mkdir(clonedRepo, { recursive: true })
  await cp(join(root, 'design-system'), clonedBundle, { recursive: true })

  // The density fixture: 100 components, built by cloning a real one so every
  // tile has real markup to render rather than a stub.
  await cp(join(root, 'resources/design-system/example'), bigBundle, { recursive: true })
  const manifestPath = join(bigBundle, 'design-system.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const template = join(bigBundle, 'components', manifest.contents.components[0])
  const names = [...manifest.contents.components]
  for (let index = names.length; index < 100; index += 1) {
    const name = `generated-${String(index).padStart(3, '0')}`
    await cp(template, join(bigBundle, 'components', name), { recursive: true })
    names.push(name)
  }
  manifest.contents.components = names
  manifest.name = 'hundred'
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
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
  await locator.first().evaluate((el) => {
    el.focus()
    el.click()
  })
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

/** Point the next folder-picker call at a specific directory. */
async function aimPicker(app, dir) {
  await app.evaluate(({}, target) => {
    process.env.MULTICODE_TEST_OPEN_DIR = target
  }, dir)
}

/** One navigation column, or two? Geometry, not class names (item 1993). */
const MEASURE_COLUMNS = `(() => {
  const railColumn = document.querySelector('[data-context-rail]')
  const projectsTree = document.querySelector('nav[role="tree"]')
  const surface = document.querySelector('section[aria-label]')
  const laidOut = (n) => Boolean(n) && n.offsetParent !== null && n.getBoundingClientRect().width > 0
  const surfaceAside = document.querySelector('section[aria-label] aside')
  return {
    surfaceLabel: surface ? surface.getAttribute('aria-label') : null,
    navColumns: [
      laidOut(projectsTree) ? 'projects-tree' : null,
      laidOut(railColumn) ? 'context-rail' : null,
      laidOut(surfaceAside) ? 'surface-inline-aside' : null,
    ].filter(Boolean),
    railHasBack: Boolean(
      railColumn &&
        Array.from(railColumn.querySelectorAll('button')).some(
          (b) => (b.textContent || '').trim() === 'Back',
        ),
    ),
  }
})()`

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
      ELECTRON_RENDERER_URL: rendererUrl,
      MULTICODE_USER_DATA_DIR: userDataDir,
      MULTICODE_ALLOW_MULTI_INSTANCE: '1',
      MULTICODE_TEST_OPEN_DIR: workspaceDir,
      // NOT overriding HOME: Electron reads real paths off it during startup and
      // a bare temp directory hangs the renderer before it becomes evaluable.
      // The library registry therefore lands in the REAL ~/.multicode — so this
      // pass forgets everything it registers before it exits.
    },
  })

  console.log('stage: electron launched')
  try {
    const page = await app.firstWindow()
    console.log('stage: first window')
    page.on('console', (m) => {
      if (m.type() === 'error') console.error(`[renderer] ${m.text()}`)
    })
    await page.waitForLoadState('domcontentloaded')
    console.log('stage: domcontentloaded')
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.setContentSize(1440, 900)
      w.center()
    })
    await page.waitForTimeout(3000)
    console.log(`stage: settled; headings=${await headings(page)}`)
    await finishOnboarding(page)
    console.log(`stage: onboarding done; headings=${await headings(page)}`)
    await page.waitForTimeout(800)

    // ── 1. The door opens and owns the column ───────────────────────────────
    const trigger = page.getByRole('button', { name: 'Design', exact: true })
    check('the Design door has a row in the sidebar', (await trigger.count()) > 0)
    await click(page, trigger)
    await page.waitForTimeout(1500)
    const opened = await page.evaluate(MEASURE_COLUMNS)
    check(
      'the door opens and owns the ONE navigation column',
      opened.surfaceLabel === 'Design' && opened.navColumns.length === 1,
      JSON.stringify(opened),
    )
    check('Back is a pinned rail row', opened.railHasBack === true)
    await shot(page, '01-door-empty')

    // ── 2. Point at a real cloned bundle folder ─────────────────────────────
    await aimPicker(app, clonedBundle)
    await click(page, page.getByRole('button', { name: /New design system/ }))
    await page.waitForTimeout(600)
    await shot(page, '02-create-screen')
    await click(page, page.getByRole('button', { name: /^Point at a folder$/ }))
    await page.waitForTimeout(2500)
    await shot(page, '03-canvas-rendered')

    const canvas = await page.evaluate(() => {
      const text = document.body.textContent || ''
      const frames = Array.from(document.querySelectorAll('iframe'))
      return {
        text: text.slice(0, 4000),
        showsPath: text.includes('cloned-repo'),
        groupHeadings: Array.from(document.querySelectorAll('h3')).map((h) => h.textContent?.trim()),
        iframeCount: frames.length,
        sandboxed: frames.every((f) => f.getAttribute('sandbox') === ''),
        hasReveal: text.includes('Reveal'),
        hasReload: text.includes('Reload'),
      }
    })
    check(
      'the canvas renders the system: manifest-declared groups, with previews',
      canvas.groupHeadings.length > 0 && canvas.iframeCount > 0,
      `groups=${JSON.stringify(canvas.groupHeadings)} iframes=${canvas.iframeCount}`,
    )
    check('the chrome bar carries the folder path with Reveal and Reload', canvas.showsPath && canvas.hasReveal && canvas.hasReload)
    check('every preview is a sandboxed iframe', canvas.sandboxed, `n=${canvas.iframeCount}`)
    check(
      'no Release, lint, regenerate, version history or pull affordance',
      !/release|lint|regenerate|version history|\bpull\b/i.test(canvas.text),
    )
    // Nothing was copied: the bundle is still only where the user's repo put it,
    // and the registry records a PATH. Checked in the driver — same machine, and
    // Electron's evaluate context has no `require`.
    const registryPath = join(homedir(), '.multicode', 'design-systems.json')
    const registryText = await readFile(registryPath, 'utf8').catch(() => '')
    const legacyCopy = join(homedir(), '.multicode', 'design-systems', 'multicode')
    check(
      'pointing at a folder registers a PATH and copies nothing',
      registryText.includes(clonedBundle) && !existsSync(legacyCopy),
      `registryHasPath=${registryText.includes(clonedBundle)} legacyCopy=${existsSync(legacyCopy)}`,
    )
    registeredPaths.push(clonedBundle)
    measured.groups = canvas.groupHeadings

    // ── 3. Open a component ─────────────────────────────────────────────────
    const tile = page.locator('button[aria-label^="button"]').first()
    if ((await tile.count()) > 0) {
      await click(page, tile)
      await page.waitForTimeout(1500)
      await shot(page, '04-component-detail')
      const detail = await page.evaluate(() => {
        const text = document.body.textContent || ''
        return {
          sections: ['Anatomy', 'Variants', 'States', 'Usage', 'Accessibility'].filter((s) => text.includes(s)),
          stages: document.querySelectorAll('figure').length,
        }
      })
      check(
        'a component opens with every stage and its component.md sections as authored',
        detail.sections.length === 5 && detail.stages >= 2,
        `sections=${detail.sections.join(',')} stages=${detail.stages}`,
      )
      measured.componentDetail = detail
      await click(page, page.getByRole('button', { name: /All components/ }))
      await page.waitForTimeout(800)
    } else {
      check('a component opens with every stage and its sections', false, 'no component tile found')
    }

    // ── 4. Stale tokens.css: edit the SOURCE, do not regenerate, Reload ─────
    const before = await page.evaluate(() => {
      const bar = document.querySelector('[role="img"][aria-label*="ramp"]')
      const first = bar?.firstElementChild
      return first ? getComputedStyle(first).backgroundColor : null
    })
    // Edit the SOURCE and deliberately do NOT regenerate tokens.css.
    const tokensPath = join(clonedBundle, 'foundations', 'tokens.tokens.json')
    const tokens = JSON.parse(await readFile(tokensPath, 'utf8'))
    const firstKey = Object.keys(tokens.ref.color)[0]
    const node = tokens.ref.color[firstKey]
    const leaf = '$value' in node ? node : node[Object.keys(node)[0]]
    leaf.$value = '#ff00ff'
    await writeFile(tokensPath, `${JSON.stringify(tokens, null, 2)}\n`)
    const cssStale = !(await readFile(join(clonedBundle, 'foundations', 'tokens.css'), 'utf8')).includes('#ff00ff')
    check('the generated tokens.css is left deliberately stale', cssStale)
    await click(page, page.getByRole('button', { name: /^Reload$/ }))
    await page.waitForTimeout(2500)
    const after = await page.evaluate(() => {
      const bar = document.querySelector('[role="img"][aria-label*="ramp"]')
      return Array.from(bar?.children ?? []).map((c) => getComputedStyle(c).backgroundColor)
    })
    check(
      'editing the token SOURCE without regenerating, then Reload, shows the new value',
      after.includes('rgb(255, 0, 255)'),
      `before=${before} after=${after.slice(0, 4).join(' ')}`,
    )
    measured.staleTokens = { before, afterIncludesMagenta: after.includes('rgb(255, 0, 255)') }
    await shot(page, '05-reload-after-source-edit')

    // ── 5. Delete the folder: a named broken row, with repairs ──────────────
    await rm(clonedBundle, { recursive: true, force: true })
    await click(page, page.getByRole('button', { name: /^Reload$/ }))
    await page.waitForTimeout(2000)
    const broken = await page.evaluate(() => {
      const text = document.body.textContent || ''
      return {
        namesTheKind: /no longer there|not a design system|could not be read|could not be opened/i.test(text),
        showsPath: text.includes('cloned-repo'),
        offersRepoint: text.includes('Re-point'),
        offersForget: text.includes('Forget'),
        rowSurvives: text.includes('multicode'),
      }
    })
    check(
      'a deleted folder is a NAMED broken row with its path, offering Re-point and Forget',
      broken.namesTheKind && broken.showsPath && broken.offersRepoint && broken.offersForget && broken.rowSurvives,
      JSON.stringify(broken),
    )
    await shot(page, '06-broken-row')

    // ── 6. Density: 100 components, measured ────────────────────────────────
    await aimPicker(app, bigBundle)
    await click(page, page.getByRole('button', { name: /New design system/ }))
    await page.waitForTimeout(500)
    await click(page, page.getByRole('button', { name: /^Point at a folder$/ }))
    await page.waitForTimeout(4000)
    // How many previews are LIVE before anyone scrolls. This is what lazy
    // mounting buys: opening a 100-component system must not stand up 100
    // documents at once. (After a full scroll they are all live, by design —
    // PreviewFrame keeps a mounted frame rather than reloading it every time the
    // user scrolls back, and the frame timings below show that holds up.)
    const onOpen = await page.evaluate(() => document.querySelectorAll('iframe').length)
    measuredOnOpen.value = onOpen
    const density = await page.evaluate(async () => {
      const scroller = Array.from(document.querySelectorAll('div')).find(
        (d) => d.scrollHeight > d.clientHeight + 400 && d.clientHeight > 200,
      )
      if (!scroller) return { error: 'no scroller found' }
      const frames = []
      let last = performance.now()
      let raf = 0
      const tick = () => {
        const now = performance.now()
        frames.push(now - last)
        last = now
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
      const start = performance.now()
      // Scroll the whole list in steps, the way a person reading it would.
      for (let i = 0; i < 40; i += 1) {
        scroller.scrollTop += scroller.scrollHeight / 40
        await new Promise((r) => setTimeout(r, 40))
      }
      const elapsed = performance.now() - start
      cancelAnimationFrame(raf)
      const sorted = frames.slice(1).sort((a, b) => a - b)
      const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
      return {
        tiles: document.querySelectorAll('button[aria-label]').length,
        liveIframes: document.querySelectorAll('iframe').length,
        scrollHeight: scroller.scrollHeight,
        elapsedMs: Math.round(elapsed),
        frameCount: sorted.length,
        medianFrameMs: Number(pct(0.5).toFixed(1)),
        p95FrameMs: Number(pct(0.95).toFixed(1)),
        worstFrameMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(1)),
      }
    })
    measured.density = density
    console.log(`  MEASURED density: ${JSON.stringify(density)}`)
    check(
      '100 components scroll without the page becoming unusable (measured)',
      !density.error && density.p95FrameMs > 0 && density.p95FrameMs < 100,
      JSON.stringify(density),
    )
    density.liveIframesOnOpen = measuredOnOpen.value
    check(
      'lazy mounting: opening a 100-component system stands up only the visible previews',
      measuredOnOpen.value > 0 && measuredOnOpen.value < 40,
      `liveOnOpen=${measuredOnOpen.value} of ${density.tiles} tiles; liveAfterFullScroll=${density.liveIframes} (mounted frames are kept on purpose)`,
    )
    await shot(page, '07-hundred-components')

    // ── 7. Back returns to the workspace rail ───────────────────────────────
    await click(page, page.locator('[data-context-rail] button').filter({ hasText: /^Back$/ }))
    await page.waitForTimeout(1200)
    const back = await page.evaluate(MEASURE_COLUMNS)
    check(
      'Back leaves the door and returns the projects rail, still one column',
      back.surfaceLabel !== 'Design' && back.navColumns.length === 1 && back.navColumns[0] === 'projects-tree',
      JSON.stringify(back),
    )
    await shot(page, '08-back-to-workspace')
  } finally {
    await writeFile(
      join(outDir, 'transcript.json'),
      `${JSON.stringify({ checks, measured, shots }, null, 2)}\n`,
    )
    await app.close().catch(() => undefined)
    await renderer.close().catch(() => undefined)
    await forgetWhatWeRegistered()
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  console.log(`screenshots + transcript: ${outDir}`)
  if (failed.length > 0) {
    console.error(`FAILED:\n${failed.map((c) => `  - ${c.name} (${c.detail})`).join('\n')}`)
    process.exitCode = 1
  }
}

void main()
