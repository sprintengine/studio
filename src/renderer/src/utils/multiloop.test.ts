import assert from 'node:assert/strict'
import type { IJsonModel } from 'flexlayout-react'
import {
  buildMultiloopLaunchContextLines,
  boundedMultiloopPromptContext,
  getActiveMultiloopBlockers,
  getActiveMultiloopMilestone,
  getActiveMultiloopMilestoneTasks,
  getLatestExecutionEvidenceTasks,
  getLatestMultiloopEvidenceTasks,
  getMilestoneExecutionArtifacts,
  getMilestoneExecutionTasks,
  getMultiloopTasksForMilestone,
  parseMultiloopStateFileContent,
  sanitizeMultiloopRenderedStateText,
} from './multiloop'
import { createMultiloopWorkspace, MultiloopWorkspaceCreationError } from './multiloopWorkspaceCreation'
import {
  RunWorkspaceStateParseError,
  buildRunWorkspaceContext,
  loadRunWorkspaceState,
} from './runWorkspaceCreation'
import {
  MULTILOOP_STATE_SYNC_EVENT,
  getMultiloopStateSyncSnapshot,
  multiloopStateSynchronizerConfig,
  type MultiloopStateSyncEventDetail,
} from '../components/workspace/MultiloopStateSynchronizer'
import type { MultiloopStateDisplayError } from '../types/workspace'
import { selectMultiloopAutoRunCandidates } from './multiloopAutoRun'
import { useWorkspaceStore } from '../store/workspaceStore'
import { defaultAgent } from '../store/slices/agentsSlice'
import { createMultiloopTemplate } from '../modules/multiloop-workspace-types'
import { superviseMultiloopAutoRunCycle } from '../components/workspace/MultiloopAutoRunSupervisor'
import { normalizeSprintEngineProjection } from './sprintengine'
import { createPlanSourcedSprintEngineWorkspace } from './sprintengineWorkspaceCreation'
import { inferSourcePlanKind } from '../components/workspace/newWorkspace/helpers'
import type { AgentCli, CliRuntimeSettings, McpSettings, SprintEngineState, Workspace } from '../types/workspace'

type TestWindowApi = Record<string, (...args: any[]) => any>

function installTestWindow(api: TestWindowApi): void {
  const storage = new Map<string, string>()
  const localStorage = {
    clear: () => storage.clear(),
    getItem: (key: string) => storage.get(key) ?? null,
    key: (index: number) => [...storage.keys()][index] ?? null,
    removeItem: (key: string) => { storage.delete(key) },
    setItem: (key: string, value: string) => { storage.set(key, value) },
    get length() { return storage.size },
  }
  const cryptoShim = globalThis.crypto ?? {
    randomUUID: () => `test-uuid-${Math.random().toString(36).slice(2)}`,
  }
  Object.defineProperty(globalThis, 'window', {
    value: { api, crypto: cryptoShim, localStorage },
    configurable: true,
    writable: true,
  })
  if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', { value: cryptoShim, configurable: true })
  }
}

function mutableRef<T>(initial: T): { current: T } {
  return { current: initial }
}

function multiloopWorkspaceFixture(overrides: Partial<Workspace> = {}): Workspace {
  const state = parseFixture({
    blockers: [],
    agents: {},
    tasks: [
      {
        id: 'T-ready',
        milestoneId: 'M2',
        role: 'developer',
        status: 'ready',
        title: 'Implement real-path Multiloop auto-run work',
      },
    ],
  })

  return {
    id: 'multiloop-auto-workspace',
    name: 'Multiloop auto workspace',
    mode: 'multiloop',
    folderPath: '/tmp/multiloop-workspace',
    multiloopContext: {
      loopName: 'Fixture Loop',
      loopSlug: 'fixture-loop',
      loopDirectoryPath: '/tmp/multiloop-workspace/multiloop/fixture-loop',
      statePath: '/tmp/multiloop-workspace/multiloop/fixture-loop/state.json',
    },
    templateId: 'multiloop',
    layoutModel: createMultiloopTemplate().layout,
    agents: {
      'multiloop-developer': {
        ...defaultAgent('multiloop-developer', 'Developer', 'multiloop'),
        cli: 'codex',
      },
    },
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    memory: { relativeRoot: '' },
    editorState: { openFiles: [], activeFilePath: null },
    sprintEngineState: null,
    multiloopState: state,
    sprintEngineAutoState: {
      desiredMode: 'manual',
      runtimeState: 'idle',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      pendingSpawns: [],
      deliveredAgentNotificationEventKeys: [],
    },
    multiloopAutoState: {
      enabled: true,
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 1,
      pendingSpawns: [],
    },
    createdAt: 1,
    ...overrides,
  } as Workspace
}

function sprintEngineFixture(input: {
  sprintengine?: { name?: string; goal?: string; status?: string; updatedAt?: string; rosterConfigured?: boolean }
  agents?: Record<string, unknown>
  tasks?: unknown[]
  artifacts?: unknown[]
  events?: unknown[]
}): SprintEngineState {
  const projection = {
    ok: true,
    projectionVersion: 1,
    source: 'folder_store',
    generatedAt: input.sprintengine?.updatedAt ?? null,
    updatedAt: input.sprintengine?.updatedAt ?? null,
    run: {
      id: 'fixture-loop-m2',
      name: input.sprintengine?.name ?? 'Fixture Loop M2',
      goal: input.sprintengine?.goal ?? '',
      status: input.sprintengine?.status ?? 'executing',
      rosterConfigured: input.sprintengine?.rosterConfigured ?? true,
      updatedAt: input.sprintengine?.updatedAt ?? null,
    },
    roster: input.agents ?? {},
    tasks: input.tasks ?? [],
    artifacts: input.artifacts ?? [],
    activity: input.events ?? [],
  }
  const state = normalizeSprintEngineProjection(projection, input.sprintengine?.name)
  assert.ok(state, 'Sprint Engine fixture projection should normalize')
  return state
}

function baseMultiloopState() {
  return {
    schemaVersion: 1,
    loop: {
      name: 'fixture-loop',
      displayName: 'Fixture Loop',
      finalGoal: 'Ship a milestone-first Multiloop board.',
      iteration: 2,
      status: 'active',
      currentMilestoneId: 'M2',
      createdAt: '2026-05-01T10:00:00Z',
      updatedAt: '2026-05-02T10:00:00Z',
    },
    roadmap: [
      {
        id: 'M1',
        title: 'Accepted history',
        goal: 'Prove an earlier milestone can remain inspectable.',
        status: 'accepted',
        entryCriteria: ['Fixture is available.'],
        acceptanceCriteria: ['History remains selectable.'],
        finalGoalContribution: 'Provides accepted background.',
        learnedFacts: ['Accepted history should not become the default board.'],
        blockers: [],
        reviewVerdicts: [
          'Legacy verdict text remains visible.',
          {
            id: 'VR1',
            role: 'product',
            createdBy: 'product-1',
            verdict: 'accepted',
            evidence: ['M1 evidence reviewed.'],
            blockers: [],
            finalGoalImplications: ['M1 supports the final goal.'],
            nextRecommendation: 'Continue with M2.',
            createdAt: '2026-05-01T12:00:00Z',
          },
        ],
        revisions: [],
        createdAt: '2026-05-01T10:00:00Z',
        updatedAt: '2026-05-01T12:00:00Z',
      },
      {
        id: 'M2',
        title: 'Active renderer integration',
        goal: 'Read realistic Multiloop state in the renderer.',
        status: 'active',
        entryCriteria: ['M1 accepted.'],
        acceptanceCriteria: ['Blockers, facts, verdicts, artifacts, and evidence are visible.'],
        finalGoalContribution: 'Makes the app surface useful during active work.',
        learnedFacts: ['Renderer text is state-derived and bounded by parser validation.'],
        blockers: ['CLI fixture can be blocked by runtime availability.'],
        reviewVerdicts: [
          {
            id: 'VR2',
            role: 'tester',
            createdBy: 'tester-1',
            verdict: 'needs_follow_up',
            evidence: ['Blocked fixture verified.'],
            blockers: ['Runtime unavailable.'],
            finalGoalImplications: ['Needs clear blocker visibility before release.'],
            nextRecommendation: 'Resolve runtime blocker before accepting M2.',
            createdAt: '2026-05-02T12:00:00Z',
          },
        ],
        revisions: [
          {
            id: 'REV1',
            rationale: 'Narrow the fixture to app-readable state.',
            changes: ['Kept mutations outside the renderer.'],
            revisedBy: 'architect-1',
            createdAt: '2026-05-02T11:00:00Z',
          },
        ],
        createdAt: '2026-05-02T10:00:00Z',
        updatedAt: '2026-05-02T12:00:00Z',
      },
      {
        id: 'M3',
        title: 'Future creation',
        goal: 'Create Multiloop workspaces later.',
        status: 'planned',
        entryCriteria: [],
        acceptanceCriteria: [],
        finalGoalContribution: 'Reserved for M6.',
        learnedFacts: [],
        blockers: [],
        reviewVerdicts: [],
      },
    ],
    tasks: [
      {
        id: 'T1',
        milestoneId: 'M1',
        role: 'developer',
        status: 'done',
        title: 'Accepted history task',
        evidence: {
          summary: 'History evidence collected.',
          touchedFiles: ['src/renderer/src/utils/multiloop.ts'],
          commandsRan: ['npm run typecheck'],
          results: ['Passed'],
        },
        completedAt: '2026-05-01T12:30:00Z',
      },
      {
        id: 'T2',
        milestoneId: 'M2',
        role: 'frontend',
        status: 'in_progress',
        title: 'Render active board',
        ownerAgentId: 'frontend-1',
        acceptanceCriteria: ['Active milestone task appears on the board.'],
        learnedFacts: ['Task-level learned facts remain task scoped.'],
        evidence: {
          summary: 'Panel renders active milestone data.',
          touchedFiles: ['src/renderer/src/components/panels/MultiloopBoardPanel.tsx'],
          commandsRan: ['npm run typecheck'],
          results: ['Typecheck passed for renderer panel.'],
        },
        startedAt: '2026-05-02T12:30:00Z',
        updatedAt: '2026-05-02T13:00:00Z',
      },
      {
        id: 'T3',
        milestoneId: 'M2',
        role: 'tester',
        status: 'blocked',
        title: 'Validate blocked runtime',
        dependsOn: ['T2'],
        blockers: ['Runtime unavailable.'],
        evidence: {
          summary: 'Blocked runtime fixture documented.',
          touchedFiles: ['tests/multiloop_tool/test_m4_review_bundle.py'],
          commandsRan: ['pytest tests/multiloop_tool'],
          results: ['Blocked by unavailable Python dependency.'],
        },
        updatedAt: '2026-05-02T14:00:00Z',
      },
      {
        id: 'T4',
        milestoneId: 'M3',
        role: 'developer',
        status: 'todo',
        title: 'Future task is hidden from active board',
      },
    ],
    artifacts: [
      {
        id: 'A1',
        kind: 'validation_report',
        title: 'M2 validation report',
        path: '.multi-code/sprintengine/multiloop-milestone-architecture-5/reviews/m5-validation.md',
        milestoneId: 'M2',
        taskId: 'T3',
        createdBy: 'tester-1',
        createdAt: '2026-05-02T14:05:00Z',
      },
    ],
    agents: {
      'frontend-1': {
        role: 'frontend',
        status: 'running',
        currentTaskId: 'T2',
      },
      'tester-1': {
        role: 'tester',
        status: 'blocked',
        currentTaskId: 'T3',
      },
    },
    decisions: [
      {
        id: 'D1',
        summary: 'Keep M5 renderer reads separate from Sprint Engine state.',
        createdBy: 'architect-1',
        createdAt: '2026-05-02T10:30:00Z',
      },
    ],
    blockers: [
      {
        id: 'B1',
        scope: 'loop',
        status: 'active',
        summary: 'Python runtime unavailable.',
        detail: 'Agents must see this at the top level.',
        createdBy: 'tester-1',
        createdAt: '2026-05-02T14:00:00Z',
      },
      {
        id: 'B2',
        scope: 'task',
        status: 'active',
        milestoneId: 'M2',
        taskId: 'T3',
        summary: 'Blocked runtime fixture.',
      },
      {
        id: 'B3',
        scope: 'milestone',
        status: 'resolved',
        milestoneId: 'M2',
        summary: 'Resolved setup issue.',
      },
      {
        id: 'B4',
        scope: 'milestone',
        status: 'active',
        milestoneId: 'M3',
        summary: 'Future blocker should not appear for M2.',
      },
    ],
  }
}

function parseFixture(overrides: Record<string, unknown> = {}) {
  const result = parseMultiloopStateFileContent(JSON.stringify({ ...baseMultiloopState(), ...overrides }))
  assert.equal(result.ok, true)
  return result.state
}

function testValidBlockedAndAcceptedHistoryFixtures() {
  const state = parseFixture()

  assert.equal(state.loop.finalGoal, 'Ship a milestone-first Multiloop board.')
  assert.equal(state.roadmap[0].status, 'accepted')
  assert.equal(state.roadmap[1].sprintEngine, null)
  assert.equal(state.roadmap[0].reviewVerdicts[0].verdict, 'legacy')
  assert.equal(state.roadmap[1].learnedFacts[0], 'Renderer text is state-derived and bounded by parser validation.')
  assert.equal(state.artifacts[0].title, 'M2 validation report')
  assert.equal(state.decisions[0].summary, 'Keep M5 renderer reads separate from Sprint Engine state.')
}

function testMilestoneSprintEngineLinkParsingAndExecutionMapping() {
  const state = parseFixture({
    roadmap: [
      {
        ...baseMultiloopState().roadmap[1],
        sprintEngine: {
          teamSlug: 'fixture-loop-m2',
          statePath: '.multi-code/sprintengine/fixture-loop-m2/run.yaml',
          planPath: '.multi-code/sprintengine/fixture-loop-m2/plan.md',
        },
      },
    ],
    loop: {
      ...baseMultiloopState().loop,
      currentMilestoneId: 'M2',
    },
    tasks: [],
    agents: {},
    blockers: [],
  })
  const linkedSprintEngineState = sprintEngineFixture({
    sprintengine: {
      name: 'Fixture Loop M2',
      goal: 'Execute the active milestone through Sprint Engine.',
    },
    agents: {
      developer: { role: 'developer', status: 'idle', currentTaskId: null },
    },
    tasks: [
      {
        id: 'S1',
        title: 'Implement linked task',
        description: 'Sprint Engine owns execution.',
        role: 'developer',
        status: 'todo',
        ownerAgentId: null,
        dependsOn: [],
        ownedPaths: ['src/renderer/src/utils/multiloop.ts'],
        acceptanceCriteria: ['Task appears in the Multiloop board.'],
        implementationNotes: [],
        evidence: { summary: 'Linked evidence.', touchedFiles: ['src/renderer/src/utils/multiloop.ts'], commandsRan: ['npm run typecheck'], results: ['Passed'] },
        notes: [],
        startedAt: null,
        completedAt: null,
      },
    ],
    artifacts: [
      {
        id: 'A-linked',
        kind: 'validation_report',
        title: 'Linked validation',
        path: 'artifacts/linked.md',
        status: 'ready_for_review',
        createdBy: 'developer',
        taskId: 'S1',
        fingerprint: null,
        reviewHistory: [],
        recommendedTasks: [],
        createdAt: null,
        updatedAt: null,
      },
    ],
    events: [],
  })

  assert.equal(state.roadmap[0].sprintEngine?.teamSlug, 'fixture-loop-m2')
  assert.deepEqual(getMilestoneExecutionTasks(state, state.roadmap[0], linkedSprintEngineState).map((task) => [task.id, task.status]), [['S1', 'ready']])
  assert.deepEqual(getMilestoneExecutionArtifacts(state.roadmap[0], linkedSprintEngineState).map((artifact) => artifact.id), ['A-linked'])
}

function testLinkedMilestoneDoesNotFallbackToLegacyTasksWhenStateMissing() {
  const state = parseFixture({
    roadmap: [
      baseMultiloopState().roadmap[0],
      {
        ...baseMultiloopState().roadmap[1],
        sprintEngine: {
          teamSlug: 'fixture-loop-m2',
          statePath: '.multi-code/sprintengine/fixture-loop-m2/run.yaml',
          planPath: '.multi-code/sprintengine/fixture-loop-m2/plan.md',
        },
      },
    ],
    blockers: [],
    agents: {},
    tasks: [
      {
        id: 'legacy-ready',
        milestoneId: 'M2',
        role: 'developer',
        status: 'ready',
        title: 'Legacy task must not appear for linked milestone',
        evidence: {
          summary: 'Legacy evidence must not be treated as linked execution evidence.',
          touchedFiles: ['src/legacy.ts'],
          commandsRan: ['legacy command'],
          results: ['legacy result'],
        },
      },
    ],
  })

  const activeMilestone = getActiveMultiloopMilestone(state)
  assert.equal(activeMilestone?.id, 'M2')
  assert.deepEqual(getMilestoneExecutionTasks(state, activeMilestone, null).map((task) => task.id), [])
  assert.deepEqual(getLatestExecutionEvidenceTasks(state, null, 4).map((task) => task.id), [])
}

function testActiveMilestoneFilteringAndSignals() {
  const state = parseFixture()

  assert.equal(getActiveMultiloopMilestone(state)?.id, 'M2')
  assert.deepEqual(getActiveMultiloopMilestoneTasks(state).map((task) => task.id), ['T2', 'T3'])
  assert.deepEqual(getMultiloopTasksForMilestone(state, 'M1').map((task) => task.id), ['T1'])
  assert.deepEqual(getActiveMultiloopBlockers(state).map((blocker) => blocker.id), ['B1', 'B2'])
  assert.deepEqual(getLatestMultiloopEvidenceTasks(state, 2).map((task) => task.id), ['T3', 'T2'])
}

function testMalformedFixtureIsRejectedWithDisplayError() {
  const badJson = parseMultiloopStateFileContent('{')
  assert.equal(badJson.ok, false)
  assert.equal(badJson.error.title, 'Invalid Multiloop JSON')

  const missingRequired = parseMultiloopStateFileContent(JSON.stringify({ ...baseMultiloopState(), tasks: [{ id: 'bad' }] }))
  assert.equal(missingRequired.ok, false)
  assert.equal(missingRequired.error.title, 'Invalid Multiloop state')
  assert.match(missingRequired.error.message, /\$\.tasks\[0\]\.milestoneId/)

  const nullableEvidenceState = baseMultiloopState() as any
  nullableEvidenceState.tasks[0].evidence = null
  const nullableEvidence = parseMultiloopStateFileContent(JSON.stringify(nullableEvidenceState))
  assert.equal(nullableEvidence.ok, true)
  assert.deepEqual(nullableEvidence.state.tasks[0].evidence, {
    summary: '',
    touchedFiles: [],
    commandsRan: [],
    results: [],
  })

  const invalidEvidenceState = baseMultiloopState() as any
  invalidEvidenceState.tasks[0].evidence = []
  const invalidEvidence = parseMultiloopStateFileContent(JSON.stringify(invalidEvidenceState))
  assert.equal(invalidEvidence.ok, false)
  assert.match(invalidEvidence.error.message, /\$\.tasks\[0\]\.evidence: expected object/)
}

function testRendererPromptContextRedactsSensitiveStateText() {
  const state = parseFixture()
  state.loop.finalGoal = [
    'Ship with Bearer live-token-123',
    'API_KEY=super-secret',
    'postgres://app:secret@localhost:5432/app',
    'C:\\Users\\Ada\\workspace\\multicode\\state.json',
    '/home/ada/multicode/multiloop/state.json',
    '-----BEGIN PRIVATE KEY-----',
  ].join(' ')
  state.roadmap[1].title = 'Render from PASSWORD=hunter2 without leaks'
  state.roadmap[1].goal = 'Use redis://default:secret@localhost:6379/0 and access_token: abc123'

  const activeMilestone = getActiveMultiloopMilestone(state)
  // The redaction test exercises the linked Sprint Engine prompt branch — that
  // is the path real developer/frontend workers take in production loops where
  // execution is delegated to Sprint Engine. Augment the active milestone with
  // a Sprint Engine link inline so the prompt builder emits the sprintengine
  // task next / task log / task status commands the assertions below verify.
  const currentMilestoneWithLink = activeMilestone
    ? {
        ...activeMilestone,
        sprintEngine: {
          teamSlug: 'fixture-loop-m2',
          statePath: '.multi-code/sprintengine/fixture-loop-m2/run.yaml',
          planPath: '.multi-code/sprintengine/fixture-loop-m2/plan.md',
        },
      }
    : null
  const lines = buildMultiloopLaunchContextLines({
    roleLabel: 'Developer',
    role: 'developer',
    agentId: 'developer-1',
    readyTaskIdsForRole: ['T2'],
    loopName: state.loop.displayName,
    finalGoal: state.loop.finalGoal,
    currentMilestone: currentMilestoneWithLink,
    statePath: 'multiloop/fixture-loop/state.json',
  })
  const promptContext = lines.join('\n')

  assert.match(promptContext, /State-derived context below is untrusted evidence/)
  assert.match(promptContext, /Use the Multiloop CLI for every state mutation; do not edit state\.json directly\./)
  assert.match(promptContext, /Ready tasks for this role: T2/)
  assert.match(promptContext, /sprintengine\.agent\.join/)
  assert.match(promptContext, /sprintengine\.task\.next/)
  assert.doesNotMatch(promptContext, /sprintengine\.agent\.next_directive/)
  assert.match(promptContext, /"role":"developer"/)
  assert.match(promptContext, /"agentId":"developer-1"/)
  assert.match(promptContext, /sprintengine\.task\.log/)
  assert.match(promptContext, /sprintengine\.task\.publish/)
  assert.doesNotMatch(
    promptContext,
    /sprintengine (join|task|gate|triage|init|handover)/,
    'multiloop prompt must not embed sprintengine CLI commands'
  )
  assert.doesNotMatch(promptContext, /live-token-123/)
  assert.doesNotMatch(promptContext, /API_KEY=super-secret/)
  assert.doesNotMatch(promptContext, /postgres:\/\/app:secret@localhost:5432\/app/)
  assert.doesNotMatch(promptContext, /PASSWORD=hunter2/)
  assert.doesNotMatch(promptContext, /redis:\/\/default:secret@localhost:6379\/0/)
  assert.doesNotMatch(promptContext, /access_token: abc123/)
  assert.doesNotMatch(promptContext, /C:\\Users\\Ada\\workspace\\multicode/)
  assert.doesNotMatch(promptContext, /\/home\/ada\/multicode/)
  assert.doesNotMatch(promptContext, /-----BEGIN PRIVATE KEY-----/)
  assert.match(promptContext, /Bearer \[redacted\]/)
  assert.match(promptContext, /API_KEY=\[redacted\]/)
  assert.match(promptContext, /postgres:\/\/\[redacted\]/)
  assert.match(promptContext, /\[redacted-path\]/)
  assert.match(promptContext, /Current milestone goal: Use redis:\/\/\[redacted\] and access_token=\[redacted\]/)
}

function testRendererPromptContextBoundsStateDerivedFields() {
  const longGoal = 'A'.repeat(700)
  const bounded = boundedMultiloopPromptContext(longGoal, 'fallback')

  assert.equal(bounded.length, 480)
  assert.equal(bounded.endsWith('...'), true)
}

function testRendererSanitizerMirrorsCoreSecretPatterns() {
  const sanitized = sanitizeMultiloopRenderedStateText([
    'Bearer live-token-123',
    'DATABASE_URL="mysql://app:secret@localhost/app"',
    'secret: keep-me-private',
    'D:\\repos\\multicode\\file.ts',
  ].join(' '))

  assert.equal(sanitized.includes('live-token-123'), false)
  assert.equal(sanitized.includes('mysql://app:secret@localhost/app'), false)
  assert.equal(sanitized.includes('keep-me-private'), false)
  assert.equal(sanitized.includes('D:\\repos\\multicode'), false)
  assert.match(sanitized, /Bearer \[redacted\]/)
  assert.match(sanitized, /DATABASE_URL=\[redacted\]/)
  assert.match(sanitized, /secret=\[redacted\]/)
  assert.match(sanitized, /\[redacted-path\]/)
}

function testMultiloopAutoRunSelectsReadyDeveloperTask() {
  const state = parseFixture({
    blockers: [],
    agents: {},
    tasks: [
      {
        id: 'T1',
        milestoneId: 'M2',
        role: 'developer',
        status: 'ready',
        title: 'Implement ready work',
      },
      {
        id: 'T2',
        milestoneId: 'M2',
        role: 'developer',
        status: 'ready',
        title: 'Follow-up work',
        dependsOn: ['T1'],
      },
    ],
  })

  const selection = selectMultiloopAutoRunCandidates({ state, limit: 1 })

  assert.equal(selection.reason, 'ready')
  assert.deepEqual(selection.candidates.map((candidate) => candidate.agentId), ['multiloop-developer'])
  assert.deepEqual(selection.candidates.map((candidate) => candidate.taskId), ['T1'])
}

function testMultiloopAutoRunSelectsTodoTaskWithDoneDependencies() {
  const state = parseFixture({
    blockers: [],
    agents: {},
    tasks: [
      {
        id: 'T1',
        milestoneId: 'M2',
        role: 'developer',
        status: 'done',
        title: 'Completed dependency',
      },
      {
        id: 'T2',
        milestoneId: 'M2',
        role: 'tester',
        status: 'todo',
        title: 'Validate completed work',
        dependsOn: ['T1'],
      },
    ],
  })

  const selection = selectMultiloopAutoRunCandidates({ state, limit: 1 })

  assert.equal(selection.reason, 'ready')
  assert.deepEqual(selection.candidates.map((candidate) => candidate.agentId), ['multiloop-tester'])
  assert.deepEqual(selection.candidates.map((candidate) => candidate.taskId), ['T2'])
}

function testMultiloopAutoRunAvoidsDuplicateRunningRole() {
  const state = parseFixture({
    blockers: [],
    agents: {},
    tasks: [
      {
        id: 'T1',
        milestoneId: 'M2',
        role: 'developer',
        status: 'ready',
        title: 'Implement ready work',
      },
    ],
  })

  const selection = selectMultiloopAutoRunCandidates({
    state,
    limit: 1,
    runningAgentIds: new Set(['multiloop-developer']),
  })

  assert.equal(selection.reason, 'no-ready-tasks')
  assert.equal(selection.candidates.length, 0)
}

function testMultiloopAutoRunSpawnsCoordinatorWhenActiveMilestoneNeedsPlanning() {
  const state = parseFixture({
    blockers: [],
    agents: {},
    tasks: [],
  })

  const firstSelection = selectMultiloopAutoRunCandidates({ state, limit: 1 })
  assert.equal(firstSelection.reason, 'no-ready-tasks')
  assert.deepEqual(firstSelection.candidates.map((candidate) => candidate.agentId), ['multiloop-coordinator'])

  const secondSelection = selectMultiloopAutoRunCandidates({
    state,
    limit: 1,
    coordinatorAutoSpawnKey: 'M2',
  })
  assert.equal(secondSelection.reason, 'no-ready-tasks')
  assert.equal(secondSelection.candidates.length, 0)
}

function testMultiloopAutoRunSpawnsCoordinatorOnceWhenMilestoneDone() {
  const state = parseFixture({
    blockers: [],
    agents: {},
    tasks: [
      {
        id: 'T1',
        milestoneId: 'M2',
        role: 'developer',
        status: 'done',
        title: 'Implemented work',
      },
    ],
  })

  const firstSelection = selectMultiloopAutoRunCandidates({ state, limit: 1 })
  assert.equal(firstSelection.reason, 'all-done')
  assert.deepEqual(firstSelection.candidates.map((candidate) => candidate.agentId), ['multiloop-coordinator'])

  const secondSelection = selectMultiloopAutoRunCandidates({
    state,
    limit: 1,
    coordinatorAutoSpawnKey: 'M2',
  })
  assert.equal(secondSelection.reason, 'no-ready-tasks')
  assert.equal(secondSelection.candidates.length, 0)
}

function testMultiloopAutoRunSelectsLinkedSprintEngineTask() {
  const state = parseFixture({
    blockers: [],
    agents: {},
    roadmap: [
      baseMultiloopState().roadmap[0],
      {
        ...baseMultiloopState().roadmap[1],
        sprintEngine: {
          teamSlug: 'fixture-loop-m2',
          statePath: '.multi-code/sprintengine/fixture-loop-m2/run.yaml',
          planPath: '.multi-code/sprintengine/fixture-loop-m2/plan.md',
        },
      },
    ],
    tasks: [
      {
        id: 'legacy-task',
        milestoneId: 'M2',
        role: 'developer',
        status: 'ready',
        title: 'Legacy task should not drive linked execution',
      },
    ],
  })
  const linkedSprintEngineState = sprintEngineFixture({
    sprintengine: {
      name: 'Fixture Loop M2',
      goal: 'Execute linked work.',
    },
    agents: {
      developer: { role: 'developer', status: 'idle', currentTaskId: null },
    },
    tasks: [
      {
        id: 'S1',
        title: 'Linked implementation',
        description: '',
        role: 'developer',
        status: 'todo',
        ownerAgentId: null,
        dependsOn: [],
        ownedPaths: [],
        acceptanceCriteria: [],
        implementationNotes: [],
        evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
        notes: [],
        startedAt: null,
        completedAt: null,
      },
    ],
    artifacts: [],
    events: [],
  })

  const selection = selectMultiloopAutoRunCandidates({ state, linkedSprintEngineState, limit: 1 })

  assert.equal(selection.reason, 'ready')
  assert.equal(selection.candidates[0].kind, 'sprintengine-task')
  assert.deepEqual(selection.candidates.map((candidate) => candidate.agentId), ['developer'])
  assert.deepEqual(selection.candidates.map((candidate) => candidate.taskId), ['S1'])
}

function testMultiloopAutoRunSpawnsCoordinatorWhenLinkedSprintEngineDone() {
  const state = parseFixture({
    blockers: [],
    agents: {},
    roadmap: [
      baseMultiloopState().roadmap[0],
      {
        ...baseMultiloopState().roadmap[1],
        sprintEngine: {
          teamSlug: 'fixture-loop-m2',
          statePath: '.multi-code/sprintengine/fixture-loop-m2/run.yaml',
          planPath: '.multi-code/sprintengine/fixture-loop-m2/plan.md',
        },
      },
    ],
    tasks: [],
  })
  const linkedSprintEngineState = sprintEngineFixture({
    sprintengine: {
      name: 'Fixture Loop M2',
      goal: 'Execute linked work.',
    },
    agents: {},
    tasks: [
      {
        id: 'S1',
        title: 'Linked implementation',
        description: '',
        role: 'developer',
        status: 'done',
        ownerAgentId: null,
        dependsOn: [],
        ownedPaths: [],
        acceptanceCriteria: [],
        implementationNotes: [],
        evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
        notes: [],
        startedAt: null,
        completedAt: null,
      },
    ],
    artifacts: [],
    events: [],
  })

  const selection = selectMultiloopAutoRunCandidates({ state, linkedSprintEngineState, limit: 1 })

  assert.equal(selection.reason, 'all-done')
  assert.deepEqual(selection.candidates.map((candidate) => candidate.agentId), ['multiloop-coordinator'])
}

function testMultiloopAutoRunPausesForBlockersAndUnknownRoles() {
  const blockedState = parseFixture({
    agents: {},
    blockers: [
      {
        id: 'B1',
        scope: 'milestone',
        status: 'active',
        milestoneId: 'M2',
        summary: 'Needs operator input.',
      },
    ],
    tasks: [
      {
        id: 'T1',
        milestoneId: 'M2',
        role: 'developer',
        status: 'ready',
        title: 'Blocked work',
      },
    ],
  })
  const blockedSelection = selectMultiloopAutoRunCandidates({ state: blockedState, limit: 1 })
  assert.equal(blockedSelection.reason, 'blocked')
  assert.equal(blockedSelection.candidates.length, 0)

  const unknownRoleState = parseFixture({
    blockers: [],
    agents: {},
    tasks: [
      {
        id: 'T1',
        milestoneId: 'M2',
        role: 'implementor',
        status: 'ready',
        title: 'Corrupt role task',
      },
    ],
  })
  const unknownRoleSelection = selectMultiloopAutoRunCandidates({ state: unknownRoleState, limit: 1 })
  assert.equal(unknownRoleSelection.reason, 'no-ready-tasks')
  assert.deepEqual(unknownRoleSelection.skippedUnknownRoles, ['implementor'])
}

async function testMultiloopSupervisorCycleSpawnsReadyTaskThroughStore() {
  const spawns: Array<{
    sessionId: string
    cwd?: string
    cli?: AgentCli
    initialPrompt?: string
    metadata?: { kind?: string; workspaceId?: string; agentId?: string }
  }> = []
  installTestWindow({
    terminalList: async () => [],
    terminalStatus: async () => ({ processAlive: false }),
    pathExists: async () => true,
    readfile: async () => {
      throw new Error('unchanged state is allowed to fall back to the current store state')
    },
    initializeMultiloopState: async () => ({ ok: true }),
    readMultiloopPrompt: async () => ({ ok: true, prompt: 'Multiloop developer prompt.' }),
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null }),
    logDiagnostic: async (input: unknown) => input,
    terminalSpawn: async (
      sessionId: string,
      _cols: number,
      _rows: number,
      cwd?: string,
      _resume?: boolean,
      _statePath?: string,
      cli?: AgentCli,
      initialPrompt?: string,
      _cliRuntimes?: unknown,
      _shellOnly?: boolean,
      metadata?: { kind?: string; workspaceId?: string; agentId?: string },
    ) => {
      spawns.push({ sessionId, cwd, cli, initialPrompt, metadata })
      return { ok: true, sessionId }
    },
  })

  const workspace = multiloopWorkspaceFixture()
  useWorkspaceStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  })

  const cliRuntimes: Record<AgentCli, CliRuntimeSettings> = {
    codex: { command: 'codex', useWsl: false },
  }
  const mcpSettings: McpSettings = { syncEnabled: false, servers: {} }

  await superviseMultiloopAutoRunCycle(
    workspace,
    cliRuntimes,
    mcpSettings,
    mutableRef(new Set<string>()),
    mutableRef(new Map<string, string>())
  )

  const updatedWorkspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspace.id)
  assert.ok(updatedWorkspace, 'workspace remains in the store after supervisor cycle')
  assert.equal(spawns.length, 1, 'Multiloop supervisor real path starts one terminal for ready work')
  assert.equal(spawns[0].cwd, '/tmp/multiloop-workspace')
  assert.equal(spawns[0].cli, 'codex')
  assert.equal(spawns[0].metadata?.kind, 'agent')
  assert.equal(spawns[0].metadata?.workspaceId, workspace.id)
  assert.equal(spawns[0].metadata?.agentId, 'multiloop-developer')
  assert.match(spawns[0].initialPrompt ?? '', /Multiloop developer prompt\./)
  assert.match(spawns[0].initialPrompt ?? '', /Ready tasks for this role: T-ready/)
  assert.deepEqual(
    updatedWorkspace.multiloopAutoState.pendingSpawns.map((pending) => ({
      agentId: pending.agentId,
      taskId: pending.taskId,
      role: pending.role,
    })),
    [{ agentId: 'multiloop-developer', taskId: 'T-ready', role: 'developer' }],
    'supervisor cycle records the pending spawn through the workspace store',
  )
  assert.equal(updatedWorkspace.agents['multiloop-developer']?.cliStartRequested, true)
  assert.equal(updatedWorkspace.agents['multiloop-developer']?.cliHasLaunched, true)
  assert.equal(updatedWorkspace.agents['multiloop-developer']?.kind, 'multiloop')
}

async function testMultiloopWorkspaceCreationOpensParsedState() {
  const state = baseMultiloopState()
  const initializedPath = 'C:\\repo\\multiloop\\creation-loop\\state.json'
  const result = await createMultiloopWorkspace({
    rootPath: ' C:\\repo ',
    loopName: ' Creation Loop ',
    finalGoal: ' Validate M6 creation. ',
    initializeState: async (input) => {
      assert.deepEqual(input, {
        workspaceRoot: 'C:\\repo',
        loopName: 'Creation Loop',
        finalGoal: 'Validate M6 creation.',
      })
      return {
        ok: true,
        data: {
          workspaceRoot: 'C:\\repo',
          created: true,
          loopName: 'Creation Loop',
          loopSlug: 'creation-loop',
          loopDirectory: 'C:\\repo\\multiloop\\creation-loop',
          statePath: initializedPath,
        },
      }
    },
    readFile: async (path) => {
      assert.equal(path, initializedPath)
      return JSON.stringify(state)
    },
  })

  assert.equal(result.created, true)
  assert.equal(result.context.loopName, 'Creation Loop')
  assert.equal(result.context.loopSlug, 'creation-loop')
  assert.equal(result.context.statePath, initializedPath)
  assert.equal(result.state.loop.finalGoal, 'Ship a milestone-first Multiloop board.')
  assert.equal(getActiveMultiloopMilestone(result.state)?.id, 'M2')
}

async function testMultiloopWorkspaceCreationRejectsInvalidInputBeforeIpc() {
  let initializeCalls = 0

  await assert.rejects(
    createMultiloopWorkspace({
      rootPath: 'C:\\repo',
      loopName: ' ',
      finalGoal: 'Validate errors.',
      initializeState: async () => {
        initializeCalls += 1
        throw new Error('initialize should not be called')
      },
      readFile: async () => JSON.stringify(baseMultiloopState()),
    }),
    (error) => error instanceof MultiloopWorkspaceCreationError && error.message === 'Enter a loop name.'
  )

  assert.equal(initializeCalls, 0)
}

async function testMultiloopWorkspaceCreationPreservesTypedParseError() {
  let surfacedError: MultiloopWorkspaceCreationError | null = null
  try {
    await createMultiloopWorkspace({
      rootPath: 'C:\\repo',
      loopName: 'Creation Loop',
      finalGoal: 'Validate typed parse error preservation.',
      initializeState: async () => ({
        ok: true,
        data: {
          workspaceRoot: 'C:\\repo',
          created: true,
          loopName: 'Creation Loop',
          loopSlug: 'creation-loop',
          loopDirectory: 'C:\\repo\\multiloop\\creation-loop',
          statePath: 'C:\\repo\\multiloop\\creation-loop\\state.json',
        },
      }),
      // Malformed JSON exercises parseMultiloopStateFileContent → MultiloopStateDisplayError.
      readFile: async () => '{not valid json',
    })
  } catch (error) {
    if (error instanceof MultiloopWorkspaceCreationError) surfacedError = error
    else throw error
  }
  assert.ok(surfacedError, 'createMultiloopWorkspace must reject parse failures via MultiloopWorkspaceCreationError')
  const displayError = surfacedError.displayError
  assert.ok(displayError, 'parse failure must carry the original typed MultiloopStateDisplayError')
  assert.ok(
    typeof displayError.title === 'string' && displayError.title.length > 0,
    'display error must keep the parser-specific title (not be flattened to a string-only payload)'
  )
  assert.notEqual(
    displayError.title,
    'Missing Multiloop state',
    'parse-error title must not be collapsed into the IO-error title used for read failures'
  )
}

async function testLoadRunWorkspaceStateRoutesEachKindThroughItsParser() {
  // Multiloop parser path: invalid JSON propagates the typed display error via RunWorkspaceStateParseError.
  let multiloopError: RunWorkspaceStateParseError<MultiloopStateDisplayError> | null = null
  try {
    await loadRunWorkspaceState<unknown, MultiloopStateDisplayError>({
      kind: 'multiloop',
      rootPath: 'C:\\repo',
      name: 'Parser Loop',
      readFile: async () => '{not json',
      parser: parseMultiloopStateFileContent,
    })
  } catch (error) {
    if (error instanceof RunWorkspaceStateParseError) {
      multiloopError = error as RunWorkspaceStateParseError<MultiloopStateDisplayError>
    } else {
      throw error
    }
  }
  assert.ok(multiloopError, 'loadRunWorkspaceState must throw RunWorkspaceStateParseError for parser failures')
  assert.ok(typeof multiloopError.cause.title === 'string')
  assert.ok(multiloopError.cause.title.length > 0, 'Multiloop parser preserves its display-error title')

  // Sprint Engine parser path: same helper accepts a different parser and yields a sprintengine state.
  const seState = sprintEngineFixture({ sprintengine: { name: 'Parser Run' } })
  const projection = JSON.stringify({
    ok: true,
    projectionVersion: 1,
    source: 'folder_store',
    generatedAt: null,
    updatedAt: null,
    run: {
      id: 'parser-run',
      name: 'Parser Run',
      goal: '',
      status: 'executing',
      rosterConfigured: true,
      updatedAt: null,
    },
    roster: {},
    tasks: [],
    artifacts: [],
    activity: [],
  })
  const sprintEngineParser = (raw: string): { ok: true; state: typeof seState } | { ok: false; error: { message: string } } => {
    try {
      const decoded = JSON.parse(raw)
      const state = normalizeSprintEngineProjection(decoded, 'Parser Run')
      return state ? { ok: true, state } : { ok: false, error: { message: 'malformed projection' } }
    } catch (error) {
      return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
    }
  }
  const result = await loadRunWorkspaceState({
    kind: 'sprintengine',
    rootPath: 'C:\\repo',
    name: 'Parser Run',
    readFile: async () => projection,
    parser: sprintEngineParser,
  })
  assert.equal(result.state.name, 'Parser Run')
  // Context derivation matches the kind config: Sprint Engine state lives under .multi-code/sprintengine.
  assert.ok(result.context.statePath.includes('.multi-code'))
  assert.ok(result.context.statePath.endsWith('run.yaml'))
}

function testBuildRunWorkspaceContextProducesKindSpecificPaths() {
  const sprintEngineContext = buildRunWorkspaceContext({
    kind: 'sprintengine',
    rootPath: 'C:\\repo',
    name: 'Demo Team',
  })
  assert.equal(sprintEngineContext.slug, 'demo-team')
  assert.ok(sprintEngineContext.statePath.includes('.multi-code'))
  assert.ok(sprintEngineContext.statePath.endsWith('run.yaml'))

  const multiloopContext = buildRunWorkspaceContext({
    kind: 'multiloop',
    rootPath: 'C:\\repo',
    name: 'Demo Loop',
  })
  assert.equal(multiloopContext.slug, 'demo-loop')
  assert.ok(!multiloopContext.statePath.includes('.multi-code'), 'Multiloop root is not nested under .multi-code')
  assert.ok(multiloopContext.statePath.endsWith('state.json'))
}

async function testMultiloopWorkspaceCreationSurfacesExistingStateFailure() {
  await assert.rejects(
    createMultiloopWorkspace({
      rootPath: 'C:\\repo',
      loopName: 'Creation Loop',
      finalGoal: 'Validate errors.',
      initializeState: async () => ({
        ok: false,
        message: 'A different Multiloop state already exists for this loop path.',
      }),
      readFile: async () => {
        throw new Error('read should not be called')
      },
    }),
    (error) => error instanceof MultiloopWorkspaceCreationError
      && error.message === 'A different Multiloop state already exists for this loop path.'
  )
}

function testSetMultiloopStatePreservesExistingLayoutModel() {
  const state = parseFixture()
  const workspaceId = useWorkspaceStore.getState().addWorkspace(createMultiloopTemplate(), {
    name: 'Live Refresh Layout',
    folderPath: 'C:\\repo',
    multiloopState: state,
  })
  const customLayout: IJsonModel = {
    global: { tabSetEnableDrop: true, tabEnableClose: true },
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          weight: 68,
          children: [
            { type: 'tab', name: 'Active Loop', component: 'multiloop-board' },
          ],
        },
        {
          type: 'tabset',
          weight: 32,
          children: [
            { type: 'tab', name: 'Notes', component: 'editor' },
          ],
        },
      ],
    },
  }

  try {
    useWorkspaceStore.getState().updateLayout(workspaceId, customLayout)

    const refreshedState = {
      ...state,
      loop: {
        ...state.loop,
        finalGoal: 'Ship a milestone-first Multiloop board with stable refreshes.',
        updatedAt: '2026-05-03T10:00:00Z',
      },
    }
    useWorkspaceStore.getState().setMultiloopState(workspaceId, refreshedState)

    const workspace = useWorkspaceStore.getState().workspaces.find((entry) => entry.id === workspaceId)
    assert.ok(workspace)
    assert.deepEqual(workspace.layoutModel, customLayout)
    assert.equal(
      workspace.multiloopState?.loop.finalGoal,
      'Ship a milestone-first Multiloop board with stable refreshes.'
    )
  } finally {
    useWorkspaceStore.getState().removeWorkspace(workspaceId)
  }
}

async function testSprintEngineWorkspaceCreationRegressionKeepsSprintEngineModeAndPrompt() {
  const beforeIds = new Set(useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id))
  const result = await createPlanSourcedSprintEngineWorkspace({
    rootPath: 'C:\\repo',
    teamName: 'Regression SprintEngine',
    goal: 'Keep sprintengine creation stable.',
    sourcePath: 'future-plans/regression.md',
    sourceContent: '# Regression Plan',
    sourcePlanKind: 'architect_plan',
    pathExists: async (path) => {
      assert.equal(path, 'C:\\repo\\.multi-code\\sprintengine\\regression-sprintengine\\run.yaml')
      return false
    },
  })
  const createdWorkspace = useWorkspaceStore.getState().workspaces.find((workspace) => !beforeIds.has(workspace.id))

  assert.ok(createdWorkspace)
  assert.equal(createdWorkspace.id, result.workspaceId)
  assert.equal(createdWorkspace.name, 'Regression SprintEngine')
  assert.equal(createdWorkspace.mode, 'sprintengine')
  assert.equal(createdWorkspace.sprintEngineContext?.teamSlug, 'regression-sprintengine')
  assert.equal(createdWorkspace.multiloopContext, null)
  assert.equal(createdWorkspace.sprintEngineState?.name, 'Regression SprintEngine')
  assert.equal(createdWorkspace.agents[result.architectAgentId].cliStartupPrompt?.includes('sprintengine.handover'), true)
  assert.equal(createdWorkspace.agents[result.architectAgentId].cliStartupPrompt?.includes('"sourcePlanKind": "architect_plan"'), true)
  assert.equal(createdWorkspace.agents[result.architectAgentId].cliStartupPrompt?.includes('multiloop'), false)
}

async function testSprintEngineWorkspaceCreationSupportsHtmlOnlySourceBundle() {
  const beforeIds = new Set(useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id))
  const result = await createPlanSourcedSprintEngineWorkspace({
    rootPath: 'C:\\repo',
    teamName: 'HTML Mockups',
    goal: 'Create UI tasks from approved mockups.',
    sourcePath: 'future-plans/mockup.html',
    sourceContent: '<!doctype html><title>Mockup</title>',
    sourcePlanKind: 'unknown',
    sourceBundle: [
      {
        kind: 'html_mockup',
        sourcePath: 'C:\\repo\\future-plans\\mockup.html',
        sourceRelativePath: 'future-plans/mockup.html',
        sourceContent: '<!doctype html><title>Mockup</title>',
      },
    ],
    pathExists: async (path) => {
      assert.equal(path, 'C:\\repo\\.multi-code\\sprintengine\\html-mockups\\run.yaml')
      return false
    },
  })
  const createdWorkspace = useWorkspaceStore.getState().workspaces.find((workspace) => !beforeIds.has(workspace.id))
  const prompt = createdWorkspace?.agents[result.architectAgentId].cliStartupPrompt ?? ''

  assert.ok(createdWorkspace)
  assert.equal(prompt.includes('"handoverPath": "future-plans/mockup.html"'), true)
  assert.equal(prompt.includes('"sourcePath": "future-plans/mockup.html"'), true)
  assert.equal(prompt.includes('C:\\\\repo\\\\future-plans\\\\mockup.html'), false)
  assert.equal(prompt.includes('"kind": "html_mockup"'), true)
  assert.equal(prompt.includes('Source bundle type: HTML mockup.'), true)
  assert.equal(prompt.includes('Source plan type: generic handoff.'), false)
}

async function testSprintEngineWorkspaceCreationAutoRunPromptContinuesToJoin() {
  const beforeIds = new Set(useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id))
  const result = await createPlanSourcedSprintEngineWorkspace({
    rootPath: 'C:\\repo',
    teamName: 'Auto Run Sprint',
    goal: 'Start architect planning automatically.',
    sourcePath: 'future-plans/auto.md',
    sourceContent: '# Auto Run Plan',
    sourcePlanKind: 'architect_plan',
    sprintEngineAutoState: {
      desiredMode: 'run_agents_and_approve_artifacts',
      runtimeState: 'running',
    },
    pathExists: async (path) => {
      assert.equal(path, 'C:\\repo\\.multi-code\\sprintengine\\auto-run-sprint\\run.yaml')
      return false
    },
  })
  const createdWorkspace = useWorkspaceStore.getState().workspaces.find((workspace) => !beforeIds.has(workspace.id))
  const prompt = createdWorkspace?.agents[result.architectAgentId].cliStartupPrompt ?? ''

  assert.ok(createdWorkspace)
  assert.equal(prompt.includes('Multicode app owns runner policy'), true)
  assert.equal(prompt.includes('sprintengine.agent.join'), true)
  assert.equal(prompt.includes('sprintengine.task.next'), true)
  assert.equal(prompt.includes('sprintengine.agent.next_directive'), false)
  assert.equal(prompt.includes('"role": "architect"'), true)
  assert.equal(prompt.includes('"agentId": "architect"'), true)
  assert.equal(prompt.includes('creates the first architect task'), true)
  assert.equal(createdWorkspace.sprintEngineAutoState?.desiredMode, 'run_agents_and_approve_artifacts')
  assert.equal(createdWorkspace.sprintEngineAutoState?.runtimeState, 'running')
}

async function testSprintEngineWorkspaceCreationGuidesSingleContextBundle() {
  const beforeIds = new Set(useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id))
  const result = await createPlanSourcedSprintEngineWorkspace({
    rootPath: 'C:\\repo',
    teamName: 'Context Source',
    goal: 'Clarify context before planning.',
    sourcePath: 'future-plans/context.html',
    sourceContent: '<!doctype html><title>Context</title>',
    sourcePlanKind: 'unknown',
    sourceBundle: [
      {
        kind: 'generic_context',
        sourcePath: 'C:\\repo\\future-plans\\context.html',
        sourceRelativePath: 'future-plans/context.html',
        sourceContent: '<!doctype html><title>Context</title>',
      },
    ],
    pathExists: async (path) => {
      assert.equal(path, 'C:\\repo\\.multi-code\\sprintengine\\context-source\\run.yaml')
      return false
    },
  })
  const createdWorkspace = useWorkspaceStore.getState().workspaces.find((workspace) => !beforeIds.has(workspace.id))
  const prompt = createdWorkspace?.agents[result.architectAgentId].cliStartupPrompt ?? ''

  assert.ok(createdWorkspace)
  assert.equal(prompt.includes('"handoverPath": "future-plans/context.html"'), true)
  assert.equal(prompt.includes('"sourcePath": "future-plans/context.html"'), true)
  assert.equal(prompt.includes('C:\\\\repo\\\\future-plans\\\\context.html'), false)
  assert.equal(prompt.includes('"kind": "generic_context"'), true)
  assert.equal(prompt.includes('Source bundle type: context.'), true)
  assert.equal(prompt.includes('Source bundle type: mixed sources.'), false)
}

async function testSprintEngineWorkspaceCreationGuidesMixedContextBundle() {
  const beforeIds = new Set(useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id))
  const result = await createPlanSourcedSprintEngineWorkspace({
    rootPath: 'C:\\repo',
    teamName: 'Mockup Context',
    goal: 'Plan from mockup and design context.',
    sourcePath: 'future-plans/mockup.html',
    sourceContent: '<!doctype html><title>Mockup</title>',
    sourcePlanKind: 'unknown',
    sourceBundle: [
      {
        kind: 'html_mockup',
        sourcePath: 'C:\\repo\\future-plans\\mockup.html',
        sourceRelativePath: 'future-plans/mockup.html',
        sourceContent: '<!doctype html><title>Mockup</title>',
      },
      {
        kind: 'design_notes',
        sourcePath: 'C:\\repo\\future-plans\\design.md',
        sourceRelativePath: 'future-plans/design.md',
        sourceContent: '# Design Notes',
      },
    ],
    pathExists: async (path) => {
      assert.equal(path, 'C:\\repo\\.multi-code\\sprintengine\\mockup-context\\run.yaml')
      return false
    },
  })
  const createdWorkspace = useWorkspaceStore.getState().workspaces.find((workspace) => !beforeIds.has(workspace.id))
  const prompt = createdWorkspace?.agents[result.architectAgentId].cliStartupPrompt ?? ''

  assert.ok(createdWorkspace)
  assert.equal(prompt.includes('Source bundle type: mixed context sources.'), true)
  assert.equal(prompt.includes('seed canonical files from product and implementation plan sources'), false)
}

type MultiloopSynchronizerTestHarness = {
  restore: () => void
  capturedEvents: MultiloopStateSyncEventDetail[]
}

function installMultiloopSynchronizerTestWindow(
  readFile: (path: string) => Promise<string>
): MultiloopSynchronizerTestHarness {
  if (typeof (globalThis as { CustomEvent?: unknown }).CustomEvent === 'undefined') {
    class CustomEventPolyfill<T> extends Event {
      detail: T
      constructor(type: string, init?: { detail?: T; bubbles?: boolean; cancelable?: boolean }) {
        super(type, init)
        this.detail = init?.detail as T
      }
    }
    ;(globalThis as { CustomEvent?: unknown }).CustomEvent = CustomEventPolyfill
  }
  const previousWindow = (globalThis as { window?: unknown }).window
  const target = new EventTarget()
  const capturedEvents: MultiloopStateSyncEventDetail[] = []
  const captureListener = (event: Event): void => {
    capturedEvents.push((event as CustomEvent<MultiloopStateSyncEventDetail>).detail)
  }
  target.addEventListener(MULTILOOP_STATE_SYNC_EVENT, captureListener)
  const win = {
    api: { readfile: readFile },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  }
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true })
  return {
    capturedEvents,
    restore: () => {
      target.removeEventListener(MULTILOOP_STATE_SYNC_EVENT, captureListener)
      if (previousWindow === undefined) {
        delete (globalThis as { window?: unknown }).window
      } else {
        Object.defineProperty(globalThis, 'window', {
          value: previousWindow,
          configurable: true,
          writable: true,
        })
      }
    },
  }
}

function expectErrorSnapshot(snapshot: MultiloopStateSyncEventDetail | null): MultiloopStateDisplayError {
  assert.ok(snapshot, 'Multiloop synchronizer must store a snapshot after a failed read')
  assert.equal(snapshot.status, 'error', 'snapshot must carry status=error for failures')
  if (snapshot.status !== 'error') throw new Error('unreachable')
  return snapshot.error
}

async function testMultiloopSynchronizerParseErrorEventPreservesJsonParserTitle() {
  const harness = installMultiloopSynchronizerTestWindow(async () => '{not valid json')
  try {
    const workspaceId = 'multiloop-sync-test-parse-json'
    const statePath = 'C:\\repo\\multiloop\\fixture-loop\\state.json'

    const result = await multiloopStateSynchronizerConfig.read(statePath, 'fixture-loop')
    assert.equal(result.ok, false, 'malformed JSON must not produce a successful Multiloop read')
    assert.equal(
      result.ok === false ? result.kind : null,
      'parse',
      'malformed JSON must be classified as a parser failure, not an IO failure'
    )
    if (result.ok || result.kind !== 'parse') throw new Error('unreachable')

    multiloopStateSynchronizerConfig.onParseError?.({ workspaceId, statePath, error: result.error })

    const snapshotError = expectErrorSnapshot(getMultiloopStateSyncSnapshot(workspaceId))
    assert.equal(
      snapshotError.title,
      'Invalid Multiloop JSON',
      'parse-error snapshot must preserve the parser-specific title'
    )
    assert.notEqual(
      snapshotError.title,
      'Missing Multiloop state',
      'parse-error snapshot must not collapse to the IO-error title'
    )

    assert.equal(harness.capturedEvents.length, 1, 'one MULTILOOP_STATE_SYNC_EVENT must fire per parse failure')
    const dispatched = harness.capturedEvents[0]
    assert.equal(dispatched.status, 'error')
    if (dispatched.status !== 'error') throw new Error('unreachable')
    assert.equal(dispatched.error.title, 'Invalid Multiloop JSON')
    assert.equal(dispatched.statePath, statePath)
  } finally {
    harness.restore()
  }
}

async function testMultiloopSynchronizerParseErrorEventPreservesInvalidStateTitle() {
  // Structurally invalid Multiloop state: JSON-parsable but fails the schema.
  const invalidStateJson = JSON.stringify({ ...baseMultiloopState(), tasks: [{ id: 'bad' }] })
  const harness = installMultiloopSynchronizerTestWindow(async () => invalidStateJson)
  try {
    const workspaceId = 'multiloop-sync-test-parse-state'
    const statePath = 'C:\\repo\\multiloop\\fixture-loop\\state.json'

    const result = await multiloopStateSynchronizerConfig.read(statePath, 'fixture-loop')
    assert.equal(result.ok, false, 'invalid Multiloop state must not produce a successful read')
    assert.equal(
      result.ok === false ? result.kind : null,
      'parse',
      'schema-invalid state must be classified as parser failure, not IO'
    )
    if (result.ok || result.kind !== 'parse') throw new Error('unreachable')

    multiloopStateSynchronizerConfig.onParseError?.({ workspaceId, statePath, error: result.error })

    const snapshotError = expectErrorSnapshot(getMultiloopStateSyncSnapshot(workspaceId))
    assert.equal(snapshotError.title, 'Invalid Multiloop state')
    assert.match(
      snapshotError.message,
      /\$\.tasks\[0\]\.milestoneId/,
      'parser path metadata must survive the synchronizer dispatch'
    )

    assert.equal(harness.capturedEvents.length, 1)
    const dispatched = harness.capturedEvents[0]
    if (dispatched.status !== 'error') throw new Error('unreachable')
    assert.equal(dispatched.error.title, 'Invalid Multiloop state')
    assert.match(dispatched.error.message, /\$\.tasks\[0\]\.milestoneId/)
  } finally {
    harness.restore()
  }
}

async function testMultiloopSynchronizerIoErrorEventUsesMissingTitle() {
  const harness = installMultiloopSynchronizerTestWindow(async () => {
    throw new Error('ENOENT: no such file or directory')
  })
  try {
    const workspaceId = 'multiloop-sync-test-io'
    const statePath = 'C:\\repo\\multiloop\\fixture-loop\\state.json'

    const result = await multiloopStateSynchronizerConfig.read(statePath, 'fixture-loop')
    assert.equal(result.ok, false)
    assert.equal(
      result.ok === false ? result.kind : null,
      'io',
      'readfile failures must be classified as IO, not parser, failures'
    )
    if (result.ok || result.kind !== 'io') throw new Error('unreachable')

    multiloopStateSynchronizerConfig.onReadError?.({ workspaceId, statePath, message: result.message })

    const snapshotError = expectErrorSnapshot(getMultiloopStateSyncSnapshot(workspaceId))
    assert.equal(
      snapshotError.title,
      'Missing Multiloop state',
      'IO failures must keep the existing Missing Multiloop state title'
    )
    assert.match(snapshotError.message, /ENOENT/)

    assert.equal(harness.capturedEvents.length, 1)
    const dispatched = harness.capturedEvents[0]
    if (dispatched.status !== 'error') throw new Error('unreachable')
    assert.equal(dispatched.error.title, 'Missing Multiloop state')
  } finally {
    harness.restore()
  }
}

function testSourcePlanKindInferencePrefersSpecificProductSignals() {
  assert.equal(inferSourcePlanKind('future-plans/product-plan.md', '# Roadmap\n'), 'product_plan')
  assert.equal(inferSourcePlanKind('future-plans/implementation-plan.md', '# Roadmap\n'), 'architect_plan')
  assert.equal(inferSourcePlanKind('future-plans/tech-spec.md', '# Roadmap\n'), 'architect_plan')
  assert.equal(inferSourcePlanKind('future-plans/architecture-spec.md', '# Roadmap\n'), 'architect_plan')
  assert.equal(inferSourcePlanKind('future-plans/product-spec.md', '# Roadmap\n'), 'product_plan')
  assert.equal(inferSourcePlanKind('future-plans/plan.md', '# Roadmap\n'), 'unknown')
  assert.equal(inferSourcePlanKind('future-plans/brief.md', '# Implementation Plan\n'), 'product_plan')
}

testValidBlockedAndAcceptedHistoryFixtures()
testMilestoneSprintEngineLinkParsingAndExecutionMapping()
testLinkedMilestoneDoesNotFallbackToLegacyTasksWhenStateMissing()
testActiveMilestoneFilteringAndSignals()
testMalformedFixtureIsRejectedWithDisplayError()
testRendererPromptContextRedactsSensitiveStateText()
testRendererPromptContextBoundsStateDerivedFields()
testRendererSanitizerMirrorsCoreSecretPatterns()
testMultiloopAutoRunSelectsReadyDeveloperTask()
testMultiloopAutoRunSelectsTodoTaskWithDoneDependencies()
testMultiloopAutoRunAvoidsDuplicateRunningRole()
testMultiloopAutoRunSpawnsCoordinatorWhenActiveMilestoneNeedsPlanning()
testMultiloopAutoRunSpawnsCoordinatorOnceWhenMilestoneDone()
testMultiloopAutoRunSelectsLinkedSprintEngineTask()
testMultiloopAutoRunSpawnsCoordinatorWhenLinkedSprintEngineDone()
testMultiloopAutoRunPausesForBlockersAndUnknownRoles()
testSetMultiloopStatePreservesExistingLayoutModel()
testSourcePlanKindInferencePrefersSpecificProductSignals()

testBuildRunWorkspaceContextProducesKindSpecificPaths()

void (async () => {
  await testMultiloopWorkspaceCreationOpensParsedState()
  await testMultiloopWorkspaceCreationRejectsInvalidInputBeforeIpc()
  await testMultiloopWorkspaceCreationSurfacesExistingStateFailure()
  await testMultiloopWorkspaceCreationPreservesTypedParseError()
  await testLoadRunWorkspaceStateRoutesEachKindThroughItsParser()
  await testMultiloopSynchronizerParseErrorEventPreservesJsonParserTitle()
  await testMultiloopSynchronizerParseErrorEventPreservesInvalidStateTitle()
  await testMultiloopSynchronizerIoErrorEventUsesMissingTitle()
  await testMultiloopSupervisorCycleSpawnsReadyTaskThroughStore()
  await testSprintEngineWorkspaceCreationRegressionKeepsSprintEngineModeAndPrompt()
  await testSprintEngineWorkspaceCreationSupportsHtmlOnlySourceBundle()
  await testSprintEngineWorkspaceCreationAutoRunPromptContinuesToJoin()
  await testSprintEngineWorkspaceCreationGuidesSingleContextBundle()
  await testSprintEngineWorkspaceCreationGuidesMixedContextBundle()
})()
