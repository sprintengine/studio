#!/usr/bin/env node
// The web client's smoke test in a real browser (phase 9 spec, 8.3): the built
// server (`npm run build:server`) serving the built web client
// (`npm run build:web`) to headless Chromium, on a fresh data directory.
//
//   npm run test:web:smoke
//
// Chromium comes from Playwright's own download (`npx playwright-core install
// chromium`) unless `WEB_SMOKE_CHROMIUM` names a browser. Everything it writes
// (the data directory, a copy of the web bundle, screenshots on failure) goes
// under `WEB_SMOKE_DIR`, or a fresh temporary directory, and never into the
// checkout.
//
// What it walks:
// - pairing by a fragment link: the code leaves the address and the history;
// - the app boots under its CSP with no page error, and the members it refuses
//   at boot are the known list (a new refusal is a member the boot needs that a
//   browser does not have);
// - axe finds nothing critical on the pairing page or the app's first screen;
// - pairing by approval: a second browser asks, the owner types its six digits;
// - removing a browser sends its tab back to pairing at once;
// - a file with no path dropped on the composer is uploaded, and its path on
//   the server typed into the message;
// - at a phone's width the sidebar and the content take turns at the full
//   width;
// - a bundle replaced under an open tab makes it offer a reload.

import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverBundle = join(root, 'out', 'server', 'server.cjs')
const webBundle = join(root, 'out', 'web')
for (const [path, build] of [
  [serverBundle, 'npm run build:server'],
  [join(webBundle, 'index.html'), 'npm run build:web'],
]) {
  if (!existsSync(path)) {
    console.error(`web smoke: ${path} is missing. Run ${build} first.`)
    process.exit(1)
  }
}

let chromium
try {
  ;({ chromium } = require('playwright-core'))
} catch {
  console.error('web smoke: playwright-core is not installed (npm ci).')
  process.exit(1)
}
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')

const keepDir = process.env.WEB_SMOKE_DIR
const work = keepDir ? resolve(keepDir) : mkdtempSync(join(tmpdir(), 'web-smoke-'))
mkdirSync(work, { recursive: true })
const dataDir = mkdtempSync(join(work, 'data-'))
// A copy of the bundle, so the test can replace it under an open tab.
const webRoot = join(work, `web-${process.pid}`)
cpSync(webBundle, webRoot, { recursive: true })

// The members a tab refuses while the app boots on a fresh data directory:
// each is a desktop-only domain (14.8) whose caller already treats the
// refusal as "not here". A member added to this list is a decision; a member
// that appears without one is a regression in what the boot reaches for.
const KNOWN_BOOT_REFUSALS = new Set([
  'plugins:list',
  'plugins:detect-availability',
  'studio-server:status',
  'update:get-state',
  'tailnet:get-status',
  'tailnet:get-live-state',
  'mesh:list-connections',
  'mesh:get-live-state',
  'git:get-repository-identity',
  'pullRequest:listForWorkspaces',
  'git:get-repo-root',
  'git:get-workspace-change-summary',
  'git:checkout-watch-retain',
  'hosted-card-feed:get',
  'skills:list-workspace',
  // Importing this machine's CLI conversations is the desktop's: a browser has
  // none of its own to offer at first run.
  'conversation-import:scan',
])

// A server run with no inherited Studio settings: nothing of this machine's own Studio is read.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SPRINTENGINE_')))

function startServer() {
  const child = spawn(
    process.execPath,
    [serverBundle, 'serve', '--data-dir', dataDir, '--web', '--web-port', '0', '--web-root', webRoot],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const ready = new Promise((resolveReady, reject) => {
    let buffered = ''
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      for (const line of buffered.split('\n').slice(0, -1)) {
        try {
          const parsed = JSON.parse(line)
          if (parsed.ready?.web) resolveReady(parsed.ready.web)
        } catch {
          // Not a control line.
        }
      }
      buffered = buffered.slice(buffered.lastIndexOf('\n') + 1)
    })
    child.on('exit', (code) => reject(new Error(`The server exited (${code}) before it was ready:\n${stderr}`)))
    setTimeout(() => reject(new Error(`The server was not ready in 60 s:\n${stderr}`)), 60_000).unref()
  })
  return { child, ready }
}

function pairingLink() {
  return execFileSync(process.execPath, [serverBundle, 'pair', '--data-dir', dataDir], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

/** Page errors and console errors, less the sockets a test closes on purpose. */
function watchErrors(page) {
  const errors = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' && !/WebSocket|ERR_CONNECTION_REFUSED|401/u.test(message.text()))
      errors.push(`console: ${message.text().slice(0, 300)}`)
  })
  return errors
}

async function axeCritical(page) {
  await page.evaluate(axeSource)
  const results = await page.evaluate(() =>
    globalThis.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
      resultTypes: ['violations'],
    }),
  )
  for (const violation of results.violations.filter((each) => each.impact === 'serious'))
    console.log(`  axe (serious, reported): ${violation.id} on ${violation.nodes.length} element(s)`)
  return results.violations
    .filter((each) => each.impact === 'critical')
    .map((each) => `${each.id}: ${each.nodes.map((node) => node.target.join(' ')).join(', ')}`)
}

const results = []
async function step(name, run) {
  try {
    await run()
    results.push([name, true])
    console.log(`ok - ${name}`)
  } catch (error) {
    results.push([name, false])
    console.log(
      `not ok - ${name}\n  ${String(error?.stack ?? error)
        .split('\n')
        .slice(0, 6)
        .join('\n  ')}`,
    )
  }
}

const { child, ready } = startServer()
let browser
try {
  const origin = await ready
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEB_SMOKE_CHROMIUM ? { executablePath: process.env.WEB_SMOKE_CHROMIUM } : {}),
  })
  const ownerContext = await browser.newContext()
  const owner = await ownerContext.newPage()
  const ownerErrors = watchErrors(owner)

  await step('pairing by a fragment link leaves no code in the address or the history', async () => {
    const link = pairingLink()
    assert.match(link, /\/pair#code=sepair_/u)
    await owner.goto(link)
    await owner.waitForURL(`${origin}/`, { timeout: 15_000 })
    assert.doesNotMatch(owner.url(), /code=/u)
    const cookies = await ownerContext.cookies()
    const session = cookies.find((cookie) => cookie.name.startsWith('se_s_'))
    assert.ok(session, 'the session cookie is set')
    assert.equal(session.httpOnly, true)
    assert.equal(session.sameSite, 'Strict')
    // Back from the app is the pairing page as replaced, without its code.
    await owner.goBack().catch(() => undefined)
    assert.doesNotMatch(owner.url(), /sepair_/u)
    if (owner.url() !== `${origin}/`) await owner.goto(`${origin}/`)
  })

  await step('the app boots under its CSP with no page error, refusing only the known members', async () => {
    await owner.waitForFunction(() => typeof window.__studioWebRefusals === 'function', null, { timeout: 15_000 })
    // The boot is done when the sidebar is drawn and the refusals it makes
    // have stopped growing: read until the list has held for a second and a
    // half, rather than for a fixed time a slow runner may not finish in.
    await owner.locator('aside[aria-label="Workspaces"]').waitFor({ timeout: 15_000 })
    await owner.waitForFunction(
      () => {
        const count = window.__studioWebRefusals().length
        const seen = window.__smokeRefusalsSeen
        if (!seen || seen.count !== count) {
          window.__smokeRefusalsSeen = { count, since: Date.now() }
          return false
        }
        return Date.now() - seen.since >= 1500
      },
      null,
      { timeout: 20_000, polling: 250 },
    )
    assert.equal(await owner.locator('[role=alert]').count(), 0, 'no alert on the first screen')
    assert.deepEqual(ownerErrors, [])
    const refused = await owner.evaluate(() => window.__studioWebRefusals())
    const unexpected = refused.filter((channel) => !KNOWN_BOOT_REFUSALS.has(channel))
    assert.deepEqual(unexpected, [], 'members refused at boot that the known list does not name')
  })

  await step('axe finds nothing critical on the pairing page or the first screen', async () => {
    const guest = await (await browser.newContext()).newPage()
    await guest.goto(`${origin}/pair`)
    await guest.getByLabel('Name this browser').waitFor()
    assert.deepEqual(await axeCritical(guest), [], 'the pairing page')
    await guest.context().close()
    assert.deepEqual(await axeCritical(owner), [], 'the app')
  })

  let guestName = 'Smoke guest'
  let guest
  await step('pairing by approval: the owner types the six digits the other browser shows', async () => {
    guest = await (await browser.newContext()).newPage()
    await guest.goto(`${origin}/`)
    await guest.waitForURL(/\/pair/u)
    await guest.getByLabel('Name this browser').fill(guestName)
    await guest.getByRole('button', { name: 'Ask to pair' }).click()
    await guest.locator('#pair-digits').waitFor()
    const digits = (await guest.locator('#pair-digits').textContent()).replace(/\s/gu, '')
    assert.match(digits, /^\d{6}$/u)
    const answer = await owner.evaluate(
      async ({ name, code }) => {
        const { requests } = await window.api.webDevicesStatus()
        const request = requests.find((each) => each.name === name)
        if (!request) return { ok: false, message: 'no request' }
        const wrong = await window.api.webDevicesApprove(request.requestId, code === '000000' ? '111111' : '000000')
        if (wrong.ok) return { ok: false, message: 'a wrong code was accepted' }
        return window.api.webDevicesApprove(request.requestId, code)
      },
      { name: guestName, code: digits },
    )
    assert.equal(answer.ok, true, answer.message)
    await guest.waitForURL(`${origin}/`, { timeout: 15_000 })
  })

  await step('removing a browser sends its tab back to pairing at once', async () => {
    assert.ok(guest, 'the guest paired')
    await owner.evaluate(async (name) => {
      const { devices } = await window.api.webDevicesStatus()
      const device = devices.find((each) => each.name === name && !each.current)
      await window.api.webDevicesRevoke(device.id)
    }, guestName)
    await guest.waitForURL(/\/pair/u, { timeout: 15_000 })
    const status = await guest.evaluate(async () => (await fetch('./api/session')).status)
    assert.equal(status, 401)
  })

  await step('a file dropped on the composer is uploaded and typed as its server path', async () => {
    // A fresh data directory has no chat yet: New chat opens the composer that starts one.
    await owner.getByRole('button', { name: 'New chat' }).last().click()
    const composer = owner.locator('textarea, [contenteditable="true"]').last()
    await composer.waitFor({ timeout: 15_000 })
    const box = await composer.boundingBox()
    const transfer = await owner.evaluateHandle(() => {
      const data = new DataTransfer()
      data.items.add(new File(['quarterly numbers\n'], 'report notes.txt', { type: 'text/plain' }))
      return data
    })
    for (const type of ['dragenter', 'dragover', 'drop'])
      await composer.dispatchEvent(type, { dataTransfer: transfer, clientX: box.x + 10, clientY: box.y + 10 })
    await owner.waitForFunction(
      () => {
        const field = [...document.querySelectorAll('textarea, [contenteditable="true"]')].at(-1)
        return /web-uploads/u.test(field?.value ?? field?.innerText ?? '')
      },
      null,
      { timeout: 10_000 },
    )
    const typed = await composer.evaluate((field) => field.value ?? field.innerText)
    const path = /'([^']*web-uploads[^']*)'/u.exec(typed)?.[1]
    assert.ok(path, `a quoted server path is typed: ${typed}`)
    assert.ok(path.startsWith(dataDir), 'the path is in the server data directory')
    assert.equal(readFileSync(path, 'utf8'), 'quarterly numbers\n')
  })

  await step("at a phone's width the sidebar and the content take turns at the full width", async () => {
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true })).newPage()
    await phone.goto(pairingLink())
    await phone.waitForURL(`${origin}/`, { timeout: 15_000 })
    const sidebar = phone.locator('aside[aria-label="Workspaces"]')
    await phone
      .getByRole('button', { name: /sidebar/iu })
      .first()
      .waitFor({ timeout: 15_000 })
    assert.equal(await sidebar.isVisible(), false, 'the content has the screen at first')
    await phone
      .getByRole('button', { name: /sidebar/iu })
      .first()
      .click()
    await sidebar.waitFor({ state: 'visible' })
    const box = await sidebar.boundingBox()
    assert.ok(box && box.width > 250, 'the sidebar fills the width beside the rail')
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), 390, 'nothing scrolls sideways')
    await phone
      .getByRole('button', { name: /sidebar/iu })
      .first()
      .click()
    await sidebar.waitFor({ state: 'hidden' })
    await phone.context().close()
  })

  await step('a bundle replaced under an open tab makes it offer a reload', async () => {
    const index = join(webRoot, 'index.html')
    const html = readFileSync(index, 'utf8')
    const next = html.replace(/(<meta name="sprintengine-web-build" content=")[^"]+"/u, '$1smoke-next"')
    assert.notEqual(next, html, 'the bundle carries a build id')
    writeFileSync(index, next)
    await owner.evaluate(() => window.dispatchEvent(new Event('online')))
    await owner.getByText('Studio was updated').waitFor({ timeout: 10_000 })
    await owner.getByRole('button', { name: 'Reload' }).click()
    await owner.waitForFunction(
      () => document.querySelector('meta[name="sprintengine-web-build"]')?.content === 'smoke-next',
      null,
      { timeout: 15_000 },
    )
  })

  if (results.some(([, passed]) => !passed)) await owner.screenshot({ path: join(work, 'failure.png') }).catch(() => {})
} catch (error) {
  console.log(`not ok - the smoke could not run\n  ${error?.stack ?? error}`)
  results.push(['setup', false])
} finally {
  await browser?.close().catch(() => undefined)
  child.kill('SIGTERM')
  await new Promise((done) => {
    if (child.exitCode !== null) done()
    else child.once('exit', done)
    setTimeout(done, 10_000).unref()
  })
  if (!keepDir) rmSync(work, { recursive: true, force: true })
}

const failed = results.filter(([, passed]) => !passed).length
console.log(`${results.length - failed}/${results.length} web smoke steps passed`)
process.exit(failed ? 1 : 0)
