// Contract tests for the module agent-sessions service (D5 / WP-B).
//
// The harness is the review guide's, generalised: a fake terminal runtime, the
// REAL agent control plane writing into it, and — the part the guide's harness
// did not have — the REAL AgentLaunchService composing the spawn. So these
// tests assert the payload that reaches a pty, and that the composition a
// module gets is the same one every app-level launch gets, without an Electron
// window, a plugin registry, or a pty anywhere in the process.
import assert from 'node:assert/strict'

import type { TerminalSessionSnapshot, TerminalSpawnResult } from '../shared/electron-api'
import type { AgentSessionExitEvent } from '../shared/agent-runtime'
import { emptyAgentLaunchSettings } from '../shared/launch-settings'
import type { AgentLaunchSettings } from '../shared/launch-settings'
import type { TerminalSpawnPayload } from './ipc/terminal-ipc'
import { createAgentControlPlane } from './agent-control-plane'
import { createAgentLaunchService } from './agent-launch-service'
import {
  createAgentSessionsModuleRegistry,
  type AgentSessionsModuleDeps,
  type AgentSessionsModuleRegistry,
} from './agent-sessions-module-service'
import type { ModuleAgentExitEvent, ModuleAgentSpawnRequest } from '../shared/modules/agent-sessions'
import { test } from 'vitest'

test('agent-sessions-module-service', async () => {
  const tests: Array<{ name: string; body: () => Promise<void> | void }> = []
  function run(name: string, body: () => Promise<void> | void): void {
    tests.push({ name, body })
  }

  const MODULE_ID = 'review'
  const OTHER_MODULE_ID = 'notes'
  const WORKSPACE_ID = 'ws-app'
  const PROJECT_ROOT = '/projects/app'
  const PREFIX = 'review-guide-'
  const REVIEW_ID = 'review_1'
  const AGENT_ID = `${PREFIX}${REVIEW_ID}`
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

  function session(overrides: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot {
    return {
      sessionId: 'session-existing',
      processAlive: true,
      kind: 'agent',
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      agentName: 'Review guide',
      cli: 'claude-code',
      visible: false,
      suspended: false,
      reapExempt: false,
      startedAt: 1,
      lastOutputAt: null,
      lastInputAt: null,
      lastVisibleAt: null,
      exitedAt: null,
      outputBufferLength: 0,
      retainedOutputBytes: 0,
      fileChanges: [],
      activeSubagents: 0,
      contextUsage: null,
      activity: { kind: 'idle', since: 1 },
      ...overrides,
    }
  }

  type Harness = {
    registry: AgentSessionsModuleRegistry
    spawns: TerminalSpawnPayload[]
    writes: Array<{ sessionId: string; data: string }>
    kills: string[]
    reapExempt: Array<{ sessionId: string; exempt: boolean }>
    sessions: TerminalSessionSnapshot[]
    exit: (event: AgentSessionExitEvent) => void
    spawnResult: (result: TerminalSpawnResult) => void
  }

  function makeHarness(
    options: {
      sessions?: TerminalSessionSnapshot[]
      workspaces?: Array<{ id: string; folderPath?: string | null; mode?: string }>
      settings?: AgentLaunchSettings
      permissions?: Record<string, readonly string[]>
      knownSkills?: string[]
      skillInvocation?: (cli: string, skillId: string) => string | undefined
      prefixes?: (moduleId: string) => readonly string[] | undefined
      isAgentSelectableCli?: (cli: string) => boolean
    } = {},
  ): Harness {
    const spawns: TerminalSpawnPayload[] = []
    const writes: Array<{ sessionId: string; data: string }> = []
    const kills: string[] = []
    const reapExempt: Array<{ sessionId: string; exempt: boolean }> = []
    const sessions = options.sessions ?? []
    const exitListeners: Array<(event: AgentSessionExitEvent) => void> = []
    const workspaces = options.workspaces ?? [{ id: WORKSPACE_ID, folderPath: PROJECT_ROOT, mode: 'standard' }]
    const settings =
      options.settings ?? ({ ...emptyAgentLaunchSettings(), lastSelectedCli: 'claude-code' } as AgentLaunchSettings)
    const knownSkills = options.knownSkills ?? ['review-guide']
    let nextSpawn: TerminalSpawnResult | null = null
    let minted = 0

    // The real control plane over the fake terminal: a module's prompts are the
    // same bracketed-paste-then-submit turn every other writer's are.
    const controlPlane = createAgentControlPlane({
      terminal: {
        list: () => sessions,
        write: (sessionId, data) => writes.push({ sessionId, data }),
        read: (sessionId) => (sessions.some((entry) => entry.sessionId === sessionId) ? '' : undefined),
      },
      delay: async () => {},
    })

    const launchService = createAgentLaunchService({
      listWorkspaces: () => workspaces,
      getLaunchSettings: () => settings,
      ...(options.isAgentSelectableCli ? { isAgentSelectableCli: options.isAgentSelectableCli } : {}),
      terminal: {
        list: () => sessions,
        spawn: async (payload) => {
          spawns.push(payload)
          const result = nextSpawn ?? { ok: true, sessionId: payload.sessionId }
          if (result.ok) {
            sessions.push(
              session({
                sessionId: payload.sessionId,
                ...(payload.agentId ? { agentId: payload.agentId } : {}),
                ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
                ...(payload.agentName ? { agentName: payload.agentName } : {}),
                cli: payload.cli,
                ...(payload.agentSession
                  ? { agentSession: { ...payload.agentSession, sessionId: payload.sessionId } }
                  : {}),
              }),
            )
          }
          return result
        },
        kill: (sessionId) => kills.push(sessionId),
      },
      // Stable, distinct, UUID-shaped: the service must never reuse an agent id
      // as a session id, and a Claude-harness CLI refuses a non-UUID outright.
      newSessionId: () => `0000000${++minted}-1111-4222-8333-444444444444`,
    })

    const deps: AgentSessionsModuleDeps = {
      launchAgent: (request) => launchService.launch(request),
      terminal: {
        list: () => sessions,
        kill: (sessionId) => {
          kills.push(sessionId)
          const index = sessions.findIndex((entry) => entry.sessionId === sessionId)
          if (index >= 0) sessions.splice(index, 1)
        },
        setReapExempt: (sessionId, exempt) => reapExempt.push({ sessionId, exempt }),
        onAgentSessionExit: (listener) => {
          exitListeners.push(listener)
          return () => exitListeners.splice(exitListeners.indexOf(listener), 1)
        },
      },
      sendPrompt: async (sessionId, text) => {
        const result = await controlPlane.send({ sessionId }, text, { submit: true })
        return result.ok ? { ok: true } : { ok: false, message: result.message }
      },
      hasWorkspace: (workspaceId) => workspaces.some((workspace) => workspace.id === workspaceId),
      resolveSkill: (skillId) => (knownSkills.includes(skillId) ? { id: skillId } : null),
      resolveSkillInvocation: options.skillInvocation ?? ((_cli, skillId) => `/${skillId}`),
      getModulePermissions: (moduleId) => (options.permissions ?? { [MODULE_ID]: ['agents:session'] })[moduleId],
      ...(options.prefixes ? { getModuleAgentIdPrefixes: options.prefixes } : {}),
    }

    return {
      registry: createAgentSessionsModuleRegistry(deps),
      spawns,
      writes,
      kills,
      reapExempt,
      sessions,
      exit: (event) => {
        for (const listener of [...exitListeners]) listener(event)
      },
      spawnResult: (result) => {
        nextSpawn = result
      },
    }
  }

  function spawnInput(overrides: Partial<ModuleAgentSpawnRequest> = {}): ModuleAgentSpawnRequest {
    return {
      workspaceId: WORKSPACE_ID,
      cwd: PROJECT_ROOT,
      prompt: 'Build the walkthrough.',
      skill: { id: 'review-guide' },
      agentIdPrefix: PREFIX,
      agentIdKey: REVIEW_ID,
      label: 'Review guide',
      permissionPreset: 'bypass',
      role: 'review-guide',
      ...overrides,
    }
  }

  run("a fresh spawn is an ordinary agent terminal with the module's own identity", async () => {
    const harness = makeHarness()
    const result = await harness.registry.spawn(MODULE_ID, spawnInput())

    assert.ok(result.ok, 'the spawn succeeded')
    if (!result.ok) return
    assert.equal(result.agentId, AGENT_ID, 'the agent id is prefix + key')
    assert.equal(result.reused, false)
    assert.equal(result.cli, 'claude-code', 'the resolved CLI comes back')
    assert.match(result.sessionId, UUID, 'the session id is a freshly minted UUID')
    assert.notEqual(result.sessionId, result.agentId, 'the agent id is never used as a session id')
    assert.equal(result.executionId, result.sessionId, 'the spawn is stamped with an execution identity')
    assert.equal(result.skillInvocation, '/review-guide', 'the CLI-native invocation comes back')

    const payload = harness.spawns[0]
    assert.ok(payload, 'a spawn payload reached the terminal runtime')
    assert.equal(payload.cwd, PROJECT_ROOT)
    assert.equal(payload.kind, 'agent')
    assert.equal(payload.workspaceId, WORKSPACE_ID)
    assert.equal(payload.agentId, AGENT_ID)
    assert.equal(payload.agentName, 'Review guide')
    assert.equal(payload.cliPermissionPreset, 'bypass', "the caller's preset is honoured")
    assert.equal(payload.spawnSkillId, 'review-guide', 'the skill is installed before the CLI starts')
    assert.equal(payload.visible, false)
    assert.equal(payload.initialPrompt, 'Build the walkthrough.')
    assert.equal(
      payload.agentSession?.executionId,
      result.executionId,
      'without an execution identity the runtime reports no exit for this session at all',
    )
    assert.equal(payload.agentSession?.workspaceRoot, PROJECT_ROOT)
  })

  run("a spawn with no preset takes the user's default, never an escalation", async () => {
    const harness = makeHarness({
      settings: {
        ...emptyAgentLaunchSettings(),
        lastSelectedCli: 'claude-code',
        lastAgentSpawnPermissionPreset: 'auto',
      } as AgentLaunchSettings,
    })
    const input = spawnInput()
    delete input.permissionPreset
    const result = await harness.registry.spawn(MODULE_ID, input)

    assert.ok(result.ok)
    assert.equal(harness.spawns[0]?.cliPermissionPreset, 'auto')
  })

  run('a live session under the same agent id takes the prompt instead of being twinned', async () => {
    const harness = makeHarness({ sessions: [session()] })
    const result = await harness.registry.spawn(MODULE_ID, spawnInput({ prompt: 'Refresh step 3.' }))

    assert.ok(result.ok && result.reused, 'the start reports a reused session')
    assert.equal(harness.spawns.length, 0, 'nothing was spawned')
    assert.ok(harness.writes.length > 0, 'the prompt reached the pty through the control plane')
    assert.ok(
      harness.writes.some((write) => write.data.includes('Refresh step 3.')),
      'the prompt text itself was written',
    )
    assert.ok(
      harness.writes.some((write) => write.data.includes('\r')),
      'the turn was submitted, not left at the prompt',
    )
    assert.ok(result.ok && result.sessionId === 'session-existing')
  })

  run('reuseLive: false spawns a second terminal rather than pasting into the live one', async () => {
    const harness = makeHarness({ sessions: [session()] })
    const result = await harness.registry.spawn(MODULE_ID, spawnInput({ reuseLive: false }))

    assert.ok(result.ok && !result.reused)
    assert.equal(harness.spawns.length, 1)
    assert.deepEqual(harness.kills, ['session-existing'], 'the previous terminal was disposed first')
  })

  run('a dead or suspended session under the agent id is disposed before the fresh spawn', async () => {
    const harness = makeHarness({ sessions: [session({ processAlive: false })] })
    const result = await harness.registry.spawn(MODULE_ID, spawnInput())

    assert.ok(result.ok && !result.reused, 'a dead session is not reused')
    assert.deepEqual(harness.kills, ['session-existing'], 'the stale record went before the spawn')
    assert.equal(harness.spawns.length, 1)
    assert.notEqual(harness.spawns[0]?.sessionId, 'session-existing', 'a fresh pty id is minted')

    const suspended = makeHarness({ sessions: [session({ suspended: true })] })
    const second = await suspended.registry.spawn(MODULE_ID, spawnInput())
    assert.ok(second.ok && !second.reused, 'a suspended session is not written into')
    assert.deepEqual(suspended.kills, ['session-existing'])
  })

  run('an unresolvable skill refuses loudly instead of spawning without its instructions', async () => {
    const harness = makeHarness()
    const result = await harness.registry.spawn(MODULE_ID, spawnInput({ skill: { id: 'no-such-skill' } }))

    assert.ok(!result.ok)
    assert.equal(!result.ok && result.code, 'unknown_skill')
    assert.equal(harness.spawns.length, 0, 'nothing was started')
  })

  run('every method refuses a module that did not declare agents:session', async () => {
    const harness = makeHarness({ permissions: { [MODULE_ID]: ['storage'] } })

    const spawned = await harness.registry.spawn(MODULE_ID, spawnInput())
    assert.ok(!spawned.ok)
    assert.equal(!spawned.ok && spawned.code, 'permission_missing')
    assert.equal(harness.spawns.length, 0)

    const sent = await harness.registry.send(MODULE_ID, 'session-existing', 'hello')
    assert.equal(sent.ok, false)
    assert.match(sent.message ?? '', /agents:session/)

    assert.throws(() => harness.registry.kill(MODULE_ID, 'session-existing'), /agents:session/)
    assert.throws(() => harness.registry.setReapExempt(MODULE_ID, 'session-existing', true), /agents:session/)
    assert.throws(() => harness.registry.onExit(MODULE_ID, () => {}), /agents:session/)
    assert.throws(() => harness.registry.list(MODULE_ID), /agents:session/)
  })

  run('a workspace that is not open, and a relative cwd, both refuse before spawning', async () => {
    const harness = makeHarness()

    const unknown = await harness.registry.spawn(MODULE_ID, spawnInput({ workspaceId: 'ws-nope' }))
    assert.equal(!unknown.ok && unknown.code, 'unknown_workspace')

    const relative = await harness.registry.spawn(MODULE_ID, spawnInput({ cwd: 'projects/app' }))
    assert.equal(!relative.ok && relative.code, 'missing_cwd')

    const empty = await harness.registry.spawn(MODULE_ID, spawnInput({ cwd: '   ' }))
    assert.equal(!empty.ok && empty.code, 'missing_cwd')
    assert.equal(harness.spawns.length, 0)
  })

  run('a workspace of any mode can host a module session', async () => {
    const harness = makeHarness({
      workspaces: [{ id: WORKSPACE_ID, folderPath: PROJECT_ROOT, mode: 'weather-deck' }],
    })
    const result = await harness.registry.spawn(MODULE_ID, spawnInput())
    assert.ok(result.ok, 'the workspace the surface was opened from is the right host, whatever its mode')
  })

  run('an unregistered agent-id namespace is refused when main can see the registry', async () => {
    const harness = makeHarness({ prefixes: () => ['notes-'] })
    const result = await harness.registry.spawn(MODULE_ID, spawnInput())
    assert.ok(!result.ok)
    assert.match(!result.ok ? result.message : '', /namespace/)
  })

  run('a failed spawn reports the failure rather than a started agent', async () => {
    const harness = makeHarness()
    harness.spawnResult({ ok: false, sessionId: 'x', message: 'the CLI is not installed', exitCode: 1 })
    const result = await harness.registry.spawn(MODULE_ID, spawnInput())

    assert.ok(!result.ok)
    assert.equal(!result.ok && result.code, 'spawn_failed')
    assert.match(!result.ok ? result.message : '', /not installed/)
  })

  run('no CLI anywhere refuses instead of guessing one', async () => {
    const harness = makeHarness({ settings: emptyAgentLaunchSettings() })
    const result = await harness.registry.spawn(MODULE_ID, spawnInput())
    assert.equal(!result.ok && result.code, 'no_cli_selected')
  })

  run('a CLI that cannot report agent state is refused, never substituted', async () => {
    const harness = makeHarness({ isAgentSelectableCli: () => false })
    const result = await harness.registry.spawn(MODULE_ID, spawnInput())
    assert.equal(!result.ok && result.code, 'cli_not_agent_selectable')
  })

  run("send goes through the control plane, and only for the module's own sessions", async () => {
    const harness = makeHarness({
      sessions: [session(), session({ sessionId: 'session-theirs', agentId: 'agent-claude-xyz' })],
      prefixes: () => [PREFIX],
    })

    const mine = await harness.registry.send(MODULE_ID, 'session-existing', 'Which file next?')
    assert.equal(mine.ok, true)
    assert.ok(harness.writes.some((write) => write.data.includes('Which file next?')))

    const theirs = await harness.registry.send(MODULE_ID, 'session-theirs', 'stop what you are doing')
    assert.equal(theirs.ok, false, 'a module cannot prompt an agent it does not own')
    assert.ok(!harness.writes.some((write) => write.sessionId === 'session-theirs'))
  })

  run('kill and setReapExempt pass through for owned sessions and no-op for others', async () => {
    const harness = makeHarness({
      sessions: [session(), session({ sessionId: 'session-theirs', agentId: 'agent-claude-xyz' })],
      prefixes: () => [PREFIX],
    })

    harness.registry.setReapExempt(MODULE_ID, 'session-existing', true)
    assert.deepEqual(harness.reapExempt, [{ sessionId: 'session-existing', exempt: true }])

    harness.registry.setReapExempt(MODULE_ID, 'session-theirs', true)
    assert.equal(harness.reapExempt.length, 1, "another module's session is not touched")

    harness.registry.kill(MODULE_ID, 'session-theirs')
    assert.deepEqual(harness.kills, [])
    harness.registry.kill(MODULE_ID, 'session-existing')
    assert.deepEqual(harness.kills, ['session-existing'])
  })

  run('the host clears a reap exemption when the session it protects exits', async () => {
    const harness = makeHarness()
    const spawned = await harness.registry.spawn(MODULE_ID, spawnInput())
    assert.ok(spawned.ok)
    if (!spawned.ok) return
    harness.registry.setReapExempt(MODULE_ID, spawned.sessionId, true)

    harness.exit({
      system: 'manual',
      workspaceRoot: PROJECT_ROOT,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      executionId: spawned.executionId,
      exitCode: 0,
    })

    assert.deepEqual(
      harness.reapExempt,
      [
        { sessionId: spawned.sessionId, exempt: true },
        { sessionId: spawned.sessionId, exempt: false },
      ],
      'a module that never balances its own exemption cannot leave an unsuspendable pty behind',
    )
  })

  run("onExit fans the runtime's exit out to the module that owns the agent, and no other", async () => {
    const harness = makeHarness({
      permissions: { [MODULE_ID]: ['agents:session'], [OTHER_MODULE_ID]: ['agents:session'] },
      prefixes: (moduleId) => (moduleId === MODULE_ID ? [PREFIX] : ['notes-']),
    })
    const mine: ModuleAgentExitEvent[] = []
    const theirs: ModuleAgentExitEvent[] = []
    const stop = harness.registry.onExit(MODULE_ID, (event) => mine.push(event))
    harness.registry.onExit(OTHER_MODULE_ID, (event) => theirs.push(event))

    harness.exit({
      system: 'manual',
      workspaceRoot: PROJECT_ROOT,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      executionId: 'exec-1',
      exitCode: 3,
    })

    assert.deepEqual(mine, [{ agentId: AGENT_ID, executionId: 'exec-1', workspaceId: WORKSPACE_ID, exitCode: 3 }])
    assert.deepEqual(theirs, [], 'another module hears nothing about an agent it does not own')

    stop()
    harness.exit({
      system: 'manual',
      workspaceRoot: PROJECT_ROOT,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      executionId: 'exec-2',
      exitCode: 0,
    })
    assert.equal(mine.length, 1, 'the unsubscribe releases the listener')
  })

  run('list answers only for the agent-id prefixes the module owns', async () => {
    const harness = makeHarness({
      sessions: [
        session(),
        session({ sessionId: 'session-notes', agentId: 'notes-daily' }),
        session({ sessionId: 'session-user', agentId: 'agent-claude-abc' }),
        session({ sessionId: 'session-plain', kind: 'terminal', agentId: undefined }),
      ],
      permissions: { [MODULE_ID]: ['agents:session'], [OTHER_MODULE_ID]: ['agents:session'] },
      prefixes: (moduleId) => (moduleId === MODULE_ID ? [PREFIX] : ['notes-']),
    })

    assert.deepEqual(
      harness.registry.list(MODULE_ID).map((record) => record.sessionId),
      ['session-existing'],
    )
    assert.deepEqual(
      harness.registry.list(OTHER_MODULE_ID).map((record) => record.sessionId),
      ['session-notes'],
    )

    const record = harness.registry.list(MODULE_ID)[0]
    assert.deepEqual(record, {
      sessionId: 'session-existing',
      agentId: AGENT_ID,
      name: 'Review guide',
      cli: 'claude-code',
      workspaceId: WORKSPACE_ID,
      executionId: null,
      isLive: true,
      suspended: false,
      reapExempt: false,
      startedAt: 1,
    })
  })

  run('with no main-side namespace mirror, list falls back to what this module spawned', async () => {
    const harness = makeHarness({
      permissions: { [MODULE_ID]: ['agents:session'], [OTHER_MODULE_ID]: ['agents:session'] },
    })
    assert.deepEqual(harness.registry.list(MODULE_ID), [], 'nothing is owned before the first spawn')

    const spawned = await harness.registry.spawn(MODULE_ID, spawnInput())
    assert.ok(spawned.ok)
    assert.deepEqual(
      harness.registry.list(MODULE_ID).map((record) => record.agentId),
      [AGENT_ID],
    )
    assert.deepEqual(harness.registry.list(OTHER_MODULE_ID), [], 'the prefix is not shared')
  })

  run('dispose releases the runtime exit listener', async () => {
    const harness = makeHarness()
    const seen: ModuleAgentExitEvent[] = []
    harness.registry.onExit(MODULE_ID, (event) => seen.push(event))
    harness.registry.dispose()
    harness.exit({
      system: 'manual',
      workspaceRoot: PROJECT_ROOT,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      executionId: 'exec-1',
      exitCode: 0,
    })
    assert.deepEqual(seen, [])
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
    console.log('agent-sessions-module-service.test.ts: ok')
  }

  const suiteRun = main()

  await suiteRun
})
