import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { DesktopMobileSwarmSessionOrchestrator, type DesktopMobileSwarmSessionAdapters } from './session'
import type { MobileSwarmTaskStartRequest } from './command'

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
  const orchestrator = new DesktopMobileSwarmSessionOrchestrator({ adapters, now: () => now })

  const result = await orchestrator.startTask(taskStartRequest(fixture))

  assert.equal(result.executionMode, 'current_workspace')
  assert.equal(result.agentId, 'developer-1')
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].executionMode, 'current_workspace')
  assert.equal(spawned[0].cwd, fixture.workspaceRoot)
  assert.match(spawned[0].initialPrompt, /\\.venv\\Scripts\\python\.exe" \.\\scripts\\sprintengine_tool\.py join --role developer --id developer-1/u)
  assert.match(spawned[0].initialPrompt, /Otherwise run `sprintengine join --role developer --id developer-1`/u)
}

async function assertTaskStartRejectsTerminalLimit(): Promise<void> {
  const fixture = await writeFixture('session-limit-team')
  const orchestrator = new DesktopMobileSwarmSessionOrchestrator({
    adapters: adaptersForFixture({
      listTerminals: async () => [
        {
          sessionId: 'session_existing',
          running: true,
          kind: 'agent',
          agentId: 'developer-1',
          swarmStatePath: fixture.statePath,
        },
      ],
    }),
    maxRunningAgentTerminals: 1,
    now: () => now,
  })

  await assert.rejects(
    () => orchestrator.startTask(taskStartRequest(fixture)),
    /running sprintengine terminal limit/
  )
}

async function assertFollowUpWritesOnlyToKnownAgentTerminal(): Promise<void> {
  const fixture = await writeFixture('session-follow-up-team')
  const writes: Array<{ sessionId: string; data: string }> = []
  const orchestrator = new DesktopMobileSwarmSessionOrchestrator({
    adapters: adaptersForFixture({
      listTerminals: async () => [
        {
          sessionId: 'session_developer',
          running: true,
          kind: 'agent',
          agentId: 'developer-1',
          swarmStatePath: fixture.statePath,
        },
      ],
      writeTerminal: (sessionId, data) => {
        writes.push({ sessionId, data })
      },
    }),
    now: () => now,
  })

  const result = await orchestrator.sendFollowUp({
    swarmId: fixture.swarmId,
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
    const orchestrator = new DesktopMobileSwarmSessionOrchestrator({
      adapters: adaptersForFixture({
        listTerminals: async () => [
          {
            sessionId: 'session_developer',
            running: true,
            kind: 'agent',
            agentId: 'developer-1',
            swarmStatePath: fixture.statePath,
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
        swarmId: fixture.swarmId,
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

function adaptersForFixture(overrides: Partial<DesktopMobileSwarmSessionAdapters> = {}): DesktopMobileSwarmSessionAdapters {
  return {
    listTerminals: async () => [],
    spawnAgentTerminal: async (input) => ({ ok: true, sessionId: input.sessionId }),
    writeTerminal: () => undefined,
    ...overrides,
  }
}

async function writeFixture(swarmId: string): Promise<{
  swarmId: string
  workspaceRoot: string
  teamDirectory: string
  statePath: string
}> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-session-'))
  const teamDirectory = join(workspaceRoot, '.multi-code', 'sprintengine', swarmId)
  await mkdir(teamDirectory, { recursive: true })
  const statePath = join(teamDirectory, 'state.yaml')
  await writeFile(statePath, `${JSON.stringify({
    sprintengine: {
      name: swarmId,
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
    swarmAgents: {
      'developer-1': { role: 'developer', status: 'idle', currentTaskId: null },
    },
  }, null, 2)}\n`, 'utf8')

  return {
    swarmId,
    workspaceRoot,
    teamDirectory,
    statePath,
  }
}

function taskStartRequest(fixture: Awaited<ReturnType<typeof writeFixture>>): MobileSwarmTaskStartRequest {
  return {
    swarmId: fixture.swarmId,
    statePath: fixture.statePath,
    teamDirectory: fixture.teamDirectory,
    workspaceRoot: fixture.workspaceRoot,
    taskId: 'T2',
    role: 'developer',
    deviceId: 'device_1',
    commandId: 'cmd_start',
  }
}
