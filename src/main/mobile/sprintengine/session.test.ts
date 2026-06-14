import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { DesktopMobileSprintEngineSessionOrchestrator, type DesktopMobileSprintEngineSessionAdapters } from './session'
import type { MobileSprintEngineTaskStartRequest } from './command'

const now = new Date('2026-04-28T20:20:00.000Z')

void main()

async function main(): Promise<void> {
  await assertTaskStartUsesCurrentWorkspace()
  await assertTaskStartRejectsTerminalLimit()
  await assertFollowUpWritesOnlyToKnownAgentTerminal()
  await assertFollowUpRejectsCrLfBeforeTerminalWrite()
}

async function assertTaskStartUsesCurrentWorkspace(): Promise<void> {
  const fixture = await writeFixture('session-worktree-team')
  const spawned: Array<{ cwd: string; executionMode: string; initialPrompt: string }> = []
  const adapters = adaptersForFixture({
    spawnAgentTerminal: async (input) => {
      spawned.push({
        cwd: input.cwd,
        executionMode: input.executionMode,
        initialPrompt: input.initialPrompt,
      })
      return { ok: true, sessionId: input.sessionId }
    },
  })
  const orchestrator = new DesktopMobileSprintEngineSessionOrchestrator({ adapters, now: () => now })

  const result = await orchestrator.startTask(taskStartRequest(fixture))

  assert.equal(result.executionMode, 'current_workspace')
  assert.equal(result.agentId, 'developer-1')
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].executionMode, 'current_workspace')
  assert.equal(spawned[0].cwd, fixture.workspaceRoot)
  assert.match(spawned[0].initialPrompt, /managed Sprint Engine MCP server/u)
  assert.match(spawned[0].initialPrompt, /sprintengine\.agent\.join/u)
  assert.match(spawned[0].initialPrompt, /sprintengine\.task\.next/u)
  assert.doesNotMatch(spawned[0].initialPrompt, /sprintengine\.agent\.next_directive/u)
  assert.match(spawned[0].initialPrompt, /"role": "developer"/u)
  assert.match(spawned[0].initialPrompt, /"agentId": "developer-1"/u)
  assert.doesNotMatch(
    spawned[0].initialPrompt,
    /"statePath"|"workspaceRoot"/u,
    'mobile startup MCP payloads do not embed server-resolvable paths'
  )
  assert.doesNotMatch(
    spawned[0].initialPrompt,
    /retryAfterMs|sleep .*sprintengine\.agent\.next_directive/iu,
    'mobile startup prompt does not define an idle sleep/retry loop'
  )
  assert.doesNotMatch(
    spawned[0].initialPrompt,
    /sprintengine (join|task|gate|triage|init|handover)/u,
    'mobile startup prompt does not embed any sprintengine CLI command'
  )
}

async function assertTaskStartRejectsTerminalLimit(): Promise<void> {
  const fixture = await writeFixture('session-limit-team')
  const orchestrator = new DesktopMobileSprintEngineSessionOrchestrator({
    adapters: adaptersForFixture({
      listTerminals: async () => [
        {
          sessionId: 'session_existing',
          processAlive: true,
          kind: 'agent',
          agentId: 'developer-1',
          sprintEngineStatePath: fixture.statePath,
        },
      ],
    }),
    maxProcessAliveAgentTerminals: 1,
    now: () => now,
  })

  await assert.rejects(
    () => orchestrator.startTask(taskStartRequest(fixture)),
    /live Sprint Engine terminal limit/
  )
}

async function assertFollowUpWritesOnlyToKnownAgentTerminal(): Promise<void> {
  const fixture = await writeFixture('session-follow-up-team')
  const writes: Array<{ sessionId: string; data: string }> = []
  const orchestrator = new DesktopMobileSprintEngineSessionOrchestrator({
    adapters: adaptersForFixture({
      listTerminals: async () => [
        {
          sessionId: 'session_developer',
          processAlive: true,
          kind: 'agent',
          agentId: 'developer-1',
          sprintEngineStatePath: fixture.statePath,
        },
      ],
      writeTerminal: (sessionId, data) => {
        writes.push({ sessionId, data })
      },
    }),
    now: () => now,
  })

  const result = await orchestrator.sendFollowUp({
    sprintEngineId: fixture.sprintEngineId,
    statePath: fixture.statePath,
    teamDirectory: fixture.teamDirectory,
    workspaceRoot: fixture.workspaceRoot,
    agentId: 'developer-1',
    text: 'Please post the verification command.',
    deviceId: 'device_1',
    commandId: 'cmd_follow_up',
  })

  assert.equal(result.sessionId, 'session_developer')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].sessionId, 'session_developer')
  assert.equal(writes[0].data.includes('Please post the verification command.'), true)
}

async function assertFollowUpRejectsCrLfBeforeTerminalWrite(): Promise<void> {
  const fixture = await writeFixture('session-follow-up-control-team')

  for (const [text, pattern] of [
    ['Please post evidence.\nThen stop.', /single message/],
    ['Please post evidence.\rThen stop.', /single message/],
    ['Please post evidence.\u001B[2J', /single message/],
  ] as const) {
    const writes: Array<{ sessionId: string; data: string }> = []
    const orchestrator = new DesktopMobileSprintEngineSessionOrchestrator({
      adapters: adaptersForFixture({
        listTerminals: async () => [
          {
            sessionId: 'session_developer',
            processAlive: true,
            kind: 'agent',
            agentId: 'developer-1',
            sprintEngineStatePath: fixture.statePath,
          },
        ],
        writeTerminal: (sessionId, data) => {
          writes.push({ sessionId, data })
        },
      }),
      now: () => now,
    })

    await assert.rejects(
      () => orchestrator.sendFollowUp({
        sprintEngineId: fixture.sprintEngineId,
        statePath: fixture.statePath,
        teamDirectory: fixture.teamDirectory,
        workspaceRoot: fixture.workspaceRoot,
        agentId: 'developer-1',
        text,
        deviceId: 'device_1',
        commandId: 'cmd_follow_up_control',
      }),
      pattern
    )
    assert.equal(writes.length, 0)
  }
}

function adaptersForFixture(overrides: Partial<DesktopMobileSprintEngineSessionAdapters> = {}): DesktopMobileSprintEngineSessionAdapters {
  return {
    listTerminals: async () => [],
    spawnAgentTerminal: async (input) => ({ ok: true, sessionId: input.sessionId }),
    writeTerminal: () => undefined,
    ...overrides,
  }
}

async function writeFixture(sprintEngineId: string): Promise<{
  sprintEngineId: string
  workspaceRoot: string
  teamDirectory: string
  statePath: string
}> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-session-'))
  const teamDirectory = join(workspaceRoot, '.multi-code', 'sprintengine', sprintEngineId)
  await mkdir(teamDirectory, { recursive: true })
  const statePath = join(teamDirectory, 'run.yaml')
  // The mobile session orchestrator now reads `projection.json` (the canonical
  // Sprint Engine read shape) instead of parsing run-store internals. The
  // empty run.yaml is still written so state-path validation succeeds.
  await writeFile(statePath, '', 'utf8')
  await writeFile(join(teamDirectory, 'projection.json'), JSON.stringify({
    run: {
      name: sprintEngineId,
      goal: 'Build mobile sprintengine control.',
    },
    tasks: [
      {
        id: 'T2',
        title: 'Implement task start',
        role: 'developer',
        status: 'todo',
        ownerAgentId: null,
        dependsOn: [],
      },
    ],
    roster: {
      'developer-1': { role: 'developer', status: 'idle', currentTaskId: null },
    },
  }, null, 2), 'utf8')

  return {
    sprintEngineId,
    workspaceRoot,
    teamDirectory,
    statePath,
  }
}

function taskStartRequest(fixture: Awaited<ReturnType<typeof writeFixture>>): MobileSprintEngineTaskStartRequest {
  return {
    sprintEngineId: fixture.sprintEngineId,
    statePath: fixture.statePath,
    teamDirectory: fixture.teamDirectory,
    workspaceRoot: fixture.workspaceRoot,
    taskId: 'T2',
    role: 'developer',
    deviceId: 'device_1',
    commandId: 'cmd_start',
  }
}
