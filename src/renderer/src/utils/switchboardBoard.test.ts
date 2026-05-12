import assert from 'node:assert/strict'
import {
  attentionReasonDescription,
  attentionReasonLabel,
  deriveAttentionInfo,
} from './switchboardBoard'
import {
  executionRouteLabel,
  executionSubjectLabel,
  isSwitchboardTaskExecution,
} from './switchboardRunner'
import type {
  SwitchboardExecutionStatus,
  SwitchboardFolderStatus,
  SwitchboardRunnerExecution,
  SwitchboardTaskRecord,
} from '../../../shared/switchboard'

function record(
  folderStatus: SwitchboardFolderStatus,
  attempts: Array<{ startedAt: string; completedAt?: string | null }>,
  overrides: Partial<SwitchboardTaskRecord['task']['execution']> = {}
): SwitchboardTaskRecord {
  return {
    location: { folderStatus, path: '/tmp/x.json' },
    warnings: [],
    task: {
      schemaVersion: 1,
      id: '00000000-0000-4000-8000-000000000000',
      identifier: 'TASK-1',
      title: 'Sample',
      description: '',
      priority: null,
      state: folderStatus === 'inbox' ? 'todo' : folderStatus,
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      source: { type: 'manual' },
      claim: null,
      execution: {
        attempts: attempts.map((attempt, idx) => ({
          id: `attempt-${idx}`,
          startedAt: attempt.startedAt,
          completedAt: attempt.completedAt ?? null,
        })),
        worktreePath: null,
        worktreeBranch: null,
        worktreeState: null,
        activeExecutionId: null,
        activeProvider: null,
        activeSessionId: null,
        providerRef: null,
        ...overrides,
      },
      evidence: { summary: '', artifacts: [], commandsRun: [], touchedFiles: [] },
      comments: [],
      createdAt: '2026-05-11T00:00:00Z',
      updatedAt: '2026-05-11T00:00:00Z',
    },
  }
}

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`fail - ${name}`)
    throw error
  }
}

run('returns null for tasks outside claimed lanes', () => {
  const r = record('ready', [{ startedAt: '2026-05-11T00:00:00Z', completedAt: '2026-05-11T00:00:01Z' }])
  assert.equal(deriveAttentionInfo(r, 'abandoned'), null)
})

run('returns null when execution is actively running', () => {
  const r = record('in_progress', [{ startedAt: '2026-05-11T00:00:00Z' }])
  assert.equal(deriveAttentionInfo(r, 'active'), null)
})

const claimedLanes: SwitchboardFolderStatus[] = ['in_progress', 'testing_in_progress', 'review_in_progress']
for (const lane of claimedLanes) {
  for (const status of ['abandoned', 'stopped', 'stale', 'missing'] as SwitchboardExecutionStatus[]) {
    run(`flags ${lane} task with ${status} execution`, () => {
      const r = record(lane, [
        { startedAt: '2026-05-11T00:00:00Z', completedAt: '2026-05-11T00:00:01Z' },
      ])
      const info = deriveAttentionInfo(r, status)
      assert.ok(info, `expected attention info for ${lane}/${status}`)
      assert.equal(info!.reason, status)
      assert.equal(info!.attempts, 1)
      assert.equal(info!.lastAttemptAt, '2026-05-11T00:00:01Z')
    })
  }
}

run('falls back to lost-track when there is no live execution but latest attempt completed', () => {
  const r = record('in_progress', [
    { startedAt: '2026-05-11T00:00:00Z', completedAt: '2026-05-11T00:00:01Z' },
  ])
  const info = deriveAttentionInfo(r, null)
  assert.ok(info)
  assert.equal(info!.reason, 'lost-track')
  assert.equal(info!.attempts, 1)
})

run('does not flag in-progress tasks whose latest attempt is still running', () => {
  const r = record('in_progress', [{ startedAt: '2026-05-11T00:00:00Z' }])
  assert.equal(deriveAttentionInfo(r, null), null)
})

run('counts every attempt in the history', () => {
  const r = record('testing_in_progress', [
    { startedAt: '2026-05-11T00:00:00Z', completedAt: '2026-05-11T00:00:01Z' },
    { startedAt: '2026-05-11T00:01:00Z', completedAt: '2026-05-11T00:01:05Z' },
    { startedAt: '2026-05-11T00:02:00Z', completedAt: '2026-05-11T00:02:30Z' },
  ])
  const info = deriveAttentionInfo(r, 'abandoned')
  assert.ok(info)
  assert.equal(info!.attempts, 3)
  assert.equal(info!.lastAttemptAt, '2026-05-11T00:02:30Z')
})

run('attentionReasonLabel returns human-readable labels for each reason', () => {
  const reasons: Array<'abandoned' | 'stopped' | 'stale' | 'missing' | 'lost-track'> = [
    'abandoned',
    'stopped',
    'stale',
    'missing',
    'lost-track',
  ]
  for (const reason of reasons) {
    const label = attentionReasonLabel(reason)
    assert.ok(label.length > 0, `${reason} should have a label`)
    assert.ok(attentionReasonDescription(reason).length > 0, `${reason} should have a description`)
  }
})

run('runner execution labels handle switchboard task executions', () => {
  const execution: SwitchboardRunnerExecution = {
    executionId: 'exec_1234567890',
    kind: 'switchboard_task',
    taskId: '11111111-2222-4333-8444-555555555555',
    role: 'Developer',
    claimedFrom: 'ready',
    claimedStatus: 'in_progress',
    provider: 'electron-session',
    providerRef: {},
    startedAt: '2026-05-11T00:00:00Z',
    lastSeenAt: '2026-05-11T00:00:01Z',
  }

  assert.equal(isSwitchboardTaskExecution(execution), true)
  assert.equal(executionSubjectLabel(execution), '11111111')
  assert.equal(executionRouteLabel(execution), 'Ready -> in progress')
})

run('runner execution labels handle watchtower executions without task fields', () => {
  const execution: SwitchboardRunnerExecution = {
    executionId: 'exec_abcdef1234567890',
    kind: 'watchtower_review',
    role: 'Performance Engineer',
    provider: 'electron-session',
    providerRef: {},
    startedAt: '2026-05-11T00:00:00Z',
    lastSeenAt: '2026-05-11T00:00:01Z',
    status: 'active',
    watchtowerRunId: 'watchtower_20260511T223057Z_89e921cf',
    watchtowerAgentId: 'watchtower-0a097cf8-performance',
  }

  assert.equal(isSwitchboardTaskExecution(execution), false)
  assert.equal(executionSubjectLabel(execution), 'watchtower-0a097cf8-performance')
  assert.equal(executionRouteLabel(execution), 'Watchtower review')
})

console.log('switchboardBoard attention tests passed')
