// Acceptance drive for the prepackaged automations: browse the Extensions
// Automations shelf, press Get on a starter, land in the Automations door with
// its editor open, and check what the install left on disk — plus the duplicate
// Get, and the regression that an automation written before this sprint still
// loads, edits and saves.
//
// Run after `npm run build`, once per polarity (the dark ramp keys off
// `data-mode`, which the theme sets):
//   NODE_PATH=/tmp/multicode-playwright/node_modules \
//     T9_THEME=Light node scripts/testing/prepackaged-automations-e2e.mjs
//   NODE_PATH=/tmp/multicode-playwright/node_modules \
//     T9_THEME=Dark  node scripts/testing/prepackaged-automations-e2e.mjs
//
// Screenshots and a step log land in T9_OUT (a temp directory by default).
// What this drive deliberately does NOT do is press Run now: that launches an
// agent with permissions fully bypassed, which is a person's call to make.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
// Which theme onboarding is answered with. The dark ramp keys off `data-mode`,
// which the theme sets, so the two polarities are two runs of this drive rather
// than a DOM attribute poked from outside the app.
const THEME = process.env.T9_THEME || 'Light'
const OUT = process.env.T9_OUT || join(tmpdir(), `t9-drive-${THEME.toLowerCase()}`)
const PROFILE = join(OUT, 'profile')
const PROJECT = join(OUT, 'project')

// The drive needs a clean profile and a clean project every run, so it wipes
// OUT first. That is a recursive delete of a path this script did not create,
// so it only ever runs inside the system temp directory — an OUT pointed
// anywhere else is refused rather than emptied.
if (!resolve(OUT).startsWith(resolve(tmpdir()))) {
  console.error(`T9_OUT must be inside ${tmpdir()} — refusing to delete ${OUT}.`)
  process.exit(2)
}
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
mkdirSync(PROFILE, { recursive: true })
mkdirSync(PROJECT, { recursive: true })

// A real git project, with one hand-written automation already in it so the
// regression check has something that pre-dates this sprint.
execFileSync('git', ['init', '-q'], { cwd: PROJECT })
execFileSync('git', ['config', 'user.email', 't9@example.test'], { cwd: PROJECT })
execFileSync('git', ['config', 'user.name', 'T9'], { cwd: PROJECT })
writeFileSync(join(PROJECT, 'README.md'), '# t9 drive project\n')
execFileSync('git', ['add', '-A'], { cwd: PROJECT })
execFileSync('git', ['commit', '-qm', 'init'], { cwd: PROJECT })

const HANDWRITTEN_DIR = join(PROJECT, '.multi-code/automations/definitions')
mkdirSync(HANDWRITTEN_DIR, { recursive: true })
// Written in the pre-sprint shape on purpose: it carries the retired
// `autonomyDefault`, which a definition written before this sprint would have.
writeFileSync(
  join(HANDWRITTEN_DIR, 'hand-written-nightly.json'),
  `${JSON.stringify(
    {
      id: 'hand-written-nightly',
      name: 'Hand-written nightly',
      status: 'enabled',
      autonomyDefault: 'review_only',
      trigger: { kind: 'schedule', config: { kind: 'schedule', timezone: 'UTC', cadence: { type: 'daily', timeLocal: '04:00' } } },
      action: { kind: 'spawn-agent', config: { prompt: 'Written by hand before the sprint.', cli: 'claude-code' } },
      nextRunAt: '2026-07-31T04:00:00.000Z',
      lastRunAt: null,
      lastRunId: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
    null,
    2
  )}\n`
)

const notes = []
function note(step, detail) {
  const line = `${step} :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  notes.push(line)
  console.log(line)
}

// Every clickable thing the renderer is currently showing, by the label a user
// would read. Used to navigate rather than guessing at CSS selectors.
async function controls(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('button,[role="button"],[role="tab"],a[href]'))
      .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim())
      .filter((label) => label.length > 0 && label.length < 80)
  )
}

// A door replaces the sidebar with its own rail, so reaching another door means
// leaving this one first. Back is the door's own exit.
async function goToDoor(page, name) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const door = page.getByRole('button', { name, exact: true })
    if ((await door.count()) > 0 && (await door.first().isVisible())) {
      await door.first().click()
      await page.waitForTimeout(2500)
      return
    }
    const back = page.getByRole('button', { name: 'Back', exact: true })
    if ((await back.count()) === 0) break
    await back.first().click()
    await page.waitForTimeout(1500)
  }
  throw new Error(`could not reach the ${name} door`)
}

async function shot(page, name) {
  const path = join(OUT, `${name}.png`)
  await page.screenshot({ path })
  note('screenshot', path)
  return path
}

function rpcClient(socketPath) {
  const socket = connect(socketPath)
  socket.setEncoding('utf8')
  let nextId = 1
  const pending = new Map()
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk
    let nl = buffer.indexOf('\n')
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) {
        const message = JSON.parse(line)
        const resolve = pending.get(message.id)
        if (resolve) {
          pending.delete(message.id)
          resolve(message)
        }
      }
      nl = buffer.indexOf('\n')
    }
  })
  const ready = new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  return {
    ready,
    rpc(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)))
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
      })
    },
    notify(method) {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
    },
    end: () => socket.end(),
  }
}

async function main() {
  const { _electron: electron } = require('playwright')
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [join(ROOT, 'out/main/index.js')],
    cwd: ROOT,
    // ELECTRON_RENDERER_URL is set inside a Multicode terminal and points at
    // whatever dev server is already running — another checkout's renderer, not
    // this build's. Inheriting it silently drives the wrong app, so it and its
    // dev-mode companion are stripped rather than overridden.
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RENDERER_URL' && key !== 'NODE_ENV_ELECTRON_VITE')
      ),
      MULTICODE_USER_DATA_DIR: PROFILE,
      MULTICODE_ALLOW_MULTI_INSTANCE: '1',
    },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(4000)

  // Give the app a real project through its own MCP gateway, the same way the
  // shipped acceptance drive does.
  const infoPath = join(PROFILE, 'sprintengine-studio-mcp-info.json')
  for (let attempt = 0; attempt < 40 && !existsSync(infoPath); attempt += 1) await page.waitForTimeout(500)
  const info = JSON.parse(readFileSync(infoPath, 'utf8'))
  const client = rpcClient(info.socketPath)
  await client.ready
  await client.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't9-drive', version: '1' } })
  client.notify('notifications/initialized')
  const created = await client.rpc('tools/call', { name: 'workspace.create', arguments: { name: 'T9 Drive', folderPath: PROJECT } })
  note('workspace.create', created.structuredContent?.workspace ?? created)
  client.end()
  await page.waitForTimeout(4000)

  await shot(page, '00-app')
  note('controls', await controls(page))

  // A fresh profile opens onboarding over the app; close it before driving.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const dialog = page.locator('[role="dialog"]')
    if ((await dialog.count()) === 0) break
    const buttons = await dialog.first().locator('button').all()
    const labels = await Promise.all(buttons.map(async (b) => ((await b.getAttribute('aria-label')) || (await b.innerText()) || '').trim().replace(/\s+/gu, ' ')))
    note('onboarding step', { text: (await dialog.first().innerText().catch(() => '')).slice(0, 80).replace(/\s+/gu, ' '), buttons: labels })
    const theme = labels.findIndex((label) => label.startsWith(`${THEME},`))
    const advance = labels.findIndex((label) => /^(Get started|Continue|Next|Done|Finish|Skip|Start)/u.test(label))
    if (theme >= 0) {
      await buttons[theme].click()
      await page.waitForTimeout(600)
      if (advance >= 0) await dialog.first().locator('button').nth(advance).click()
    } else if (advance >= 0) await buttons[advance].click()
    else if (buttons.length > 0) await buttons[buttons.length - 1].click()
    else await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
  }
  await shot(page, '00b-after-dialogs')

  // --- Extensions door -> Automations shelf
  await goToDoor(page, 'Extensions')
  await shot(page, '01-extensions')
  note('extensions controls', await controls(page))

  // Rail rows carry `title="<row> — <state line>"`, which distinguishes the
  // shelf's Automations row from the sidebar door of the same name.
  const automationsRow = page.locator('button[title^="Automations — "]')
  note('automations rail row', await automationsRow.first().getAttribute('title'))
  await automationsRow.first().click()
  await page.waitForTimeout(2000)
  await shot(page, '02-automations-shelf')
  note('shelf rows', await controls(page))

  // --- Detail aside for a starter, then Get.
  await page.getByRole('button', { name: 'Show details for Dead code sweep' }).first().click()
  await page.waitForTimeout(1200)
  await shot(page, '03-starter-detail')
  note('detail aside', (await page.locator('[aria-label="Dead code sweep details"]').innerText().catch(() => 'NOT FOUND')).replace(/\s+/gu, ' ').slice(0, 700))

  await page.getByRole('button', { name: 'Add to Automations' }).first().click()
  await page.waitForTimeout(6000)
  await shot(page, '04-after-get')
  note('after Get controls', await controls(page))
  note('on-disk after Get', storeDefinitions())
  note('data-mode', await page.evaluate(() => document.documentElement.dataset.mode ?? '<unset>'))
  note('data-theme', await page.evaluate(() => document.documentElement.dataset.theme ?? '<unset>'))

  // --- Negative: a second Get for the same starter in the same project.
  await goToDoor(page, 'Extensions')
  await page.locator('button[title^="Automations — "]').first().click()
  await page.waitForTimeout(2500)
  await shot(page, '05-shelf-after-get')
  const shelfAgain = await controls(page)
  note('shelf row for the added starter', shelfAgain.filter((label) => /Dead code sweep/u.test(label)))
  note('a second Get is offered', shelfAgain.includes('Get Dead code sweep'))

  // --- Regression: the hand-written automation still loads, edits and saves.
  await goToDoor(page, 'Automations')
  await shot(page, '05b-automations-door')
  note('automations door controls', await controls(page))
  await page.locator('button[title^="Hand-written nightly"]').first().click()
  await page.waitForTimeout(1500)
  await shot(page, '06-handwritten-loaded')
  note('hand-written detail pane', (await page.locator('main, [role="main"]').first().innerText().catch(() => '')).replace(/\s+/gu, ' ').slice(0, 400))
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
  await page.waitForTimeout(1500)
  note('editor textareas', await page.locator('textarea').evaluateAll((nodes) => nodes.map((node) => node.value.slice(0, 60))))
  // The prompt is the editor's last textarea; the first belongs to the pane
  // behind it, which is inert while the editor is open.
  const prompt = page.locator('textarea').last()
  await prompt.fill('Written by hand before the sprint. Edited by the T9 drive.')
  await prompt.blur()
  await page.waitForTimeout(600)
  note('prompt field after edit', await prompt.inputValue())
  const save = page.getByRole('button', { name: 'Save', exact: true })
  note('save offered for the hand-written automation', (await save.count()) > 0)
  if ((await save.count()) > 0) await save.first().click()
  await page.waitForTimeout(2500)
  await shot(page, '07-handwritten-saved')
  const handWritten = storeDefinitions().find((definition) => definition.id === 'hand-written-nightly')
  note('hand-written after save', {
    prompt: handWritten?.action?.config?.prompt,
    autonomyDefault: handWritten?.autonomyDefault ?? '<dropped>',
    updatedAt: handWritten?.updatedAt,
  })

  writeFileSync(join(OUT, 'notes.txt'), `${notes.join('\n')}\n`)
  await app.close()
}

function storeDefinitions() {
  const dir = join(PROJECT, '.multi-code/automations/definitions')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
}

main().catch(async (error) => {
  console.error(error)
  writeFileSync(join(OUT, 'notes.txt'), `${notes.join('\n')}\nFAILED: ${error.message}\n`)
  process.exit(1)
})
