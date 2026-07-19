import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { ReviewBrief, ReviewChangeSet, ReviewWorkspaceState } from '../../shared/review'
import { enumerateReviews } from './review-index'

const tests: Array<{ name: string; body: () => Promise<void> | void }> = []
function run(name: string, body: () => Promise<void> | void): void {
  tests.push({ name, body })
}

const tempDirs: string[] = []
function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'review-root-'))
  tempDirs.push(dir)
  return dir
}

function prChangeSet(title: string): ReviewChangeSet {
  return {
    schemaVersion: 1,
    id: 'cs-pr',
    source: {
      kind: 'pull-request',
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      repo: 'app',
      number: 42,
      url: 'https://github.com/acme/app/pull/42',
    },
    title,
    baseRef: 'main',
    headSha: 'deadbeef',
    files: [
      { path: 'src/a.ts', status: 'modified', binary: false, additions: 4, deletions: 2, hunks: [] },
      { path: 'src/b.ts', status: 'added', binary: false, additions: 6, deletions: 0, hunks: [] },
      { path: 'logo.png', status: 'added', binary: true, additions: 0, deletions: 0, hunks: [] },
    ],
    stats: { files: 3, additions: 10, deletions: 2 },
    fetchedAt: '2026-07-17T10:00:00Z',
  }
}

function branchChangeSet(title: string): ReviewChangeSet {
  const cs = prChangeSet(title)
  cs.id = 'cs-branch'
  cs.source = { kind: 'branch', repoRoot: '/repo', baseRef: 'main', headRef: 'feature' }
  return cs
}

function twoStepBrief(): ReviewBrief {
  return {
    schemaVersion: 1,
    changeSetId: 'cs-pr',
    generatedAt: '2026-07-17T10:05:00Z',
    overview: { intent: 'x', blastRadius: 'y', readingGuide: 'z', complexity: 'medium' },
    steps: [
      { id: 'step-a', order: 0, title: 'A', narrative: 'a', files: [{ path: 'src/a.ts', why: 'w' }], annotations: [] },
      { id: 'step-b', order: 1, title: 'B', narrative: 'b', files: [{ path: 'src/b.ts', why: 'w' }], annotations: [] },
    ],
    knowledgeRefs: [],
    coverage: { assignedPaths: ['src/a.ts', 'src/b.ts'], unassignedPaths: [] },
  }
}

function stateWithComments(): ReviewWorkspaceState {
  return {
    schemaVersion: 1,
    changeSetId: 'cs-pr',
    readFiles: ['src/a.ts'],
    diffView: 'side-by-side',
    comments: [
      { id: 'c1', path: 'src/a.ts', anchor: { side: 'new', startLine: 1, endLine: 1 }, body: 'pending', createdAt: 't', sync: { state: 'pending' } },
      { id: 'c2', path: 'src/a.ts', anchor: { side: 'new', startLine: 2, endLine: 2 }, body: 'held', createdAt: 't', sync: { state: 'failed', error: 'e' } },
      { id: 'c3', path: 'src/b.ts', anchor: { side: 'new', startLine: 3, endLine: 3 }, body: 'posted', createdAt: 't', sync: { state: 'posted', url: 'u', postedAt: 't' } },
    ],
  }
}

function writeReview(root: string, reviewId: string, files: Record<string, unknown>): void {
  const dir = join(root, '.multi-code', 'review', reviewId)
  mkdirSync(dir, { recursive: true })
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  }
}

run('enumerates every review across all roots with project, title, source, and state-line data', async () => {
  const rootA = makeRoot()
  const rootB = makeRoot()
  const rootEmpty = makeRoot() // no .multi-code/review — contributes nothing.

  // A fully-progressed PR review: brief + state with pending/held/posted comments.
  writeReview(rootA, 'rv_pr', { 'changeset.json': prChangeSet('Add invitations'), 'brief.json': twoStepBrief(), 'state.json': stateWithComments() })
  // A branch review the guide has not walked yet: change set only.
  writeReview(rootA, 'rv_branch', { 'changeset.json': branchChangeSet('Refactor auth') })
  // A review in a second project.
  writeReview(rootB, 'rv_pr2', { 'changeset.json': prChangeSet('B project change') })

  const reviews = await enumerateReviews([rootA, rootB, rootEmpty])
  assert.equal(reviews.length, 3, 'one entry per review dir; the review-less root adds nothing')

  const pr = reviews.find((r) => r.reviewId === 'rv_pr')
  assert.ok(pr)
  assert.equal(pr.workspaceRoot, rootA)
  assert.equal(pr.projectName, basename(rootA))
  assert.equal(pr.title, 'Add invitations')
  assert.equal(pr.sourceKind, 'pull-request')
  assert.equal(pr.fileCount, 3)
  assert.equal(pr.hasWalkthrough, true)
  assert.equal(pr.stepCount, 2)
  assert.equal(pr.readFileCount, 1)
  assert.equal(pr.pendingComments, 2, 'pending + failed are both still-to-post')
  assert.equal(pr.postedComments, 1)

  const branch = reviews.find((r) => r.reviewId === 'rv_branch')
  assert.ok(branch)
  assert.equal(branch.sourceKind, 'branch')
  assert.equal(branch.hasWalkthrough, false, 'no brief.json → no walkthrough yet')
  assert.equal(branch.stepCount, 0)
  assert.equal(branch.readFileCount, 0)
  assert.equal(branch.pendingComments, 0)
})

run('a directory without a valid change set is not a review', async () => {
  const root = makeRoot()
  // A stray dir (temp/no changeset) and a review with a corrupt change set.
  mkdirSync(join(root, '.multi-code', 'review', 'rv_stray'), { recursive: true })
  writeReview(root, 'rv_bad', { 'changeset.json': { schemaVersion: 1, nonsense: true } })
  writeReview(root, 'rv_good', { 'changeset.json': prChangeSet('Good') })

  const reviews = await enumerateReviews([root])
  assert.deepEqual(reviews.map((r) => r.reviewId), ['rv_good'], 'only the dir with a valid change set is enumerated')
})

run('a corrupt brief or state degrades the entry rather than dropping the review', async () => {
  const root = makeRoot()
  const dir = join(root, '.multi-code', 'review', 'rv_partial')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'changeset.json'), `${JSON.stringify(prChangeSet('Partial'))}\n`, 'utf-8')
  writeFileSync(join(dir, 'brief.json'), '{ broken', 'utf-8')
  writeFileSync(join(dir, 'state.json'), '{ also broken', 'utf-8')

  const reviews = await enumerateReviews([root])
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].hasWalkthrough, false, 'unreadable brief → no walkthrough, not a thrown enumeration')
  assert.equal(reviews[0].readFileCount, 0)
  assert.equal(reviews[0].pendingComments, 0)
})

run('duplicate roots are scanned once', async () => {
  const root = makeRoot()
  writeReview(root, 'rv_dup', { 'changeset.json': prChangeSet('Once') })
  const reviews = await enumerateReviews([root, root])
  assert.equal(reviews.length, 1, 'the same folder passed twice yields one entry')
})

async function main(): Promise<void> {
  let failed = false
  for (const test of tests) {
    try {
      await test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      failed = true
      console.error(`not ok - ${test.name}`)
      console.error(error)
    }
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  if (failed) process.exit(1)
  console.log('review-index.test.ts: ok')
}

void main()
