import assert from 'node:assert/strict'
import {
  agentOwnsOpenSprintEngineImplementationWork,
  getActiveSprintEngineAutoRunGateClaims,
  getClaimableSprintEngineAutoRunGates,
  getSprintEngineAutoRunOccupiedAgentIds,
  isSprintEngineAutoPendingSpawnStillRelevant,
  shouldSkipExitedSprintEngineRosterAgent,
  sprintEngineAutoRunWorkKey,
} from './sprintengineAutoRun'
import type { SprintEngineState, SprintEngineTask } from '../types/workspace'

function task(overrides: Partial<SprintEngineTask> = {}): SprintEngineTask {
  return {
    id: 'T3',
    title: 'Scaffold site',
    description: '',
    role: 'developer',
    status: 'review',
    ownerAgentId: 'developer-1',
    dependsOn: [],
    ownedPaths: [],
    acceptanceCriteria: [],
    implementationNotes: [],
    evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
    notes: [],
    comments: [],
    startedAt: null,
    completedAt: null,
    boardColumn: 'review',
    qualityGates: [
      { id: 'code_reviewer', phase: 'review', role: 'code_reviewer', status: 'pending', required: true, allowSelfReview: true, focus: '', attempts: [] },
      { id: 'spec_reviewer', phase: 'review', role: 'spec_reviewer', status: 'pending', required: true, allowSelfReview: true, focus: '', attempts: [] },
      { id: 'tester', phase: 'testing', role: 'tester', status: 'pending', required: true, allowSelfReview: true, focus: '', attempts: [] },
    ],
    ...overrides,
  }
}

function testWorkKeysSeparateTaskAndGateSpawns() {
  assert.equal(sprintEngineAutoRunWorkKey({ taskId: 'T3' }), 'task:T3')
  assert.equal(sprintEngineAutoRunWorkKey({ taskId: 'T3', gateId: 'code_reviewer' }), 'gate:T3:code_reviewer')
  assert.notEqual(
    sprintEngineAutoRunWorkKey({ taskId: 'T3', gateId: 'code_reviewer' }),
    sprintEngineAutoRunWorkKey({ taskId: 'T3', gateId: 'spec_reviewer' })
  )
}

function sprintEngineStateFixture(overrides: Partial<SprintEngineState> = {}): SprintEngineState {
  return {
    name: 'Auto Run Test',
    goal: 'Ship reliable Sprint Engine auto-run',
    tasks: [],
    artifacts: [],
    events: [],
    roleCounts: { architect: 1, product: 0, developer: 1, frontend: 1, tester: 1, security: 0, code_reviewer: 1, spec_reviewer: 1, performance: 0 },
    sprintEngineAgents: {},
    runner: { mode: 'auto', pollIntervalSeconds: 2, idleBackoffSeconds: 5, maxBackoffSeconds: 30, stopWhenComplete: true },
    ...overrides,
  }
}

function testAgentOwnsOpenSprintEngineImplementationWorkDetectsRework() {
  const state = sprintEngineStateFixture({
    tasks: [
      task({ id: 'T1', status: 'changes_requested', ownerAgentId: 'frontend', role: 'frontend' }),
      task({ id: 'T2', status: 'needs_input', ownerAgentId: 'developer-1', role: 'developer' }),
      task({ id: 'T3', status: 'done', ownerAgentId: 'tester', role: 'tester' }),
    ],
  })

  assert.equal(agentOwnsOpenSprintEngineImplementationWork(state, 'frontend'), true)
  assert.equal(agentOwnsOpenSprintEngineImplementationWork(state, 'developer-1'), false)
  assert.equal(agentOwnsOpenSprintEngineImplementationWork(state, 'tester'), false)
}

function testShouldSkipExitedSprintEngineRosterAgentAllowsOwnedReworkRestart() {
  const exitedAgent = {
    kind: 'sprintengine' as const,
    cliLastExitedAt: Date.now(),
    cliStartRequested: false,
    cliHasLaunched: false,
  }

  assert.equal(
    shouldSkipExitedSprintEngineRosterAgent(exitedAgent, false),
    true,
    'exited idle roster agents without owned work remain skipped'
  )
  assert.equal(
    shouldSkipExitedSprintEngineRosterAgent(exitedAgent, true),
    false,
    'exited owners with open implementation work are eligible for restart'
  )
}

function testGetSprintEngineAutoRunOccupiedAgentIdsCountsChangesRequestedOwners() {
  const occupiedAgentIds = getSprintEngineAutoRunOccupiedAgentIds({
    tasks: [
      task({ id: 'T1', status: 'changes_requested', ownerAgentId: 'frontend', role: 'frontend' }),
      task({ id: 'T2', status: 'in_progress', ownerAgentId: 'developer-1', role: 'developer' }),
      task({ id: 'T3', status: 'review', ownerAgentId: 'code-reviewer', role: 'developer' }),
    ],
    pendingSpawns: [{ taskId: 'T4', agentId: 'tester', startedAt: 1 }],
    inFlightSpawnKeys: new Set(['workspace-1:spec-reviewer', 'other-workspace:security']),
    workspaceId: 'workspace-1',
  })

  assert.deepEqual(
    [...occupiedAgentIds].sort(),
    ['developer-1', 'frontend', 'spec-reviewer', 'tester'],
    'changes_requested owners occupy global auto-run concurrency slots'
  )
}

function testReviewPhaseOnlyExposesReviewGates() {
  const gates = getClaimableSprintEngineAutoRunGates(task(), [task()])
  assert.deepEqual(gates.map((gate) => gate.id), ['code_reviewer', 'spec_reviewer'])
}

function testPendingGateRelevanceIsGateSpecific() {
  const reviewTask = task()
  assert.equal(
    isSprintEngineAutoPendingSpawnStillRelevant(
      { taskId: 'T3', gateId: 'code_reviewer', agentId: 'code_reviewer' },
      reviewTask,
      [reviewTask]
    ),
    true
  )
  assert.equal(
    isSprintEngineAutoPendingSpawnStillRelevant(
      { taskId: 'T3', gateId: 'tester', agentId: 'tester-1' },
      reviewTask,
      [reviewTask]
    ),
    false
  )
}

function testActiveGateClaimCanBeResumed() {
  const reviewTask = task({
    qualityGates: [
      {
        id: 'code_reviewer',
        phase: 'review',
        role: 'code_reviewer',
        status: 'in_progress',
        required: true,
        allowSelfReview: true,
        focus: '',
        attempts: [{ id: 'GA-001', status: 'in_progress', role: 'code_reviewer', claimedBy: 'code_reviewer', startedAt: '2026-05-17T14:03:34Z' }],
      },
      { id: 'spec_reviewer', phase: 'review', role: 'spec_reviewer', status: 'pending', required: true, allowSelfReview: true, focus: '', attempts: [] },
    ],
  })
  const claims = getActiveSprintEngineAutoRunGateClaims(reviewTask, [reviewTask])
  assert.deepEqual(claims.map((claim) => [claim.gate.id, claim.claimedBy]), [['code_reviewer', 'code_reviewer']])
}

function testTestingPhaseExposesTesterAfterReviewApproval() {
  const testingTask = task({
    status: 'testing',
    boardColumn: 'testing',
    qualityGates: [
      { id: 'code_reviewer', phase: 'review', role: 'code_reviewer', status: 'approved', required: true, allowSelfReview: true, focus: '', attempts: [] },
      { id: 'spec_reviewer', phase: 'review', role: 'spec_reviewer', status: 'approved', required: true, allowSelfReview: true, focus: '', attempts: [] },
      { id: 'tester', phase: 'testing', role: 'tester', status: 'pending', required: true, allowSelfReview: true, focus: '', attempts: [] },
    ],
  })
  const gates = getClaimableSprintEngineAutoRunGates(testingTask, [testingTask])
  assert.deepEqual(gates.map((gate) => gate.id), ['tester'])
}

testWorkKeysSeparateTaskAndGateSpawns()
testAgentOwnsOpenSprintEngineImplementationWorkDetectsRework()
testShouldSkipExitedSprintEngineRosterAgentAllowsOwnedReworkRestart()
testGetSprintEngineAutoRunOccupiedAgentIdsCountsChangesRequestedOwners()
testReviewPhaseOnlyExposesReviewGates()
testPendingGateRelevanceIsGateSpecific()
testActiveGateClaimCanBeResumed()
testTestingPhaseExposesTesterAfterReviewApproval()
