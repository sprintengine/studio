import assert from 'node:assert/strict'

import type { ReviewChangeSet } from '../../../../../shared/review'
import { checkBriefMatchesChangeSet, validateReviewBrief } from '../../../../../shared/review'
import { synthesizeDegradedBrief } from './degradedBrief'
import { fixtureChangeSet } from './fixtures'

// T1 acceptance: the renderer-synthesized degraded brief must be a valid brief for
// the changeset it walks — it flows through the same `ReviewWalkthrough` projection
// as a guide's brief, so it has to clear both validators or the surface would treat
// it as corrupt. These are pure-function tests: no React, no IPC, no disk.

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

// A minimal changed file — enough for the grouping + coverage checks, which never
// read hunks (the synthesized brief carries no annotations to anchor).
function file(path: string): ReviewChangeSet['files'][number] {
  return { path, status: 'modified', binary: false, additions: 1, deletions: 0, hunks: [] }
}

function changeSetOf(paths: string[]): ReviewChangeSet {
  return {
    schemaVersion: 1,
    id: 'cs-degraded-test',
    source: { kind: 'patch', label: 'test patch' },
    title: 'Test change',
    baseRef: 'main',
    headSha: 'deadbeefcafe',
    files: paths.map(file),
    stats: { files: paths.length, additions: paths.length, deletions: 0 },
    fetchedAt: '2026-07-22T00:00:00.000Z',
  }
}

run('a small change synthesizes one valid "All files" step that clears both validators', () => {
  const brief = synthesizeDegradedBrief(fixtureChangeSet)

  const shape = validateReviewBrief(brief)
  assert.ok(shape.ok, `brief must validate; got ${shape.ok ? '' : shape.errors.join('; ')}`)
  const match = checkBriefMatchesChangeSet(brief, fixtureChangeSet)
  assert.ok(match.ok, `brief must match the changeset; got ${match.ok ? '' : match.errors.join('; ')}`)

  assert.equal(brief.steps.length, 1, 'four files (≤ 8) collapse into a single step')
  assert.equal(brief.steps[0].id, 'degraded-all')
  assert.equal(brief.steps[0].title, 'All files')
  assert.equal(brief.changeSetId, fixtureChangeSet.id)
  assert.equal(brief.generatedAt, fixtureChangeSet.fetchedAt, 'generatedAt is deterministic (the fetch time)')
})

run('the synthesized brief carries no guide chrome — zero annotations, no change map', () => {
  const brief = synthesizeDegradedBrief(fixtureChangeSet)
  assert.equal(brief.changeMap, undefined, 'no change map — that is the guide’s')
  assert.deepEqual(brief.knowledgeRefs, [], 'no grounded knowledge without a guide')
  for (const step of brief.steps) {
    assert.deepEqual(step.annotations, [], 'no annotations — the guide has not explained anything')
    for (const f of step.files) assert.equal(f.why, 'Changed in this review', 'a neutral placeholder why-line')
  }
})

run('files land in deterministic path-sorted order', () => {
  const cs = changeSetOf(['src/z.ts', 'src/a.ts', 'lib/m.ts'])
  const brief = synthesizeDegradedBrief(cs)
  assert.deepEqual(
    brief.coverage.assignedPaths,
    ['lib/m.ts', 'src/a.ts', 'src/z.ts'],
    'assigned paths are byte-sorted regardless of input order',
  )
})

run('a large change groups by top-level directory and still clears both validators', () => {
  const cs = changeSetOf([
    'src/b.ts',
    'src/a.ts',
    'src/nested/c.ts',
    'lib/y.ts',
    'lib/x.ts',
    'docs/f.md',
    'docs/e.md',
    'docs/d.md',
    'README.md',
    'LICENSE',
  ])
  const brief = synthesizeDegradedBrief(cs)

  assert.ok(validateReviewBrief(brief).ok, 'the grouped brief validates')
  const match = checkBriefMatchesChangeSet(brief, cs)
  assert.ok(match.ok, `the grouped brief matches; got ${match.ok ? '' : match.errors.join('; ')}`)

  assert.deepEqual(
    brief.steps.map((step) => step.title),
    ['Repository root', 'docs', 'lib', 'src'],
    'one step per top-level directory, dir-sorted (root first)',
  )
  const rootStep = brief.steps[0]
  assert.deepEqual(rootStep.files.map((f) => f.path), ['LICENSE', 'README.md'], 'root files, path-sorted')
  // Every file is covered exactly once — no double-assignment, nothing uncovered.
  assert.equal(brief.coverage.assignedPaths.length, 10)
  assert.deepEqual(brief.coverage.unassignedPaths, [])
})

run('synthesis is pure — same changeset yields an identical model', () => {
  const a = synthesizeDegradedBrief(fixtureChangeSet)
  const b = synthesizeDegradedBrief(fixtureChangeSet)
  assert.deepEqual(a, b, 'no time/randomness leaks in')
})

console.log('all degradedBrief tests passed')
