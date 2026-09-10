import assert from 'node:assert/strict'

// What Enter on a palette extension row does — and, more to the point, what it
// refuses to do.
//
// The safety assertion is `planPluginRow`: a plugin's hooks are shell commands
// that run on the agent's tool calls, and a search box that installed them on
// Enter would be the worst affordance in the app. Everything a scan cannot
// vouch for — hooks, an unread linked repository, a choice of skills, a
// first-party registry entry — must come back as a deep link, never an install.

import type {
  AgentSkillTarget,
  TerminalSessionSnapshot,
  WorkspaceSkill,
} from '../../../../shared/electron-api'
import {
  decidePaletteTarget,
  installPluginRow,
  planPluginRow,
  useSkillRowInAgent,
  type ExtensionsActionApi,
} from './extensionsActions'
import type { ExtensionPluginRow, ExtensionSkillRow } from './extensionsProvider'
import { AGENT_NO_LONGER_RUNNING_MESSAGE, type LiveAgentSession } from '../../utils/useSkillInAgent'

let failures = 0
// Each case installs its OWN fake bridge on `globalThis.window`, so they are
// queued and run one at a time rather than interleaved: two overlapping cases
// would record their calls into each other's list.
const queue: (() => Promise<void>)[] = []
function run(name: string, body: () => void | Promise<void>): void {
  queue.push(async () => {
    try {
      await body()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  })
}

// ── A fake bridge ────────────────────────────────────────────────────────────

type Call = { name: string; input: unknown }

const REVIEW: WorkspaceSkill = {
  id: 'review',
  name: 'review',
  source: 'custom',
  harnesses: ['claude'],
  installState: 'installed',
}

const LIVE_SESSION: TerminalSessionSnapshot = {
  sessionId: 'session-1',
  kind: 'agent',
  processAlive: true,
} as unknown as TerminalSessionSnapshot

const WRITTEN: AgentSkillTarget = {
  harnessId: 'claude',
  pluginIds: ['claude-code'],
  path: '.claude/skills/review',
  restartRequired: false,
  status: 'written',
}

function fakeBridge(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = []
  const record = <T>(name: string, result: T) => async (input?: unknown) => {
    calls.push({ name, input })
    return result
  }
  const api = {
    skillsInstall: record('skillsInstall', { ok: true, dirName: 'review', harnesses: ['claude'], paths: [], fileCount: 3 }),
    skillsInstallPlugin: record('skillsInstallPlugin', {
      ok: true,
      plugin: {},
      harnesses: [{ harness: 'claude', mode: 'skills', skillDirNames: ['send'], message: '' }],
      mcpServers: [],
      claudePluginKey: '',
      pluginRoot: '',
      pluginFileCount: 0,
      warnings: [],
    }),
    workspaceSkillsList: record('workspaceSkillsList', { ok: true, skills: [REVIEW, { ...REVIEW, id: 'send', name: 'send' }] }),
    agentSkillAttach: record('agentSkillAttach', { ok: true, skillId: 'review', targets: [WRITTEN] }),
    terminalList: record('terminalList', [LIVE_SESSION]),
    terminalWrite: record('terminalWrite', undefined),
    builtinSkillStatus: record('builtinSkillStatus', { ok: false }),
    ...overrides,
  }
  ;(globalThis as unknown as { window: unknown }).window = { api }
  return { api: api as unknown as ExtensionsActionApi, calls }
}

const skillRow = (overrides: Partial<ExtensionSkillRow> = {}): ExtensionSkillRow => ({
  kind: 'skill',
  id: 'ext-skill-acme-skills/review',
  sourceId: 'acme',
  sourceName: 'Acme',
  skillId: 'skills/review',
  dirName: 'review',
  name: 'review',
  description: '',
  keywords: '',
  icon: {},
  installed: false,
  ...overrides,
})

const pluginRow = (overrides: Partial<ExtensionPluginRow> = {}): ExtensionPluginRow => ({
  kind: 'plugin',
  id: 'ext-plugin-acme-telegram',
  sourceId: 'acme',
  sourceName: 'Acme',
  pluginId: 'telegram',
  name: 'Telegram',
  description: '',
  keywords: '',
  icon: {},
  registry: false,
  hooks: false,
  mcp: false,
  componentsKnown: true,
  skillDirNames: ['send'],
  ...overrides,
})

// ── Skills ───────────────────────────────────────────────────────────────────

run('an uninstalled skill is installed from its source, then pasted at the chosen agent', async () => {
  const { api, calls } = fakeBridge()
  const used = await useSkillRowInAgent({
    row: skillRow(),
    workspaceRoot: '/repo',
    session: { sessionId: 'session-1', cli: 'claude-code' },
    api,
  })
  assert.equal(used.ok, true, used.ok ? '' : used.message)
  const names = calls.map((call) => call.name)
  assert.deepEqual(
    names.filter((name) => name === 'skillsInstall' || name === 'agentSkillAttach' || name === 'terminalWrite'),
    ['skillsInstall', 'agentSkillAttach', 'terminalWrite'],
    'install, then attach where the CLI reads skills, then paste — in that order',
  )
  assert.deepEqual(calls[0].input, { sourceId: 'acme', skillId: 'skills/review', workspaceRoot: '/repo' })
  const write = calls.find((call) => call.name === 'terminalWrite')
  assert.equal(write?.input, 'session-1', 'the paste goes to the session the caller named, with no menu')
})

run('a skill the workspace already has is not installed again', async () => {
  const { api, calls } = fakeBridge()
  const used = await useSkillRowInAgent({
    row: skillRow({ installed: true }),
    workspaceRoot: '/repo',
    session: { sessionId: 'session-1', cli: 'claude-code' },
    api,
  })
  assert.equal(used.ok, true)
  assert.equal(calls.some((call) => call.name === 'skillsInstall'), false)
  assert.equal(calls.some((call) => call.name === 'terminalWrite'), true)
})

run('the inventory is resolved by the DIRECTORY the install reported, not the source path', async () => {
  // A source-relative id carries the whole `plugins/x/skills/y` path; the
  // workspace files the skill under the last segment alone. Resolving by the
  // wrong one is a skill that installs and then cannot be found.
  const { api, calls } = fakeBridge({
    skillsInstall: async () => ({ ok: true, dirName: 'review', harnesses: ['claude'], paths: [], fileCount: 1 }),
  })
  await useSkillRowInAgent({
    row: skillRow({ skillId: 'plugins/acme/skills/review' }),
    workspaceRoot: '/repo',
    session: { sessionId: 'session-1' },
    api,
  })
  const attach = calls.find((call) => call.name === 'agentSkillAttach')
  assert.deepEqual(attach?.input, { workspaceRoot: '/repo', skillId: 'review' })
})

run('a failed install stops before anything is pasted, and says why', async () => {
  const { api, calls } = fakeBridge({
    skillsInstall: async () => ({ ok: false, message: 'That repository could not be read.' }),
  })
  const used = await useSkillRowInAgent({
    row: skillRow(),
    workspaceRoot: '/repo',
    session: { sessionId: 'session-1' },
    api,
  })
  assert.equal(used.ok, false)
  assert.equal(used.ok === false ? used.message : '', 'That repository could not be read.')
  assert.equal(calls.some((call) => call.name === 'terminalWrite'), false)
})

run('with no folder open there is nowhere to install to, and it says so', async () => {
  const { api, calls } = fakeBridge()
  const used = await useSkillRowInAgent({
    row: skillRow(),
    workspaceRoot: null,
    session: { sessionId: 'session-1' },
    api,
  })
  assert.equal(used.ok, false)
  assert.match(used.ok === false ? used.message : '', /Open a folder/)
  assert.deepEqual(calls, [], 'nothing is attempted')
})

// ── Plugins ──────────────────────────────────────────────────────────────────

run('a plugin that declares hooks is a page, never a one-press install', () => {
  const plan = planPluginRow(pluginRow({ hooks: true }))
  assert.deepEqual(plan, { kind: 'deep-link', reason: 'hooks' })
})

// The main process does not gate MCP servers the way it gates hooks, so this
// is the only place the ruling can live: a stdio server is a command the CLI
// will launch, and a palette row never showed it (review, 2026-09-10).
run('a plugin that declares MCP servers is a page too — nothing gates them downstream', () => {
  assert.deepEqual(planPluginRow(pluginRow({ mcp: true })), { kind: 'deep-link', reason: 'mcp' })
})

run('the other three shapes a scan cannot vouch for are pages too', () => {
  assert.equal(planPluginRow(pluginRow({ componentsKnown: false })).kind, 'deep-link')
  assert.equal(planPluginRow(pluginRow({ skillDirNames: ['a', 'b'] })).kind, 'deep-link')
  assert.equal(planPluginRow(pluginRow({ skillDirNames: [] })).kind, 'deep-link')
  assert.equal(planPluginRow(pluginRow({ registry: true })).kind, 'deep-link')
  assert.deepEqual(
    [
      planPluginRow(pluginRow({ componentsKnown: false })),
      planPluginRow(pluginRow({ skillDirNames: ['a', 'b'] })),
      planPluginRow(pluginRow({ skillDirNames: [] })),
      planPluginRow(pluginRow({ registry: true })),
    ].map((plan) => (plan.kind === 'deep-link' ? plan.reason : null)),
    ['unread', 'choice', 'nothing-to-run', 'registry'],
  )
})

run('a read, hook-free, single-skill plugin is the one that installs on Enter', () => {
  assert.deepEqual(planPluginRow(pluginRow()), { kind: 'install-and-use', skillDirName: 'send' })
})

run('the plugin install never claims the hooks were acknowledged', async () => {
  const { api, calls } = fakeBridge()
  await installPluginRow({ row: pluginRow(), workspaceRoot: '/repo', skillDirName: 'send', api })
  const install = calls.find((call) => call.name === 'skillsInstallPlugin')
  assert.deepEqual(install?.input, { sourceId: 'acme', pluginId: 'telegram', workspaceRoot: '/repo' })
  assert.equal(
    (install?.input as Record<string, unknown>).acknowledgedHooks,
    undefined,
    'a mis-wired caller is refused by main rather than obeyed',
  )
})

run('the install receipt outranks the scan on which directory now exists', async () => {
  const { api, calls } = fakeBridge({
    skillsInstallPlugin: async () => ({
      ok: true,
      plugin: {},
      harnesses: [{ harness: 'claude', mode: 'skills', skillDirNames: ['send'], message: '' }],
      mcpServers: [],
      claudePluginKey: '',
      pluginRoot: '',
      pluginFileCount: 0,
      warnings: [],
    }),
  })
  const resolved = await installPluginRow({
    row: pluginRow({ skillDirNames: ['stale-guess'] }),
    workspaceRoot: '/repo',
    skillDirName: 'stale-guess',
    api,
  })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.ok ? resolved.skill.id : '', 'send')
  assert.equal(calls.some((call) => call.name === 'workspaceSkillsList'), true)
})

// ── Which agent ──────────────────────────────────────────────────────────────
// The star names a session. That is an instruction, not a hint: honoured while
// it is live, and never swapped for "the one agent left" once it is not —
// because the one left is exactly the one the person did not point at.

const live = (sessionId: string, agentId: string): LiveAgentSession =>
  ({ sessionId, agentId, workspaceId: 'ws', label: agentId, snapshot: {} as never }) as LiveAgentSession

run('the pane the palette was opened for is used while it is live', () => {
  const sessions = [live('s1', 'a1'), live('s2', 'a2')]
  const decision = decidePaletteTarget(sessions, { sessionId: 's2' }, 'a1')
  assert.equal(decision.kind, 'use')
  assert.equal(decision.kind === 'use' ? decision.session.sessionId : '', 's2', 'over the focused agent')
})

run('a named pane that has exited is a question with a reason, not a guess at the one agent left', () => {
  const decision = decidePaletteTarget([live('s2', 'a2')], { sessionId: 's1' }, 'a2')
  assert.deepEqual(decision, { kind: 'ask', notice: AGENT_NO_LONGER_RUNNING_MESSAGE })
})

run('with no pane named, the focused agent wins, then a lone live agent, then a question', () => {
  const two = [live('s1', 'a1'), live('s2', 'a2')]
  assert.equal(
    (decidePaletteTarget(two, null, 'a2') as { session: LiveAgentSession }).session.sessionId,
    's2',
  )
  assert.equal(
    (decidePaletteTarget([live('s1', 'a1')], null, undefined) as { session: LiveAgentSession }).session.sessionId,
    's1',
  )
  assert.deepEqual(decidePaletteTarget(two, null, 'gone'), { kind: 'ask', notice: null })
  assert.deepEqual(decidePaletteTarget([], null, null), { kind: 'ask', notice: null })
})

async function main(): Promise<void> {
  for (const step of queue) await step()
  if (failures > 0) {
    console.error(`extensionsActions: ${failures} assertion group(s) failed`)
    process.exitCode = 1
    return
  }
  console.log('extensionsActions: all assertions passed')
}

void main()
