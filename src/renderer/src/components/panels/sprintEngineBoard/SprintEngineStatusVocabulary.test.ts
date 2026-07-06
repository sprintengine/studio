import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SOURCE_HANDOFF_ARTIFACT_ID,
  getSprintEngineEvidenceArtifacts,
  getSprintEngineInboxArtifacts,
  getSprintEngineInboxBadgeCount,
  sprintEngineInboxRowLifecycle,
} from '../sprintEngineInspector'
import { LIFECYCLE_LABEL } from '../../ui/LifecycleGlyph'
import { sprintEngineArtifactStatusLabels } from '../../../utils/sprintengine'
import type { SprintEngineArtifact } from '../../../types/workspace'

// T6 (Slice 3: status vocabulary). The Inbox status symbology must match reality:
//   1. approved splits on approvalMode — manual/legacy → filled `done` tick,
//      policy → outline `approved_auto` tick; recorded → the read-only `recorded`
//      evidence glyph; draft never maps to the live spinner;
//   2. status label copy is the plain-human, sentence-case vocabulary;
//   3. recorded artifacts partition into a separate Evidence grouping, stay out
//      of the actionable queue, and never inflate the badge;
//   4. row glyph and detail-pane glyph resolve through the SAME mapper, and the
//      policy-approval provenance line renders in the detail pane (source
//      contracts — no headless React harness for the inspector).

function artifact(
  id: string,
  status: SprintEngineArtifact['status'],
  overrides: Partial<SprintEngineArtifact> = {},
): SprintEngineArtifact {
  return {
    id,
    kind: 'design_notes',
    title: `Artifact ${id}`,
    path: `designs/${id}.md`,
    status,
    createdBy: 'frontend',
    taskId: 'T1',
    fingerprint: null,
    reviewHistory: [],
    recommendedTasks: [],
    createdAt: '2026-07-05T10:00:00Z',
    updatedAt: '2026-07-05T10:00:00Z',
    ...overrides,
  }
}

// 1. Glyph mapping — the split on approvalMode and the aligned vocabulary.
{
  assert.equal(
    sprintEngineInboxRowLifecycle(artifact('m', 'approved', { approvalMode: 'manual' })),
    'done',
    'manual approval → filled green tick (done)',
  )
  assert.equal(
    sprintEngineInboxRowLifecycle(artifact('l', 'approved')),
    'done',
    'legacy/absent approvalMode → filled green tick (done)',
  )
  assert.equal(
    sprintEngineInboxRowLifecycle(artifact('p', 'approved', { approvalMode: 'policy' })),
    'approved_auto',
    'policy approval → outline green tick (approved_auto)',
  )
  assert.equal(
    sprintEngineInboxRowLifecycle(artifact('e', 'recorded')),
    'recorded',
    'recorded → the read-only evidence glyph',
  )
  assert.equal(sprintEngineInboxRowLifecycle(artifact('r', 'ready_for_review')), 'review')
  assert.equal(sprintEngineInboxRowLifecycle(artifact('c', 'changes_requested')), 'changes_requested')
  assert.equal(sprintEngineInboxRowLifecycle(artifact('s', 'superseded')), 'archived')
  // The old draft→in_progress mapping produced a live spinner; drafts must not.
  assert.notEqual(
    sprintEngineInboxRowLifecycle(artifact('d', 'draft')),
    'in_progress',
    'a draft never renders the live spinner',
  )
  // The source handoff always leads the queue as a plain ready ring, whatever
  // its underlying status.
  assert.equal(
    sprintEngineInboxRowLifecycle(artifact(SOURCE_HANDOFF_ARTIFACT_ID, 'draft')),
    'ready',
  )
}

// 2. Label copy — plain-human, sentence case, with a `recorded` label present.
{
  assert.equal(sprintEngineArtifactStatusLabels.recorded, 'Recorded')
  assert.equal(sprintEngineArtifactStatusLabels.ready_for_review, 'Ready for review')
  assert.equal(sprintEngineArtifactStatusLabels.changes_requested, 'Changes requested')
  assert.equal(sprintEngineArtifactStatusLabels.approved, 'Approved')
  assert.equal(sprintEngineArtifactStatusLabels.superseded, 'Superseded')
  // The lifecycle glyph carries accessible names for the two new states.
  assert.equal(LIFECYCLE_LABEL.recorded, 'Recorded')
  assert.equal(LIFECYCLE_LABEL.approved_auto, 'Approved automatically')
}

// 3. Evidence partition — recorded is split out, stays out of the queue, and is
//    never counted in the badge.
{
  const artifacts = [
    artifact('A-review', 'ready_for_review'),
    artifact('A-changes', 'changes_requested'),
    artifact('A-approved', 'approved'),
    artifact('A-recorded-1', 'recorded'),
    artifact('A-recorded-2', 'recorded'),
    artifact('A-draft', 'draft'),
  ]

  const inboxIds = getSprintEngineInboxArtifacts(artifacts).map((a) => a.id)
  assert.ok(!inboxIds.some((id) => id.startsWith('A-recorded')), 'recorded artifacts are held out of the actionable queue')
  assert.ok(!inboxIds.includes('A-draft'), 'drafts stay out of the queue')

  const evidenceIds = getSprintEngineEvidenceArtifacts(artifacts).map((a) => a.id)
  assert.deepEqual([...evidenceIds].sort(), ['A-recorded-1', 'A-recorded-2'], 'evidence grouping is exactly the recorded artifacts')

  // Recorded never inflates the review badge (only ready_for_review + changes_requested).
  assert.equal(getSprintEngineInboxBadgeCount(artifacts), 2, 'badge counts only actionable artifacts, not recorded')

  // A recorded-only inbox reads as an empty queue with a populated Evidence list.
  const recordedOnly = [artifact('A-recorded-1', 'recorded')]
  assert.equal(getSprintEngineInboxArtifacts(recordedOnly).length, 0, 'recorded-only queue is empty')
  assert.equal(getSprintEngineEvidenceArtifacts(recordedOnly).length, 1, 'recorded-only evidence has the record')
  assert.equal(getSprintEngineInboxBadgeCount(recordedOnly), 0, 'recorded-only badge is 0')
}

// 3b. The source handoff is never treated as evidence, even at a recorded status
//     — it leads the review queue instead.
{
  const artifacts = [artifact(SOURCE_HANDOFF_ARTIFACT_ID, 'recorded', { title: 'Architect handover' })]
  assert.deepEqual(getSprintEngineEvidenceArtifacts(artifacts).map((a) => a.id), [], 'handoff is not evidence')
  assert.deepEqual(
    getSprintEngineInboxArtifacts(artifacts).map((a) => a.id),
    [SOURCE_HANDOFF_ARTIFACT_ID],
    'handoff stays in the queue',
  )
}

// 4. Source contract: the inbox row and the artifact detail pane both resolve
//    their glyph through sprintEngineInboxRowLifecycle, so row == detail by
//    construction; and the policy-approval provenance line renders in the pane.
{
  const panelSource = readFileSync(
    join(process.cwd(), 'src/renderer/src/components/panels/SprintEngineInspectorPanel.tsx'),
    'utf8',
  )
  const rowStart = panelSource.indexOf('export function SprintEngineInboxRow(')
  const inspectorStart = panelSource.indexOf('function SprintEngineArtifactInspector(')
  assert.ok(rowStart >= 0 && inspectorStart > rowStart, 'row + inspector components are present')

  const rowBody = panelSource.slice(rowStart, inspectorStart)
  assert.ok(
    rowBody.includes('sprintEngineInboxRowLifecycle(artifact)'),
    'the inbox row derives its glyph from the shared mapper',
  )
  const inspectorBody = panelSource.slice(inspectorStart)
  assert.ok(
    inspectorBody.includes('sprintEngineInboxRowLifecycle(artifact)'),
    'the detail pane derives its glyph from the same shared mapper (row == detail)',
  )
  assert.ok(
    inspectorBody.includes("artifact.approvalMode === 'policy'")
      && inspectorBody.includes('Approved automatically by run policy · on your behalf'),
    'the detail pane renders the policy-approval provenance line',
  )
}

// eslint-disable-next-line no-console
console.log('SprintEngineStatusVocabulary.test.ts: ok')
