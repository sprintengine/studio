import assert from 'node:assert/strict'

import type { TerminalSessionSnapshot } from '../../../shared/electron-api'
import type { AgentLaunchRecord } from '../../../shared/agent-launch'
import {
  agentStateFromLaunchRecord,
  markLaunchedAgentProjected,
  projectedLaunchedAgents,
  projectionKey,
  resetLaunchedAgentProjectionForTest,
  retiredLaunchedAgents,
} from './launchedAgentProjection'
import { test } from 'vitest'

test('launchedAgentProjection', async () => {
  const tests: Array<{ name: string; body: () => void }> = []
  function run(name: string, body: () => void): void {
    tests.push({ name, body })
  }

  function record(overrides: Partial<AgentLaunchRecord> = {}): AgentLaunchRecord {
    return {
      agentId: 'agent-claude-code-abc123',
      name: 'Scout',
      cli: 'claude-code',
      cliPermissionPreset: 'auto',
      ...overrides,
    }
  }

  function session(overrides: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot {
    return {
      sessionId: 'session-1',
      processAlive: true,
      kind: 'agent',
      workspaceId: 'ws-1',
      agentId: 'agent-claude-code-abc123',
      agentRecord: record(),
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
      fileChanges: [],
      activeSubagents: 0,
      contextUsage: null,
      retainedOutputBytes: 0,
      ...overrides,
    }
  }

  const KNOWN = new Set(['ws-1'])

  run('a main-launched session projects one agent, complete', () => {
    const projected = projectedLaunchedAgents({
      sessions: [session()],
      knownWorkspaceIds: KNOWN,
      existing: new Set(),
    })
    assert.equal(projected.length, 1)
    assert.equal(projected[0]!.workspaceId, 'ws-1')
    assert.equal(projected[0]!.agentId, 'agent-claude-code-abc123')
    assert.equal(projected[0]!.agent.name, 'Scout')
    assert.equal(projected[0]!.agent.cli, 'claude-code')
    assert.equal(projected[0]!.agent.cliPermissionPreset, 'auto')
  })

  run('the projected record attaches instead of launching a second process', () => {
    // These three fields ARE the attach contract read by TerminalView: the session
    // id it binds to, and the two flags that say the CLI is already running with
    // its prompt delivered. Get them wrong and the mounting tab spawns a twin
    // alongside the agent it is looking at.
    const agent = agentStateFromLaunchRecord(record(), session({ sessionId: 'session-live' }))
    assert.equal(agent.cliSessionId, 'session-live')
    assert.equal(agent.cliHasLaunched, true)
    assert.equal(agent.cliOnboardingPromptSent, true)
    assert.equal(agent.cliStartupPrompt, undefined, 'main already delivered the prompt')
    assert.equal(agent.cliStartRequested, false, 'nobody in this window asked for a start')
  })

  run('a worktree launch projects its execution root', () => {
    const agent = agentStateFromLaunchRecord(
      record({ worktreePath: '/repo/a/.worktrees/run-1' }),
      session({ worktreeId: 'wt-1' }),
    )
    assert.deepEqual(agent.execution, { mode: 'worktree', worktreeId: 'wt-1', cwd: '/repo/a/.worktrees/run-1' })

    const plain = agentStateFromLaunchRecord(record(), session())
    assert.deepEqual(plain.execution, { mode: 'current_workspace', worktreeId: null, cwd: null })
  })

  run('the connector environment survives the projection', () => {
    const agent = agentStateFromLaunchRecord(
      record({
        connectorMcpSettings: { syncEnabled: true, servers: {} },
        spawnSkillId: 'backlog',
      }),
      session(),
    )
    assert.deepEqual(agent.connectorMcpSettings, { syncEnabled: true, servers: {} })
    assert.equal(agent.spawnSkillId, 'backlog')
  })

  run('an agent the store already holds is never overwritten', () => {
    const projected = projectedLaunchedAgents({
      sessions: [session()],
      knownWorkspaceIds: KNOWN,
      existing: new Set([projectionKey('ws-1', 'agent-claude-code-abc123')]),
    })
    assert.deepEqual(projected, [], 'the store copy may carry user edits the launch never saw')
  })

  run('only live, main-launched agent sessions in known workspaces project', () => {
    const projected = projectedLaunchedAgents({
      sessions: [
        // Dead: the agent is over, so a tab for it would be a ghost.
        session({ sessionId: 's-dead', processAlive: false, agentRecord: record({ agentId: 'a-dead' }) }),
        // No launch record: a renderer-launched agent already owns its record.
        session({ sessionId: 's-renderer', agentRecord: undefined, agentId: 'a-renderer' }),
        // A plain terminal is not an agent.
        session({ sessionId: 's-shell', kind: 'terminal', agentRecord: record({ agentId: 'a-shell' }) }),
        // A workspace this window does not hold has nowhere to put the tab.
        session({ sessionId: 's-other', workspaceId: 'ws-unknown', agentRecord: record({ agentId: 'a-other' }) }),
        // The one that should land.
        session({ sessionId: 's-live', agentRecord: record({ agentId: 'a-live' }) }),
      ],
      knownWorkspaceIds: KNOWN,
      existing: new Set(),
    })
    assert.deepEqual(
      projected.map((entry) => entry.agentId),
      ['a-live'],
    )
  })

  run('two sessions for one agent project it once', () => {
    // A relaunched agent can briefly have a retained session alongside its live
    // one; projecting twice would mint the record and then immediately re-mint it.
    const projected = projectedLaunchedAgents({
      sessions: [session({ sessionId: 's-1' }), session({ sessionId: 's-2' })],
      knownWorkspaceIds: KNOWN,
      existing: new Set(),
    })
    assert.equal(projected.length, 1)
    assert.equal(projected[0]!.agent.cliSessionId, 's-1', 'the first live session wins')
  })

  run('a projected agent retires when its session is gone, and only then', () => {
    resetLaunchedAgentProjectionForTest()
    markLaunchedAgentProjected('ws-1', 'a-live')
    markLaunchedAgentProjected('ws-1', 'a-paused')
    markLaunchedAgentProjected('ws-1', 'a-gone')

    const retired = retiredLaunchedAgents([
      session({ sessionId: 's-live', agentId: 'a-live' }),
      // Suspended by the reaper: not `processAlive`, but its painted scrollback is
      // still readable and the operator can resume it. Retiring it would delete an
      // agent they can still open.
      session({ sessionId: 's-paused', agentId: 'a-paused', processAlive: false, suspended: true }),
    ])

    assert.deepEqual(retired, [{ workspaceId: 'ws-1', agentId: 'a-gone' }])
    assert.deepEqual(
      retiredLaunchedAgents([session({ sessionId: 's-live', agentId: 'a-live' })]),
      [{ workspaceId: 'ws-1', agentId: 'a-paused' }],
      'the paused agent retires once its session really goes',
    )
    assert.deepEqual(
      retiredLaunchedAgents([session({ sessionId: 's-live', agentId: 'a-live' })]),
      [],
      'a retirement is reported exactly once',
    )
  })

  run('an agent this projection never created is never retired', () => {
    resetLaunchedAgentProjectionForTest()
    // A user-created agent whose terminal exited keeps its tab. Nothing was
    // projected, so there is nothing to retire — the registry, not the session
    // list, is what makes removal safe.
    assert.deepEqual(retiredLaunchedAgents([]), [])
  })

  function main(): void {
    let failed = false
    for (const test of tests) {
      try {
        test.body()
        console.log(`ok - ${test.name}`)
      } catch (error) {
        failed = true
        console.error(`not ok - ${test.name}`)
        console.error(error)
      }
    }
    if (failed) process.exit(1)
    console.log('launchedAgentProjection.test.ts: ok')
  }

  main()
})
