import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { WebContents } from 'electron'
import type {
  SwitchboardClaimTaskInput,
  SwitchboardClaimTaskResult,
  SwitchboardExecutionProviderKind,
  SwitchboardMutationResult,
  SwitchboardReadResult,
  SwitchboardRunnerExecution,
  SwitchboardTask,
  SwitchboardTaskRecord,
  SwitchboardUpdateTaskInput,
} from '../shared/switchboard'
import type {
  SwitchboardExecutionProvider,
  SwitchboardExecutionStartInput,
} from './switchboard-execution-provider'
import { createSwitchboardRunner } from './switchboard-runner'
import {
  readRunnerState,
  switchboardRunnerEventsPath,
  switchboardRunnerStatePath,
  writeRunnerState,
} from './switchboard-runner-state'

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main(): Promise<void> {
  await assertRunnerStateReadWrite()
  await assertRunnerPersistsCli()
  await assertRunnerClaimsUpToMaxConcurrencyAndPersistsExecutionLinks()
  await assertTickIsIdempotentAfterConcurrencyIsFull()
  await assertLaunchFailureRequeuesClaimedTask()
  await assertExecutionLinkFailureStopsProviderAndRequeues()
  await assertLegacyActiveSessionsOnlyIncludeActiveExecutions()
  await assertReconciliationMarksMissingExecutionAbandoned()
}

function taskRecord(id: string, folderStatus = 'in_progress'): SwitchboardTaskRecord {
  const now = '2026-05-09T12:00:00Z'
  const task: SwitchboardTask = {
    schemaVersion: 1,
    id,
    identifier: `SB-${id.slice(0, 8)}`,
    title: `Task ${id}`,
    description: '',
    priority: null,
    state: folderStatus as SwitchboardTask['state'],
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    source: { type: 'manual', externalId: null, externalKey: null, externalUrl: null },
    claim: { owner: 'switchboard-developer', sessionId: null, claimedAt: now },
    execution: { attempts: [], worktreePath: null, activeExecutionId: null, activeProvider: null, activeSessionId: null },
    evidence: { summary: '', artifacts: [], commandsRun: [], touchedFiles: [] },
    comments: [],
    createdAt: now,
    updatedAt: now,
  }
  return {
    task,
    location: {
      folderStatus: folderStatus as SwitchboardTaskRecord['location']['folderStatus'],
      path: `.multi-code/switchboard/tasks/${folderStatus}/${id}.json`,
    },
    warnings: [],
  }
}

function createProvider(kind: SwitchboardExecutionProviderKind = 'desktop-terminal', failStart = false) {
  const started: SwitchboardExecutionStartInput[] = []
  const active = new Map<string, boolean>()
  const stopped: string[] = []
  const provider: SwitchboardExecutionProvider = {
    kind,
    async canStart() {
      return { ok: true }
    },
    async start(input) {
      started.push(input)
      if (failStart) throw new Error('spawn failed')
      active.set(input.executionId, true)
      return {
        executionId: input.executionId,
        provider: kind,
        providerRef: { sessionId: `terminal-${input.taskId}` },
      }
    },
    async list() {
      return []
    },
    async getStatus(input) {
      return active.get(input.executionId) ? 'active' : 'missing'
    },
    async stop(input) {
      stopped.push(input.executionId)
      active.set(input.executionId, false)
    },
  }
  return { provider, started, active, stopped }
}

function createHarness(workspaceRoot: string, taskIds: string[], options: { failStart?: boolean; failUpdate?: boolean } = {}) {
  const remaining = [...taskIds]
  const records = new Map<string, SwitchboardTaskRecord>()
  const claims: SwitchboardClaimTaskInput[] = []
  const updates: SwitchboardUpdateTaskInput[] = []
  const requeues: string[] = []
  const { provider, started, active, stopped } = createProvider('desktop-terminal', options.failStart)
  const runner = createSwitchboardRunner({
    async claimTask(input): Promise<SwitchboardClaimTaskResult> {
      claims.push(input)
      const next = remaining.shift()
      if (!next) return { ok: false, message: 'No eligible task.' }
      const record = taskRecord(next)
      records.set(next, record)
      return { ok: true, record }
    },
    async updateTask(input): Promise<SwitchboardMutationResult> {
      updates.push(input)
      if (options.failUpdate) return { ok: false, message: 'update failed' }
      const record = records.get(input.id)
      if (!record) return { ok: false, message: 'missing task' }
      record.task = { ...record.task, ...input.updates } as SwitchboardTask
      return { ok: true, record }
    },
    async readAll(): Promise<SwitchboardReadResult> {
      return {
        ok: true,
        workspaceRoot,
        switchboardRoot: path.join(workspaceRoot, '.multi-code', 'switchboard'),
        tasks: [...records.values()],
        problems: [],
        locks: [],
      }
    },
    async requeueTask(input): Promise<SwitchboardMutationResult> {
      requeues.push(input.id)
      const record = records.get(input.id)
      if (!record) return { ok: false, message: 'missing task' }
      record.location = {
        folderStatus: record.task.state === 'testing_in_progress' ? 'testing' : record.task.state === 'review_in_progress' ? 'review' : 'ready',
        path: `.multi-code/switchboard/tasks/ready/${input.id}.json`,
      }
      return { ok: true, record }
    },
    providers: {
      'desktop-terminal': provider,
      'headless-process': provider,
      'codex-app-server': provider,
    },
  })
  return { runner, started, active, stopped, claims, updates, requeues, records }
}

async function withWorkspace<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'multicode-switchboard-runner-'))
  try {
    return await fn(workspaceRoot)
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function assertRunnerStateReadWrite(): Promise<void> {
  await withWorkspace(async (workspaceRoot) => {
    const state = await readRunnerState(workspaceRoot)
    assert.equal(state.enabled, false)
    state.enabled = true
    state.paused = false
    state.activeExecutions = [
      {
        executionId: 'exec_test',
        taskId: '11111111-1111-4111-8111-111111111111',
        role: 'developer',
        claimedFrom: 'ready',
        claimedStatus: 'in_progress',
        provider: 'desktop-terminal',
        providerRef: { sessionId: 'terminal-1' },
        startedAt: '2026-05-09T12:00:00Z',
        lastSeenAt: '2026-05-09T12:00:00Z',
      },
    ]
    await writeRunnerState(state)
    const parsed = JSON.parse(await readFile(switchboardRunnerStatePath(workspaceRoot), 'utf-8')) as { activeExecutions: unknown[] }
    assert.equal(parsed.activeExecutions.length, 1)
    assert.equal((await readRunnerState(workspaceRoot)).activeExecutions[0]?.executionId, 'exec_test')
  })
}

async function assertRunnerPersistsCli(): Promise<void> {
  await withWorkspace(async (workspaceRoot) => {
    const { runner, started } = createHarness(workspaceRoot, ['77777777-7777-4777-8777-777777777777'])

    await runner.start({} as WebContents, {
      workspaceRoot,
      maxConcurrency: 1,
      queues: ['ready'],
      cli: 'claude',
    })

    assert.equal((await readRunnerState(workspaceRoot)).cli, 'claude')
    assert.equal(started[0]?.cli, 'claude')
  })
}

async function assertRunnerClaimsUpToMaxConcurrencyAndPersistsExecutionLinks(): Promise<void> {
  await withWorkspace(async (workspaceRoot) => {
    const { runner, started, claims, updates } = createHarness(workspaceRoot, [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ])

    const state = await runner.start({} as WebContents, {
      workspaceRoot,
      maxConcurrency: 2,
      queues: ['ready'],
    })

    assert.equal(state.ok, true)
    assert.equal(state.ok && state.activeExecutions.length, 2)
    assert.equal(started.length, 2)
    assert.equal(claims.length, 2)
    assert.equal(updates.length, 2)
    assert.match(started[0]?.prompt ?? '', /Execution ID: exec_/)
    assert.equal(updates[0]?.updates.execution?.activeProvider, 'desktop-terminal')
    assert.ok(updates[0]?.updates.execution?.activeExecutionId)
  })
}

async function assertTickIsIdempotentAfterConcurrencyIsFull(): Promise<void> {
  await withWorkspace(async (workspaceRoot) => {
    const { runner, started, claims } = createHarness(workspaceRoot, [
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
    ])
    await runner.start({} as WebContents, { workspaceRoot, maxConcurrency: 1, queues: ['ready'] })
    await runner.tick(workspaceRoot)

    assert.equal(started.length, 1)
    assert.equal(claims.length, 1)
  })
}

async function assertLaunchFailureRequeuesClaimedTask(): Promise<void> {
  await withWorkspace(async (workspaceRoot) => {
    const { runner, requeues } = createHarness(
      workspaceRoot,
      ['88888888-8888-4888-8888-888888888888'],
      { failStart: true }
    )

    const state = await runner.start({} as WebContents, { workspaceRoot, maxConcurrency: 1, queues: ['ready'] })

    assert.equal(state.ok, true)
    assert.equal(state.ok && state.activeExecutions.length, 0)
    assert.deepEqual(requeues, ['88888888-8888-4888-8888-888888888888'])
    assert.match(state.ok ? state.lastError ?? '' : '', /spawn failed/)
  })
}

async function assertExecutionLinkFailureStopsProviderAndRequeues(): Promise<void> {
  await withWorkspace(async (workspaceRoot) => {
    const { runner, requeues, stopped } = createHarness(
      workspaceRoot,
      ['99999999-9999-4999-8999-999999999999'],
      { failUpdate: true }
    )

    const state = await runner.start({} as WebContents, { workspaceRoot, maxConcurrency: 1, queues: ['ready'] })

    assert.equal(state.ok, true)
    assert.equal(state.ok && state.activeExecutions.length, 0)
    assert.deepEqual(requeues, ['99999999-9999-4999-8999-999999999999'])
    assert.equal(stopped.length, 1)
    assert.match(state.ok ? state.lastError ?? '' : '', /update failed/)
  })
}

async function assertLegacyActiveSessionsOnlyIncludeActiveExecutions(): Promise<void> {
  await withWorkspace(async (workspaceRoot) => {
    const { runner, active } = createHarness(workspaceRoot, ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])
    const started = await runner.start({} as WebContents, { workspaceRoot, maxConcurrency: 1, queues: ['ready'] })
    const execution = started.ok ? started.activeExecutions[0] as SwitchboardRunnerExecution : null
    assert.ok(execution)
    active.set(execution.executionId, false)
    const fileState = await readRunnerState(workspaceRoot)
    fileState.activeExecutions = fileState.activeExecutions.map((activeExecution) => ({
      ...activeExecution,
      lastSeenAt: '2026-05-09T12:00:00Z',
    }))
    await writeRunnerState(fileState)

    const status = await runner.getState(workspaceRoot)

    assert.equal(status.ok, true)
    assert.equal(status.ok && status.activeExecutions[0]?.status, 'abandoned')
    assert.equal(status.ok && status.activeSessions.length, 0)
  })
}

async function assertReconciliationMarksMissingExecutionAbandoned(): Promise<void> {
  await withWorkspace(async (workspaceRoot) => {
    const { runner, active } = createHarness(workspaceRoot, ['66666666-6666-4666-8666-666666666666'])
    const started = await runner.start({} as WebContents, { workspaceRoot, maxConcurrency: 1, queues: ['ready'] })
    const execution = started.ok ? started.activeExecutions[0] as SwitchboardRunnerExecution : null
    assert.ok(execution)
    active.set(execution.executionId, false)
    const fileState = await readRunnerState(workspaceRoot)
    fileState.activeExecutions = fileState.activeExecutions.map((activeExecution) => ({
      ...activeExecution,
      lastSeenAt: '2026-05-09T12:00:00Z',
    }))
    await writeRunnerState(fileState)

    const status = await runner.getState(workspaceRoot)

    assert.equal(status.ok, true)
    assert.equal(status.ok && status.activeExecutions[0]?.status, 'abandoned')
    const events = await readFile(switchboardRunnerEventsPath(workspaceRoot), 'utf-8')
    assert.match(events, /task_abandoned/)
  })
}
