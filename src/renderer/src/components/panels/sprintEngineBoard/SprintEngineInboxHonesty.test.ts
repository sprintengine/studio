import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SOURCE_HANDOFF_ARTIFACT_ID,
  getSprintEngineDocumentedArtifacts,
  getSprintEngineInboxArtifacts,
  getSprintEngineInboxBadgeCount,
  sprintEngineArtifactHasDocument,
} from '../sprintEngineInspector'
import type { SprintEngineArtifact } from '../../../types/workspace'

// T1 (Slice 1: Inbox honesty). Three guarantees so a fresh backlog-launched
// sprint stops rendering expected state as failure:
//   1. draft artifacts never appear in the Inbox list;
//   2. the Inbox tab badge counts only decision-actionable artifacts
//      (ready_for_review + changes_requested), so a draft-only sprint reads 0;
//   3. a per-artifact open failure routes to the inline action state only, never
//      flips the board sync banner to "Refresh failed", and reads as a sentence
//      with the raw path behind a disclosure rather than pasted into the row;
//   4. a registered-but-unwritten artifact is not listed as a document.
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
    catchBody.includes("kind: 'open',") && catchBody.includes("status: 'error',"),
    'open failure sets the inline per-artifact error action',
  )
  assert.ok(
    !catchBody.includes('setSyncState'),
    'open failure must not drive the board sync banner (setSyncState)',
  )

  // 3b. The failure is presented, not dumped: the row gets a plain sentence and
  // the absolute path rides as `detail`, which only InlineNotice's "Show
  // details" disclosure renders. A raw `Artifact file does not exist: /abs/…`
  // as the message is what this replaces.
  assert.ok(
    !openBody.includes('Artifact file does not exist'),
    'the missing-file failure no longer pastes a raw path-prefixed string into the row',
  )
  assert.ok(
    openBody.includes('has not been written yet.') && openBody.includes('detail: artifactPath'),
    'the missing-file failure says what happened and keeps the path as detail',
  )
}

// 4. A registered-but-unwritten artifact is not a document. The task detail
// lists outputs a person can open, so a `draft` with no fingerprint (the plan
// gate seeded at run creation, an agent that registered ahead of writing) is
// held out — while every written artifact, whatever its status, stays.
{
  const written = artifact('A-written', 'draft', { fingerprint: 'abc123' })
  const unwritten = artifact('A-unwritten', 'draft')
  const pathless = artifact('A-pathless', 'draft', { path: '  ', fingerprint: 'abc123' })
  const ready = artifact('A-ready', 'ready_for_review')
  const approved = artifact('A-approved', 'approved')

  assert.equal(sprintEngineArtifactHasDocument(written), true, 'a written draft is a document')
  assert.equal(sprintEngineArtifactHasDocument(unwritten), false, 'an unwritten draft is not')
  assert.equal(sprintEngineArtifactHasDocument(pathless), false, 'no path, no document')
  // Every post-draft status is file-backed by the engine (`artifact.ready`
  // resolves with require_file=True), so a null fingerprint there — the
  // in-place reference handoff carries one — must not hide a real file.
  assert.equal(sprintEngineArtifactHasDocument(ready), true, 'ready_for_review always shows')
  assert.equal(
    sprintEngineArtifactHasDocument({ ...approved, fingerprint: null }),
    true,
    'an approved artifact with no recorded fingerprint still shows',
  )

  assert.deepEqual(
    getSprintEngineDocumentedArtifacts([written, unwritten, pathless, ready, approved]).map((a) => a.id),
    ['A-written', 'A-ready', 'A-approved'],
    'the documented list keeps written artifacts in order and drops the placeholders',
  )
}

// eslint-disable-next-line no-console
console.log('SprintEngineInboxHonesty.test.ts: ok')
