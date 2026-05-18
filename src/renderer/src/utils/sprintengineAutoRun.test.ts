import assert from 'node:assert/strict'
import {
  getActiveSprintEngineAutoRunGateClaims,
  getClaimableSprintEngineAutoRunGates,
  isSprintEngineAutoPendingSpawnStillRelevant,
  sprintEngineAutoRunWorkKey,
} from './sprintengineAutoRun'
import type { SprintEngineTask } from '../types/workspace'

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
testReviewPhaseOnlyExposesReviewGates()
testPendingGateRelevanceIsGateSpecific()
testActiveGateClaimCanBeResumed()
testTestingPhaseExposesTesterAfterReviewApproval()
