import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import {
  MobileSprintEngineSnapshotService,
  readSprintEngineSnapshot,
} from './snapshot'
import {
  mobileControlProtocolVersion,
  validateMobileControlSnapshot,
  type MobileControlSnapshot,
} from '../../../shared/mobile-control/protocol'
import type { SwitchboardFolderStatus, SwitchboardTaskRecord, SwitchboardTaskStatus } from '../../../shared/switchboard'

const generatedAt = '2026-04-28T19:30:00.000Z'
const requiredMutationCommands = [
  'artifact.approve',
  'artifact.requestChanges',
  'task.start',
  'agent.followUp',
  'device.revoke',
] as const

void main()

async function main(): Promise<void> {
  await assertFixtureSnapshotMatchesDesktopBoardCounts()
  await assertMigratedProjectionSnapshotIsPreferred()
  await assertProjectionSnapshotPassesProtocolValidation()
  await assertSnapshotIncludesDesktopWorkspaceEntries()
  await assertSnapshotOmitsUnavailableWorkspaceKinds()
  await assertMalformedMultiloopStateIsSkipped()
  await assertSnapshotOmitsNonMobileStatePayloads()
  await assertSnapshotSkipsMalformedStateFiles()
  await assertPublishingIsThrottled()
}

async function assertProjectionSnapshotPassesProtocolValidation(): Promise<void> {
  // The projection-derived snapshot now includes locks/activity/counts. This
  // test pushes that snapshot through the public protocol validator so the
  // shared contract guarantees the new optional fields stay well-formed.
  const statePath = await writeStateText('not-real-state\n')
  const teamDirectory = dirname(statePath)
  await writeFile(join(teamDirectory, 'projection.json'), JSON.stringify({
    ok: true,
    projectionVersion: 1,
    source: 'folder_store',
    updatedAt: generatedAt,
    run: {
      id: 'protocol-team',
      name: 'Protocol Team',
      status: 'executing',
      updatedAt: generatedAt,
    },
    tasks: [
      { id: 'T1', title: 'Done', role: 'developer', status: 'done', stateStatus: 'done', dependsOn: [] },
      { id: 'T2', title: 'Ready', role: 'developer', status: 'ready', stateStatus: 'todo', dependsOn: ['T1'] },
    ],
    artifacts: [
      { id: 'A1', title: 'Review', kind: 'code_review', status: 'ready_for_review', taskId: 'T2', path: 'reviews/x.md' },
    ],
    roster: {
      'developer-1': { role: 'developer', status: 'running', currentTaskId: 'T1' },
    },
    locks: {
      locks: [{ name: 'readyQueue', exists: true, stale: true, ageSeconds: 720 }],
      warnings: [{ name: 'readyQueue', message: 'readyQueue lock appears stale.', ageSeconds: 720 }],
    },
    activity: [
      { id: 'EVT-1', type: 'task_added', actor: 'architect', message: 'added T1', timestamp: generatedAt },
    ],
    counts: { ready: 1, needsInput: 0 },
    runSummary: { status: 'executing' },
  }), 'utf8')

  const sprintEngineSnapshot = await readSprintEngineSnapshot(statePath)
  assert.equal(sprintEngineSnapshot.locks?.warnings?.length, 1)
  assert.equal(sprintEngineSnapshot.activity?.count, 1)
  assert.equal(sprintEngineSnapshot.counts?.ready, 1)

  const snapshot: MobileControlSnapshot = {
    protocolVersion: mobileControlProtocolVersion,
    generatedAt,
    desktopSessionId: 'desktop-session-test',
    sprintEngines: [sprintEngineSnapshot as unknown as MobileControlSnapshot['sprintEngines'][number]],
    workspaces: [],
  }
  const validationResult = validateMobileControlSnapshot(snapshot)
  assert.equal(validationResult.ok, true, validationResult.ok === false ? validationResult.error.message : undefined)
}

async function assertFixtureSnapshotMatchesDesktopBoardCounts(): Promise<void> {
  const statePath = await writeStateFixture({
    sprintengine: {
      name: 'mobile-sprintengine-companion-integration',
      updatedAt: '2026-04-28T19:29:00.000Z',
    },
    tasks: [
      task('T1', 'done', []),
      task('T2', 'todo', ['T1']),
      task('T3', 'todo', ['T9']),
      task('T4', 'in_progress', ['T1']),
      task('T5', 'needs_input', ['T1']),
      task('T6', 'done', ['T1']),
    ],
    artifacts: [
      artifact('A1', 'requirements', 'approved', 'T1'),
      artifact('A2', 'architect_plan', 'ready_for_review', 'T5'),
      artifact('A3', 'code_review', 'superseded', 'T2'),
    ],
  })

  const snapshot = await readSprintEngineSnapshot(statePath)

  assert.deepEqual(snapshot.board, {
    todo: 1,
    ready: 1,
    inProgress: 1,
    changesRequested: 0,
    needsInput: 1,
    blocked: 0,
    done: 2,
  })
  assert.equal(snapshot.tasks.find((candidate) => candidate.taskId === 'T2')?.status, 'ready')
  assert.equal(snapshot.tasks.find((candidate) => candidate.taskId === 'T3')?.status, 'todo')
  assert.deepEqual(snapshot.artifacts.map((candidate) => candidate.artifactId), ['A1', 'A2'])
}

async function assertMigratedProjectionSnapshotIsPreferred(): Promise<void> {
  const statePath = await writeStateText('{"sprintengine":')
  const teamDirectory = dirname(statePath)
  await writeFile(join(teamDirectory, 'projection.json'), `${JSON.stringify({
    ok: true,
    projectionVersion: 1,
    source: 'folder_store',
    updatedAt: generatedAt,
    run: {
      id: 'team',
      name: 'Migrated Projection',
      status: 'executing',
      updatedAt: generatedAt,
    },
    roster: {
      'developer-1': { role: 'developer', status: 'running', currentTaskId: 'T2' },
    },
    board: {
      counts: { todo: 0, ready: 1, in_progress: 1, changes_requested: 1, needs_input: 1, done: 1 },
    },
    tasks: [
      { id: 'T1', title: 'Foundation', role: 'developer', status: 'done', dependsOn: [] },
      { id: 'T2', title: 'Ready work', role: 'developer', status: 'ready', dependsOn: ['T1'] },
      { id: 'T2R', title: 'Rework', role: 'developer', status: 'changes_requested', stateStatus: 'changes_requested', dependsOn: ['T1'] },
      {
        id: 'T3',
        title: 'Waiting review',
        role: 'developer',
        status: 'needs_input',
        dependsOn: ['T1'],
        needsInput: { kind: 'architect', reason: 'artifact_review', question: 'Approve artifact?', artifactId: 'A1' },
      },
      { id: 'T4', title: 'Active work', role: 'developer', status: 'in_progress', dependsOn: ['T1'] },
    ],
    artifacts: [
      { id: 'A1', title: 'Code review', kind: 'code_review', status: 'ready_for_review', taskId: 'T3', path: 'reviews/code.md' },
    ],
    locks: {
      locks: [{ name: 'readyQueue', exists: true, stale: true, ageSeconds: 999 }],
      warnings: [{ name: 'readyQueue', message: 'readyQueue lock appears stale.' }],
    },
    activity: [{ type: 'artifact_ready_for_review', timestamp: generatedAt }],
    counts: { ready: 1, needsInput: 1, changesRequested: 1 },
    runSummary: { status: 'executing' },
  }, null, 2)}\n`, 'utf8')

  const snapshot = await readSprintEngineSnapshot(statePath)

  assert.equal(snapshot.name, 'Migrated Projection')
  assert.deepEqual(snapshot.board, {
    todo: 0,
    ready: 1,
    inProgress: 1,
    changesRequested: 1,
    needsInput: 1,
    blocked: 0,
    done: 1,
  })
  assert.equal(snapshot.tasks.find((candidate) => candidate.taskId === 'T2')?.status, 'ready')
  assert.equal(snapshot.tasks.find((candidate) => candidate.taskId === 'T2R')?.status, 'changes_requested')
  assert.equal(snapshot.tasks.find((candidate) => candidate.taskId === 'T3')?.needsInput?.artifactId, 'A1')
  assert.equal(snapshot.artifacts[0].status, 'ready_for_review')
  assert.equal(snapshot.locks?.warnings?.length, 1)
  assert.equal(snapshot.activity?.count, 1)
  assert.equal(snapshot.counts?.ready, 1)
  assert.equal(snapshot.counts?.changesRequested, 1)
}

async function assertSnapshotIncludesDesktopWorkspaceEntries(): Promise<void> {
  const statePath = await writeStateFixture({
    sprintengine: {
      name: 'Rich Sprint Engine',
      updatedAt: generatedAt,
    },
    sprintEngineAgents: {
      'developer-1': { role: 'developer', status: 'running', currentTaskId: 'T1' },
    },
    runSummary: { active: true, completedTasks: 1 },
    planReview: { status: 'approved' },
    tasks: [
      {
        ...task('T1', 'needs_input', []),
        needsInput: {
          kind: 'architect',
          reason: 'verification',
          question: 'Can this be verified on device?',
          suggestedResolution: 'Run the relay smoke test.',
          artifactId: 'A1',
        },
        evidence: {
          summary: 'Implemented command handling.',
          touchedFiles: ['src/main/mobile/sprintengine/snapshot.ts'],
          commandsRan: ['npm run test:main:mobile-sprintengine-snapshot'],
          results: ['Passed'],
        },
        feedback: { confidencePct: 88, hallucinationRiskPct: 5 },
        findings: [{ severity: 'low' }],
        release: { requestedBy: 'architect', reason: 'stale owner' },
      },
    ],
    artifacts: [artifact('A1', 'architect_plan', 'approved', 'T1')],
  })
  const workspaceRoot = workspaceRootForStatePath(statePath)
  await writeMultiloopFixture(workspaceRoot)
  const service = new MobileSprintEngineSnapshotService({
    stateReaders: {
      readSwitchboardTasks: async () => ({
        ok: true,
        workspaceRoot,
        switchboardRoot: join(workspaceRoot, '.multi-code', 'switchboard'),
        tasks: [
          switchboardRecord('inbox', 'Inbox task', generatedAt),
          switchboardRecord('ready', 'Ready task', generatedAt),
        ],
        problems: [],
      }),
      getSwitchboardRunnerState: async () => ({
        ok: true,
        workspaceRoot,
        enabled: true,
        running: true,
        paused: false,
        provider: 'electron-session',
        cli: 'codex',
        maxConcurrency: 1,
        queues: ['ready'],
        activeExecutions: [
          {
            kind: 'switchboard_task',
            executionId: 'exec_1',
            taskId: 'task_1',
            claimedFrom: 'ready',
            claimedStatus: 'in_progress',
            role: 'developer',
            provider: 'electron-session',
            providerRef: {},
            startedAt: generatedAt,
            lastSeenAt: generatedAt,
            status: 'active',
          },
        ],
        lastError: null,
        updatedAt: generatedAt,
      }),
      listWatchtowerRuns: async () => ({
        ok: true,
        runs: [
          {
            schemaVersion: 1,
            runId: 'run_1',
            status: 'completed',
            createdAt: generatedAt,
            completedAt: generatedAt,
            workspaceRoot,
            preset: 'standard',
            agents: [
              {
                agentId: 'watchtower-agent-1',
                specialistId: 'reviewer',
                status: 'completed',
                outputDir: 'watchtower/run_1/agent_1',
                reportPath: 'watchtower/run_1/agent_1/report.md',
                taskIds: ['watchtower-task-1', 'watchtower-task-2'],
              },
            ],
            counts: { valid: 1, invalid: 0, ingested: 2 },
          },
        ],
      }),
    },
  })

  const snapshot = await service.readSnapshot({
    desktopSessionId: 'desktop_1',
    statePaths: [statePath],
    generatedAt,
  })

  assert.equal(snapshot.sprintEngines.length, 1)
  assert.equal(snapshot.sprintEngines[0].workspacePath, workspaceRoot)
  for (const command of requiredMutationCommands) {
    assert.equal(snapshot.commands?.includes(command), true, `${command} command should be advertised`)
  }
  assert.equal(snapshot.commands?.includes('snapshot.request'), true)
  assert.equal(snapshot.commands?.includes('artifact.read'), true)
  const richTask = snapshot.sprintEngines[0].tasks[0]
  assert.equal(richTask.needsInput?.question, 'Can this be verified on device?')
  assert.equal(richTask.evidence?.commandCount, 1)
  assert.equal(richTask.feedback?.confidencePct, 88)
  assert.equal(richTask.reviewSignals?.findingCount, 1)
  assert.equal(richTask.release?.reason, 'stale owner')

  assert.deepEqual(snapshot.workspaces?.map((workspace) => workspace.kind), [
    'sprintengine',
    'switchboard',
    'watchtower',
    'multiloop',
  ])
  assert.deepEqual(snapshot.workspaces?.find((workspace) => workspace.kind === 'switchboard')?.capabilities, ['summary.read', 'detail.read'])
  assert.deepEqual(snapshot.workspaces?.find((workspace) => workspace.kind === 'watchtower')?.capabilities, ['summary.read', 'detail.read'])
  assert.equal(snapshot.workspaces?.some((workspace) => (workspace.capabilities as string[]).includes('tasks.move')), false)
  assert.equal(snapshot.workspaces?.find((workspace) => workspace.kind === 'switchboard')?.summary.counts?.inbox, 1)
  assert.equal(snapshot.workspaces?.find((workspace) => workspace.kind === 'watchtower')?.summary.counts?.generatedInboxItems, 2)
  const switchboardDetail = snapshot.workspaces?.find((workspace) => workspace.kind === 'switchboard')?.detail
  assert.equal(switchboardDetail?.kind, 'switchboard')
  assert.equal(switchboardDetail?.kind === 'switchboard' ? switchboardDetail.data.tasks?.[0]?.title : '', 'Ready task')
  assert.equal(switchboardDetail?.kind === 'switchboard' ? switchboardDetail.data.inboxItems?.[0]?.title : '', 'Inbox task')
  assert.equal(switchboardDetail?.kind === 'switchboard' ? switchboardDetail.data.comments?.[0]?.body : '', 'Latest mobile-visible comment')
  assert.equal(switchboardDetail?.kind === 'switchboard' ? switchboardDetail.data.evidence?.[0]?.commandCount : 0, 1)
  assert.equal(switchboardDetail?.kind === 'switchboard' ? switchboardDetail.data.logs?.[0]?.executionId : '', 'exec_task_ready')
  const watchtowerDetail = snapshot.workspaces?.find((workspace) => workspace.kind === 'watchtower')?.detail
  assert.equal(watchtowerDetail?.kind, 'watchtower')
  assert.equal(watchtowerDetail?.kind === 'watchtower' ? watchtowerDetail.data.runs?.[0]?.runId : '', 'run_1')
  assert.equal(watchtowerDetail?.kind === 'watchtower' ? watchtowerDetail.data.generatedInboxItems?.length : 0, 2)
  const multiloopDetail = snapshot.workspaces?.find((workspace) => workspace.kind === 'multiloop')?.detail
  assert.equal(multiloopDetail?.kind, 'multiloop')
  assert.equal(multiloopDetail?.kind === 'multiloop' ? multiloopDetail.data.milestones?.[0]?.title : '', 'Milestone One')
  assert.equal(multiloopDetail?.kind === 'multiloop' ? multiloopDetail.data.blockers?.[0]?.title : '', 'Blocked by validation')
  service.shutdown()
}

async function assertSnapshotOmitsUnavailableWorkspaceKinds(): Promise<void> {
  const statePath = await writeStateFixture({
    sprintengine: { name: 'Only Sprint Engine', updatedAt: generatedAt },
    tasks: [task('T1', 'done', [])],
    artifacts: [],
  })
  const service = new MobileSprintEngineSnapshotService({
    stateReaders: {
      readSwitchboardTasks: async () => ({ ok: false, message: 'Switchboard is not initialized.' }),
      getSwitchboardRunnerState: async () => ({ ok: false, message: 'Runner unavailable.' }),
      listWatchtowerRuns: async () => ({ ok: true, runs: [] }),
      readMultiloopStates: async () => [],
    },
  })

  const snapshot = await service.readSnapshot({
    desktopSessionId: 'desktop_1',
    statePaths: [statePath],
    generatedAt,
  })

  assert.deepEqual(snapshot.workspaces?.map((workspace) => workspace.kind), ['sprintengine'])
  service.shutdown()
}

async function assertMalformedMultiloopStateIsSkipped(): Promise<void> {
  const statePath = await writeStateFixture({
    sprintengine: { name: 'Malformed Multiloop Fixture', updatedAt: generatedAt },
    tasks: [task('T1', 'done', [])],
    artifacts: [],
  })
  const workspaceRoot = workspaceRootForStatePath(statePath)
  const malformedMultiloopDirectory = join(workspaceRoot, 'multiloop', 'bad-loop')
  await mkdir(malformedMultiloopDirectory, { recursive: true })
  await writeFile(join(malformedMultiloopDirectory, 'state.json'), '{"loop":', 'utf8')
  const service = new MobileSprintEngineSnapshotService({
    stateReaders: {
      readSwitchboardTasks: async () => ({ ok: false, message: 'Switchboard is not initialized.' }),
      getSwitchboardRunnerState: async () => ({ ok: false, message: 'Runner unavailable.' }),
      listWatchtowerRuns: async () => ({ ok: true, runs: [] }),
    },
  })

  const snapshot = await service.readSnapshot({
    desktopSessionId: 'desktop_1',
    statePaths: [statePath],
    generatedAt,
  })

  assert.equal(snapshot.workspaces?.some((workspace) => workspace.kind === 'multiloop'), false)
  service.shutdown()
}

async function assertSnapshotOmitsNonMobileStatePayloads(): Promise<void> {
  const statePath = await writeStateFixture({
    sprintengine: {
      name: 'Sanitized Snapshot',
      updatedAt: '2026-04-28T19:31:00.000Z',
    },
    tasks: [
      {
        ...task('T1', 'done', []),
        description: 'Long source-sensitive task brief',
        evidence: {
          summary: 'Implementation details',
          touchedFiles: ['src/private.ts'],
          commandsRan: ['cat src/private.ts'],
          results: ['private source output'],
        },
        notes: ['terminal stream should not leave desktop'],
      },
    ],
    events: [
      {
        id: 'EVT-1',
        timestamp: generatedAt,
        type: 'terminal_output',
        actor: 'developer-1',
        message: 'raw terminal stream',
      },
    ],
    artifacts: [
      {
        ...artifact('A1', 'requirements', 'approved', 'T1'),
        reviewHistory: [{ action: 'approved', actor: 'user', timestamp: generatedAt }],
        fingerprint: 'secret-ish-hash',
      },
    ],
  })

  const snapshot = await readSprintEngineSnapshot(statePath)
  const serialized = JSON.stringify(snapshot)

  assert.equal(serialized.includes('raw terminal stream'), false)
  assert.equal(serialized.includes('private source output'), false)
  assert.equal(serialized.includes('secret-ish-hash'), false)
  assert.equal(snapshot.artifacts[0].path, '.multi-code/sprintengine/team/product-requirements.md')
}

async function assertPublishingIsThrottled(): Promise<void> {
  const statePath = await writeStateFixture({
    sprintengine: { name: 'Throttle Fixture', updatedAt: generatedAt },
    tasks: [task('T1', 'done', [])],
    artifacts: [],
  })
  const service = new MobileSprintEngineSnapshotService({ publishThrottleMs: 60 })
  const published: string[] = []
  service.subscribe((snapshot) => {
    published.push(snapshot.generatedAt)
  })

  const first = await service.publishSnapshot({
    desktopSessionId: 'desktop_1',
    statePaths: [statePath],
    generatedAt,
  })
  const second = await service.publishSnapshot({
    desktopSessionId: 'desktop_1',
    statePaths: [statePath],
    generatedAt: '2026-04-28T19:30:01.000Z',
  })
  const flushed = await service.flushPendingSnapshot()

  assert.equal(first?.generatedAt, generatedAt)
  assert.equal(second, null)
  assert.equal(flushed?.generatedAt, '2026-04-28T19:30:01.000Z')
  assert.deepEqual(published, [generatedAt, '2026-04-28T19:30:01.000Z'])
  service.shutdown()
}

async function assertSnapshotSkipsMalformedStateFiles(): Promise<void> {
  const validStatePath = await writeStateFixture({
    sprintengine: { name: 'Valid Snapshot', updatedAt: generatedAt },
    tasks: [task('T1', 'done', [])],
    artifacts: [],
  })
  const malformedStatePath = await writeStateText(
    `${String.raw`{"sprintengine":{"name":"Bad"},"tasks":[{"evidence":{"commandsRan":[".multi-code\sprintengine\state.yaml"]}}]}`}\n`
  )
  const service = new MobileSprintEngineSnapshotService()

  const snapshot = await service.readSnapshot({
    desktopSessionId: 'desktop_1',
    statePaths: [malformedStatePath, validStatePath],
    generatedAt,
  })

  assert.deepEqual(snapshot.sprintEngines.map((sprintEngine) => sprintEngine.name), ['Valid Snapshot'])
  service.shutdown()
}

async function writeStateFixture(state: Record<string, unknown>): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'multicode-sprintengine-snapshot-'))
  const teamDirectory = join(workspacePath, '.multi-code', 'sprintengine', 'team')
  await mkdir(teamDirectory, { recursive: true })
  const statePath = join(teamDirectory, 'state.yaml')
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  return statePath
}

async function writeStateText(content: string): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'multicode-sprintengine-snapshot-'))
  const teamDirectory = join(workspacePath, '.multi-code', 'sprintengine', 'team')
  await mkdir(teamDirectory, { recursive: true })
  const statePath = join(teamDirectory, 'state.yaml')
  await writeFile(statePath, content, 'utf8')
  return statePath
}

async function writeMultiloopFixture(workspaceRoot: string): Promise<void> {
  const loopDirectory = join(workspaceRoot, 'multiloop', 'loop_1')
  await mkdir(loopDirectory, { recursive: true })
  await writeFile(join(loopDirectory, 'state.json'), `${JSON.stringify({
    loop: {
      name: 'loop_1',
      displayName: 'Loop 1',
      status: 'blocked',
      updatedAt: generatedAt,
    },
    roadmap: [
      {
        id: 'milestone-1',
        title: 'Milestone One',
        status: 'active',
        updatedAt: generatedAt,
        sprintEngine: { teamSlug: 'team' },
      },
      {
        id: 'milestone-2',
        title: 'Milestone Two',
        status: 'todo',
      },
    ],
    blockers: [
      {
        id: 'blocker-1',
        title: 'Blocked by validation',
        status: 'active',
        updatedAt: generatedAt,
      },
    ],
  }, null, 2)}\n`, 'utf8')
}

function task(id: string, status: string, dependsOn: string[]): Record<string, unknown> {
  return {
    id,
    title: `Task ${id}`,
    role: 'developer',
    status,
    ownerAgentId: status === 'in_progress' ? 'developer-1' : null,
    dependsOn,
  }
}

function artifact(id: string, kind: string, status: string, taskId: string): Record<string, unknown> {
  return {
    id,
    kind,
    title: `Artifact ${id}`,
    path: '.multi-code/sprintengine/team/product-requirements.md',
    status,
    createdBy: 'product',
    taskId,
  }
}

function workspaceRootForStatePath(statePath: string): string {
  return dirname(dirname(dirname(dirname(statePath))))
}

function switchboardRecord(folderStatus: SwitchboardFolderStatus, title: string, updatedAt: string): SwitchboardTaskRecord {
  const taskState: SwitchboardTaskStatus = folderStatus === 'inbox' ? 'todo' : folderStatus
  return {
    location: {
      folderStatus,
      path: `.multi-code/switchboard/${folderStatus}/task.json`,
    },
    warnings: [],
    task: {
      schemaVersion: 1,
      id: `task_${folderStatus}`,
      identifier: `TASK-${folderStatus}`,
      title,
      description: title,
      priority: null,
      state: taskState,
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      source: { type: folderStatus === 'inbox' ? 'watchtower' : 'manual', externalKey: `${folderStatus.toUpperCase()}-1` },
      claim: null,
      execution: {
        attempts: folderStatus === 'ready'
          ? [{
              id: 'exec_task_ready',
              agentId: 'developer-1',
              startedAt: updatedAt,
              completedAt: updatedAt,
              summary: 'Completed ready task execution.',
              worktreePath: null,
            }]
          : [],
        worktreePath: null,
        activeSessionId: null,
      },
      evidence: {
        summary: folderStatus === 'ready' ? 'Ready task evidence' : '',
        artifacts: [],
        commandsRun: folderStatus === 'ready' ? ['npm test'] : [],
        touchedFiles: folderStatus === 'ready' ? ['src/main/mobile/sprintengine/snapshot.ts'] : [],
      },
      comments: folderStatus === 'ready'
        ? [{
            id: 'comment_ready_1',
            author: { type: 'agent', id: 'developer-1', name: 'Developer' },
            kind: 'comment',
            body: 'Latest mobile-visible comment',
            createdAt: updatedAt,
            confidencePct: 90,
          }]
        : [],
      createdAt: updatedAt,
      updatedAt,
    },
  }
}
