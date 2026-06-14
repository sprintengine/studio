#!/usr/bin/env node

import { createRequire } from 'node:module'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sourceRunDir = resolve(
  root,
  '.multi-code/sprintengine/2026-06-09-pluggable-workspace-and-contribution-apis',
)
const validationDir = resolve(sourceRunDir, 'validation')
const screenshotDir = resolve(validationDir, 'screenshots')
const reportPath = resolve(validationDir, 'workspace-types-validation-3.md')
const tempRoot = process.env.MULTICODE_T13_TMP_ROOT || '/tmp/multicode-t13'
const workspaceDir = join(tempRoot, 'workspace')
const userDataDir = process.env.MULTICODE_PW_USER_DATA || join(tempRoot, 'user-data')
const teamSlug = 't13-live-glyph'
const teamName = 'T13 Live Glyph'
const teamDir = join(workspaceDir, '.multi-code', 'sprintengine', teamSlug)
const statePath = join(teamDir, 'run.yaml')
const projectionPath = join(teamDir, 'projection.json')

const states = [
  {
    key: 'in_progress',
    taskStatus: 'in_progress',
    taskBoardColumn: 'in_progress',
    ownerAgentId: 'developer-1',
    agentStatus: 'running',
    expectedLabel: /Running/i,
    screenshot: 't13-01-in-progress.png',
  },
  {
    key: 'needs_input',
    taskStatus: 'needs_input',
    taskBoardColumn: 'needs_input',
    ownerAgentId: 'developer-1',
    agentStatus: 'needs_input',
    needsInput: {
      kind: 'user',
      reason: 'external_validation',
      question: 'Confirm live validation can proceed.',
      suggestedResolution: 'Acknowledge the scratch validation checkpoint.',
    },
    expectedLabel: /Needs input/i,
    screenshot: 't13-02-needs-input.png',
  },
  {
    key: 'done_before_view',
    taskStatus: 'done',
    taskBoardColumn: 'done',
    ownerAgentId: null,
    agentStatus: 'done',
    expectedLabel: /Run completed/i,
    screenshot: 't13-03-done-before-view.png',
  },
]

async function loadPlaywright() {
  try {
    return require('playwright')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      [
        'Playwright is not available to this Node process.',
        'Install it locally, or run:',
        '  tmp=/tmp/multicode-playwright',
        '  npm --prefix "$tmp" install playwright --no-audit --no-fund',
        '  NODE_PATH="$tmp/node_modules" node scripts/testing/sprintengine-live-glyph-harness.mjs',
        `Original error: ${message}`,
      ].join('\n'),
    )
  }
}

function isoNow() {
  return new Date().toISOString()
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function taskDirectory(status) {
  if (status === 'in_progress') return 'in_progress'
  if (status === 'needs_input') return 'needs_input'
  if (status === 'done') return 'done'
  return 'todo'
}

function setTaskState(task, state, now) {
  const next = deepClone(task)
  next.id = 'T13-SCRATCH'
  next.title = 'Scratch live glyph validation task'
  next.description = 'Schema-valid scratch task used by the live Electron glyph validation harness.'
  next.status = state.taskStatus
  next.stateStatus = state.taskStatus
  next.folderStatus = taskDirectory(state.taskStatus)
  next.boardColumn = state.taskBoardColumn
  next.ownerAgentId = state.ownerAgentId
  next.completedAt = state.taskStatus === 'done' ? now : null
  next.startedAt = state.taskStatus === 'todo' ? null : (next.startedAt || now)
  next.needsInput = state.needsInput
  next.activity = [
    ...(Array.isArray(task.activity) ? task.activity.slice(0, 1) : []),
    {
      id: `ACT-T13-${state.key}`,
      actor: state.ownerAgentId || 'sprintengine',
      type: state.taskStatus === 'needs_input' ? 'needs_input' : 'status_change',
      status: state.taskStatus,
      timestamp: now,
      message: `Scratch task moved to ${state.taskStatus}.`,
    },
  ]
  next.latestComments = []
  next.latestOpenFeedback = []
  next.comments = []
  next.qualityGates = []
  next.qualityGateSummary = []
  next.recordedArtifacts = []
  next.artifacts = []
  return next
}

function updateCounts(projection, status) {
  const taskStatuses = ['canceled', 'changes_requested', 'done', 'in_progress', 'needs_input', 'product', 'ready', 'review', 'testing', 'todo']
  projection.counts = projection.counts && typeof projection.counts === 'object' ? projection.counts : {}
  projection.counts.tasks = Object.fromEntries(taskStatuses.map((entry) => [entry, entry === status ? 1 : 0]))
  projection.counts.ready = status === 'ready' ? 1 : 0
  projection.counts.needsInput = status === 'needs_input' ? 1 : 0
  projection.counts.changesRequested = status === 'changes_requested' ? 1 : 0
}

async function writeScratchState(state, baseRun, baseProjection, baseTask) {
  const now = isoNow()
  const run = deepClone(baseRun)
  const projection = deepClone(baseProjection)
  const task = setTaskState(baseTask, state, now)
  const agentId = state.ownerAgentId || 'developer-1'

  run.name = teamSlug
  run.goal = 'Validate live Sprint Engine sidebar glyph progression.'
  run.status = state.taskStatus === 'done' ? 'complete' : 'executing'
  run.updatedAt = now
  run.sprintengine = {
    ...(run.sprintengine && typeof run.sprintengine === 'object' ? run.sprintengine : {}),
    name: teamName,
    goal: run.goal,
    updatedAt: now,
  }
  run.tasks = [task]
  run.artifacts = []
  run.agents = {
    [agentId]: {
      role: task.role,
      status: state.agentStatus,
      heartbeatAt: now,
      currentTaskId: state.taskStatus === 'done' ? null : task.id,
      currentDispatch: null,
      joinedAt: now,
      lastDirectiveAt: now,
      subscription: { mode: 'none' },
    },
  }
  run.roles = { [task.role]: { count: 1 } }

  projection.ok = true
  projection.source = 'folder_store'
  projection.generatedAt = now
  projection.updatedAt = now
  projection.statePath = statePath
  projection.planPath = join(teamDir, 'plan.md')
  projection.activity = task.activity
  projection.artifacts = []
  projection.tasks = [task]
  projection.roster = {
    [agentId]: {
      role: task.role,
      status: state.agentStatus,
      currentTaskId: state.taskStatus === 'done' ? null : task.id,
      currentDispatch: null,
    },
  }
  projection.run = {
    ...(projection.run && typeof projection.run === 'object' ? projection.run : {}),
    id: teamSlug,
    name: teamName,
    goal: run.goal,
    status: state.taskStatus === 'done' ? 'complete' : 'executing',
    rosterConfigured: true,
    updatedAt: now,
    runner: {
      cliWatchPolling: 'enabled',
      pollIntervalSeconds: 10,
      idleBackoffSeconds: 30,
      maxBackoffSeconds: 120,
      stopWhenComplete: true,
    },
  }
  projection.board = {
    columns: [
      {
        key: state.taskBoardColumn,
        label: state.taskBoardColumn,
        tasks: [task.id],
      },
    ],
  }
  updateCounts(projection, state.taskStatus)

  await writeFile(statePath, yaml.dump(run, { lineWidth: 120 }), 'utf8')
  await writeFile(projectionPath, `${JSON.stringify(projection, null, 2)}\n`, 'utf8')
  await writeFile(join(teamDir, 'plan.md'), '# T13 Scratch Sprint Engine Plan\n\nValidation-only scratch run.\n', 'utf8')
}

async function prepareFixture() {
  await rm(tempRoot, { recursive: true, force: true })
  await mkdir(teamDir, { recursive: true })
  await mkdir(screenshotDir, { recursive: true })

  await cp(sourceRunDir, teamDir, {
    recursive: true,
    filter: (source) => {
      const rel = source.slice(sourceRunDir.length).replace(/^\/+/u, '')
      if (!rel) return true
      return !rel.startsWith('runner/') && !rel.startsWith('metrics/')
    },
  })

  const baseRun = yaml.load(await readFile(resolve(sourceRunDir, 'run.yaml'), 'utf8'))
  const baseProjection = JSON.parse(await readFile(resolve(sourceRunDir, 'projection.json'), 'utf8'))
  const baseTask = baseProjection.tasks.find((task) => task.id === 'T9') ?? baseProjection.tasks[0]
  if (!baseRun || typeof baseRun !== 'object' || !baseTask) {
    throw new Error('Could not load a schema-valid source Sprint Engine run fixture.')
  }
  await writeScratchState(states[0], baseRun, baseProjection, baseTask)
  return { baseRun, baseProjection, baseTask }
}

async function seedEntitlements() {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
  const snapshot = {
    schemaVersion: 1,
    product: 'multicode',
    userId: 't13-validation-user',
    organizationId: 't13-validation-org',
    plan: { code: 'pro', status: 'active' },
    features: {
      'multicode.sprintengine': true,
    },
    limits: {},
    issuedAt: now.toISOString(),
    expiresAt,
  }
  await mkdir(userDataDir, { recursive: true })
  await writeFile(
    join(userDataDir, 'multiauth-entitlements-cache.json'),
    JSON.stringify({ snapshot, lastRefreshAt: now.toISOString() }, null, 2),
    'utf8',
  )
}

async function domClick(page, locator) {
  await locator.first().evaluate((el) => {
    if (el instanceof HTMLButtonElement) el.click()
    else if (el instanceof HTMLElement) el.click()
  })
  await page.waitForTimeout(500)
}

async function selectComboboxOption(page, comboboxName, optionText) {
  await domClick(page, page.getByRole('combobox', { name: comboboxName }))
  await domClick(page, page.getByRole('option', { name: optionText }))
}

async function waitForBodyText(page, text, timeout = 10000) {
  await page.waitForFunction(
    (expected) => document.body.innerText.includes(expected),
    text,
    { timeout },
  ).catch(async (error) => {
    const body = await getBody(page).catch(() => '')
    throw new Error(`Timed out waiting for body text "${text}". Body preview: ${body.slice(0, 3000)}\n${error.message}`)
  })
}

async function createWorkspace(page) {
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1200)
  await domClick(page, page.getByRole('button', { name: /Get started/i }))
  await domClick(page, page.getByRole('button', { name: /Continue/i }))
  await page.getByPlaceholder('my-workspace').fill('T13 Scratch Sprint Engine')
  await domClick(page, page.locator('button').filter({ hasText: 'Browse existing folder' }))
  await waitForBodyText(page, workspaceDir)
  await domClick(page, page.getByRole('button', { name: /^Continue$/i }))
  await waitForBodyText(page, 'Sprint Engine')
  await domClick(page, page.locator('button').filter({ hasText: /^Sprint Engine/ }))
  await domClick(page, page.getByRole('button', { name: /^Continue$/i }))
  await domClick(page, page.getByRole('button', { name: /^Continue$/i }))
  await domClick(page, page.getByRole('button', { name: /^Continue$/i }))
  await waitForBodyText(page, 'Load an existing team')
  await domClick(page, page.getByRole('radio', { name: /Load an existing team/i }))
  await selectComboboxOption(page, 'Team', teamName)
  await domClick(page, page.getByRole('button', { name: /^Continue$/i }))
  await waitForBodyText(page, 'Ready to load team.')
  await domClick(page, page.getByRole('radio', { name: /^Run agents\b/i }))
  await domClick(page, page.getByRole('button', { name: /Load team/i }))
  await waitForBodyText(page, 'Watching agent-managed state', 15000)
}

async function getBody(page) {
  return page.locator('body').innerText({ timeout: 5000 })
}

async function assertNoRenderError(page, stateKey) {
  const body = await getBody(page)
  if (/Error rendering component/i.test(body)) {
    throw new Error(`Sprint Engine board rendered an error in state ${stateKey}`)
  }
}

async function waitForGlyph(page, pattern, stateKey) {
  await page.waitForFunction(
    ({ source, flags }) => {
      const re = new RegExp(source, flags)
      return Array.from(document.querySelectorAll('[aria-label]')).some((el) => {
        const label = el.getAttribute('aria-label') || ''
        return re.test(label)
      })
    },
    { source: pattern.source, flags: pattern.flags },
    { timeout: 20000 },
  ).catch(async (error) => {
    const labels = await page.locator('[aria-label]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')).filter(Boolean))
    throw new Error(`Timed out waiting for ${stateKey} glyph ${pattern}; labels=${JSON.stringify(labels)}; ${error.message}`)
  })
}

async function captureState(page, state, result) {
  await waitForGlyph(page, state.expectedLabel, state.key)
  await assertNoRenderError(page, state.key)
  const path = join(screenshotDir, state.screenshot)
  await page.screenshot({ path, fullPage: true })
  result.screenshots.push(path)
  result.states.push({ state: state.key, screenshot: path, matched: String(state.expectedLabel) })
}

async function writeReport(result) {
  const finding = result.doneClearedAfterView
    ? 'No findings.'
    : [
        '### High - Completion seen-rule does not clear after viewing',
        '',
        'Impact: The T13 acceptance criteria require the completed Sprint Engine run glyph to persist before viewing the workspace and clear after viewing it. The live harness observed the done glyph before viewing, then selected/viewed the workspace and still observed `Run completed` on the sidebar row. This matches the current focused contract in `workspaceRunGlyph.test.ts`, which states completed runs keep the done glyph, but it conflicts with this task acceptance criterion.',
        '',
        'Reproduction: Run `NODE_PATH=/tmp/multicode-playwright/node_modules node scripts/testing/sprintengine-live-glyph-harness.mjs` after `npm run build`. Review `t13-03-done-before-view.png` and `t13-04-done-after-view.png`.',
        '',
        'Recommended fix: Clarify whether the desired product contract is persistent completion glyphs or clear-on-view completion acknowledgement. If clear-on-view is required, add a real workspace-level acknowledgement state and update `deriveSprintEngineWorkspaceRunGlyph` plus its focused tests.',
        '',
        'Owner role: developer',
      ].join('\n')

  const report = [
    '# Workspace Types Validation 3',
    '',
    'Task: T13 - Live scratch Sprint Engine run glyph/supervisor progression validation harness',
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    'Tester: developer-1',
    '',
    '## Summary',
    '',
    `The reusable harness \`scripts/testing/sprintengine-live-glyph-harness.mjs\` launched the built Electron app through Playwright \`_electron\` with an isolated profile at \`${userDataDir}\` and a scratch workspace at \`${workspaceDir}\`. It copied the schema shape from the real Sprint Engine run store, trimmed it to one complete task record, and advanced the scratch \`projection.json\` through \`in_progress\`, \`needs_input\`, and \`done\` without mutating renderer localStorage task or automation state.`,
    '',
    result.doneClearedAfterView
      ? 'The board rendered without `Error rendering component` at every state, sidebar glyphs transitioned through Running, Needs input, and Run completed, and the done glyph cleared after the workspace was viewed.'
      : 'The board rendered without `Error rendering component` at every state, and sidebar glyphs transitioned through Running, Needs input, and Run completed. The final clear-after-view expectation did not pass; the done glyph remained visible after viewing the workspace.',
    '',
    '## Environment',
    '',
    '- App launch: Playwright `_electron`',
    '- Electron entry: `out/main/index.js`',
    `- Scratch workspace: \`${workspaceDir}\``,
    `- Scratch run store: \`${statePath}\``,
    `- Isolated profile: \`${userDataDir}\``,
    '- Folder picker seam: `MULTICODE_TEST_OPEN_DIR`',
    '- Source run schema: current sprint run store copied from `.multi-code/sprintengine/2026-06-09-pluggable-workspace-and-contribution-apis`',
    '- Source changes: includes Sprint Engine completion acknowledgement in `src/**`; no diagnostic hook was added.',
    '',
    '## Commands',
    '',
    '```bash',
    'npm run build',
    'tmp=/tmp/multicode-playwright',
    'npm --prefix "$tmp" install playwright --no-audit --no-fund',
    'NODE_PATH="$tmp/node_modules" node scripts/testing/sprintengine-live-glyph-harness.mjs',
    '```',
    '',
    `Harness result: ${result.ok ? 'PASS' : 'FAIL'}.`,
    '',
    '## Screenshots',
    '',
    ...result.states.map((entry) => `- ${entry.state}: \`${entry.screenshot.replace(`${root}/`, '')}\``),
    `- done_after_view: \`${result.doneAfterViewScreenshot.replace(`${root}/`, '')}\``,
    '',
    '## Findings',
    '',
    finding,
    '',
  ].join('\n')
  await writeFile(reportPath, report, 'utf8')
}

async function main() {
  const result = {
    ok: false,
    states: [],
    screenshots: [],
    doneClearedAfterView: false,
    doneAfterViewScreenshot: join(screenshotDir, 't13-04-done-after-view.png'),
  }

  const { _electron: electron } = await loadPlaywright()
  const electronPath = require('electron')
  const fixture = await prepareFixture()
  await seedEntitlements()

  const app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out/main/index.js')],
    cwd: root,
    env: {
      ...process.env,
      MULTICODE_USER_DATA_DIR: userDataDir,
      MULTICODE_ALLOW_MULTI_INSTANCE: '1',
      MULTICODE_DIAGNOSTICS: '1',
      MULTICODE_TEST_OPEN_DIR: workspaceDir,
      MULTIAUTH_BASE_URL: 'http://127.0.0.1:9',
    },
  })

  try {
    const page = await app.firstWindow()
    page.on('console', (message) => {
      if (message.type() === 'error') console.error(`[renderer] ${message.text()}`)
    })

    await createWorkspace(page)
    await captureState(page, states[0], result)

    for (const state of states.slice(1)) {
      await writeScratchState(state, fixture.baseRun, fixture.baseProjection, fixture.baseTask)
      await captureState(page, state, result)
    }

    await domClick(page, page.getByText(teamName).first())
    await page.waitForTimeout(2500)
    await assertNoRenderError(page, 'done_after_view')
    await page.screenshot({ path: result.doneAfterViewScreenshot, fullPage: true })
    result.doneClearedAfterView = !(await page.locator('[aria-label*="Run completed"]').first().isVisible().catch(() => false))
    result.ok = result.doneClearedAfterView
  } finally {
    await app.close()
    await writeReport(result)
  }

  console.log(JSON.stringify({
    ok: result.ok,
    workspaceDir,
    userDataDir,
    statePath,
    reportPath,
    screenshots: [...result.screenshots, result.doneAfterViewScreenshot],
    states: result.states,
    doneClearedAfterView: result.doneClearedAfterView,
  }, null, 2))

  if (!result.ok) process.exit(1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})
