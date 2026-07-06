import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SOURCE_HANDOFF_ARTIFACT_ID,
  getSprintEngineInboxArtifacts,
  getSprintEngineInboxBadgeCount,
} from '../sprintEngineInspector'
import type { SprintEngineArtifact } from '../../../types/workspace'

// T1 (Slice 1: Inbox honesty). Three guarantees so a fresh backlog-launched
// sprint stops rendering expected state as failure:
//   1. draft artifacts never appear in the Inbox list;
//   2. the Inbox tab badge counts only decision-actionable artifacts
//      (ready_for_review + changes_requested), so a draft-only sprint reads 0;
//   3. a per-artifact open failure routes to the inline action state only, and
//      never flips the board sync banner to "Refresh failed".
// (1)+(2) are proven directly against the pure filters; (3) is pinned as a
// source contract on the open-artifact error path, which has no headless
// React harness to drive.

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

// 1. Draft artifacts are excluded from the Inbox list; other statuses remain.
{
  const artifacts = [
    artifact('A-draft', 'draft'),
    artifact('A-review', 'ready_for_review'),
    artifact('A-changes', 'changes_requested'),
    artifact('A-approved', 'approved'),
  ]
  const inboxIds = getSprintEngineInboxArtifacts(artifacts).map((a) => a.id)
  assert.ok(!inboxIds.includes('A-draft'), 'draft artifact must not appear in the Inbox list')
  assert.deepEqual(
    [...inboxIds].sort(),
    ['A-approved', 'A-changes', 'A-review'],
    'non-draft artifacts stay in the Inbox list',
  )
}

// 1b. The source handoff is always kept, even though it is not a review status.
{
  const artifacts = [
    artifact(SOURCE_HANDOFF_ARTIFACT_ID, 'draft', { title: 'Architect handover' }),
    artifact('A-draft', 'draft'),
  ]
  const inboxIds = getSprintEngineInboxArtifacts(artifacts).map((a) => a.id)
  assert.deepEqual(inboxIds, [SOURCE_HANDOFF_ARTIFACT_ID], 'handoff kept, other draft dropped')
}

// 2. Badge counts only ready_for_review + changes_requested.
{
  const mixed = [
    artifact('A-draft', 'draft'),
    artifact('A-review', 'ready_for_review'),
    artifact('A-changes', 'changes_requested'),
    artifact('A-approved', 'approved'),
  ]
  assert.equal(
    getSprintEngineInboxBadgeCount(mixed),
    2,
    'badge counts only ready_for_review + changes_requested',
  )
}

// 2b. A fresh sprint whose only artifact is a draft plan placeholder reads 0.
{
  const draftOnly = [artifact('plan', 'draft', { kind: 'architect_plan', title: 'Sprint plan' })]
  assert.equal(getSprintEngineInboxArtifacts(draftOnly).length, 0, 'draft-only list is empty')
  assert.equal(getSprintEngineInboxBadgeCount(draftOnly), 0, 'draft-only badge is 0')
}

// 2c. The source handoff alone (no review-status artifacts) does not inflate the
// badge — it is a seed doc, not a pending decision.
{
  const handoffOnly = [artifact(SOURCE_HANDOFF_ARTIFACT_ID, 'draft', { title: 'Architect handover' })]
  assert.equal(getSprintEngineInboxBadgeCount(handoffOnly), 0, 'handoff alone yields a 0 badge')
}

// 3. Source contract: openArtifact's error path sets the inline artifact action
// state and does NOT drive the board sync banner. A missing artifact file is an
// expected, per-action failure — not a board refresh failure.
{
  const hookSource = readFileSync(
    join(
      process.cwd(),
      'src/renderer/src/components/panels/sprintEngineBoard/useSprintEngineBoardArtifactActions.ts',
    ),
    'utf8',
  )
  const openStart = hookSource.indexOf('const openArtifact = useCallback(')
  assert.ok(openStart >= 0, 'openArtifact callback is present')
  const openEnd = hookSource.indexOf('const popOutPreviewedArtifact', openStart)
  assert.ok(openEnd > openStart, 'openArtifact callback boundary is present')
  const openBody = hookSource.slice(openStart, openEnd)

  const catchStart = openBody.indexOf('} catch (error) {')
  assert.ok(catchStart >= 0, 'openArtifact has a catch block')
  const catchBody = openBody.slice(catchStart)

  assert.ok(
    catchBody.includes("setArtifactAction(artifact.id, { kind: 'open', status: 'error'"),
    'open failure sets the inline per-artifact error action',
  )
  assert.ok(
    !catchBody.includes('setSyncState'),
    'open failure must not drive the board sync banner (setSyncState)',
  )
}

// eslint-disable-next-line no-console
console.log('SprintEngineInboxHonesty.test.ts: ok')
