import assert from 'node:assert/strict'

import { validateReviewWorkspaceState, type ReviewComment, type ReviewWorkspaceState } from '../../../../shared/review'
import type { ReviewCommentPostOutcome } from '../../../../shared/electron-api'
import {
  addComment,
  applyPostFailure,
  applyPostOutcomes,
  canPostReview,
  commentCitation,
  commentLocationLabel,
  commentSyncChip,
  commentsForFile,
  commentsToMarkdown,
  deleteComment,
  editComment,
  hasPostedComments,
  isCommentEditable,
  isPullRequestReviewSource,
  markCommentsPosting,
  newReviewComment,
  pendingCommentCount,
  postableComments,
  pullRequestLabel,
} from './commentModel'
import { buildDiffFileModel, modifiedZoneLineForAnchor } from './diffModel'
import { fixtureChangeSet } from './fixtures'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const pending: ReviewComment = {
  id: 'c-pending',
  path: 'prisma/schema.prisma',
  anchor: { side: 'new', startLine: 37, endLine: 37 },
  body: 'Should accept cap at MEMBER?',
  createdAt: '2026-07-18T00:00:00.000Z',
  sync: { state: 'pending' },
}
const posted: ReviewComment = {
  id: 'c-posted',
  path: 'src/server/api/invitations.ts',
  anchor: { side: 'new', startLine: 63, endLine: 66 },
  body: 'Nice, findUnique is right here.',
  createdAt: '2026-07-18T00:01:00.000Z',
  sync: { state: 'posted', url: 'https://github.com/acme/web-app/pull/482#note', postedAt: '2026-07-18T00:02:00.000Z' },
}
const failed: ReviewComment = {
  id: 'c-failed',
  path: 'src/server/api/invitations.ts',
  anchor: { side: 'new', startLine: 65, endLine: 65 },
  body: 'Is 400 right versus 404?',
  createdAt: '2026-07-18T00:03:00.000Z',
  sync: { state: 'failed', error: 'network error' },
}

run('newReviewComment stamps a pending comment and records the head sha', () => {
  const comment = newReviewComment({
    id: 'x1',
    path: 'a.ts',
    anchor: { side: 'new', startLine: 5, endLine: 5 },
    body: 'why?',
    createdAt: '2026-07-18T00:00:00.000Z',
    headSha: 'abc123',
  })
  assert.equal(comment.sync.state, 'pending')
  assert.equal(comment.anchor.anchoredAtSha, 'abc123')
  assert.equal(comment.body, 'why?')
})

run('add → edit → delete round-trips through valid ReviewWorkspaceState (survives restart)', () => {
  const state: ReviewWorkspaceState = {
    schemaVersion: 1,
    changeSetId: fixtureChangeSet.id,
    readFiles: [],
    diffView: 'side-by-side',
    comments: [],
  }
  const created = newReviewComment({
    id: 'r1',
    path: 'prisma/schema.prisma',
    anchor: { side: 'new', startLine: 37, endLine: 37 },
    body: 'first',
    createdAt: '2026-07-18T00:00:00.000Z',
  })

  const afterAdd = { ...state, comments: addComment(state.comments, created) }
  assert.equal(afterAdd.comments.length, 1)
  assert.ok(validateReviewWorkspaceState(afterAdd).ok, 'added state validates (persistable)')

  const afterEdit = { ...afterAdd, comments: editComment(afterAdd.comments, 'r1', 'edited body') }
  assert.equal(afterEdit.comments[0].body, 'edited body')
  assert.ok(validateReviewWorkspaceState(afterEdit).ok, 'edited state validates')

  const afterDelete = { ...afterEdit, comments: deleteComment(afterEdit.comments, 'r1') }
  assert.equal(afterDelete.comments.length, 0)
  assert.ok(validateReviewWorkspaceState(afterDelete).ok, 'deleted state validates')
})

run('edit and delete are no-ops on a posted (read-only) comment', () => {
  assert.equal(isCommentEditable(posted), false)
  assert.equal(isCommentEditable(pending), true)
  assert.equal(isCommentEditable(failed), true)
  const edited = editComment([posted], 'c-posted', 'hijacked')
  assert.equal(edited[0].body, posted.body, 'posted body unchanged')
  const deleted = deleteComment([posted], 'c-posted')
  assert.equal(deleted.length, 1, 'posted comment not removable locally')
})

run('sync chips read one status word each', () => {
  assert.deepEqual(commentSyncChip(pending), { label: 'Pending', tone: 'neutral' })
  assert.deepEqual(commentSyncChip(posted), { label: 'Posted', tone: 'good' })
  assert.deepEqual(commentSyncChip(failed), { label: 'Failed', tone: 'error' })
})

run('location + citation labels use the anchor range', () => {
  assert.equal(commentLocationLabel(pending), 'prisma/schema.prisma · L37')
  assert.equal(commentLocationLabel(posted), 'src/server/api/invitations.ts · L63–66')
  assert.equal(commentCitation(pending), 'prisma/schema.prisma:L37')
  assert.equal(commentCitation(posted), 'src/server/api/invitations.ts:L63-66')
})

run('postable / pending count excludes posted comments', () => {
  const all = [pending, posted, failed]
  assert.equal(postableComments(all).length, 2)
  assert.equal(pendingCommentCount(all), 2)
  assert.deepEqual(
    commentsForFile(all, 'src/server/api/invitations.ts').map((c) => c.id),
    ['c-posted', 'c-failed'],
  )
})

run('copy-as-markdown produces path:line + body blocks', () => {
  const md = commentsToMarkdown([pending, posted])
  assert.ok(md.includes('`prisma/schema.prisma:L37`'))
  assert.ok(md.includes('Should accept cap at MEMBER?'))
  assert.ok(md.includes('`src/server/api/invitations.ts:L63-66`'))
  // Two blocks separated by a blank line.
  assert.equal(md.split('\n\n').length, 2)
})

run('PR-source detection drives the tray post affordance', () => {
  assert.equal(isPullRequestReviewSource(fixtureChangeSet), true)
  // design-tokens-allow: "#482" is a pull-request number in an expected string, not a color literal
  assert.equal(pullRequestLabel(fixtureChangeSet), 'acme/web-app #482')
  const branch = { ...fixtureChangeSet, source: { kind: 'branch', repoRoot: '/r', baseRef: 'main', headRef: 'x' } as const }
  assert.equal(isPullRequestReviewSource(branch), false)
  assert.equal(pullRequestLabel(branch), null)
})

run('canPostReview needs a PR source and at least one postable comment', () => {
  assert.equal(canPostReview(fixtureChangeSet, [pending, posted]), true)
  assert.equal(canPostReview(fixtureChangeSet, [posted]), false, 'all posted → nothing to send')
  assert.equal(canPostReview(fixtureChangeSet, []), false)
  const branch = { ...fixtureChangeSet, source: { kind: 'branch', repoRoot: '/r', baseRef: 'main', headRef: 'x' } as const }
  assert.equal(canPostReview(branch, [pending]), false, 'branch has no remote to post to')
  assert.equal(hasPostedComments([pending, posted]), true)
  assert.equal(hasPostedComments([pending, failed]), false)
})

run('markCommentsPosting flips only postable comments to posting', () => {
  const marked = markCommentsPosting([pending, posted, failed])
  assert.deepEqual(
    marked.map((c) => c.sync.state),
    ['posting', 'posted', 'posting'],
    'pending + failed → posting; posted is left on the PR',
  )
})

run('applyPostOutcomes flips each comment to its returned sync state', () => {
  const outcomes: ReviewCommentPostOutcome[] = [
    { id: 'c-pending', sync: { state: 'posted', url: 'https://github.com/acme/web-app/pull/482#c1', postedAt: '2026-07-18T01:00:00.000Z' } },
    { id: 'c-failed', sync: { state: 'pending' }, anchorStatus: 'moved' },
  ]
  const applied = applyPostOutcomes([pending, posted, failed], outcomes)
  const byId = new Map(applied.map((c) => [c.id, c]))
  assert.equal(byId.get('c-pending')!.sync.state, 'posted')
  // A held comment stays pending and carries the moved flag (never posted to a guessed line).
  assert.equal(byId.get('c-failed')!.sync.state, 'pending')
  assert.equal(byId.get('c-failed')!.anchorStatus, 'moved')
  // A comment with no outcome is untouched.
  assert.equal(byId.get('c-posted')!.sync.state, 'posted')
})

run('applyPostOutcomes clears a stale moved flag when the comment posts cleanly', () => {
  const held: ReviewComment = { ...pending, anchorStatus: 'moved' }
  const applied = applyPostOutcomes([held], [
    { id: 'c-pending', sync: { state: 'posted', url: 'u', postedAt: 't' } },
  ])
  assert.equal(applied[0].sync.state, 'posted')
  assert.equal(applied[0].anchorStatus, undefined, 'a cleanly posted comment keeps no moved flag')
})

run('applyPostFailure flips only the batch it sent, sparing a mid-post comment', () => {
  // A comment composed while the post was in flight — pending, but NOT in the batch.
  const midFlight: ReviewComment = { ...pending, id: 'c-midflight' }
  const failedBatch = applyPostFailure(
    [pending, posted, failed, midFlight],
    ['c-pending', 'c-failed'],
    'GitHub denied the request (403).',
  )
  const byId = new Map(failedBatch.map((c) => [c.id, c]))
  assert.equal(byId.get('c-pending')!.sync.state, 'failed')
  assert.equal((byId.get('c-pending')!.sync as { error: string }).error, 'GitHub denied the request (403).')
  assert.equal(byId.get('c-failed')!.sync.state, 'failed')
  assert.equal(byId.get('c-posted')!.sync.state, 'posted', 'a posted comment is not re-failed')
  assert.equal(byId.get('c-midflight')!.sync.state, 'pending', 'a comment outside the batch is untouched')
  assert.ok(isCommentEditable(byId.get('c-pending')!), 'a failed comment is editable for retry')
})

run('a comment anchor maps to a modified-editor line by anchor math (view-independent)', () => {
  const file = fixtureChangeSet.files.find((f) => f.path === 'src/server/api/invitations.ts')!
  const model = buildDiffFileModel(file)
  // modified rows are the context + adds: real lines 62,63,64,65,66 → editor lines 1..5.
  // The placement takes no diff-view argument, so side-by-side and inline share it.
  assert.equal(modifiedZoneLineForAnchor(model, { side: 'new', startLine: 65, endLine: 65 }), 4)
  assert.equal(modifiedZoneLineForAnchor(model, { side: 'new', startLine: 63, endLine: 66 }), 5)
})

console.log('all commentModel tests passed')
