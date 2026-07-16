import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import {
  MobileSprintEngineSnapshotService,
  readSprintEngineSnapshot,
  sanitizeMobileSnapshotForRelay,
} from './snapshot'
import { normalizeRoleCatalog } from './role-catalog'
import { deriveWorkspaceId } from './workspace-id'
import { containsLocalPath } from './relay-path-safety'
import { relayResultSummaryMaxBytes, relaySummaryByteLength, summarizeCommandResult } from '../bridge/command-results'
import { dispatchSnapshotRequest } from '../bridge/snapshot-request'
import { AutomationsStore } from '../../automations/store'
import { createBacklogItem } from '../../backlog-service'
import {
  automationRecentRunsMax,
  automationRunTextMaxChars,
  automationsPerProjectMax,
  mobileControlProtocolVersion,
  validateMobileControlSnapshot,
  type MobileControlAutomationSnapshot,
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
  await assertReviewProjectionSnapshotExposesReviewContext()
  await assertProjectionSnapshotPassesProtocolValidation()
  await assertProjectionSnapshotExposesProvenanceAndVcs()
  await assertSnapshotIncludesDesktopWorkspaceEntries()
  await assertSnapshotIncludesWorkspaceBacklog()
  await assertAutomationsJoinTheirSprintEngineOnProjectKey()
  await assertCappedAutomationsFitTheRelayResultBudget()
  await assertShedDropsRecentRunsBeforeAnySprintEngine()
  await assertRoleCatalogReducesRegistryPayload()
  await assertSnapshotSurfacesCreatedSpikeBacklogItem()
  await assertSnapshotOmitsBacklogWhenWorkspaceHasNone()
  await assertSnapshotOmitsUnavailableWorkspaceKinds()
  await assertUnscopedSnapshotShedsTerminalRunsBeyondKeepWindow()
  await assertUnscopedDefaultSnapshotIsValidForOldClients()
  await assertWorkspacePathScopingReturnsOnlyThatRoot()
  await assertScopedRequestSkipsSheddingLadder()
  await assertIncludeScopingOmitsUnrequestedCollections()
  await assertMalformedMultiloopStateIsSkipped()
  await assertSnapshotOmitsNonMobileStatePayloads()
  await assertSnapshotSkipsMalformedStateFiles()
  await assertPublishingIsThrottled()
  await assertAutomationIntentSidecarWinsOverRunnerHeuristic()
  await assertAutomationIntentSidecarSurfacesOnStateFallback()
}

async function assertAutomationIntentSidecarWinsOverRunnerHeuristic(): Promise<void> {
  // MC-1567: the main-owned `automation.json` intent is the exact automation
  // mode — including the `run_agents_and_approve_artifacts` variant the
  // cliWatchPolling heuristic can never express (enabled would read as
  // run_agents below).
  const statePath = await writeStateText('not-real-state\n')
  const teamDirectory = dirname(statePath)
  await writeFile(join(teamDirectory, 'projection.json'), JSON.stringify({
    ok: true,
    projectionVersion: 1,
    source: 'folder_store',
    updatedAt: generatedAt,
    run: {
      id: 'intent-team',
      name: 'Intent Team',
      status: 'executing',
      updatedAt: generatedAt,
      runner: { cliWatchPolling: 'enabled' },
    },
    tasks: [],
    artifacts: [],
  }), 'utf8')
  await writeFile(join(teamDirectory, 'automation.json'), JSON.stringify({
    schemaVersion: 1,
    revision: 4,
    desiredMode: 'run_agents_and_approve_artifacts',
    changedAt: 1789000000000,
    lastWrite: { actor: 'mobile', deviceId: 'device-1', at: generatedAt },
  }), 'utf8')

  const snapshot = await readSprintEngineSnapshot(statePath)
  assert.equal(snapshot.automationMode, 'run_agents_and_approve_artifacts')

  // A mode-only change must perturb snapshotVersion (phone-side dedup and the
  // stale-snapshot guard key on it).
  await writeFile(join(teamDirectory, 'automation.json'), JSON.stringify({
    schemaVersion: 1,
    revision: 5,
    desiredMode: 'manual',
    changedAt: 1789000001000,
    lastWrite: { actor: 'ui', deviceId: null, at: generatedAt },
  }), 'utf8')
  const afterModeChange = await readSprintEngineSnapshot(statePath)
  assert.equal(afterModeChange.automationMode, 'manual')
  assert.notEqual(afterModeChange.snapshotVersion, snapshot.snapshotVersion,
    'a mode-only change produces a new snapshotVersion')

  // A corrupt sidecar falls back to the legacy heuristic rather than failing.
  await writeFile(join(teamDirectory, 'automation.json'), '{corrupt', 'utf8')
  const fallback = await readSprintEngineSnapshot(statePath)
  assert.equal(fallback.automationMode, 'run_agents')
}

async function assertAutomationIntentSidecarSurfacesOnStateFallback(): Promise<void> {
  // The run.yaml fallback path (no projection.json) previously had no
  // automationMode at all; the sidecar gives it the exact value too.
  const statePath = await writeStateFixture({
    schemaVersion: 2,
    sprintengine: { name: 'Fallback Team', updatedAt: generatedAt },
    tasks: [],
    artifacts: [],
  })
  const before = await readSprintEngineSnapshot(statePath)
  assert.equal(before.automationMode, undefined)

  await writeFile(join(dirname(statePath), 'automation.json'), JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    desiredMode: 'manual',
    changedAt: 1789000000000,
    lastWrite: { actor: 'ui', deviceId: null, at: generatedAt },
  }), 'utf8')
  const after = await readSprintEngineSnapshot(statePath)
  assert.equal(after.automationMode, 'manual')
}

async function assertProjectionSnapshotExposesProvenanceAndVcs(): Promise<void> {
  // MC-1498: a worktree run launched from a backlog epic exposes its provenance
  // ("Started from") and its PR/branch state on the mobile snapshot.
  const statePath = await writeStateText('not-real-state\n')
  const teamDirectory = dirname(statePath)
  await writeFile(
    join(teamDirectory, 'projection.json'),
    JSON.stringify({
      ok: true,
      projectionVersion: 1,
      updatedAt: generatedAt,
      run: {
        id: 'vcs-team',
        name: 'VCS Team',
        status: 'complete',
        updatedAt: generatedAt,
        source: {
          kind: 'markdown',
          origin: 'reference',
          path: 'backlog/epics/checkout.md',
          capturedAt: generatedAt,
        },
        vcs: {
          mode: 'run_worktree',
          worktreePath: '.worktrees/checkout',
          branchName: 'sprintengine/checkout',
          pullRequestUrl: 'https://github.com/acme/repo/pull/9',
          pullRequestState: 'open',
          // MC-1615 multi-repo seam: an unknown per-repo array must ride through
          // buildVcsState verbatim rather than being stripped.
          repos: [{ repoRoot: 'packages/api', branchName: 'sprintengine/checkout-api' }],
        },
      },
      tasks: [{ id: 'T1', title: 'Done', role: 'developer', status: 'done', stateStatus: 'done', dependsOn: [] }],
      artifacts: [],
    }),
    'utf8',
  )

  const snapshot = await readSprintEngineSnapshot(statePath)
  assert.equal(snapshot.startedFrom?.epic, true, 'an epic-launched run reads as an epic provenance')
  assert.equal(snapshot.startedFrom?.rows[0]?.path, 'backlog/epics/checkout.md')
  assert.equal(snapshot.startedFrom?.rows[0]?.isPrimary, true)
  assert.equal(snapshot.startedFrom?.rows[0]?.capturedAt, generatedAt)
  assert.equal(snapshot.vcs?.worktree, true)
  assert.equal(snapshot.vcs?.branch, 'sprintengine/checkout')
  assert.equal(snapshot.vcs?.pullRequestUrl, 'https://github.com/acme/repo/pull/9')
  assert.equal(snapshot.vcs?.pullRequestStatus, 'open')
  // MC-1615: the multi-repo array is preserved verbatim (single-repo runs omit it).
  assert.deepEqual(snapshot.vcs?.repos, [{ repoRoot: 'packages/api', branchName: 'sprintengine/checkout-api' }])

  // A hand-started run with no source and no worktree exposes neither.
  const bareStatePath = await writeStateText('bare\n')
  await writeFile(
    join(dirname(bareStatePath), 'projection.json'),
    JSON.stringify({
      ok: true,
      projectionVersion: 1,
      updatedAt: generatedAt,
      run: { id: 'bare', name: 'Bare', status: 'executing', updatedAt: generatedAt },
      tasks: [],
      artifacts: [],
    }),
    'utf8',
  )
  const bare = await readSprintEngineSnapshot(bareStatePath)
  assert.equal(bare.startedFrom, undefined, 'a hand-started run shows no provenance')
  assert.equal(bare.vcs, undefined, 'a non-worktree run shows no vcs block')
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
    workers: {
      'developer-1': { role: 'developer', status: 'running', currentTaskId: 'T1', sessionId: 'sess-1', ownedTaskIds: ['T1'] },
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
  // The roster map is derived from the projection's workers view (MC-1594),
  // keeping only the three fields the v2 wire renders.
  assert.deepEqual(sprintEngineSnapshot.roster?.['developer-1'], { role: 'developer', status: 'running', currentTaskId: 'T1' })

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
    review: 0,
    needsInput: 1,
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
    workers: {
      'developer-1': { role: 'developer', status: 'running', currentTaskId: 'T2' },
    },
    board: {
      counts: { todo: 0, ready: 1, in_progress: 1, review: 1, needs_input: 1, done: 1 },
    },
    tasks: [
      { id: 'T1', title: 'Foundation', role: 'developer', status: 'done', dependsOn: [] },
      { id: 'T2', title: 'Ready work', role: 'developer', status: 'ready', dependsOn: ['T1'] },
      { id: 'T2R', title: 'Owner review', role: 'developer', status: 'review', stateStatus: 'review', dependsOn: ['T1'] },
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
    counts: { ready: 1, needsInput: 1 },
    runSummary: { status: 'executing' },
  }, null, 2)}\n`, 'utf8')

  const snapshot = await readSprintEngineSnapshot(statePath)

  assert.equal(snapshot.name, 'Migrated Projection')
  assert.equal(snapshot.roster?.['developer-1']?.currentTaskId, 'T2', 'roster derives from projection.workers')
  assert.deepEqual(snapshot.board, {
    todo: 0,
    ready: 1,
    inProgress: 1,
    review: 1,
    needsInput: 1,
    done: 1,
  })
  assert.equal(snapshot.tasks.find((candidate) => candidate.taskId === 'T2')?.status, 'ready')
  assert.equal(snapshot.tasks.find((candidate) => candidate.taskId === 'T2R')?.status, 'review')
  assert.equal(snapshot.tasks.find((candidate) => candidate.taskId === 'T3')?.needsInput?.artifactId, 'A1')
  assert.equal(snapshot.artifacts[0].status, 'ready_for_review')
  assert.equal(snapshot.locks?.warnings?.length, 1)
  assert.equal(snapshot.activity?.count, 1)
  assert.equal(snapshot.counts?.ready, 1)
  assert.equal(snapshot.counts?.needsInput, 1)
}

// MC-1542 single-owner tasks deleted quality gates: the qualityPolicy /
// qualityGates / qualityGateSummary wire fields and the changes_requested /
// testing / product statuses are gone. What survives — and this test still
// pins — is the `review` board column round-trip and the review-context comment
// / feedback / recorded-artifact surfaces the mobile snapshot exposes for a task
// its single owner is reviewing.
async function assertReviewProjectionSnapshotExposesReviewContext(): Promise<void> {
  const statePath = await writeStateText('not-real-state\n')
  const teamDirectory = dirname(statePath)
  await writeFile(join(teamDirectory, 'projection.json'), JSON.stringify({
    ok: true,
    projectionVersion: 1,
    source: 'folder_store',
    updatedAt: generatedAt,
    run: {
      id: 'review-team',
      name: 'Review Team',
      status: 'executing',
      updatedAt: generatedAt,
    },
    tasks: [
      {
        id: 'G1',
        title: 'Implementation under review',
        role: 'developer',
        status: 'review',
        stateStatus: 'review',
        boardColumn: 'review',
        dependsOn: [],
        latestComments: [
          {
            id: 'C1',
            type: 'review_feedback',
            actor: 'developer-1',
            authorAgentId: 'developer-1',
            authorRole: 'developer',
            source: 'agent',
            body: 'Need an extra null check.',
            createdAt: generatedAt,
          },
        ],
        latestOpenFeedback: [
          {
            id: 'C1',
            type: 'review_feedback',
            actor: 'developer-1',
            authorAgentId: 'developer-1',
            authorRole: 'developer',
            source: 'agent',
            body: 'Need an extra null check.',
            createdAt: generatedAt,
            data: { status: 'open' },
          },
        ],
        recordedArtifacts: [
          {
            id: 'R1',
            kind: 'code_review',
            title: 'Self review pass 1',
            path: '.multi-code/sprintengine/review-team/reviews/code-review-1.md',
            createdAt: generatedAt,
          },
        ],
      },
    ],
    artifacts: [],
    workers: {},
    activity: [],
  }), 'utf8')

  const snapshot = await readSprintEngineSnapshot(statePath)
  assert.equal(snapshot.board.review, 1, 'review column counted from boardColumn')

  const reviewTask = snapshot.tasks.find((task) => task.taskId === 'G1')
  assert.ok(reviewTask, 'review task is present')
  assert.equal(reviewTask!.status, 'review')
  assert.equal(reviewTask!.latestComments?.length, 1)
  assert.equal(reviewTask!.latestOpenFeedback?.length, 1)
  assert.equal(reviewTask!.latestOpenFeedback?.[0].type, 'review_feedback')
  assert.equal(reviewTask!.recordedArtifacts?.length, 1)
  assert.equal(reviewTask!.recordedArtifacts?.[0].kind, 'code_review')
}

async function assertSnapshotIncludesDesktopWorkspaceEntries(): Promise<void> {
  const statePath = await writeStateFixture({
    sprintengine: {
      name: 'Rich Sprint Engine',
      updatedAt: generatedAt,
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

  // The switchboard/watchtower/multiloop projections are off in the default
  // composition (item 1600); a surface that wants them names `desktopWorkspaces`.
  const snapshot = await service.readSnapshot({
    desktopSessionId: 'desktop_1',
    statePaths: [statePath],
    generatedAt,
    include: ['sprintEngines', 'desktopWorkspaces', 'backlog', 'roleCatalogs', 'automations'],
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

async function assertSnapshotIncludesWorkspaceBacklog(): Promise<void> {
  const statePath = await writeStateFixture({
    sprintengine: { name: 'Backlog Sprint Engine', updatedAt: generatedAt },
    tasks: [task('T1', 'done', [])],
    artifacts: [],
  })
  const workspaceRoot = workspaceRootForStatePath(statePath)
  await mkdir(join(workspaceRoot, 'backlog'), { recursive: true })
  await writeFile(
    join(workspaceRoot, 'backlog', '2026-06-11-widget.md'),
    '---\ntype: feature\n---\n\n# Ship the widget\n\nUsers need the widget on the phone.\n',
    'utf8'
  )
  await mkdir(join(workspaceRoot, '.multi-code', 'backlog'), { recursive: true })
  await writeFile(
    join(workspaceRoot, '.multi-code', 'backlog', 'items.json'),
    JSON.stringify({
      schemaVersion: 1,
      items: [
        {
          id: 'backlog_widget',
          source: { type: 'file', relativePath: 'backlog/2026-06-11-widget.md' },
          status: 'ready',
          type: 'feature',
          difficulty: 'm',
          criticality: 'high',
          metadata: {},
          links: [],
          createdAt: generatedAt,
          updatedAt: generatedAt,
        },
        {
          id: 'backlog_archived',
          source: { type: 'file', relativePath: 'backlog/archived/old.md' },
          status: 'archived',
          metadata: {},
          links: [],
          createdAt: generatedAt,
          updatedAt: generatedAt,
        },
      ],
    }),
    'utf8'
  )
  const service = new MobileSprintEngineSnapshotService({
    stateReaders: {
      readSwitchboardTasks: async () => ({ ok: false, message: 'Switchboard is not initialized.' }),
      getSwitchboardRunnerState: async () => ({ ok: false, message: 'Runner unavailable.' }),
      listWatchtowerRuns: async () => ({ ok: true, runs: [] }),
      readMultiloopStates: async () => [],
      // The real reader spawns the Sprint Engine MCP; stub it so this stays a unit test.
      readRoleCatalog: async () => [
        { roleId: 'architect', label: 'Architect', summary: 'Plans the run.', source: 'bundled' },
        { roleId: 'tester', label: 'QA', sweep: true, source: 'bundled' },
        { roleId: 'prompt_smith', label: 'Prompt Smith', summary: 'Tunes prompts.', source: 'user' },
      ],
    },
  })

  const snapshot = await service.readSnapshot({
    desktopSessionId: 'desktop_1',
    statePaths: [statePath],
    generatedAt,
  })

  assert.equal(snapshot.commands?.includes('backlog.update'), true)
  assert.equal(snapshot.commands?.includes('backlog.startSprintEngine'), true)
  assert.equal(snapshot.backlog?.length, 1)
  const backlogWorkspace = snapshot.backlog?.[0]
  assert.equal(backlogWorkspace?.workspacePath, workspaceRoot)
  assert.equal(backlogWorkspace?.items.length, 1)
  const item = backlogWorkspace?.items[0]
  assert.equal(item?.itemId, 'backlog_widget')
  assert.equal(item?.title, 'Ship the widget')
  assert.equal(item?.status, 'ready')
  assert.equal(item?.type, 'feature')
  assert.equal(item?.difficulty, 'm')
  assert.equal(item?.criticality, 'high')
  assert.equal(item?.excerpt?.includes('Users need the widget'), true)
  assert.equal(item?.excerpt?.includes('type: feature'), false)

  // MC-1543: the workspace's role registry rides its backlog workspace, so the
  // phone's launch picker can offer roles it was never compiled to know about.
  assert.deepEqual(backlogWorkspace?.roles?.map((role) => role.roleId), ['architect', 'tester', 'prompt_smith'])
  assert.equal(backlogWorkspace?.roles?.find((role) => role.roleId === 'tester')?.sweep, true)
  const custom = backlogWorkspace?.roles?.find((role) => role.roleId === 'prompt_smith')
  assert.equal(custom?.label, 'Prompt Smith')
  assert.equal(custom?.source, 'user')
  // And the snapshot carrying it is still a valid snapshot.
  assert.equal(validateMobileControlSnapshot(snapshot).ok, true)
  service.shutdown()
}

// The automations projection (item 47) is only useful if its `projectKey` is the
// SAME key the phone joins the other collections on — a key that grouped nothing
// would still typecheck, still validate, and still be wrong. The sprint engine's
// key is stamped during the relay sanitize pass and the automation's is stamped by
// the producer, so nothing but a test holds the two together.
//
// The same pass is the only thing standing between an agent's run summary (which
// routinely quotes absolute paths) and a relay that rejects any summary containing
// one — so this asserts the payload is relay-safe, not merely well-formed.
async function assertAutomationsJoinTheirSprintEngineOnProjectKey(): Promise<void> {
  const statePath = await writeStateFixture({
    sprintengine: { name: 'Automations Sprint Engine', updatedAt: generatedAt },
    tasks: [task('T1', 'done', [])],
    artifacts: [],
  })
  const workspaceRoot = workspaceRootForStatePath(statePath)
  const store = new AutomationsStore(workspaceRoot)
  await store.createDefinition({
    id: 'nightly',
    name: 'Nightly sweep',
    status: 'enabled',
    trigger: { kind: 'schedule', config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 90 }, timezone: 'UTC' } },
    action: { kind: 'agent-run', config: { prompt: 'sweep' } },
    autonomyDefault: 'review_only',
    nextRunAt: null,
    lastRunAt: generatedAt,
    lastRunId: 'run-1',
    createdAt: generatedAt,
    updatedAt: generatedAt,
  })
  await store.recordRun({
    id: 'run-1',
    automationId: 'nightly',
    status: 'completed',
    dueAt: generatedAt,
    startedAt: generatedAt,
    completedAt: generatedAt,
    summary: `Rewrote ${join(workspaceRoot, 'src/app.ts')} and left the tests green.`,
  })

  const service = new MobileSprintEngineSnapshotService({
    stateReaders: {
      readSwitchboardTasks: async () => ({ ok: false, message: 'Switchboard is not initialized.' }),
      getSwitchboardRunnerState: async () => ({ ok: false, message: 'Runner unavailable.' }),
      listWatchtowerRuns: async () => ({ ok: true, runs: [] }),
      readMultiloopStates: async () => [],
      readRoleCatalog: async () => [],
    },
  })

  const snapshot = sanitizeMobileSnapshotForRelay(
    await service.readSnapshot({ desktopSessionId: 'desktop_1', statePaths: [statePath], generatedAt })
  )

  const automation = snapshot.automations?.[0]
  assert.equal(automation?.automationId, 'nightly')
  assert.equal(automation?.cadence, 'Every 90 min')
  // The join: same repo, same key, across two collections stamped in two places —
  // the sprint engine's during the sanitize pass, the automation's by the producer.
  assert.ok(automation?.projectKey)
  assert.equal(automation?.projectKey, snapshot.sprintEngines[0]?.projectKey)

  // The run summary quoted an absolute path; the relay would reject the whole
  // command result for it, so the sanitize pass has to reach inside recentRuns.
  const wireSummary = automation?.recentRuns?.[0]?.summary ?? ''
  assert.equal(wireSummary.includes('[redacted-path]'), true)
  assert.equal(containsLocalPath(JSON.stringify(snapshot.automations)), false)

  assert.equal(validateMobileControlSnapshot(snapshot).ok, true)
  service.shutdown()
}

// One project's automations, seeded PAST every cap, must still ride the on-demand
// snapshot.request path inside the relay's 256 KB result-summary budget — and must
// still be there at the far end, unshed. This drives the real producer through the
// real bridge path, so it is the caps and the size budget measured together rather
// than either one asserted in isolation.
async function assertCappedAutomationsFitTheRelayResultBudget(): Promise<void> {
  const statePath = await writeStateFixture({
    sprintengine: { name: 'Capped Automations', updatedAt: generatedAt },
    tasks: [task('T1', 'done', [])],
    artifacts: [],
  })
  const store = new AutomationsStore(workspaceRootForStatePath(statePath))
  // Every automation is seeded at worst case: past both caps, and with run text
  // well past the truncation limit, so the wire payload is the largest one project
  // can produce.
  const seededAutomations = automationsPerProjectMax + 2
  const seededRuns = automationRecentRunsMax + 2
  for (let index = 0; index < seededAutomations; index += 1) {
    const automationId = `automation-${String(index).padStart(2, '0')}`
    await store.createDefinition({
      id: automationId,
      name: `Automation ${index}`,
      status: 'enabled',
      trigger: { kind: 'schedule', config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 30 }, timezone: 'UTC' } },
      action: { kind: 'agent-run', config: { prompt: 'sweep' } },
      autonomyDefault: 'review_only',
      nextRunAt: null,
      lastRunAt: generatedAt,
      lastRunId: `${automationId}-run-0`,
      createdAt: generatedAt,
      updatedAt: `2026-06-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    })
    for (let runIndex = 0; runIndex < seededRuns; runIndex += 1) {
      const minute = String(runIndex).padStart(2, '0')
      await store.recordRun({
        id: `${automationId}-run-${runIndex}`,
        automationId,
        status: 'blocked',
        dueAt: `2026-07-13T10:${minute}:00.000Z`,
        startedAt: `2026-07-13T10:${minute}:01.000Z`,
        completedAt: `2026-07-13T10:${minute}:30.000Z`,
        blockedReason: 'b'.repeat(automationRunTextMaxChars * 3),
        summary: 's'.repeat(automationRunTextMaxChars * 3),
      })
    }
  }

  const service = new MobileSprintEngineSnapshotService({
    stateReaders: {
      readSwitchboardTasks: async () => ({ ok: false, message: 'Switchboard is not initialized.' }),
      getSwitchboardRunnerState: async () => ({ ok: false, message: 'Runner unavailable.' }),
      listWatchtowerRuns: async () => ({ ok: true, runs: [] }),
      readMultiloopStates: async () => [],
      readRoleCatalog: async () => [],
    },
  })
  const result = await dispatchSnapshotRequest({
    command: { type: 'snapshot.request', commandId: 'c1', deviceId: 'd1', payload: {} } as never,
    snapshotService: service,
    desktopSessionId: 'desktop_1',
    statePathsProvider: async () => [statePath],
  })
  assert.equal(result.ok, true)
  const snapshot = (result.ok ? result.data : null) as MobileControlSnapshot

  const automations = snapshot.automations ?? []
  assert.equal(automations.length, automationsPerProjectMax)
  for (const automation of automations) {
    assert.equal(automation.recentRuns?.length, automationRecentRunsMax)
    const [latest] = automation.recentRuns ?? []
    assert.equal(latest.summary?.length, automationRunTextMaxChars)
    assert.equal(latest.summary?.endsWith('…'), true)
    assert.equal(latest.blockedReason?.length, automationRunTextMaxChars)
  }

  // The whole point of the caps: a project at full cap fits, so the ladder never
  // has to shed anything for one project's automations.
  assert.equal(snapshot.sprintEngines.length, 1)
  assert.equal(
    relaySummaryByteLength(summarizeCommandResult(result)) <= relayResultSummaryMaxBytes,
    true,
    'a project at full automations cap must fit the relay result-summary budget'
  )
  assert.equal(validateMobileControlSnapshot(snapshot).ok, true)
  service.shutdown()
}

// The ladder's ORDER is the contract: run history is monitor detail on an automation
// the phone can still see, whereas a dropped sprint engine is a run it can no longer
// see or drive. So a snapshot that cannot fit must lose `recentRuns` first and keep
// every sprint engine.
//
// Four workspace roots at full automations cap exceed the budget on automations alone
// (~110% of 256 KB, measured), which is exactly the case the per-project caps cannot
// prevent — so this drives the ladder with the snapshot the real producer would emit
// for four such roots.
async function assertShedDropsRecentRunsBeforeAnySprintEngine(): Promise<void> {
  const statePath = await writeStateFixture({
    sprintengine: { name: 'Crowded Sprint Engine', updatedAt: generatedAt },
    tasks: [task('T1', 'done', [])],
    artifacts: [],
  })
  const service = new MobileSprintEngineSnapshotService({
    stateReaders: {
      readSwitchboardTasks: async () => ({ ok: false, message: 'Switchboard is not initialized.' }),
      getSwitchboardRunnerState: async () => ({ ok: false, message: 'Runner unavailable.' }),
      listWatchtowerRuns: async () => ({ ok: true, runs: [] }),
      readMultiloopStates: async () => [],
      readRoleCatalog: async () => [],
    },
  })
  const base = sanitizeMobileSnapshotForRelay(
    await service.readSnapshot({ desktopSessionId: 'desktop_1', statePaths: [statePath], generatedAt })
  )
  const oversized: MobileControlSnapshot = {
    ...base,
    automations: ['ws_alpha', 'ws_beta', 'ws_gamma', 'ws_delta'].flatMap(automationsAtFullCap),
  }
  assert.equal(
    relaySummaryByteLength(oversized) > relayResultSummaryMaxBytes,
    true,
    'fixture must actually exceed the budget, or the ladder is never exercised'
  )

  const result = await dispatchSnapshotRequest({
    command: { type: 'snapshot.request', commandId: 'c2', deviceId: 'd1', payload: {} } as never,
    snapshotService: { readSnapshot: async () => oversized } as never,
    desktopSessionId: 'desktop_1',
    statePathsProvider: async () => [statePath],
  })
  assert.equal(result.ok, true)
  const shed = (result.ok ? result.data : null) as MobileControlSnapshot

  // The sprint engine survives the shed that removed the run history.
  assert.deepEqual(
    shed.sprintEngines.map((sprintEngine) => sprintEngine.sprintEngineId),
    base.sprintEngines.map((sprintEngine) => sprintEngine.sprintEngineId)
  )
  assert.equal(shed.snapshotLimits?.sprintEngines, undefined)

  // Every automation is still on the wire — only its run history went.
  assert.equal(shed.automations?.length, oversized.automations?.length)
  assert.equal(shed.automations?.some((automation) => automation.recentRuns !== undefined), false)
  // Shedding is omission, not an empty array: the wire field is optional and the
  // validator would reject a nulled one.
  assert.equal(shed.automations?.every((automation) => !('recentRuns' in automation)), true)
  assert.equal(shed.automations?.[0]?.name, oversized.automations?.[0]?.name)

  assert.equal(
    relaySummaryByteLength(summarizeCommandResult(result)) <= relayResultSummaryMaxBytes,
    true,
    'dropping recentRuns must be enough to bring four capped projects back inside the budget'
  )
  assert.equal(validateMobileControlSnapshot(shed).ok, true)
  service.shutdown()
}

// One project's automations exactly as the producer emits them at full cap: capped
// count, capped runs, run text at the truncation limit.
function automationsAtFullCap(projectKey: string): MobileControlAutomationSnapshot[] {
  return Array.from({ length: automationsPerProjectMax }, (_automation, index) => ({
    automationId: `${projectKey}-automation-${index}`,
    projectKey,
    name: `Automation ${index}`,
    status: 'enabled' as const,
    triggerKind: 'schedule',
    cadence: 'Every 30 min',
    nextRunAt: generatedAt,
    lastRunAt: generatedAt,
    lastRunStatus: 'blocked' as const,
    recentRuns: Array.from({ length: automationRecentRunsMax }, (_run, runIndex) => ({
      runId: `${projectKey}-automation-${index}-run-${runIndex}`,
      status: 'blocked' as const,
      startedAt: generatedAt,
      completedAt: generatedAt,
      blockedReason: 'b'.repeat(automationRunTextMaxChars),
      summary: 's'.repeat(automationRunTextMaxChars),
    })),
  }))
}

// The `sprintengine.roles.list` payload -> wire descriptors. Driven with the shape
// the real tool emits (verified against `sprintengine_tool.py roles list`).
async function assertRoleCatalogReducesRegistryPayload(): Promise<void> {
  const catalog = normalizeRoleCatalog({
    ok: true,
    roles: [
      {
        id: 'architect',
        label: 'Architect',
        aliases: [],
        summary: 'Plans production software work and task decomposition.',
        icon: null,
        directives: { implement: [{ skill: 'architect' }] },
        sweep: null,
        source: { layer: 'bundled' },
      },
      {
        id: 'tester',
        label: 'QA',
        aliases: [],
        summary: 'Validates real product paths.',
        directives: { implement: [{ skill: 'tester' }] },
        // A sweep is a {focus, when} block — the phone gets the boolean, never the prose.
        sweep: { focus: 'the combined branch diff', when: 'behaviour changed' },
        source: { layer: 'bundled' },
      },
      {
        id: 'prompt_smith',
        label: 'Prompt Smith',
        summary: 'Tunes prompts.',
        sweep: null,
        // User-global roles mount as a plugin root; the phone should be told "user".
        source: { layer: 'plugin:user-roles' },
      },
      { id: 'house_style', label: 'House Style', sweep: null, source: { layer: 'workspace' } },
      { id: 'vendor_role', label: 'Vendor Role', sweep: null, source: { layer: 'plugin:acme' } },
    ],
  })

  assert.deepEqual(catalog?.map((role) => role.roleId), [
    'architect',
    'tester',
    'prompt_smith',
    'house_style',
    'vendor_role',
  ])
  // Directives and skill routing are not the phone's business and must not ride.
  assert.deepEqual(Object.keys(catalog?.[0] ?? {}).sort(), ['label', 'roleId', 'source', 'summary'])
  assert.equal(catalog?.[1]?.sweep, true, 'a sweep block reduces to the flag')
  assert.equal(catalog?.[0]?.sweep, undefined, 'a null sweep is not a sweep')
  assert.equal(catalog?.[2]?.source, 'user', 'plugin:user-roles is what a user authored')
  assert.equal(catalog?.[3]?.source, 'workspace')
  assert.equal(catalog?.[4]?.source, 'plugin', 'other plugin layers collapse to plugin')

  // Junk in: no catalog rather than a broken one.
  assert.equal(normalizeRoleCatalog(undefined), undefined)
  assert.equal(normalizeRoleCatalog({ ok: false }), undefined)
  assert.deepEqual(normalizeRoleCatalog({ roles: [null, 3, { label: 'no id' }] }), [])

  // Bounded: the snapshot's size-shedding pass can only drop whole sprint engines,
  // so a catalog it cannot shed has to be small by construction.
  const flooded = normalizeRoleCatalog({
    roles: Array.from({ length: 200 }, (_, index) => ({ id: `role_${index}`, label: `R${index}` })),
  })
  assert.equal(flooded?.length, 48)

  const [truncated] = normalizeRoleCatalog({ roles: [{ id: 'x', label: 'X', summary: 's'.repeat(400) }] }) ?? []
  assert.equal(truncated?.summary?.length, 160)
  assert.equal(truncated?.summary?.endsWith('…'), true)

  // A manifest with no label still has a name to show.
  const [humanized] = normalizeRoleCatalog({ roles: [{ id: 'data_platform_engineer' }] }) ?? []
  assert.equal(humanized?.label, 'Data Platform Engineer')
}

async function assertSnapshotSurfacesCreatedSpikeBacklogItem(): Promise<void> {
  const statePath = await writeStateFixture({
    sprintengine: { name: 'Backlog Sprint Engine', updatedAt: generatedAt },
    tasks: [task('T1', 'done', [])],
    artifacts: [],
  })
  const workspaceRoot = workspaceRootForStatePath(statePath)

  // Use the real create path the mobile backlog.create command calls.
  const created = await createBacklogItem({
    workspaceRoot,
    title: 'Probe the relay timeout',
    description: 'Spike how the relay behaves under a 30s stall.',
    type: 'spike',
  })
  assert.equal(created.ok, true)

  const service = new MobileSprintEngineSnapshotService({
    stateReaders: {
      readSwitchboardTasks: async () => ({ ok: false, message: 'Switchboard is not initialized.' }),
      getSwitchboardRunnerState: async () => ({ ok: false, message: 'Runner unavailable.' }),
      listWatchtowerRuns: async () => ({ ok: true, runs: [] }),
      readMultiloopStates: async () => [],
      // A registry that cannot be read publishes no catalog — the backlog is
      // unaffected, and the phone falls back to its bundled list (MC-1543).
      readRoleCatalog: async () => undefined,
    },
  })

  const snapshot = await service.readSnapshot({
    desktopSessionId: 'desktop_1',
    statePaths: [statePath],
    generatedAt,
  })

  assert.equal(snapshot.commands?.includes('backlog.create'), true)
  const backlogWorkspace = snapshot.backlog?.find((entry) => entry.workspacePath === workspaceRoot)
  assert.equal(backlogWorkspace?.items.length, 1)
  const item = backlogWorkspace?.items[0]
  assert.equal(item?.title, 'Probe the relay timeout')
  assert.equal(item?.status, 'idea')
  assert.equal(item?.type, 'spike')
  assert.equal(item?.excerpt?.includes('30s stall'), true)
  assert.equal('roles' in (backlogWorkspace ?? {}), false, 'an unreadable registry omits roles rather than sending an empty catalog')
  service.shutdown()
}

async function assertSnapshotOmitsBacklogWhenWorkspaceHasNone(): Promise<void> {
  const statePath = await writeStateFixture({
    sprintengine: { name: 'No Backlog Sprint Engine', updatedAt: generatedAt },
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

  assert.equal(snapshot.backlog, undefined)
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
    include: ['sprintEngines', 'desktopWorkspaces'],
  })

  assert.deepEqual(snapshot.workspaces?.map((workspace) => workspace.kind), ['sprintengine'])
  service.shutdown()
}

// Item 1600 part 1: the unscoped default keeps every live run but only the
// most-recent few terminal ones, and drops the switchboard/watchtower/multiloop
// projections entirely.
async function assertUnscopedSnapshotShedsTerminalRunsBeyondKeepWindow(): Promise<void> {
  // Newest-first, mirroring discovery's updatedAt-descending order.
  const statePaths = [
    await writeRunProjectionFixture({ id: 'live-a', status: 'executing' }),
    await writeRunProjectionFixture({ id: 'done-1', status: 'completed' }),
    await writeRunProjectionFixture({ id: 'done-2', status: 'failed' }),
    await writeRunProjectionFixture({ id: 'done-3', status: 'archived' }),
    await writeRunProjectionFixture({ id: 'live-b', status: 'planning' }),
    await writeRunProjectionFixture({ id: 'done-4', status: 'completed' }),
  ]
  const service = new MobileSprintEngineSnapshotService()
  const result = await dispatchSnapshotRequest({
    command: { type: 'snapshot.request', commandId: 'c-terminal', deviceId: 'd1', payload: {} } as never,
    snapshotService: service,
    desktopSessionId: 'desktop_1',
    statePathsProvider: async () => statePaths,
  })
  assert.equal(result.ok, true)
  const snapshot = (result.ok ? result.data : null) as MobileControlSnapshot

  const ids = snapshot.sprintEngines.map((sprintEngine) => sprintEngine.sprintEngineId).sort()
  // Both live runs plus the three most-recent terminal runs survive; the fourth is shed.
  assert.deepEqual(ids, ['done-1', 'done-2', 'done-3', 'live-a', 'live-b'])
  assert.equal(snapshot.sprintEngines.some((sprintEngine) => sprintEngine.sprintEngineId === 'done-4'), false)
  // Default composition carries no switchboard/watchtower/multiloop projections.
  assert.equal(snapshot.workspaces?.every((workspace) => workspace.kind === 'sprintengine'), true)
  service.shutdown()
}

// Item 1600: a request with none of the new fields still gets a valid, now-leaner
// default snapshot — old-client compatibility.
async function assertUnscopedDefaultSnapshotIsValidForOldClients(): Promise<void> {
  const statePath = await writeRunProjectionFixture({ id: 'default-engine', status: 'executing' })
  const service = new MobileSprintEngineSnapshotService()
  const result = await dispatchSnapshotRequest({
    command: { type: 'snapshot.request', commandId: 'c-default', deviceId: 'd1', payload: {} } as never,
    snapshotService: service,
    desktopSessionId: 'desktop_1',
    statePathsProvider: async () => [statePath],
  })
  assert.equal(result.ok, true)
  const snapshot = (result.ok ? result.data : null) as MobileControlSnapshot
  assert.equal(validateMobileControlSnapshot(snapshot).ok, true)
  assert.equal(snapshot.sprintEngines.length, 1)
  assert.equal(snapshot.workspaces?.every((workspace) => workspace.kind === 'sprintengine'), true)
  service.shutdown()
}

// Item 1600 acceptance: a scoped request keeps skipping the size-shedding ladder,
// so an oversized scoped result is returned whole rather than shed.
async function assertScopedRequestSkipsSheddingLadder(): Promise<void> {
  const statePath = await writeRunProjectionFixture({ id: 'scoped-shed', status: 'executing' })
  const oversized: MobileControlSnapshot = {
    protocolVersion: mobileControlProtocolVersion,
    generatedAt,
    desktopSessionId: 'desktop_1',
    snapshotVersion: 'snap_scoped',
    commands: [],
    sprintEngines: [],
    workspaces: [],
    automations: ['ws_alpha', 'ws_beta', 'ws_gamma', 'ws_delta'].flatMap(automationsAtFullCap),
  }
  assert.equal(relaySummaryByteLength(oversized) > relayResultSummaryMaxBytes, true, 'fixture must exceed the budget')

  const result = await dispatchSnapshotRequest({
    command: { type: 'snapshot.request', commandId: 'c-scoped', deviceId: 'd1', payload: { workspacePath: deriveWorkspaceId(workspaceRootForStatePath(statePath)) } } as never,
    snapshotService: { readSnapshot: async () => oversized } as never,
    desktopSessionId: 'desktop_1',
    statePathsProvider: async () => [statePath],
    workspaceRootsProvider: async () => [workspaceRootForStatePath(statePath)],
  })
  assert.equal(result.ok, true)
  const returned = (result.ok ? result.data : null) as MobileControlSnapshot
  // No shedding: every automation keeps its run history despite the over-budget size.
  assert.equal(returned.automations?.length, oversized.automations?.length)
  assert.equal(returned.automations?.every((automation) => automation.recentRuns !== undefined), true)
}

// Item 1600 part 2: a `workspacePath`-scoped request (the phone sends the relay-safe
// projectKey token) narrows engines and backlog to that one root.
async function assertWorkspacePathScopingReturnsOnlyThatRoot(): Promise<void> {
  const engineA = await writeRunProjectionFixture({ id: 'engine-a', status: 'executing' })
  const rootA = workspaceRootForStatePath(engineA)
  const engineB = await writeRunProjectionFixture({ id: 'engine-b', status: 'executing' })
  const rootB = workspaceRootForStatePath(engineB)
  await writeBacklogFixture(rootB, 'backlog_root_b', 'Only in root B')

  const service = new MobileSprintEngineSnapshotService()
  const result = await dispatchSnapshotRequest({
    command: { type: 'snapshot.request', commandId: 'c-ws', deviceId: 'd1', payload: { workspacePath: deriveWorkspaceId(rootA) } } as never,
    snapshotService: service,
    desktopSessionId: 'desktop_1',
    statePathsProvider: async () => [engineA, engineB],
    workspaceRootsProvider: async () => [rootA, rootB],
  })
  assert.equal(result.ok, true)
  const snapshot = (result.ok ? result.data : null) as MobileControlSnapshot
  // Only root A's engine, and none of root B's backlog.
  assert.deepEqual(snapshot.sprintEngines.map((sprintEngine) => sprintEngine.sprintEngineId), ['engine-a'])
  assert.equal(snapshot.backlog, undefined)
  service.shutdown()
}

// Item 1600 part 3: `include` restricts the payload to the named collections, and
// `roleCatalogs` gates the role catalog that rides the backlog workspace.
async function assertIncludeScopingOmitsUnrequestedCollections(): Promise<void> {
  const statePath = await writeRunProjectionFixture({ id: 'inc-engine', status: 'executing' })
  const workspaceRoot = workspaceRootForStatePath(statePath)
  await writeBacklogFixture(workspaceRoot, 'backlog_inc', 'Include-scoped item')
  const service = new MobileSprintEngineSnapshotService({
    stateReaders: {
      readRoleCatalog: async () => [{ roleId: 'architect', label: 'Architect', summary: 'Plans the run.', source: 'bundled' }],
    },
  })

  const onlyEngines = await service.readSnapshot({
    desktopSessionId: 'desktop_1', statePaths: [statePath], workspaceRoots: [workspaceRoot], generatedAt, include: ['sprintEngines'],
  })
  assert.equal(onlyEngines.sprintEngines.length, 1)
  assert.equal(onlyEngines.backlog, undefined)
  assert.equal(onlyEngines.automations, undefined)

  const onlyBacklog = await service.readSnapshot({
    desktopSessionId: 'desktop_1', statePaths: [statePath], workspaceRoots: [workspaceRoot], generatedAt, include: ['backlog', 'roleCatalogs'],
  })
  assert.equal(onlyBacklog.sprintEngines.length, 0)
  assert.equal(onlyBacklog.backlog?.length, 1)
  assert.equal(onlyBacklog.backlog?.[0]?.roles?.length, 1)

  // Same request minus roleCatalogs: the backlog ships without its role catalog.
  const backlogNoRoles = await service.readSnapshot({
    desktopSessionId: 'desktop_1', statePaths: [statePath], workspaceRoots: [workspaceRoot], generatedAt, include: ['backlog'],
  })
  assert.equal(backlogNoRoles.backlog?.length, 1)
  assert.equal(backlogNoRoles.backlog?.[0]?.roles, undefined)
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
    include: ['sprintEngines', 'desktopWorkspaces'],
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
    `${String.raw`{"sprintengine":{"name":"Bad"},"tasks":[{"evidence":{"commandsRan":[".multi-code\sprintengine\run.yaml"]}}]}`}\n`
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
  const statePath = join(teamDirectory, 'run.yaml')
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  return statePath
}

// A run with a projection.json carrying a concrete run-level status, in its own
// workspace root and its own team directory (so its sprintEngineId is `id`). Used
// by the scoping/terminal-filter tests, which read that status.
async function writeRunProjectionFixture(input: { id: string; status: string }): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-sprintengine-snapshot-'))
  const teamDirectory = join(workspaceRoot, '.multi-code', 'sprintengine', input.id)
  await mkdir(teamDirectory, { recursive: true })
  const statePath = join(teamDirectory, 'run.yaml')
  const isLive = input.status === 'executing' || input.status === 'planning' || input.status === 'planned'
  await writeFile(statePath, `${JSON.stringify({ schemaVersion: 2, name: input.id, status: input.status }, null, 2)}\n`, 'utf8')
  await writeFile(join(teamDirectory, 'projection.json'), JSON.stringify({
    ok: true,
    projectionVersion: 1,
    updatedAt: generatedAt,
    run: { id: input.id, name: input.id, status: input.status, updatedAt: generatedAt },
    tasks: [task('T1', isLive ? 'in_progress' : 'done', [])],
    artifacts: [],
  }), 'utf8')
  return statePath
}

async function writeBacklogFixture(workspaceRoot: string, itemId: string, title: string): Promise<void> {
  await mkdir(join(workspaceRoot, 'backlog'), { recursive: true })
  await writeFile(join(workspaceRoot, 'backlog', `${itemId}.md`), `---\ntype: feature\n---\n\n# ${title}\n\nBody.\n`, 'utf8')
  await mkdir(join(workspaceRoot, '.multi-code', 'backlog'), { recursive: true })
  await writeFile(
    join(workspaceRoot, '.multi-code', 'backlog', 'items.json'),
    JSON.stringify({
      schemaVersion: 1,
      items: [
        {
          id: itemId,
          source: { type: 'file', relativePath: `backlog/${itemId}.md` },
          status: 'ready',
          type: 'feature',
          metadata: {},
          links: [],
          createdAt: generatedAt,
          updatedAt: generatedAt,
        },
      ],
    }),
    'utf8'
  )
}

async function writeStateText(content: string): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'multicode-sprintengine-snapshot-'))
  const teamDirectory = join(workspacePath, '.multi-code', 'sprintengine', 'team')
  await mkdir(teamDirectory, { recursive: true })
  const statePath = join(teamDirectory, 'run.yaml')
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
