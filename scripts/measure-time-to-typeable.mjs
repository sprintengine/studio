#!/usr/bin/env node
// Time-to-typeable for a window that opens on New chat, and the checks that
// keep the static New chat box (src/renderer/public/boot-composer.js) honest.
//
//   node scripts/measure-time-to-typeable.mjs              # 5 measured launches
//   node scripts/measure-time-to-typeable.mjs --runs 9
//
// Requires a build (`npx electron-vite build`). Each run of the script makes one
// throwaway profile with no chats, opens it once so New chat records the box,
// and then:
//   1. launches it `--runs` times and reports, in ms from the renderer's
//      navigation start, when the box took typing, when the window was on
//      screen, and when the real CodeMirror composer was focused;
//   2. launches it once more and types from the moment the box exists straight
//      through the takeover, then checks every keystroke reached the composer,
//      with the caret at the end and focus kept;
//   3. redraws the box over the live panel holding the same words and counts
//      the device pixels that differ.
// Exits non-zero if a keystroke is lost or the box and the panel disagree by
// more than a few pixels of antialiasing.
//
// Launched through Playwright's Electron driver under an allowlisted
// environment and its own SPRINTENGINE_USER_DATA_DIR, as measure-startup.mjs
// does, so it never touches a running Studio or its profile.

import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TYPED = 'refactor the parser so every token keeps its source span and nothing is dropped'
// Antialiasing on the composer's rounded border differs by a pixel or two
// between a layer of its own and the panel's; a shift moves thousands.
const MAX_DIFFERING_PIXELS = 16

let runs = 5
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--runs') runs = Number(process.argv[++i])
  else fail(`unknown argument: ${process.argv[i]}`)
}
if (!Number.isInteger(runs) || runs < 1) fail('--runs must be a positive integer')

function fail(message) {
  console.error(`[measure-time-to-typeable] ${message}`)
  process.exit(1)
}

let electronDriver
try {
  ;({ _electron: electronDriver } = require('playwright-core'))
} catch {
  fail('playwright-core is not installed (npm ci).')
}

const PASSTHROUGH_ENV_KEYS = ['PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'DISPLAY']

async function launch(profileDir) {
  const env = {}
  for (const key of PASSTHROUGH_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key]
  env.SPRINTENGINE_USER_DATA_DIR = profileDir
  env.SPRINTENGINE_ALLOW_MULTI_INSTANCE = '1'
  // A fresh profile on a machine with Claude Code or Codex sessions opens on
  // the import offer instead of New chat. Pointing both CLIs' state at empty
  // directories inside the profile keeps the scan from finding the machine's
  // own sessions, so what is measured does not depend on whose machine it is.
  env.CLAUDE_CONFIG_DIR = join(profileDir, 'claude-config')
  env.CODEX_HOME = join(profileDir, 'codex-home')
  // The boot timeline says when main revealed the window (the splash covers
  // it until then); see src/shared/startup-timeline.ts.
  env.SPRINTENGINE_STARTUP_TIMELINE = '1'
  const app = await electronDriver.launch({ executablePath: require('electron'), args: [ROOT], env, cwd: ROOT })
  let output = ''
  app.timeline = new Promise((resolve) => {
    const onData = (data) => {
      output += data.toString()
      const match = output.match(/\[startup-timeline-json\] (\{.*\})/)
      if (match) resolve(JSON.parse(match[1]))
    }
    app.process().stdout.on('data', onData)
    app.process().stderr.on('data', onData)
  })
  let page = null
  const deadline = Date.now() + 30_000
  while (!page) {
    page = app.windows().find((win) => /index\.html/.test(win.url())) ?? null
    if (!page && Date.now() > deadline) fail('the workspace window never opened')
    if (!page) await new Promise((resolve) => setTimeout(resolve, 1))
  }
  return { app, page }
}

const REAL_FIELD = '#root [data-composer-field] .cm-content'

// The import offer, if it is shown anyway, waits on "Not now" before New chat
// opens; this answers it so the rest of the run starts from New chat.
async function dismissImportOffer(page) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await page.locator('#root [data-composer-field]').count()) return
    const notNow = page.getByRole('button', { name: 'Not now' })
    if (await notNow.count()) await notNow.first().click()
    await page.waitForTimeout(200)
  }
}

// The first launch of a fresh profile: New chat opens (no chats), and if it
// opened on a plain shell — which takes no prompt and so records no box — it
// is switched to a conversation, which is remembered. The panel records the
// box after it paints.
async function prepare(profileDir) {
  const { app, page } = await launch(profileDir)
  try {
    await dismissImportOffer(page)
    await page.waitForSelector('#root [data-composer-field]', { timeout: 30_000 })
    const toConversation = page.locator('[aria-label="Start as a conversation instead of terminal"]')
    if (await toConversation.count()) await toConversation.first().click()
    await page.waitForFunction(() => Boolean(localStorage.getItem('sprintengine-boot-composer')), null, {
      timeout: 10_000,
    })
    // Local storage reaches the disk a moment after it is written; a profile
    // closed at once can lose the pick and the capture both.
    await page.waitForTimeout(2_000)
  } finally {
    await app.close()
  }
}

async function measureOnce(profileDir) {
  const { app, page } = await launch(profileDir)
  try {
    const seen = {}
    const deadline = Date.now() + 20_000
    while (seen.composerFocused === undefined && Date.now() < deadline) {
      let state
      try {
        state = await page.evaluate((selector) => {
          const field = document.querySelector(selector)
          return {
            now: performance.now(),
            box: performance.getEntriesByName('static-composer-typeable')[0]?.startTime ?? null,
            focused: Boolean(field && field.contains(document.activeElement)),
          }
        }, REAL_FIELD)
      } catch {
        continue
      }
      if (state.box !== null) seen.boxTypeable = Math.round(state.box)
      if (state.focused) seen.composerFocused = Math.round(state.now)
    }
    const timeline = await Promise.race([app.timeline, new Promise((resolve) => setTimeout(resolve, 20_000))])
    const offset = (id) => timeline?.rows.find((row) => row.id === id)?.offsetMs
    const navigation = offset('renderer.navigation-start')
    const reveal = offset('main.reveal')
    if (navigation !== undefined && reveal !== undefined) seen.onScreen = Math.round(reveal - navigation)
    // What the person can do: type once the window is on screen and something
    // in it takes keys.
    const firstField = Math.min(seen.boxTypeable ?? Infinity, seen.composerFocused ?? Infinity)
    if (seen.onScreen !== undefined && Number.isFinite(firstField)) {
      seen.typeableOnScreen = Math.max(seen.onScreen, firstField)
    }
    return seen
  } finally {
    await app.close()
  }
}

async function handoff(profileDir) {
  const { app, page } = await launch(profileDir)
  try {
    await page.waitForFunction(() => Boolean(document.querySelector('[data-static-composer]')), null, {
      polling: 1,
      timeout: 30_000,
    })
    await page.evaluate(() => {
      const input = document.querySelector('[data-static-composer-input]')
      window.__boxHandoff = { typedIntoBox: null }
      new MutationObserver((_, observer) => {
        if (document.querySelector('[data-static-composer]')) return
        window.__boxHandoff.typedIntoBox = input.value.length
        observer.disconnect()
      }).observe(document.body, { childList: true })
    })
    await page.keyboard.type(TYPED, { delay: 12 })
    await page.waitForSelector(REAL_FIELD)
    await page.waitForTimeout(300)
    const result = await page.evaluate((selector) => {
      const content = document.querySelector(selector)
      const selection = window.getSelection()
      return {
        text: content.textContent,
        focused: content.contains(document.activeElement),
        caret: selection?.isCollapsed && content.contains(selection.focusNode) ? selection.focusOffset : null,
        typedIntoBox: window.__boxHandoff.typedIntoBox,
      }
    }, REAL_FIELD)

    // The box redrawn over the live panel, holding the same words, both blurred
    // so neither caret is in the picture.
    await page.evaluate(() => document.activeElement?.blur())
    const clip = await page.evaluate(() => {
      const rect = document.querySelector('#root [data-new-chat-door]').getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })
    await page.waitForTimeout(200)
    const panelShot = await page.screenshot({ clip })
    await page.evaluate(async (text) => {
      await new Promise((resolve) => {
        const script = document.createElement('script')
        script.src = './boot-composer.js'
        script.onload = resolve
        document.body.appendChild(script)
      })
      const input = document.querySelector('[data-static-composer-input]')
      input.value = text
      input.blur()
    }, TYPED)
    await page.waitForTimeout(200)
    const boxShot = await page.screenshot({ clip })
    const differing = await page.evaluate(
      async ([a, b]) => {
        const load = (data) =>
          new Promise((resolve) => {
            const image = new Image()
            image.onload = () => resolve(image)
            image.src = `data:image/png;base64,${data}`
          })
        const [first, second] = await Promise.all([load(a), load(b)])
        const canvas = document.createElement('canvas')
        canvas.width = first.width
        canvas.height = first.height
        const context = canvas.getContext('2d')
        context.drawImage(first, 0, 0)
        const one = context.getImageData(0, 0, canvas.width, canvas.height).data
        context.clearRect(0, 0, canvas.width, canvas.height)
        context.drawImage(second, 0, 0)
        const two = context.getImageData(0, 0, canvas.width, canvas.height).data
        let count = 0
        for (let i = 0; i < one.length; i += 4) {
          const delta =
            Math.abs(one[i] - two[i]) + Math.abs(one[i + 1] - two[i + 1]) + Math.abs(one[i + 2] - two[i + 2])
          if (delta > 24) count += 1
        }
        return count
      },
      [panelShot.toString('base64'), boxShot.toString('base64')],
    )
    return { ...result, differing }
  } finally {
    await app.close()
  }
}

function median(values) {
  const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const profileDir = mkdtempSync(join(tmpdir(), 'sprintengine-typeable-'))
try {
  await prepare(profileDir)
  const samples = []
  for (let index = 0; index < runs; index += 1) {
    const sample = await measureOnce(profileDir)
    samples.push(sample)
    console.log(`  run ${index + 1}: ${JSON.stringify(sample)}`)
  }
  console.log('\n  ms from renderer navigation start (median)')
  for (const [key, label] of [
    ['boxTypeable', 'static New chat box takes typing'],
    ['onScreen', 'window on screen (splash closed)'],
    ['composerFocused', 'CodeMirror composer focused'],
    ['typeableOnScreen', 'typeable with the window on screen'],
  ]) {
    console.log(`  ${String(median(samples.map((sample) => sample[key]))).padStart(6)}  ${label}`)
  }

  const check = await handoff(profileDir)
  console.log(
    `\n  handoff: ${check.typedIntoBox} of ${TYPED.length} keys typed into the box before the takeover; ` +
      `composer holds ${check.text.length}, caret ${check.caret}, focused ${check.focused}`,
  )
  console.log(`  pixels: ${check.differing} differ between the box and the live panel`)
  if (check.text !== TYPED) fail(`keystrokes were lost: the composer holds ${JSON.stringify(check.text)}`)
  if (!check.focused || check.caret !== TYPED.length) fail('the caret or focus did not move into the composer')
  if (check.differing > MAX_DIFFERING_PIXELS) fail(`the box and the panel differ by ${check.differing} pixels`)
} finally {
  rmSync(profileDir, { recursive: true, force: true })
}
