import assert from 'node:assert/strict'

import { shiftAnchor } from '../../../../../shared/review'
import type {
  ChangeSetFile,
  ReviewBrief,
  ReviewChangeSet,
  ReviewComment,
  ReviewWorkspaceState,
} from '../../../../../shared/review'
import {
  buildCurrentBanner,
  buildStaleBanner,
  changeSetFileSignature,
  computeFreshness,
  migrateReviewState,
  reconstructSourceInput,
  shouldProbePullRequest,
  sourceCanGoStale,
  FRESHNESS_PROBE_MIN_INTERVAL_MS,
} from './freshness'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

// A one-hunk modified file whose add lines are the given texts, so two versions
// with different text produce different signatures.
function modifiedFile(path: string, adds: string[]): ChangeSetFile {
  return {
    path,
    status: 'modified',
    binary: false,
    additions: adds.length,
    deletions: 0,
    hunks: [
      {
        oldStart: 10,
        oldLines: 1,
        newStart: 10,
        newLines: 1 + adds.length,
        lines: [{ kind: 'context', text: 'context' }, ...adds.map((text) => ({ kind: 'add' as const, text }))],
      },
    ],
  }
}

function branchChangeSet(id: string, headSha: string, files: ChangeSetFile[]): ReviewChangeSet {
  return {
    schemaVersion: 1,
    id,
    source: { kind: 'branch', repoRoot: '/repo', baseRef: 'main', headRef: 'feature' },
    title: 'feature → main',
    baseRef: 'main',
    headRef: 'feature',
    headSha,
    files,
    stats: { files: files.length, additions: 0, deletions: 0 },
    fetchedAt: '2026-07-18T00:00:00.000Z',
  }
}

function threeStepBrief(id: string, headSha: string): ReviewBrief {
  const step = (n: number, path: string) => ({
    id: `step-${n}`,
    order: n,
    title: `Step ${n}`,
    narrative: `Narrative ${n}`,
    files: [{ path, why: `why ${n}` }],
    annotations: [],
  })
  return {
    schemaVersion: 1,
    changeSetId: id,
    headSha,
    generatedAt: '2026-07-18T00:00:00.000Z',
    overview: { intent: 'i', blastRadius: 'b', readingGuide: 'r', complexity: 'low' },
    steps: [step(0, 'a.ts'), step(1, 'b.ts'), step(2, 'c.ts')],
    knowledgeRefs: [],
    coverage: { assignedPaths: ['a.ts', 'b.ts', 'c.ts'], unassignedPaths: [] },
  }
}

const V1 = branchChangeSet('cs_v1', 'aaaaaaa0000000000000000000000000000aaaa', [
  modifiedFile('a.ts', ['a1']),
  modifiedFile('b.ts', ['b1']),
  modifiedFile('c.ts', ['c1']),
])
// v2: same head content for a.ts and c.ts, b.ts changed, head sha moved.
const V2 = branchChangeSet('cs_v2', 'bbbbbbb1111111111111111111111111111bbbb', [
  modifiedFile('a.ts', ['a1']),
  modifiedFile('b.ts', ['b1', 'b2-new']),
  modifiedFile('c.ts', ['c1']),
])
const BRIEF_V1 = threeStepBrief('cs_v1', 'aaaaaaa0000000000000000000000000000aaaa')

// --- Affected-step computation (acceptance fixture) ---------------------------

run('computeFreshness names exactly the step whose file changed', () => {
  const result = computeFreshness(V1, V2, BRIEF_V1)
  assert.equal(result.headMoved, true)
  assert.deepEqual(result.affectedStepIds, ['step-1'])
  assert.deepEqual(result.unaffectedStepIds, ['step-0', 'step-2'])
  assert.deepEqual(result.changedPaths, ['b.ts'])
})

run('computeFreshness reports no affected steps when only the head sha differs', () => {
  const sameFiles = branchChangeSet('cs_v1b', 'ccccccc2222222222222222222222222222cccc', V1.files)
  const result = computeFreshness(V1, sameFiles, BRIEF_V1)
  assert.equal(result.headMoved, true)
  assert.deepEqual(result.affectedStepIds, [])
  assert.deepEqual(result.unaffectedStepIds, ['step-0', 'step-1', 'step-2'])
})

run('computeFreshness flags an added and a removed file', () => {
  const v3 = branchChangeSet('cs_v3', 'ddddddd3333333333333333333333333333dddd', [
    modifiedFile('a.ts', ['a1']),
    // b.ts removed, d.ts added
    modifiedFile('c.ts', ['c1']),
    modifiedFile('d.ts', ['d1']),
  ])
  const result = computeFreshness(V1, v3, BRIEF_V1)
  assert.deepEqual(result.changedPaths.sort(), ['b.ts', 'd.ts'])
  // step-1 owns b.ts (removed) so it is affected; a.ts/c.ts steps are not.
  assert.deepEqual(result.affectedStepIds, ['step-1'])
})

run('changeSetFileSignature is stable for identical diffs and differs on change', () => {
  assert.equal(changeSetFileSignature(V1.files[0]), changeSetFileSignature(V2.files[0]))
  assert.notEqual(changeSetFileSignature(V1.files[1]), changeSetFileSignature(V2.files[1]))
})

// --- shiftAnchor unit cases (acceptance: insert/delete-above, replace-within,
//     range-deleted) -------------------------------------------------------------

run('shiftAnchor insert-above pushes the span down by the inserted count', () => {
  const shifted = shiftAnchor({ side: 'new', startLine: 10, endLine: 12 }, [{ start: 3, removed: 0, added: 4 }])
  assert.deepEqual(shifted, { side: 'new', startLine: 14, endLine: 16 })
})

run('shiftAnchor delete-above pulls the span up by the removed count', () => {
  const shifted = shiftAnchor({ side: 'new', startLine: 10, endLine: 12 }, [{ start: 2, removed: 3, added: 0 }])
  assert.deepEqual(shifted, { side: 'new', startLine: 7, endLine: 9 })
})

run('shiftAnchor replace-within grows the span end by the net replacement', () => {
  // Replace 1 line with 3 inside the span [5,10]: end grows by +2, start stays.
  const shifted = shiftAnchor({ side: 'new', startLine: 5, endLine: 10 }, [{ start: 7, removed: 1, added: 3 }])
  assert.deepEqual(shifted, { side: 'new', startLine: 5, endLine: 12 })
})

run('shiftAnchor range-deleted returns null (orphaned)', () => {
  const shifted = shiftAnchor({ side: 'new', startLine: 5, endLine: 7 }, [{ start: 4, removed: 6, added: 0 }])
  assert.equal(shifted, null)
})

// --- State migration across a re-run ------------------------------------------

function comment(id: string, path: string): ReviewComment {
  return {
    id,
    path,
    anchor: { side: 'new', startLine: 11, endLine: 11 },
    body: 'a note',
    createdAt: '2026-07-18T00:00:00.000Z',
    sync: { state: 'pending' },
  }
}

const STATE_V1: ReviewWorkspaceState = {
  schemaVersion: 1,
  changeSetId: 'cs_v1',
  readFiles: ['a.ts', 'b.ts', 'c.ts'],
  activeStepId: 'step-1',
  diffView: 'inline',
  comments: [comment('cm-a', 'a.ts'), comment('cm-b', 'b.ts')],
}

run('migrateReviewState keeps read state on unchanged files, drops it on changed', () => {
  const next = migrateReviewState(STATE_V1, V1, V2)
  assert.equal(next.changeSetId, 'cs_v2')
  // b.ts changed → unread; a.ts and c.ts unchanged → still read.
  assert.deepEqual(next.readFiles.sort(), ['a.ts', 'c.ts'])
  // View + active step carry over untouched.
  assert.equal(next.diffView, 'inline')
  assert.equal(next.activeStepId, 'step-1')
})

run('migrateReviewState keeps every comment; a changed-file comment flips to moved', () => {
  const next = migrateReviewState(STATE_V1, V1, V2)
  assert.equal(next.comments.length, 2)
  const onA = next.comments.find((c) => c.id === 'cm-a')
  const onB = next.comments.find((c) => c.id === 'cm-b')
  assert.equal(onA?.anchorStatus, undefined) // a.ts unchanged → still anchored
  assert.equal(onB?.anchorStatus, 'moved') // b.ts changed → moved, never dropped
})

run('migrateReviewState flips a comment on a vanished file to moved', () => {
  const v3 = branchChangeSet('cs_v3', 'ddddddd3333333333333333333333333333dddd', [modifiedFile('a.ts', ['a1'])])
  const next = migrateReviewState(STATE_V1, V1, v3)
  assert.equal(next.comments.find((c) => c.id === 'cm-b')?.anchorStatus, 'moved')
  assert.deepEqual(next.readFiles, ['a.ts'])
})

run('migrateReviewState clears a stale moved flag when the file is unchanged again', () => {
  const movedState: ReviewWorkspaceState = {
    ...STATE_V1,
    comments: [{ ...comment('cm-a', 'a.ts'), anchorStatus: 'moved' }],
  }
  const next = migrateReviewState(movedState, V1, V2)
  assert.equal(next.comments[0].anchorStatus, undefined)
})

// --- Banner wording -----------------------------------------------------------

run('buildStaleBanner names the sha move and splits unchanged vs needs-refresh', () => {
  const banner = buildStaleBanner(V2.source, BRIEF_V1, computeFreshness(V1, V2, BRIEF_V1))
  assert.equal(banner.tone, 'stale')
  assert.equal(banner.lead, 'Branch moved.')
  assert.match(banner.detail, /aaaaaaa → bbbbbbb/)
  assert.match(banner.detail, /steps 1, 3 unchanged/)
  assert.match(banner.detail, /step 2 needs a refresh/)
  assert.equal(banner.refreshable, true)
})

run('buildCurrentBanner is the quiet settle line naming the refreshed step', () => {
  const banner = buildCurrentBanner(V2.headSha, BRIEF_V1, ['step-1'])
  assert.equal(banner.tone, 'current')
  assert.match(banner.detail, /current with bbbbbbb/)
  assert.match(banner.detail, /step 2 refreshed/)
  assert.match(banner.detail, /read progress and pending comments were kept/)
})

// --- Source classification + PR probe debounce --------------------------------

run('sourceCanGoStale is false only for a patch source', () => {
  assert.equal(sourceCanGoStale(V2), true)
  const patch = { ...V2, source: { kind: 'patch' as const }, headSha: undefined }
  assert.equal(sourceCanGoStale(patch), false)
})

run('reconstructSourceInput rebuilds branch/PR inputs and skips patch', () => {
  assert.deepEqual(reconstructSourceInput(V2), { kind: 'branch', repoRoot: '/repo', baseRef: 'main', headRef: 'feature' })
  const pr = {
    ...V2,
    source: { kind: 'pull-request' as const, provider: 'github' as const, host: 'github.com', owner: 'o', repo: 'r', number: 5, url: 'https://github.com/o/r/pull/5' },
  }
  assert.deepEqual(reconstructSourceInput(pr), { kind: 'pull-request', url: 'https://github.com/o/r/pull/5' })
  const patch = { ...V2, source: { kind: 'patch' as const }, headSha: undefined }
  assert.equal(reconstructSourceInput(patch), null)
})

run('shouldProbePullRequest never probes while hidden, and debounces to >=60s', () => {
  // Hidden: never, even on the first opportunity.
  assert.equal(shouldProbePullRequest(1_000_000, null, false), false)
  // First reveal with no prior probe: yes.
  assert.equal(shouldProbePullRequest(1_000_000, null, true), true)
  // Within the min interval: no.
  assert.equal(shouldProbePullRequest(1_000_000 + FRESHNESS_PROBE_MIN_INTERVAL_MS - 1, 1_000_000, true), false)
  // At/after the min interval: yes.
  assert.equal(shouldProbePullRequest(1_000_000 + FRESHNESS_PROBE_MIN_INTERVAL_MS, 1_000_000, true), true)
})

console.log('all freshness tests passed')
