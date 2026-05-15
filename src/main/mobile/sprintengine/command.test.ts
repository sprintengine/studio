import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { platform, tmpdir } from 'os'
import { join } from 'path'
import {
  buildSprintEngineArtifactReviewArgs,
  mobileControlProtocolVersion,
  MobileSprintEngineCommandService,
  type MobileControlCommand,
  type MobileSprintEngineSessionOrchestrator,
} from './command'
import { readSprintEngineSnapshot } from './snapshot'

const now = new Date('2026-04-28T19:45:00.000Z')

void main()

async function main(): Promise<void> {
  await assertArtifactApproveInvokesSprintEngineTool()
  await assertArtifactApproveUsesAuthorizedDiscoveredStateOutsideServiceCwd()
  await assertArtifactApproveRejectsUnauthorizedDiscoveredStatePath()
  await assertArtifactRequestChangesInvokesSprintEngineTool()
  assertAutoRunArtifactApproveArgsUseCanonicalActor()
  await assertArtifactRequestChangesRejectsStaleSnapshot()
  await assertSameIdempotencyKeyAndBodyReplaysCachedResult()
  await assertSameIdempotencyKeyWithDifferentBodyIsRejected()
  await assertIdempotencyReplaySurvivesServiceRecreation()
  await assertToolSuccessResponseLossRetryDoesNotReinvokeTool()
  await assertInvalidArtifactPathIsRejected()
  await assertSprintEngineCreateUsesControlledHandover()
  await assertTaskStartUsesDesktopSessionOrchestration()
  await assertTaskStartUsesAuthorizedDiscoveredStateOutsideServiceCwd()
  await assertTaskStartRejectsBlockedDependencies()
  await assertFollowUpUsesKnownAgentSessionOrchestration()
  await assertFollowUpUsesAuthorizedDiscoveredStateOutsideServiceCwd()
  await assertFollowUpRejectsTerminalControlCharacters()
  await assertUnsupportedCommandIsRejected()
  await assertFilesystemMutationHandlersProtectSprintEngineStateAliases()
}

async function assertArtifactApproveInvokesSprintEngineTool(): Promise<void> {
  const fixture = await writeSprintEngineFixture('review-team', '.multi-code/sprintengine/review-team/documents/requirements.md')
  const invocations: Array<{ args: string[]; cwd: string }> = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async (invocation) => {
      invocations.push(invocation)
      return { exitCode: 0, stdout: '{"ok":true,"action":"approved"}', stderr: '' }
    },
  })

  const result = await service.dispatch(command('artifact.approve', {
    sprintEngineId: 'review-team',
    artifactId: 'A1',
  }))

  assert.equal(result.ok, true)
  assert.equal(invocations.length, 1)
  assert.deepEqual(invocations[0].args, [
    '--state',
    fixture.statePath,
    'artifact',
    'approve',
    '--artifact-id',
    'A1',
    '--id',
    'mobile:device_1',
  ])
  assert.equal(invocations[0].cwd, fixture.workspaceRoot)
  assert.equal(service.getAuditLog()[0].status, 'accepted')
}

async function assertArtifactApproveUsesAuthorizedDiscoveredStateOutsideServiceCwd(): Promise<void> {
  const fixture = await writeSprintEngineFixture('discovered-review-team', '.multi-code/sprintengine/discovered-review-team/documents/requirements.md')
  const serviceWorkspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-cwd-'))
  const invocations: Array<{ args: string[]; cwd: string }> = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: serviceWorkspaceRoot,
    now: () => now,
    execute: async (invocation) => {
      invocations.push(invocation)
      return { exitCode: 0, stdout: '{"ok":true,"action":"approved"}', stderr: '' }
    },
  })

  const result = await service.dispatch(command('artifact.approve', {
    sprintEngineId: 'discovered-review-team',
    artifactId: 'A1',
  }, {
    commandId: 'cmd_discovered_review',
    idempotencyKey: 'mobile:device_1:discovered-review',
  }), {
    statePaths: [fixture.statePath],
    allowedWorkspaceRoots: [fixture.workspaceRoot],
  })

  assert.equal(result.ok, true)
  assert.equal(invocations.length, 1)
  assert.equal(invocations[0].cwd, fixture.workspaceRoot)
  assert.deepEqual(invocations[0].args.slice(0, 2), ['--state', fixture.statePath])
}

async function assertArtifactApproveRejectsUnauthorizedDiscoveredStatePath(): Promise<void> {
  const fixture = await writeSprintEngineFixture('unauthorized-review-team', '.multi-code/sprintengine/unauthorized-review-team/documents/requirements.md')
  const allowedWorkspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-allowed-'))
  let invocationCount = 0
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: allowedWorkspaceRoot,
    now: () => now,
    execute: async () => {
      invocationCount += 1
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' }
    },
  })

  const result = await service.dispatch(command('artifact.approve', {
    sprintEngineId: 'unauthorized-review-team',
    artifactId: 'A1',
  }, {
    commandId: 'cmd_unauthorized_review',
    idempotencyKey: 'mobile:device_1:unauthorized-review',
  }), {
    statePaths: [fixture.statePath],
    allowedWorkspaceRoots: [allowedWorkspaceRoot],
  })

  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'path_not_allowed')
  assert.equal(invocationCount, 0)
}

async function assertArtifactRequestChangesInvokesSprintEngineTool(): Promise<void> {
  const fixture = await writeSprintEngineFixture('request-changes-team', '.multi-code/sprintengine/request-changes-team/documents/requirements.md')
  const invocations: Array<{ args: string[]; cwd: string }> = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async (invocation) => {
      invocations.push(invocation)
      return { exitCode: 0, stdout: '{"ok":true,"action":"changes_requested"}', stderr: '' }
    },
  })

  const result = await service.dispatch(command('artifact.requestChanges', {
    sprintEngineId: 'request-changes-team',
    artifactId: 'A1',
    feedback: 'Clarify the acceptance criteria.',
  }))

  assert.equal(result.ok, true)
  assert.equal(invocations.length, 1)
  assert.deepEqual(invocations[0].args, [
    '--state',
    fixture.statePath,
    'artifact',
    'request-changes',
    '--artifact-id',
    'A1',
    '--id',
    'mobile:device_1',
    '--feedback',
    'Clarify the acceptance criteria.',
  ])
  assert.equal(invocations[0].cwd, fixture.workspaceRoot)
}

function assertAutoRunArtifactApproveArgsUseCanonicalActor(): void {
  assert.deepEqual(buildSprintEngineArtifactReviewArgs({
    statePath: '/workspace/.multi-code/sprintengine/team/state.yaml',
    action: 'approve',
    artifactId: 'A1',
    actorId: 'auto-run',
  }), [
    '--state',
    '/workspace/.multi-code/sprintengine/team/state.yaml',
    'artifact',
    'approve',
    '--artifact-id',
    'A1',
    '--id',
    'auto-run',
  ])
}

async function assertArtifactRequestChangesRejectsStaleSnapshot(): Promise<void> {
  const fixture = await writeSprintEngineFixture('stale-team', '.multi-code/sprintengine/stale-team/documents/requirements.md')
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async () => {
      throw new Error('tool should not run for stale snapshots')
    },
  })

  const result = await service.dispatch(command('artifact.requestChanges', {
    sprintEngineId: 'stale-team',
    artifactId: 'A1',
    feedback: 'Clarify the acceptance criteria.',
  }, {
    expectedSnapshotVersion: 'snap_stale',
    idempotencyKey: 'mobile:device_1:stale',
  }))

  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'stale_snapshot')
}

async function assertSameIdempotencyKeyAndBodyReplaysCachedResult(): Promise<void> {
  const fixture = await writeSprintEngineFixture('replay-team', '.multi-code/sprintengine/replay-team/documents/requirements.md')
  let invocationCount = 0
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async () => {
      invocationCount += 1
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' }
    },
  })
  const mobileCommand = command('artifact.approve', {
    sprintEngineId: 'replay-team',
    artifactId: 'A1',
  }, {
    idempotencyKey: 'mobile:device_1:replay',
  })

  const first = await service.dispatch(mobileCommand)
  const second = await service.dispatch({ ...mobileCommand, commandId: 'cmd_replay' })

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(invocationCount, 1)
  assert.deepEqual(second.ok && first.ok ? second.data : null, first.ok ? first.data : null)
  assert.equal(service.getAuditLog()[0].status, 'accepted')
  assert.equal(service.getAuditLog()[0].deviceId, 'device_1')
  assert.equal(service.getAuditLog()[0].commandId, 'cmd_replay')
}

async function assertSameIdempotencyKeyWithDifferentBodyIsRejected(): Promise<void> {
  const fixture = await writeSprintEngineFixture('replay-conflict-team', '.multi-code/sprintengine/replay-conflict-team/documents/requirements.md')
  let invocationCount = 0
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async () => {
      invocationCount += 1
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' }
    },
  })
  const firstCommand = command('artifact.approve', {
    sprintEngineId: 'replay-conflict-team',
    artifactId: 'A1',
  }, {
    idempotencyKey: 'mobile:device_1:replay-conflict',
  })

  const first = await service.dispatch(firstCommand)
  const second = await service.dispatch(command('artifact.requestChanges', {
    sprintEngineId: 'replay-conflict-team',
    artifactId: 'A1',
    feedback: 'This different body must not be executed.',
  }, {
    commandId: 'cmd_replay_conflict',
    idempotencyKey: 'mobile:device_1:replay-conflict',
  }))

  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.ok === false ? second.error.code : '', 'duplicate_idempotency_key')
  assert.equal(invocationCount, 1)
  const audit = service.getAuditLog()[0]
  assert.equal(audit.status, 'rejected')
  assert.equal(audit.deviceId, 'device_1')
  assert.equal(audit.commandId, 'cmd_replay_conflict')
  assert.equal(audit.code, 'duplicate_idempotency_key')
  assert.equal(JSON.stringify(audit).includes('This different body'), false)
}

async function assertIdempotencyReplaySurvivesServiceRecreation(): Promise<void> {
  const fixture = await writeSprintEngineFixture('replay-recreate-team', '.multi-code/sprintengine/replay-recreate-team/documents/requirements.md')
  let invocationCount = 0
  const firstService = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async () => {
      invocationCount += 1
      return { exitCode: 0, stdout: '{"ok":true,"action":"approved"}', stderr: '' }
    },
  })
  const mobileCommand = command('artifact.approve', {
    sprintEngineId: 'replay-recreate-team',
    artifactId: 'A1',
  }, {
    idempotencyKey: 'mobile:device_1:replay-recreate',
  })

  const first = await firstService.dispatch(mobileCommand)
  const recreatedService = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async () => {
      invocationCount += 1
      return { exitCode: 0, stdout: '{"ok":true,"action":"approved-again"}', stderr: '' }
    },
  })
  const second = await recreatedService.dispatch({ ...mobileCommand, commandId: 'cmd_replay_recreate' })

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(invocationCount, 1)
  assert.deepEqual(second.ok && first.ok ? second.data : null, first.ok ? first.data : null)
}

async function assertToolSuccessResponseLossRetryDoesNotReinvokeTool(): Promise<void> {
  const fixture = await writeSprintEngineFixture('response-loss-team', '.multi-code/sprintengine/response-loss-team/documents/requirements.md')
  let invocationCount = 0
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async () => {
      invocationCount += 1
      return { exitCode: 0, stdout: '{"ok":true,"action":"changes_requested"}', stderr: '' }
    },
  })
  const mobileCommand = command('artifact.requestChanges', {
    sprintEngineId: 'response-loss-team',
    artifactId: 'A1',
    feedback: 'Clarify the launch criteria.',
  }, {
    idempotencyKey: 'mobile:device_1:response-loss',
  })

  await service.dispatch(mobileCommand)
  const retry = await service.dispatch({ ...mobileCommand, commandId: 'cmd_response_loss_retry' })

  assert.equal(retry.ok, true)
  assert.equal(invocationCount, 1)
  assert.equal(retry.ok ? (retry.data as { action: string }).action : '', 'changes_requested')
}

async function assertInvalidArtifactPathIsRejected(): Promise<void> {
  const fixture = await writeSprintEngineFixture('invalid-artifact-team', '../outside.md')
  let invocationCount = 0
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async () => {
      invocationCount += 1
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' }
    },
  })

  const result = await service.dispatch(command('artifact.approve', {
    sprintEngineId: 'invalid-artifact-team',
    artifactId: 'A1',
  }))

  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'path_not_allowed')
  assert.equal(invocationCount, 0)
}

async function assertSprintEngineCreateUsesControlledHandover(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-create-'))
  const invocations: Array<{ args: string[]; cwd: string }> = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot,
    now: () => now,
    execute: async (invocation) => {
      invocations.push(invocation)
      return { exitCode: 0, stdout: '{"ok":true,"action":"handover","team":"mobile-cmd-create"}', stderr: '' }
    },
  })

  const result = await service.dispatch(command('sprintengine.create', {
    workspacePath: workspaceRoot,
    productPrompt: 'Build a focused mobile companion sprintengine.',
  }, {
    commandId: 'cmd_create',
    idempotencyKey: 'mobile:device_1:create',
  }))

  assert.equal(result.ok, true)
  assert.equal(invocations.length, 1)
  assert.equal(invocations[0].cwd, workspaceRoot)
  assert.deepEqual(invocations[0].args.slice(0, 4), ['handover', '--name', 'mobile-cmd_create', '--goal'])
  assert.equal(invocations[0].args.includes('--handover-text'), true)
  assert.equal(invocations[0].args.includes('--actor'), true)
}

async function assertTaskStartUsesDesktopSessionOrchestration(): Promise<void> {
  const fixture = await writeSprintEngineFixture('task-start-team', '.multi-code/sprintengine/task-start-team/documents/requirements.md', {
    tasks: [
      task('T1', 'architect', 'done'),
      task('T2', 'developer', 'todo', { dependsOn: ['T1'] }),
    ],
  })
  const starts: Parameters<MobileSprintEngineSessionOrchestrator['startTask']>[0][] = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async () => {
      throw new Error('Sprint Engine tool should not run for task starts')
    },
    sessionOrchestrator: {
      startTask: async (request) => {
        starts.push(request)
        return {
          sessionId: 'session_1',
          agentId: 'developer-1',
          executionMode: 'current_workspace',
        }
      },
      sendFollowUp: async () => {
        throw new Error('follow-up should not run for task starts')
      },
    },
  })

  const result = await service.dispatch(command('task.start', {
    sprintEngineId: 'task-start-team',
    taskId: 'T2',
    role: 'developer',
    worktreeIsolation: 'preferred',
  }, {
    idempotencyKey: 'mobile:device_1:task-start',
  }))

  assert.equal(result.ok, true)
  assert.equal(starts.length, 1)
  assert.equal(starts[0].statePath, fixture.statePath)
  assert.equal(starts[0].taskId, 'T2')
  assert.equal(starts[0].role, 'developer')
  assert.equal(result.ok === true ? (result.data as { sessionId: string }).sessionId : '', 'session_1')
  assert.equal(service.getAuditLog()[0].status, 'accepted')
}

async function assertTaskStartUsesAuthorizedDiscoveredStateOutsideServiceCwd(): Promise<void> {
  const fixture = await writeSprintEngineFixture('discovered-task-start-team', '.multi-code/sprintengine/discovered-task-start-team/documents/requirements.md', {
    tasks: [
      task('T1', 'architect', 'done'),
      task('T2', 'developer', 'todo', { dependsOn: ['T1'] }),
    ],
  })
  const serviceWorkspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-cwd-'))
  const starts: Parameters<MobileSprintEngineSessionOrchestrator['startTask']>[0][] = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: serviceWorkspaceRoot,
    now: () => now,
    sessionOrchestrator: {
      startTask: async (request) => {
        starts.push(request)
        return { sessionId: 'session_discovered', agentId: 'developer-1', executionMode: 'current_workspace' }
      },
      sendFollowUp: async () => {
        throw new Error('follow-up should not run for task starts')
      },
    },
  })

  const result = await service.dispatch(command('task.start', {
    sprintEngineId: 'discovered-task-start-team',
    taskId: 'T2',
    role: 'developer',
    worktreeIsolation: 'preferred',
  }, {
    commandId: 'cmd_discovered_task_start',
    idempotencyKey: 'mobile:device_1:discovered-task-start',
  }), {
    statePaths: [fixture.statePath],
    allowedWorkspaceRoots: [fixture.workspaceRoot],
  })

  assert.equal(result.ok, true)
  assert.equal(starts.length, 1)
  assert.equal(starts[0].statePath, fixture.statePath)
  assert.equal(starts[0].workspaceRoot, fixture.workspaceRoot)
}

async function assertTaskStartRejectsBlockedDependencies(): Promise<void> {
  const fixture = await writeSprintEngineFixture('task-blocked-team', '.multi-code/sprintengine/task-blocked-team/documents/requirements.md', {
    tasks: [
      task('T1', 'architect', 'todo'),
      task('T2', 'developer', 'todo', { dependsOn: ['T1'] }),
    ],
  })
  let startCount = 0
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    sessionOrchestrator: {
      startTask: async () => {
        startCount += 1
        return { sessionId: 'session_1', agentId: 'developer-1', executionMode: 'current_workspace' }
      },
      sendFollowUp: async () => {
        throw new Error('follow-up should not run for blocked task starts')
      },
    },
  })

  const result = await service.dispatch(command('task.start', {
    sprintEngineId: 'task-blocked-team',
    taskId: 'T2',
    role: 'developer',
    worktreeIsolation: 'preferred',
  }, {
    idempotencyKey: 'mobile:device_1:task-blocked',
  }))

  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'task_not_ready')
  assert.equal(startCount, 0)
}

async function assertFollowUpUsesKnownAgentSessionOrchestration(): Promise<void> {
  const fixture = await writeSprintEngineFixture('follow-up-team', '.multi-code/sprintengine/follow-up-team/documents/requirements.md', {
    tasks: [
      task('T1', 'developer', 'in_progress', { ownerAgentId: 'developer-1' }),
    ],
    sprintEngineAgents: {
      'developer-1': { role: 'developer', status: 'running', currentTaskId: 'T1' },
    },
  })
  const followUps: Parameters<MobileSprintEngineSessionOrchestrator['sendFollowUp']>[0][] = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    sessionOrchestrator: {
      startTask: async () => {
        throw new Error('task start should not run for follow-up')
      },
      sendFollowUp: async (request) => {
        followUps.push(request)
        return { sessionId: 'session_2', agentId: request.agentId, acceptedAt: now.toISOString() }
      },
    },
  })

  const result = await service.dispatch(command('agent.followUp', {
    sprintEngineId: 'follow-up-team',
    agentId: 'developer-1',
    text: 'Please include the failing command output in your evidence.',
  }, {
    idempotencyKey: 'mobile:device_1:follow-up',
  }))

  assert.equal(result.ok, true)
  assert.equal(followUps.length, 1)
  assert.equal(followUps[0].agentId, 'developer-1')
  assert.equal(followUps[0].text, 'Please include the failing command output in your evidence.')
}

async function assertFollowUpUsesAuthorizedDiscoveredStateOutsideServiceCwd(): Promise<void> {
  const fixture = await writeSprintEngineFixture('discovered-follow-up-team', '.multi-code/sprintengine/discovered-follow-up-team/documents/requirements.md', {
    tasks: [
      task('T1', 'developer', 'in_progress', { ownerAgentId: 'developer-1' }),
    ],
    sprintEngineAgents: {
      'developer-1': { role: 'developer', status: 'running', currentTaskId: 'T1' },
    },
  })
  const serviceWorkspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-cwd-'))
  const followUps: Parameters<MobileSprintEngineSessionOrchestrator['sendFollowUp']>[0][] = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: serviceWorkspaceRoot,
    now: () => now,
    sessionOrchestrator: {
      startTask: async () => {
        throw new Error('task start should not run for follow-up')
      },
      sendFollowUp: async (request) => {
        followUps.push(request)
        return { sessionId: 'session_discovered_follow_up', agentId: request.agentId, acceptedAt: now.toISOString() }
      },
    },
  })

  const result = await service.dispatch(command('agent.followUp', {
    sprintEngineId: 'discovered-follow-up-team',
    agentId: 'developer-1',
    text: 'Continue with the latest approved plan.',
  }, {
    commandId: 'cmd_discovered_follow_up',
    idempotencyKey: 'mobile:device_1:discovered-follow-up',
  }), {
    statePaths: [fixture.statePath],
    allowedWorkspaceRoots: [fixture.workspaceRoot],
  })

  assert.equal(result.ok, true)
  assert.equal(followUps.length, 1)
  assert.equal(followUps[0].statePath, fixture.statePath)
  assert.equal(followUps[0].workspaceRoot, fixture.workspaceRoot)
}

async function assertFollowUpRejectsTerminalControlCharacters(): Promise<void> {
  const fixture = await writeSprintEngineFixture('follow-up-control-team', '.multi-code/sprintengine/follow-up-control-team/documents/requirements.md', {
    tasks: [
      task('T1', 'developer', 'in_progress', { ownerAgentId: 'developer-1' }),
    ],
    sprintEngineAgents: {
      'developer-1': { role: 'developer', status: 'running', currentTaskId: 'T1' },
    },
  })
  let followUpCount = 0
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    sessionOrchestrator: {
      startTask: async () => {
        throw new Error('task start should not run for control character rejection')
      },
      sendFollowUp: async () => {
        followUpCount += 1
        return { sessionId: 'session_2', agentId: 'developer-1', acceptedAt: now.toISOString() }
      },
    },
  })

  for (const [text, suffix] of [
    ['hello\nthere', 'newline'],
    ['hello\rthere', 'carriage-return'],
    ['hello\u001B[2J', 'escape'],
  ] as const) {
    const result = await service.dispatch(command('agent.followUp', {
      sprintEngineId: 'follow-up-control-team',
      agentId: 'developer-1',
      text,
    }, {
      commandId: `cmd_follow_up_${suffix}`,
      idempotencyKey: `mobile:device_1:follow-up-control-${suffix}`,
    }))

    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.error.code : '', 'invalid_payload')
  }
  assert.equal(followUpCount, 0)
}

async function assertUnsupportedCommandIsRejected(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-unsupported-'))
  const service = new MobileSprintEngineCommandService({
    workspaceRoot,
    now: () => now,
    execute: async () => {
      throw new Error('tool should not run for unsupported commands')
    },
  })

  const result = await service.dispatch(command('task.start', {
    sprintEngineId: 'team',
    taskId: 'T1',
    role: 'developer',
    worktreeIsolation: 'preferred',
  }))

  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'command_not_supported')
}

async function assertFilesystemMutationHandlersProtectSprintEngineStateAliases(): Promise<void> {
  const handlers = await importMainProcessIpcHandlers()
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-fs-guard-'))
  const sprintEngineDirectory = join(workspaceRoot, '.multi-code', 'sprintengine')
  const teamDirectory = join(sprintEngineDirectory, 'team')
  await mkdir(teamDirectory, { recursive: true })
  const statePath = join(teamDirectory, 'state.yaml')
  await writeFile(statePath, 'canonical Sprint Engine state\n', 'utf8')

  const stateSymlinkPath = join(workspaceRoot, 'state-link.yaml')
  const teamSymlinkPath = join(workspaceRoot, 'team-link')
  const hasStateSymlink = await tryCreateSymlink(statePath, stateSymlinkPath, 'file')
  const hasTeamSymlink = await tryCreateSymlink(
    teamDirectory,
    teamSymlinkPath,
    platform() === 'win32' ? 'junction' : 'dir'
  )

  await assertRejectsSprintEngineStateMutation(() => handlers.writeFile(statePath, 'blocked'))
  await assertRejectsSprintEngineStateMutation(() => handlers.writeFile(join(teamDirectory, '..', 'team', 'state.yaml'), 'blocked'))
  if (hasStateSymlink) {
    await assertRejectsSprintEngineStateMutation(() => handlers.writeFile(stateSymlinkPath, 'blocked'))
  }
  if (hasTeamSymlink) {
    await assertRejectsSprintEngineStateMutation(() => handlers.writeFile(join(teamSymlinkPath, 'state.yaml'), 'blocked'))
  }

  if (hasStateSymlink) {
    await assertRejectsSprintEngineStateMutation(() => handlers.rename(stateSymlinkPath, 'renamed-link.yaml'))
  }
  if (hasTeamSymlink) {
    const renameSourceThroughAlias = join(teamSymlinkPath, 'rename-source.txt')
    await writeFile(renameSourceThroughAlias, 'safe source\n', 'utf8')
    await assertRejectsSprintEngineStateMutation(() => handlers.rename(renameSourceThroughAlias, 'state.yaml'))
  }

  const copyDestination = join(workspaceRoot, 'copy-destination')
  await mkdir(copyDestination)
  if (hasStateSymlink) {
    await assertRejectsSprintEngineStateMutation(() => handlers.copy(stateSymlinkPath, copyDestination))
    await assertRejectsSprintEngineStateMutation(() => handlers.delete(stateSymlinkPath))
  }
  await assertRejectsSprintEngineStateMutation(() => handlers.rename(teamDirectory, 'team-renamed'))
  await assertRejectsSprintEngineStateMutation(() => handlers.copy(teamDirectory, copyDestination))
  await assertRejectsSprintEngineStateMutation(() => handlers.delete(teamDirectory))
  await assertRejectsSprintEngineStateMutation(() => handlers.rename(sprintEngineDirectory, 'sprintengine-renamed'))
  await assertRejectsSprintEngineStateMutation(() => handlers.copy(sprintEngineDirectory, copyDestination))
  await assertRejectsSprintEngineStateMutation(() => handlers.delete(sprintEngineDirectory))
  if (hasTeamSymlink) {
    await assertRejectsSprintEngineStateMutation(() => handlers.rename(teamSymlinkPath, 'team-link-renamed'))
    await assertRejectsSprintEngineStateMutation(() => handlers.copy(teamSymlinkPath, copyDestination))
    await assertRejectsSprintEngineStateMutation(() => handlers.delete(teamSymlinkPath))
  }

  assert.equal(await readFile(statePath, 'utf8'), 'canonical Sprint Engine state\n')

  const safeDirectory = join(workspaceRoot, 'safe')
  const safeCopyDestination = join(workspaceRoot, 'safe-copy')
  await mkdir(safeDirectory)
  await mkdir(safeCopyDestination)

  const safeFilePath = join(safeDirectory, 'notes.txt')
  await handlers.writeFile(safeFilePath, 'safe write\n')
  assert.equal(await readFile(safeFilePath, 'utf8'), 'safe write\n')

  const renamedSafeFilePath = await handlers.rename(safeFilePath, 'renamed.txt')
  assert.equal(renamedSafeFilePath, join(safeDirectory, 'renamed.txt'))
  assert.equal(await readFile(renamedSafeFilePath, 'utf8'), 'safe write\n')

  const copiedSafeFilePath = await handlers.copy(renamedSafeFilePath, safeCopyDestination)
  assert.equal(await readFile(copiedSafeFilePath, 'utf8'), 'safe write\n')

  await handlers.delete(copiedSafeFilePath)
  await assert.rejects(() => access(copiedSafeFilePath))

  const safeNestedDirectory = join(workspaceRoot, 'safe-dir')
  await mkdir(join(safeNestedDirectory, 'nested'), { recursive: true })
  await writeFile(join(safeNestedDirectory, 'nested', 'notes.txt'), 'safe nested write\n', 'utf8')

  const renamedSafeDirectoryPath = await handlers.rename(safeNestedDirectory, 'safe-dir-renamed')
  assert.equal(await readFile(join(renamedSafeDirectoryPath, 'nested', 'notes.txt'), 'utf8'), 'safe nested write\n')

  const copiedSafeDirectoryPath = await handlers.copy(renamedSafeDirectoryPath, safeCopyDestination)
  assert.equal(await readFile(join(copiedSafeDirectoryPath, 'nested', 'notes.txt'), 'utf8'), 'safe nested write\n')

  await handlers.delete(copiedSafeDirectoryPath)
  await assert.rejects(() => access(copiedSafeDirectoryPath))
  await handlers.delete(renamedSafeDirectoryPath)
  await assert.rejects(() => access(renamedSafeDirectoryPath))
}

async function tryCreateSymlink(targetPath: string, linkPath: string, type: 'file' | 'dir' | 'junction'): Promise<boolean> {
  try {
    await symlink(targetPath, linkPath, type)
    return true
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && (error.code === 'EPERM' || error.code === 'EACCES')
    ) {
      return false
    }
    throw error
  }
}

type FilesystemMutationHandlers = {
  writeFile: (filePath: string, content: string) => Promise<void>
  rename: (sourcePath: string, nextName: string) => Promise<string>
  copy: (sourcePath: string, destinationDir: string) => Promise<string>
  delete: (targetPath: string) => Promise<void>
}

async function importMainProcessIpcHandlers(): Promise<FilesystemMutationHandlers> {
  const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const nodeRequire = createRequire(__filename)
  const moduleLoader = nodeRequire('node:module') as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown
  }
  const originalLoad = moduleLoader._load

  moduleLoader._load = (request, parent, isMain) => {
    if (request === 'electron') {
      return {
        app: {
          defaultApp: false,
          getAppPath: () => process.cwd(),
          getPath: (name: string) => join(tmpdir(), `multicode-electron-${name}`),
          isPackaged: false,
          on: () => undefined,
          quit: () => undefined,
          requestSingleInstanceLock: () => true,
          setAppLogsPath: () => undefined,
          setAppUserModelId: () => undefined,
          setAsDefaultProtocolClient: () => true,
          whenReady: () => new Promise(() => undefined),
        },
        BrowserWindow: class {
          static getAllWindows(): unknown[] {
            return []
          }
        },
        dialog: {},
        ipcMain: {
          handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
            ipcHandlers.set(channel, handler)
          },
          on: () => undefined,
        },
        Menu: {
          buildFromTemplate: () => ({}),
          setApplicationMenu: () => undefined,
        },
        safeStorage: {
          decryptString: () => '',
          encryptString: (value: string) => Buffer.from(value),
          isEncryptionAvailable: () => true,
        },
        shell: {
          openExternal: async () => undefined,
          openPath: async () => '',
          showItemInFolder: () => undefined,
          trashItem: async (targetPath: string) => {
            await rm(targetPath, { force: true, recursive: true })
          },
        },
      }
    }
    if (request === 'electron-updater') {
      return { autoUpdater: { checkForUpdatesAndNotify: async () => undefined } }
    }
    if (request === 'node-pty') {
      return { spawn: () => { throw new Error('node-pty should not be used in filesystem IPC tests') } }
    }
    if (request === '@vscode/ripgrep') {
      return { rgPath: 'rg' }
    }
    return originalLoad(request, parent, isMain)
  }

  try {
    await import('../../index')
  } finally {
    moduleLoader._load = originalLoad
  }

  const getHandler = (channel: string): ((...args: unknown[]) => Promise<unknown>) => {
    const handler = ipcHandlers.get(channel)
    assert.ok(handler, `${channel} handler should be registered`)
    return async (...args) => handler(null, ...args) as Promise<unknown>
  }

  return {
    writeFile: async (filePath, content) => {
      await getHandler('fs:writefile')(filePath, content)
    },
    rename: async (sourcePath, nextName) => {
      return await getHandler('fs:rename')(sourcePath, nextName) as string
    },
    copy: async (sourcePath, destinationDir) => {
      return await getHandler('fs:copy')(sourcePath, destinationDir) as string
    },
    delete: async (targetPath) => {
      await getHandler('fs:delete')(targetPath)
    },
  }
}

async function assertRejectsSprintEngineStateMutation(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(
    action,
    (error) => error instanceof Error && error.message === 'Sprint Engine state files must be updated through the Sprint Engine tool.'
  )
}

async function writeSprintEngineFixture(
  sprintEngineId: string,
  artifactPath: string,
  options: {
    tasks?: unknown[]
    sprintEngineAgents?: Record<string, unknown>
  } = {}
): Promise<{ workspaceRoot: string; statePath: string }> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-'))
  const teamDirectory = join(workspaceRoot, '.multi-code', 'sprintengine', sprintEngineId)
  await mkdir(join(teamDirectory, 'documents'), { recursive: true })
  await writeFile(join(teamDirectory, 'documents', 'requirements.md'), '# Requirements\n', 'utf8')
  const statePath = join(teamDirectory, 'state.yaml')
  await writeFile(statePath, `${JSON.stringify({
    sprintengine: {
      name: sprintEngineId,
      updatedAt: '2026-04-28T19:44:00.000Z',
    },
    tasks: options.tasks ?? [],
    sprintEngineAgents: options.sprintEngineAgents ?? {},
    artifacts: [
      {
        id: 'A1',
        kind: 'requirements',
        title: 'Requirements',
        path: artifactPath,
        status: 'ready_for_review',
        taskId: 'T1',
      },
    ],
  }, null, 2)}\n`, 'utf8')
  await readSprintEngineSnapshot(statePath)
  return { workspaceRoot, statePath }
}

function task(
  id: string,
  role: string,
  status: 'todo' | 'in_progress' | 'needs_input' | 'done',
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    title: `Task ${id}`,
    role,
    status,
    ownerAgentId: null,
    dependsOn: [],
    ...overrides,
  }
}

function command(
  type: MobileControlCommand['type'],
  payload: MobileControlCommand['payload'],
  overrides: Partial<MobileControlCommand> = {}
): MobileControlCommand {
  return {
    protocolVersion: mobileControlProtocolVersion,
    commandId: 'cmd_1',
    type,
    issuedAt: now.toISOString(),
    deviceId: 'device_1',
    idempotencyKey: 'mobile:device_1:cmd_1',
    payload,
    ...overrides,
  } as MobileControlCommand
}
