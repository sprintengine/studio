import assert from 'node:assert/strict'

import {
  buildRosterSessionFromAgent,
  selectSprintEngineTeardownAgentIds,
  tearDownCompletedSprintRunAgents,
  tearDownDepartedTaskScopedWorker,
  type SprintEngineRunTeardownPorts,
} from './sprintengineRunTeardown'
import type { AgentState, Workspace } from '../types/workspace'

function agent(overrides: Partial<AgentState>): AgentState {
  return {
    id: 'architect',
    name: 'Architect',
    kind: 'sprintengine',
    ...overrides,
  } as AgentState
}

// --- selectSprintEngineTeardownAgentIds ---

// 1. Only sprintengine agents are selected; other kinds are left untouched.
{
  const ids = selectSprintEngineTeardownAgentIds({
    architect: agent({ id: 'architect', kind: 'sprintengine' }),
    'dev-1': agent({ id: 'dev-1', kind: 'sprintengine' }),
    chat: agent({ id: 'chat', kind: 'general' }),
  })
  assert.deepEqual(ids.sort(), ['architect', 'dev-1'])
}

// --- buildRosterSessionFromAgent ---

// 2. An agent that launched a claude session yields a resumable record.
{
  const session = buildRosterSessionFromAgent(
    agent({ cli: 'claude-code', cliSessionId: 'sess-1', cliModel: 'opus', name: 'Archie' }),
    'architect',
    undefined,
    1000,
  )
  assert.deepEqual(session, {
    role: 'architect',
    cli: 'claude-code',
    cliSessionId: 'sess-1',
    harnessSessionId: undefined,
    cliModel: 'opus',
    name: 'Archie',
    recordedAt: 1000,
  })
}

// 3. Codex: the live session's harness id is preferred when the agent's own copy
//    has not caught up.
{
  const session = buildRosterSessionFromAgent(
    agent({ cli: 'codex', cliSessionId: 'term-2', harnessSessionId: undefined }),
    'developer',
    'harness-xyz',
    2000,
  )
  assert.equal(session?.harnessSessionId, 'harness-xyz')
}

// 4. An agent that never launched a CLI session is not resumable → null.
{
  assert.equal(buildRosterSessionFromAgent(agent({ cli: 'claude-code', cliSessionId: undefined }), 'architect', undefined, 0), null)
  assert.equal(buildRosterSessionFromAgent(agent({ cli: undefined, cliSessionId: 'x' }), 'architect', undefined, 0), null)
}

// --- tearDownCompletedSprintRunAgents ---

function agentTabLayout(...agentIds: string[]): unknown {
  return {
    global: {},
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          children: agentIds.map((id) => ({
            type: 'tab',
            name: id,
            component: 'agent',
            config: { agentId: id },
          })),
        },
      ],
    },
  }
}

function makeWorkspace(agents: Record<string, AgentState>, layoutModel?: unknown): Workspace {
  return {
    id: 'ws-1',
    name: 'design-system-platform',
    agents,
    layoutModel,
    sprintEngineContext: { statePath: '/proj/.multi-code/sprintengine/x/run.yaml' },
    sprintEngineState: {
      sprintEngineAgents: {
        architect: { role: 'architect' },
        'dev-1': { role: 'developer' },
      },
    },
  } as unknown as Workspace
}

function stubPorts(workspace: Workspace, sessions: TerminalSessionSnapshot[]): {
  ports: SprintEngineRunTeardownPorts
  recorded: Record<string, unknown>
  removed: string[]
  removedTabs: string[]
  killed: string[]
  layoutUpdates: string[]
  diagnostics: string[]
  setLiveModelMounted: (mounted: boolean) => void
} {
  const recorded: Record<string, unknown> = {}
  const removed: string[] = []
  const removedTabs: string[] = []
  const killed: string[] = []
  const layoutUpdates: string[] = []
  const diagnostics: string[] = []
  // When false, simulate an unmounted workspace: removeAgentTab reports nothing
  // removed so teardown falls back to stripping the persisted layout.
  let liveModelMounted = true
  const ports: SprintEngineRunTeardownPorts = {
    terminalList: async () => sessions,
    terminalKill: async (sessionId) => {
      killed.push(sessionId)
    },
    getWorkspace: () => workspace,
    upsertRosterSession: (_ws, agentId, session) => {
      recorded[agentId] = session
    },
    removeAgent: (_ws, agentId) => {
      removed.push(agentId)
      delete workspace.agents[agentId]
    },
    removeAgentTab: (_ws, agentId) => {
      removedTabs.push(agentId)
      return liveModelMounted
    },
    updateLayout: (_ws, model) => {
      layoutUpdates.push(JSON.stringify(model))
    },
    publishDiagnostic: (input) => {
      diagnostics.push((input as { title: string }).title)
    },
    now: () => 5000,
  }
  return {
    ports,
    recorded,
    removed,
    removedTabs,
    killed,
    layoutUpdates,
    diagnostics,
    setLiveModelMounted: (mounted: boolean) => {
      liveModelMounted = mounted
    },
  }
}

void (async () => {
  // 5. Full teardown: records the live session, kills the PTY, removes tab + agent.
  {
    const workspace = makeWorkspace({
      architect: agent({ id: 'architect', cli: 'claude-code', cliSessionId: 'sess-arch' }),
      'dev-1': agent({ id: 'dev-1', cli: 'claude-code', cliSessionId: 'sess-dev' }),
    })
    const sessions = [
      {
        sessionId: 'sess-arch',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'ws-1',
        agentId: 'architect',
        sprintEngineStatePath: '/proj/.multi-code/sprintengine/x/run.yaml',
      } as unknown as TerminalSessionSnapshot,
    ]
    const { ports, recorded, removed, removedTabs, killed, diagnostics } = stubPorts(workspace, sessions)
    const result = await tearDownCompletedSprintRunAgents('ws-1', ports)

    assert.deepEqual(removed.sort(), ['architect', 'dev-1'], 'both agents removed')
    assert.deepEqual(removedTabs.sort(), ['architect', 'dev-1'], 'both tabs removed')
    assert.deepEqual(killed, ['sess-arch'], 'only the live session is killed')
    assert.equal((recorded.architect as { cliSessionId: string }).cliSessionId, 'sess-arch')
    assert.equal((recorded['dev-1'] as { cliSessionId: string }).cliSessionId, 'sess-dev', 'idle agent still recorded for resume')
    assert.deepEqual(result.removedAgentIds.sort(), ['architect', 'dev-1'])
    assert.deepEqual(result.closedSessionIds, ['sess-arch'])
    assert.deepEqual(diagnostics, ['Sprint complete — agent terminals closed'], 'user-visible teardown toasts once')
  }

  // 6. No sprint agents → no-op (idempotent on later polls).
  {
    const workspace = makeWorkspace({ chat: agent({ id: 'chat', kind: 'general' }) })
    const { ports, removed } = stubPorts(workspace, [])
    const result = await tearDownCompletedSprintRunAgents('ws-1', ports)
    assert.deepEqual(removed, [])
    assert.deepEqual(result.removedAgentIds, [])
  }

  // 7. terminalList failure still removes the panels (panel removal is the priority).
  {
    const workspace = makeWorkspace({
      architect: agent({ id: 'architect', cli: 'claude-code', cliSessionId: 'sess-arch' }),
    })
    const { ports, removed, killed } = stubPorts(workspace, [])
    ports.terminalList = async () => {
      throw new Error('IPC down')
    }
    const result = await tearDownCompletedSprintRunAgents('ws-1', ports)
    assert.deepEqual(removed, ['architect'], 'panel removed despite IPC failure')
    assert.deepEqual(killed, [], 'nothing killed when the list failed')
    assert.deepEqual(result.removedAgentIds, ['architect'])
  }

  // 8. Unmounted workspace: removeAgentTab reports nothing removed (no live
  //    Model), so the tab is stripped from the persisted layout instead.
  {
    const workspace = makeWorkspace(
      { architect: agent({ id: 'architect', cli: 'claude-code', cliSessionId: 'sess-arch' }) },
      agentTabLayout('architect'),
    )
    const stub = stubPorts(workspace, [])
    stub.setLiveModelMounted(false)
    await tearDownCompletedSprintRunAgents('ws-1', stub.ports)

    assert.deepEqual(stub.removed, ['architect'])
    assert.equal(stub.layoutUpdates.length, 1, 'persisted layout stripped when workspace unmounted')
    assert.equal(
      stub.layoutUpdates[0].includes('"agentId":"architect"'),
      false,
      'architect agent tab removed from the persisted layout',
    )
  }

  // 9. Mounted workspace (removeAgentTab succeeds): no persisted-layout write —
  //    the live Model's onModelChange owns the sync.
  {
    const workspace = makeWorkspace(
      { architect: agent({ id: 'architect', cli: 'claude-code', cliSessionId: 'sess-arch' }) },
      agentTabLayout('architect'),
    )
    const stub = stubPorts(workspace, [])
    stub.setLiveModelMounted(true)
    await tearDownCompletedSprintRunAgents('ws-1', stub.ports)
    assert.deepEqual(stub.layoutUpdates, [], 'no persisted-layout write when the live Model handled it')
  }

  // 10. Suspended session (the idle reaper froze the agent, processAlive=false):
  //     still recorded — its captured harness id is the codex resume token — and
  //     disposed via kill so the session record and snapshot sidecar are not
  //     orphaned. A plainly-exited session is left alone.
  {
    const workspace = makeWorkspace({
      architect: agent({ id: 'architect', cli: 'claude-code', cliSessionId: 'sess-arch' }),
      'dev-1': agent({ id: 'dev-1', cli: 'codex', cliSessionId: 'term-dev', harnessSessionId: undefined }),
    })
    const sessions = [
      {
        sessionId: 'term-dev',
        processAlive: false,
        suspended: true,
        kind: 'agent',
        workspaceId: 'ws-1',
        agentId: 'dev-1',
        cliSessionId: 'harness-123',
        sprintEngineStatePath: '/proj/.multi-code/sprintengine/x/run.yaml',
      } as unknown as TerminalSessionSnapshot,
      // Exited (not suspended) session: nothing to kill or dispose.
      {
        sessionId: 'sess-arch',
        processAlive: false,
        suspended: false,
        kind: 'agent',
        workspaceId: 'ws-1',
        agentId: 'architect',
        sprintEngineStatePath: '/proj/.multi-code/sprintengine/x/run.yaml',
      } as unknown as TerminalSessionSnapshot,
    ]
    const { ports, recorded, killed } = stubPorts(workspace, sessions)
    await tearDownCompletedSprintRunAgents('ws-1', ports)

    assert.deepEqual(killed, ['term-dev'], 'suspended session disposed; exited session left alone')
    assert.equal(
      (recorded['dev-1'] as { harnessSessionId?: string }).harnessSessionId,
      'harness-123',
      'suspended session still supplies the harness resume token',
    )
  }

  // 11. Tab-less teardown (reopened run whose panels were already removed —
  //     roster records recreated by a projection read): silent, no toast.
  {
    const workspace = makeWorkspace(
      { architect: agent({ id: 'architect', cli: 'claude-code', cliSessionId: 'sess-arch' }) },
      agentTabLayout(), // persisted layout has no agent tabs
    )
    const stub = stubPorts(workspace, [])
    stub.setLiveModelMounted(false)
    await tearDownCompletedSprintRunAgents('ws-1', stub.ports)

    assert.deepEqual(stub.removed, ['architect'], 'recreated record still removed')
    assert.deepEqual(stub.diagnostics, [], 'nothing user-visible closed → no toast')
  }

  // --- tearDownDepartedTaskScopedWorker (mid-run, MC-1444 B4) ---

  // 12. Departed done-worker: records its resumable session, kills the PTY, and
  //     removes only its panel/agent (the sibling is untouched → no respawn).
  {
    const workspace = makeWorkspace({
      architect: agent({ id: 'architect', cli: 'claude-code', cliSessionId: 'sess-arch' }),
      'dev-1': agent({ id: 'dev-1', cli: 'claude-code', cliSessionId: 'sess-dev', cliModel: 'opus', name: 'Dev' }),
    })
    const sessions = [
      {
        sessionId: 'sess-dev',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'ws-1',
        agentId: 'dev-1',
        sprintEngineStatePath: '/proj/.multi-code/sprintengine/x/run.yaml',
      } as unknown as TerminalSessionSnapshot,
    ]
    const { ports, recorded, removed, removedTabs, killed } = stubPorts(workspace, sessions)
    const result = await tearDownDepartedTaskScopedWorker('ws-1', 'dev-1', ports)

    assert.deepEqual(removed, ['dev-1'], 'only the departed worker is removed')
    assert.deepEqual(removedTabs, ['dev-1'], 'its tab is removed')
    assert.deepEqual(killed, ['sess-dev'], 'its live PTY is disposed')
    assert.equal((recorded['dev-1'] as { cliSessionId: string }).cliSessionId, 'sess-dev', 'resumable session recorded')
    assert.equal((recorded['dev-1'] as { role: string }).role, 'developer')
    assert.equal(Boolean(workspace.agents.architect), true, 'the sibling panel is untouched')
    assert.deepEqual(
      { recorded: result.recorded, removedAgent: result.removedAgent, removedTab: result.removedTab, closedSessionId: result.closedSessionId },
      { recorded: true, removedAgent: true, removedTab: true, closedSessionId: 'sess-dev' },
    )
  }

  // 13. Idempotent: an already-torn-down worker recreated tab-less with no live
  //     session records nothing and closes nothing (caller suppresses the toast),
  //     though the stale record is still removed.
  {
    const workspace = makeWorkspace(
      { 'dev-1': agent({ id: 'dev-1', cli: 'claude-code', cliSessionId: undefined }) },
      agentTabLayout(), // no agent tabs in the persisted layout
    )
    const stub = stubPorts(workspace, [])
    stub.setLiveModelMounted(false)
    const result = await tearDownDepartedTaskScopedWorker('ws-1', 'dev-1', stub.ports)

    assert.deepEqual(stub.removed, ['dev-1'], 'stale record still removed')
    assert.deepEqual(stub.recorded, {}, 'nothing resumable to record')
    assert.deepEqual(stub.killed, [], 'no live session to kill')
    assert.equal(result.removedTab, false, 'no visible tab closed')
    assert.equal(result.closedSessionId, null)
    assert.equal(result.recorded, false)
  }

  // 14. Unmounted workspace: removeAgentTab reports nothing removed, so the
  //     departed worker's tab is stripped from the persisted layout instead.
  {
    const workspace = makeWorkspace(
      { 'dev-1': agent({ id: 'dev-1', cli: 'claude-code', cliSessionId: 'sess-dev' }) },
      agentTabLayout('dev-1'),
    )
    const stub = stubPorts(workspace, [])
    stub.setLiveModelMounted(false)
    const result = await tearDownDepartedTaskScopedWorker('ws-1', 'dev-1', stub.ports)

    assert.equal(stub.layoutUpdates.length, 1, 'persisted layout stripped when workspace unmounted')
    assert.equal(stub.layoutUpdates[0].includes('"agentId":"dev-1"'), false, 'dev-1 tab removed from persisted layout')
    assert.equal(result.removedTab, true, 'a persisted-layout tab counts as a visible removal')
  }

  // 15. preloadedSessions is used verbatim — the executor's shared snapshot means
  //     the teardown must not issue its own terminal-list.
  {
    const workspace = makeWorkspace({ 'dev-1': agent({ id: 'dev-1', cli: 'claude-code', cliSessionId: 'sess-dev' }) })
    const preloaded = [
      {
        sessionId: 'sess-dev',
        processAlive: true,
        kind: 'agent',
        workspaceId: 'ws-1',
        agentId: 'dev-1',
        sprintEngineStatePath: '/proj/.multi-code/sprintengine/x/run.yaml',
      } as unknown as TerminalSessionSnapshot,
    ]
    const { ports, killed } = stubPorts(workspace, [])
    ports.terminalList = async () => {
      throw new Error('terminalList must not be called when sessions are preloaded')
    }
    const result = await tearDownDepartedTaskScopedWorker('ws-1', 'dev-1', ports, preloaded)
    assert.deepEqual(killed, ['sess-dev'], 'preloaded live session disposed without a terminal-list call')
    assert.equal(result.closedSessionId, 'sess-dev')
  }

  // 16. A non-sprintengine agent is never torn down by this path.
  {
    const workspace = makeWorkspace({ chat: agent({ id: 'chat', kind: 'general', cliSessionId: 'x' }) })
    const { ports, removed } = stubPorts(workspace, [])
    const result = await tearDownDepartedTaskScopedWorker('ws-1', 'chat', ports)
    assert.deepEqual(removed, [], 'non-sprintengine agent untouched')
    assert.deepEqual(
      { recorded: result.recorded, removedAgent: result.removedAgent, removedTab: result.removedTab },
      { recorded: false, removedAgent: false, removedTab: false },
    )
  }

  console.log('sprintengineRunTeardown.test.ts: ok')
})()
