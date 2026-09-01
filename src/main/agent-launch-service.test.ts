import assert from 'node:assert/strict'

import type {
  McpCatalogResult,
  TerminalSessionSnapshot,
  TerminalSpawnResult,
} from '../shared/electron-api'
import type { SprintEngineLaunchSettings } from '../shared/sprintengine/launch-settings'
import { emptySprintEngineLaunchSettings } from '../shared/sprintengine/launch-settings'
import type { TerminalSpawnPayload } from './ipc/terminal-ipc'
import {
  createAgentLaunchService,
  type AgentLaunchServiceDeps,
  type AgentLaunchWorkspace,
} from './agent-launch-service'

const tests: Array<{ name: string; body: () => Promise<void> | void }> = []
function run(name: string, body: () => Promise<void> | void): void {
  tests.push({ name, body })
}

function workspace(overrides: Partial<AgentLaunchWorkspace> = {}): AgentLaunchWorkspace {
  return { id: 'ws-1', mode: 'standard', folderPath: '/repo/a', agents: {}, ...overrides }
}

function settings(overrides: Partial<SprintEngineLaunchSettings> = {}): SprintEngineLaunchSettings {
  return { ...emptySprintEngineLaunchSettings(), ...overrides }
}

function liveSession(overrides: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot {
  return {
    sessionId: 'session-live',
    processAlive: true,
    kind: 'agent',
    visible: false,
    suspended: false,
    reapExempt: false,
    startedAt: 0,
    lastOutputAt: null,
    lastInputAt: null,
    lastVisibleAt: null,
    activity: { kind: 'idle', since: 0 },
    exitedAt: null,
    outputBufferLength: 0,
    retainedOutputBytes: 0,
    ...overrides,
  }
}

/**
 * A launch service over fakes. There is no window, no Electron, and no pty
 * anywhere in this harness — which is the whole point of the item: composing a
 * launch must not need any of them.
 */
function harness(options: {
  workspaces?: AgentLaunchWorkspace[]
  settings?: SprintEngineLaunchSettings
  catalog?: McpCatalogResult
  sessions?: TerminalSessionSnapshot[]
  spawnResult?: TerminalSpawnResult
  resolveKnowledgeRoot?: AgentLaunchServiceDeps['resolveKnowledgeRoot']
  isAgentSelectableCli?: AgentLaunchServiceDeps['isAgentSelectableCli']
} = {}) {
  const spawns: TerminalSpawnPayload[] = []
  const kills: string[] = []
  const sessions = options.sessions ?? []
  const service = createAgentLaunchService({
    listWorkspaces: () => options.workspaces ?? [workspace()],
    getLaunchSettings: () => options.settings ?? settings(),
    listConnectorCatalog: () => options.catalog ?? { ok: true, servers: [] },
    ...(options.isAgentSelectableCli ? { isAgentSelectableCli: options.isAgentSelectableCli } : {}),
    ...(options.resolveKnowledgeRoot ? { resolveKnowledgeRoot: options.resolveKnowledgeRoot } : {}),
    terminal: {
      list: () => sessions,
      spawn: async (payload) => {
        spawns.push(payload)
        return options.spawnResult ?? { ok: true, sessionId: payload.sessionId }
      },
      kill: (sessionId) => kills.push(sessionId),
    },
    newSessionId: () => 'session-minted',
    newAgentSuffix: () => 'abc123',
  })
  return { service, spawns, kills, sessions }
}

run('composes a launch with no window: settings defaults reach the spawn', async () => {
  const app = harness({
    settings: settings({
      lastSelectedCli: 'claude-code',
      lastAgentSpawnPermissionPreset: 'auto',
      cliRuntimes: { 'claude-code': { command: '/usr/local/bin/claude', useWsl: false } },
      mcp: { syncEnabled: true, servers: {} },
    }),
  })

  const launched = await app.service.launch({ workspaceId: 'ws-1', prompt: 'go' })

  assert.equal(launched.ok, true, JSON.stringify(launched))
  assert.equal(launched.ok && launched.sessionId, 'session-minted')
  assert.equal(launched.ok && launched.agentId, 'agent-claude-code-abc123')
  assert.equal(app.spawns.length, 1)
  const spawn = app.spawns[0]!
  assert.equal(spawn.cli, 'claude-code', 'the last-selected CLI is the default')
  assert.equal(spawn.cliPermissionPreset, 'auto', 'the app-level spawn preset is the default')
  assert.equal(spawn.cwd, '/repo/a')
  assert.equal(spawn.initialPrompt, 'go')
  assert.equal(spawn.kind, 'agent')
  assert.equal(spawn.visible, false, 'nothing is bound to the session yet')
  assert.deepEqual(spawn.cliRuntimes, { 'claude-code': { command: '/usr/local/bin/claude', useWsl: false } })
  assert.deepEqual(spawn.mcpSettings, { syncEnabled: true, servers: {} })
  assert.equal(spawn.connectorLaunch, undefined, 'an ordinary launch never prunes the worktree MCP config')
})

run('an explicit request beats the stored defaults', async () => {
  const app = harness({
    settings: settings({ lastSelectedCli: 'claude-code', lastAgentSpawnPermissionPreset: 'bypass' }),
  })

  const launched = await app.service.launch({
    workspaceId: 'ws-1',
    cli: 'codex',
    name: 'Scout',
    cliModel: 'opus',
    permissionPreset: 'manual',
    worktreePath: '/repo/a/.worktrees/run-1',
    spawnSkillId: 'backlog',
  })

  assert.equal(launched.ok, true, JSON.stringify(launched))
  const spawn = app.spawns[0]!
  assert.equal(spawn.cli, 'codex')
  assert.equal(spawn.agentName, 'Scout')
  assert.equal(spawn.cliModel, 'opus')
  assert.equal(spawn.cliPermissionPreset, 'manual')
  assert.equal(spawn.spawnSkillId, 'backlog')
  assert.equal(spawn.cwd, '/repo/a/.worktrees/run-1', 'a worktree launch runs in the worktree, not the checkout')
  assert.equal(spawn.executionMode, 'worktree')
  assert.equal(spawn.worktreePath, '/repo/a/.worktrees/run-1')
})

run('no CLI anywhere refuses instead of guessing one', async () => {
  const app = harness({ settings: settings({ lastSelectedCli: null }) })
  const launched = await app.service.launch({ workspaceId: 'ws-1' })
  assert.equal(launched.ok, false)
  assert.equal(!launched.ok && launched.code, 'no_cli_selected')
  assert.equal(app.spawns.length, 0)
})

run('a CLI that cannot report agent state is refused, never substituted', async () => {
  // Hooks-only selectability: the predicate is manifest-derived in prod
  // (agentStateSpec presence); here it bans 'muse'. The refusal must cover a
  // stale persisted lastSelectedCli too — the caller typed nothing.
  const banned = harness({
    settings: settings({ lastSelectedCli: 'muse' }),
    isAgentSelectableCli: (cli) => cli !== 'muse',
  })
  const refused = await banned.service.launch({ workspaceId: 'ws-1' })
  assert.equal(!refused.ok && refused.code, 'cli_not_agent_selectable')
  assert.match(!refused.ok ? refused.message : '', /"muse"/)
  assert.equal(banned.spawns.length, 0, 'nothing may spawn on a refused CLI')

  // An eligible CLI passes the same gate untouched.
  const allowed = harness({
    settings: settings({ lastSelectedCli: 'claude-code' }),
    isAgentSelectableCli: (cli) => cli !== 'muse',
  })
  const launchedOk = await allowed.service.launch({ workspaceId: 'ws-1' })
  assert.equal(launchedOk.ok, true, !launchedOk.ok ? launchedOk.message : '')
})

run('an unknown or unsupported workspace refuses before spawning', async () => {
  const missing = harness()
  const unknown = await missing.service.launch({ workspaceId: 'nope' })
  assert.equal(!unknown.ok && unknown.code, 'unknown_workspace')

  const sprintHost = harness({
    workspaces: [workspace({ mode: 'sprintengine' })],
    settings: settings({ lastSelectedCli: 'codex' }),
  })
  const refused = await sprintHost.service.launch({ workspaceId: 'ws-1' })
  assert.equal(!refused.ok && refused.code, 'unsupported_workspace_mode')
  assert.equal(sprintHost.spawns.length, 0)

  // An automations host IS a valid launch target — the default route resolves one.
  const automationsHost = harness({
    workspaces: [workspace({ mode: 'automations-host' })],
    settings: settings({ lastSelectedCli: 'codex' }),
  })
  const allowed = await automationsHost.service.launch({ workspaceId: 'ws-1' })
  assert.equal(allowed.ok, true, JSON.stringify(allowed))
})

run('a folderless workspace refuses rather than spawning into the app directory', async () => {
  const app = harness({
    workspaces: [workspace({ folderPath: null })],
    settings: settings({ lastSelectedCli: 'codex' }),
  })
  const launched = await app.service.launch({ workspaceId: 'ws-1' })
  assert.equal(!launched.ok && launched.code, 'workspace_folder_missing')
  assert.equal(app.spawns.length, 0)
})

run('a specialist launch wraps the directive in the soul-fetch preamble', async () => {
  const app = harness({ settings: settings({ lastSelectedCli: 'claude-code' }) })
  const launched = await app.service.launch({
    workspaceId: 'ws-1',
    specialistId: 'security',
    prompt: 'Audit the auth flow.',
  })

  assert.equal(launched.ok, true, JSON.stringify(launched))
  const prompt = app.spawns[0]!.initialPrompt ?? ''
  assert.match(prompt, /souls get security/, 'the specialist fetches its Soul first')
  assert.match(prompt, /autonomous run/, 'and is told nobody will answer it')
  assert.match(prompt, /Audit the auth flow\./, 'the caller directive is carried verbatim')
  assert.equal(app.spawns[0]!.agentRecord?.kind, 'specialist')
  assert.equal(app.spawns[0]!.agentRecord?.specialistId, 'security')
})

run('a connector launch carries an isolated single-server MCP and prunes', async () => {
  const app = harness({
    settings: settings({ lastSelectedCli: 'claude-code', mcp: { syncEnabled: true, servers: {} } }),
    catalog: {
      ok: true,
      servers: [
        {
          id: 'railway',
          name: 'Railway',
          category: 'infrastructure',
          description: 'Railway',
          transport: 'stdio',
          command: 'railway-mcp',
          skill: 'use-railway',
        } as McpCatalogResult extends { ok: true; servers: Array<infer T> } ? T : never,
      ],
    },
  })

  const launched = await app.service.launch({ workspaceId: 'ws-1', connectorId: 'railway' })
  assert.equal(launched.ok, true, JSON.stringify(launched))
  const spawn = app.spawns[0]!
  assert.deepEqual(Object.keys(spawn.mcpSettings?.servers ?? {}), ['railway'], 'only the connector travels')
  assert.equal(spawn.connectorLaunch, true, 'so the worktree config is pruned to it')
  assert.equal(spawn.connectorSkillId, 'use-railway')
})

run('an unavailable connector fails loudly instead of launching a plain agent', async () => {
  const app = harness({
    settings: settings({ lastSelectedCli: 'claude-code' }),
    catalog: { ok: true, servers: [] },
  })
  const launched = await app.service.launch({ workspaceId: 'ws-1', connectorId: 'railway' })
  assert.equal(!launched.ok && launched.code, 'connector_unavailable')
  assert.equal(app.spawns.length, 0, 'the connector environment is never silently dropped')
})

run('names avoid both stored records and the names of live sessions', async () => {
  // Every name the pool could pick is already taken by a record or a live
  // session, so the collision suffix is the only honest answer left.
  const app = harness({
    workspaces: [workspace({ agents: { a: { name: 'Aed' } } })],
    settings: settings({ lastSelectedCli: 'codex' }),
    sessions: [liveSession({ workspaceId: 'ws-1', agentName: 'Aidan' })],
  })
  const launched = await app.service.launch({ workspaceId: 'ws-1' })
  assert.equal(launched.ok, true, JSON.stringify(launched))
  const name = app.spawns[0]!.agentName ?? ''
  assert.notEqual(name, 'Aed', 'a name held by a stored record is taken')
  assert.notEqual(name, 'Aidan', 'so is a name held only by a live session')
})

run('a failed spawn reports the failure rather than a launched agent', async () => {
  const app = harness({
    settings: settings({ lastSelectedCli: 'codex' }),
    spawnResult: { ok: false, sessionId: 'session-minted', message: 'codex is not installed', exitCode: 1 },
  })
  const launched = await app.service.launch({ workspaceId: 'ws-1' })
  assert.equal(!launched.ok && launched.code, 'agent_spawn_failed')
  assert.match(!launched.ok ? launched.message : '', /codex is not installed/)
})

run('the launch record rides the spawn so the renderer can project a tab', async () => {
  const app = harness({
    settings: settings({ lastSelectedCli: 'claude-code', lastAgentSpawnPermissionPreset: 'auto' }),
  })
  const launched = await app.service.launch({ workspaceId: 'ws-1', name: 'Scout', cliModel: 'opus' })
  assert.equal(launched.ok, true, JSON.stringify(launched))
  assert.deepEqual(app.spawns[0]!.agentRecord, {
    agentId: 'agent-claude-code-abc123',
    name: 'Scout',
    cli: 'claude-code',
    cliModel: 'opus',
    cliPermissionPreset: 'auto',
    kind: 'general',
  })
})

run("the project's Knowledge Graph reaches a headless launch", async () => {
  const app = harness({
    workspaces: [workspace({ folderPath: '/repo/a' })],
    settings: settings({
      lastSelectedCli: 'codex',
      projectKnowledgeRoots: { '/repo/a': 'knowledge' },
    }),
    resolveKnowledgeRoot: async () => ({ ok: true, rootPath: '/repo/a/knowledge', relativeRoot: 'knowledge' }),
  })

  const launched = await app.service.launch({ workspaceId: 'ws-1', prompt: 'Do the thing.' })
  assert.equal(launched.ok, true, JSON.stringify(launched))
  const spawn = app.spawns[0]!
  // The env half: what actually sets MULTICODE_KNOWLEDGE_ROOT for the session.
  assert.equal(spawn.memoryRootPath, '/repo/a/knowledge')
  assert.equal(spawn.memoryRelativeRoot, 'knowledge')
  // And the prompt half, which is what tells the AGENT the graph is there.
  assert.match(spawn.initialPrompt ?? '', /Do the thing\./)
  assert.match(spawn.initialPrompt ?? '', /Knowledge Graph is configured at knowledge\./)
})

run('a configured-but-unreadable Knowledge Graph is said out loud, not dropped', async () => {
  const app = harness({
    workspaces: [workspace({ folderPath: '/repo/a' })],
    settings: settings({ lastSelectedCli: 'codex', projectKnowledgeRoots: { '/repo/a': 'knowledge' } }),
    resolveKnowledgeRoot: async () => {
      throw new Error('disk is on fire')
    },
  })

  const launched = await app.service.launch({ workspaceId: 'ws-1' })
  // A graph that cannot be read must not fail the launch, and the agent must be
  // told rather than left to guess another folder.
  assert.equal(launched.ok, true, JSON.stringify(launched))
  assert.equal(app.spawns[0]!.memoryRootPath, undefined)
  assert.match(app.spawns[0]!.initialPrompt ?? '', /Do not guess another knowledge folder\./)
})

run('a project with no Knowledge Graph launches with no graph and no line', async () => {
  const app = harness({ settings: settings({ lastSelectedCli: 'codex' }) })
  const launched = await app.service.launch({ workspaceId: 'ws-1', prompt: 'go' })
  assert.equal(launched.ok, true, JSON.stringify(launched))
  assert.equal(app.spawns[0]!.memoryRootPath, undefined)
  assert.equal(app.spawns[0]!.initialPrompt, 'go')
})

run('the launch carries an execution identity, or the run could never finalize', async () => {
  // Without `agentSession` the runtime fires NO agent-session exit for this
  // terminal (the listener is gated on `agentSession?.executionId`) and
  // `resolveAgentExecutionId` never matches it — an agent-backed automation run
  // would start and have no way to end, and its teardown could not find the
  // terminal to kill. This is the field that makes both work.
  const app = harness({
    workspaces: [workspace({ folderPath: '/repo/a' })],
    settings: settings({ lastSelectedCli: 'codex' }),
  })
  const launched = await app.service.launch({
    workspaceId: 'ws-1',
    name: 'Scout',
    worktreePath: '/repo/a/.worktrees/run-1',
  })
  assert.equal(launched.ok, true, JSON.stringify(launched))
  assert.deepEqual(app.spawns[0]!.agentSession, {
    executionId: 'session-minted',
    system: 'manual',
    workspaceId: 'ws-1',
    // The PROJECT root, never the run worktree: the engine's teardown matches a
    // run's sessions on the workspace root it was launched for.
    workspaceRoot: '/repo/a',
    workId: 'agent-codex-abc123',
    role: 'general',
    displayName: 'Scout',
  })
})

run('dispose kills the agent\'s live sessions and is idempotent', () => {
  const app = harness({
    sessions: [
      liveSession({ sessionId: 'session-a', workspaceId: 'ws-1', agentId: 'agent-1' }),
      liveSession({ sessionId: 'session-b', workspaceId: 'ws-1', agentId: 'agent-2' }),
      liveSession({ sessionId: 'session-c', workspaceId: 'ws-2', agentId: 'agent-1' }),
      liveSession({ sessionId: 'session-d', kind: 'terminal', workspaceId: 'ws-1', agentId: 'agent-1' }),
    ],
  })

  const first = app.service.dispose({ workspaceId: 'ws-1', agentId: 'agent-1' })
  assert.equal(first.ok, true)
  assert.deepEqual(app.kills, ['session-a'], 'only THIS agent in THIS workspace, and only agent sessions')

  // A second finalize for the same agent must stay benign.
  const again = app.service.dispose({ workspaceId: 'ws-1', agentId: 'missing' })
  assert.equal(again.ok, true)
  assert.deepEqual(app.kills, ['session-a'])
})

async function main(): Promise<void> {
  let failed = false
  for (const test of tests) {
    try {
      await test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      failed = true
      console.error(`not ok - ${test.name}`)
      console.error(error)
    }
  }
  if (failed) process.exit(1)
  console.log('agent-launch-service.test.ts: ok')
}

void main()
