import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { DesktopMobileSwarmSessionOrchestrator, type DesktopMobileSwarmSessionAdapters } from './mobile-swarm-session'
import type { MobileSwarmTaskStartRequest } from './mobile-swarm-command'

const now = new Date('2026-04-28T20:20:00.000Z')

void main()

async function main(): Promise<void> {
  await assertTaskStartPrefersWorktree()
  await assertTaskStartRejectsTerminalLimit()
  await assertFollowUpWritesOnlyToKnownAgentTerminal()
  await assertFollowUpRejectsCrLfBeforeTerminalWrite()
}

async function assertTaskStartPrefersWorktree(): Promise<void> {
  const fixture = await writeFixture('session-worktree-team')
  const spawned: Array<{ cwd: string; executionMode: string; initialPrompt: string; worktreePath?: string }> = []
  const adapters = adaptersForFixture(fixture, {
    spawnAgentTerminal: async (input) => {
      spawned.push({
        cwd: input.cwd,
        executionMode: input.executionMode,
        initialPrompt: input.initialPrompt,
        worktreePath: input.worktreePath,
      })
      return { ok: true, sessionId: input.sessionId }
    },
  })
  const orchestrator = new DesktopMobileSwarmSessionOrchestrator({ adapters, now: () => now })

  const result = await orchestrator.startTask(taskStartRequest(fixture))

  assert.equal(result.executionMode, 'worktree')
  assert.equal(result.agentId, 'developer-1')
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].executionMode, 'worktree')
  assert.equal(spawned[0].cwd, fixture.worktreePath)
  assert.equal(spawned[0].worktreePath, fixture.worktreePath)
  assert.match(spawned[0].initialPrompt, /\\.venv\\Scripts\\python\.exe" \.\\scripts\\sprintengine_tool\.py join --role developer --id developer-1/u)
  assert.match(spawned[0].initialPrompt, /Otherwise run `swarm join --role developer --id developer-1`/u)
}

async function assertTaskStartRejectsTerminalLimit(): Promise<void> {
  const fixture = await writeFixture('session-limit-team')
  const orchestrator = new DesktopMobileSwarmSessionOrchestrator({
    adapters: adaptersForFixture(fixture, {
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
    /running swarm terminal limit/
  )
}

async function assertFollowUpWritesOnlyToKnownAgentTerminal(): Promise<void> {
  const fixture = await writeFixture('session-follow-up-team')
  const writes: Array<{ sessionId: string; data: string }> = []
  const orchestrator = new DesktopMobileSwarmSessionOrchestrator({
    adapters: adaptersForFixture(fixture, {
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
      adapters: adaptersForFixture(fixture, {
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

function adaptersForFixture(
  fixture: Awaited<ReturnType<typeof writeFixture>>,
  overrides: Partial<DesktopMobileSwarmSessionAdapters> = {}
): DesktopMobileSwarmSessionAdapters {
  return {
    listTerminals: async () => [],
    spawnAgentTerminal: async (input) => ({ ok: true, sessionId: input.sessionId }),
    writeTerminal: () => undefined,
    pathExists: async (targetPath) => targetPath !== fixture.worktreePath,
    listGitWorktrees: async () => ({ ok: true, data: { worktrees: [] } }),
    createGitWorktree: async () => ({
      ok: true,
      data: {
        path: fixture.worktreePath,
        branch: 'multicode/session-worktree-team/t2-developer-1',
      },
    }),
    ...overrides,
  }
}

async function writeFixture(swarmId: string): Promise<{
  swarmId: string
  workspaceRoot: string
  teamDirectory: string
  statePath: string
  worktreePath: string
}> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-session-'))
  const teamDirectory = join(workspaceRoot, 'swarm', swarmId)
  await mkdir(teamDirectory, { recursive: true })
  const statePath = join(teamDirectory, 'state.yaml')
  await writeFile(statePath, `${JSON.stringify({
    swarm: {
      name: swarmId,
      goal: 'Build mobile swarm control.',
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
    worktreePath: join(dirname(workspaceRoot), '.multicode-worktrees', workspaceRoot.split(/[\\/]/).at(-1) ?? 'repo', 't2-developer-1'),
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
    worktreeIsolation: 'preferred',
  }
}
