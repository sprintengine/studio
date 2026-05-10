import assert from 'node:assert/strict'
import {
  MobileSprintEngineActivityPublisher,
  pushTokenHash,
  type MobileNotificationDelivery,
  type MobilePushRegistrationTarget,
} from './activity'
import type { MobileControlSnapshot, MobileSprintEngineSnapshot } from './snapshot'
import type { MobileSprintEngineCommandAuditEntry } from './command'

const now = new Date('2026-04-28T20:40:00.000Z')

void main()

async function main(): Promise<void> {
  assertPushTokenHashIsStable()
  await assertSnapshotActivityPublishesSanitizedNotifications()
  await assertRevokedRegistrationsReceiveNoNotifications()
  await assertCommandFailureAndDesktopOfflinePublishNotifications()
}

function assertPushTokenHashIsStable(): void {
  assert.equal(pushTokenHash('ExponentPushToken[test-token]'), pushTokenHash('ExponentPushToken[test-token]'))
  assert.notEqual(pushTokenHash('ExponentPushToken[test-token]'), 'ExponentPushToken[test-token]')
}

async function assertSnapshotActivityPublishesSanitizedNotifications(): Promise<void> {
  const deliveries: MobileNotificationDelivery[] = []
  const publisher = new MobileSprintEngineActivityPublisher({
    now: () => now,
    getPushTargets: () => [{ deviceId: 'device_1', registrationId: 'mpr_1' }],
    publish: (delivery) => deliveries.push(delivery),
  })

  publisher.publishSnapshotActivity(snapshot([
    sprintengine('team', {
      tasks: [task('T1', 'in_progress')],
      artifacts: [artifact('A1', 'draft')],
    }),
  ]))
  const emitted = publisher.publishSnapshotActivity(snapshot([
    sprintengine('team', {
      tasks: [task('T1', 'needs_input')],
      artifacts: [artifact('A1', 'ready_for_review')],
    }),
  ]))

  assert.equal(emitted.length, 2)
  assert.deepEqual(
    emitted.map((delivery) => delivery.event.payload.category).sort(),
    ['artifact.ready', 'task.needs_input']
  )
  assert.deepEqual(
    emitted.map((delivery) => delivery.event.payload.deepLink).sort(),
    [
      'multicode-mobile://sprintengines/team/artifacts/A1',
      'multicode-mobile://sprintengines/team/tasks/T1',
    ]
  )

  const serialized = JSON.stringify(emitted)
  assert.equal(serialized.includes('source code'), false)
  assert.equal(serialized.includes('artifact body'), false)
  assert.equal(serialized.includes('/private/workspace'), false)
  assert.equal(deliveries.length, 2)
}

async function assertRevokedRegistrationsReceiveNoNotifications(): Promise<void> {
  const targets: MobilePushRegistrationTarget[] = [
    { deviceId: 'active_device', registrationId: 'mpr_active' },
    { deviceId: 'revoked_device', registrationId: 'mpr_revoked', revokedAt: now.toISOString() },
  ]
  const deliveries: MobileNotificationDelivery[] = []
  const publisher = new MobileSprintEngineActivityPublisher({
    now: () => now,
    getPushTargets: () => targets,
    publish: (delivery) => deliveries.push(delivery),
  })

  publisher.publishSnapshotActivity(snapshot([
    sprintengine('complete-team', {
      tasks: [task('T1', 'done')],
      artifacts: [],
    }),
  ]))

  assert.deepEqual(deliveries.map((delivery) => delivery.deviceId), ['active_device'])
  assert.equal(deliveries[0].event.payload.category, 'sprintengine.complete')
}

async function assertCommandFailureAndDesktopOfflinePublishNotifications(): Promise<void> {
  const deliveries: MobileNotificationDelivery[] = []
  const publisher = new MobileSprintEngineActivityPublisher({
    now: () => now,
    getPushTargets: () => [{ deviceId: 'device_1', registrationId: 'mpr_1' }],
    publish: (delivery) => deliveries.push(delivery),
  })

  publisher.publishCommandAudit(commandAudit())
  publisher.publishDesktopPresence(false)
  publisher.publishDesktopPresence(false)

  assert.deepEqual(
    deliveries.map((delivery) => delivery.event.payload.category),
    ['command.failed', 'desktop.offline']
  )
  assert.equal(deliveries[0].event.payload.deepLink, 'multicode-mobile://sprintengines/team/commands/cmd_1')
  assert.equal(deliveries[1].event.payload.deepLink, 'multicode-mobile://desktop')
}

function snapshot(sprintEngines: MobileSprintEngineSnapshot[]): MobileControlSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: now.toISOString(),
    desktopSessionId: 'desktop_1',
    sprintEngines,
  }
}

function sprintengine(
  sprintEngineId: string,
  input: Pick<MobileSprintEngineSnapshot, 'tasks' | 'artifacts'>
): MobileSprintEngineSnapshot {
  return {
    sprintEngineId,
    name: 'Mobile SprintEngine',
    workspacePath: '/private/workspace',
    statePath: `/private/workspace/.multi-code/sprintengine/${sprintEngineId}/state.yaml`,
    planPath: `/private/workspace/.multi-code/sprintengine/${sprintEngineId}/plan.md`,
    snapshotVersion: `snap_${sprintEngineId}`,
    updatedAt: now.toISOString(),
    board: {
      todo: 0,
      ready: 0,
      inProgress: input.tasks.filter((candidate) => candidate.status === 'in_progress').length,
      needsInput: input.tasks.filter((candidate) => candidate.status === 'needs_input').length,
      blocked: 0,
      done: input.tasks.filter((candidate) => candidate.status === 'done').length,
    },
    tasks: input.tasks,
    artifacts: input.artifacts,
  }
}

function task(taskId: string, status: MobileSprintEngineSnapshot['tasks'][number]['status']): MobileSprintEngineSnapshot['tasks'][number] {
  return {
    taskId,
    title: `Task ${taskId} source code`,
    role: 'developer',
    status,
    dependsOn: [],
  }
}

function artifact(
  artifactId: string,
  status: MobileSprintEngineSnapshot['artifacts'][number]['status']
): MobileSprintEngineSnapshot['artifacts'][number] {
  return {
    artifactId,
    title: `Artifact ${artifactId} artifact body`,
    kind: 'requirements',
    status,
    taskId: 'T1',
    path: `/private/workspace/.multi-code/sprintengine/team/documents/${artifactId}.md`,
  }
}

function commandAudit(): MobileSprintEngineCommandAuditEntry {
  return {
    auditId: 'msa_1',
    commandId: 'cmd_1',
    commandType: 'artifact.approve',
    deviceId: 'device_1',
    idempotencyKey: 'idem_1',
    status: 'failed',
    code: 'python_tool_failed',
    message: 'Sprint Engine tool failed without exposing output.',
    recordedAt: now.toISOString(),
    statePath: '/private/workspace/.multi-code/sprintengine/team/state.yaml',
    artifactId: 'A1',
    toolArgs: ['artifact', 'approve'],
    exitCode: 1,
  }
}
