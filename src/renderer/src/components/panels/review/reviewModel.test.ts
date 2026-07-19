import assert from 'node:assert/strict'

import type { ReviewAnnotation, ChangeSetFile } from '../../../../../shared/review'
import {
  validateReviewChangeSet,
  validateReviewBrief,
  checkBriefMatchesChangeSet,
  validateReviewWorkspaceState,
} from '../../../../../shared/review'
import {
  buildDiffFileModel,
  editorLineForRealLine,
  modifiedZoneLineForAnchor,
} from './diffModel'
import { placeAnnotations, hoverLinesForAnnotation } from './annotationZones'
import {
  buildRailModel,
  orderedSteps,
  resolveActivePaneId,
  sourceIdentity,
  fileWhyLine,
  OVERVIEW_PANE_ID,
} from './reviewSelectors'
import { fixtureChangeSet, fixtureBrief, fixtureState } from './fixtures'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const schemaFile = fixtureChangeSet.files[0] // prisma/schema.prisma
const apiFile = fixtureChangeSet.files[2] // src/server/api/invitations.ts

run('the fixture triple is a valid, cross-checked changeset + brief + state', () => {
  const cs = validateReviewChangeSet(fixtureChangeSet)
  assert.ok(cs.ok, `changeset invalid: ${!cs.ok ? cs.errors.join('; ') : ''}`)
  const brief = validateReviewBrief(fixtureBrief)
  assert.ok(brief.ok, `brief invalid: ${!brief.ok ? brief.errors.join('; ') : ''}`)
  if (cs.ok && brief.ok) {
    const match = checkBriefMatchesChangeSet(brief.value, cs.value)
    assert.ok(match.ok, `brief/changeset mismatch: ${!match.ok ? match.errors.join('; ') : ''}`)
  }
  const state = validateReviewWorkspaceState(fixtureState)
  assert.ok(state.ok, `state invalid: ${!state.ok ? state.errors.join('; ') : ''}`)
})

run('buildDiffFileModel reconstructs both sides with real line maps', () => {
  const model = buildDiffFileModel(apiFile)
  // Modified side keeps context + add rows (1 context + 4 adds = 5); original
  // keeps context + del (1 context + 1 del = 2).
  assert.equal(model.modified.split('\n').length, 5)
  assert.equal(model.original.split('\n').length, 2)
  assert.deepEqual(model.modifiedRealLines, [62, 63, 64, 65, 66])
  // Real old lines: 62 (context), 63 (del).
  assert.deepEqual(model.originalRealLines, [62, 63])
  assert.equal(model.language, 'typescript')
})

run('editorLineForRealLine maps real lines to editor rows and rejects misses', () => {
  const model = buildDiffFileModel(apiFile)
  assert.equal(editorLineForRealLine(model, 'new', 66), 5)
  assert.equal(editorLineForRealLine(model, 'new', 62), 1)
  assert.equal(editorLineForRealLine(model, 'new', 999), null)
  assert.equal(editorLineForRealLine(model, 'old', 63), 2)
})

run('modifiedZoneLineForAnchor places a new-side anchor on its end line', () => {
  const model = buildDiffFileModel(schemaFile)
  // schema adds run new lines 33..42 (after 3 context at 30/31/32). endLine 42 → editor row 13.
  const line = modifiedZoneLineForAnchor(model, { side: 'new', startLine: 34, endLine: 42 })
  assert.equal(line, 13)
})

run('modifiedZoneLineForAnchor returns null for an out-of-range anchor', () => {
  const model = buildDiffFileModel(apiFile)
  assert.equal(modifiedZoneLineForAnchor(model, { side: 'new', startLine: 500, endLine: 999 }), null)
})

run('modifiedZoneLineForAnchor snaps an old-side deletion to the prior modified line', () => {
  const model = buildDiffFileModel(apiFile)
  // Old line 63 is the deleted findFirst row; the prior context (old 62) is modified line 1.
  assert.equal(modifiedZoneLineForAnchor(model, { side: 'old', startLine: 63, endLine: 63 }), 1)
})

run('placeAnnotations splits in-range zones from out-of-range orphans + warns once', () => {
  const model = buildDiffFileModel(schemaFile)
  const inRange = fixtureBrief.steps[0].annotations[0] // new 34-42, valid
  const orphan: ReviewAnnotation = {
    id: 'orphan',
    path: schemaFile.path,
    anchor: { side: 'new', startLine: 800, endLine: 810 },
    kind: 'context',
    title: 'Off the end',
    summary: 'Defensive: anchor beyond the described extent.',
    hoverTip: 'Should never crash Monaco.',
  }
  const { zones, orphans } = placeAnnotations([inRange, orphan], model)
  assert.equal(zones.length, 1)
  assert.equal(zones[0].annotation.id, 'anno-model-invitation')
  assert.equal(orphans.length, 1)
  assert.equal(orphans[0].id, 'orphan')
})

run('hoverLinesForAnnotation returns only present new-side lines', () => {
  const model = buildDiffFileModel(schemaFile)
  const lines = hoverLinesForAnnotation(fixtureBrief.steps[0].annotations[0], model)
  assert.deepEqual(lines, [34, 35, 36, 37, 38, 39, 40, 41, 42])
  // An old-side anchor contributes no hover decorations.
  assert.deepEqual(
    hoverLinesForAnnotation(
      { ...fixtureBrief.steps[0].annotations[0], anchor: { side: 'old', startLine: 34, endLine: 42 } },
      model,
    ),
    [],
  )
})

run('buildRailModel derives progress, meter, step read-state and continue target', () => {
  const rail = buildRailModel(fixtureChangeSet, fixtureBrief, new Set(fixtureState.readFiles))
  assert.equal(rail.totalFiles, 4)
  assert.equal(rail.readFiles, 1)
  assert.equal(rail.progressLabel, '1 of 4 files read')
  assert.equal(rail.meterFraction, 0.25)
  // step-model has 2 files, only one read → not read; it is the continue target.
  assert.equal(rail.continueStepId, 'step-model')
  assert.equal(rail.continueLabel, 'Continue with step 1')
  // Meta labels drop the notes clause at zero.
  assert.equal(rail.steps[0].metaLabel, '2 files · 1 note')
  assert.equal(rail.steps[2].metaLabel, '1 file')
})

run('buildRailModel marks a fully-read step and clamps stray read paths', () => {
  const allSchema = new Set([
    'prisma/schema.prisma',
    'prisma/migrations/20260716_add_invitations/migration.sql',
    'does/not/exist.ts',
  ])
  const rail = buildRailModel(fixtureChangeSet, fixtureBrief, allSchema)
  assert.equal(rail.steps[0].read, true)
  // Stray path is ignored; only the two real changed files count.
  assert.equal(rail.readFiles, 2)
  assert.equal(rail.continueStepId, 'step-api')
})

run('orderedSteps sorts by order and resolveActivePaneId honors a valid choice', () => {
  const steps = orderedSteps(fixtureBrief)
  assert.deepEqual(steps.map((s) => s.id), ['step-model', 'step-api', 'step-tests'])
  assert.equal(resolveActivePaneId(fixtureBrief, fixtureState), 'step-model')
  assert.equal(resolveActivePaneId(fixtureBrief, { ...fixtureState, activeStepId: OVERVIEW_PANE_ID }), OVERVIEW_PANE_ID)
  assert.equal(resolveActivePaneId(fixtureBrief, { ...fixtureState, activeStepId: 'ghost' }), 'step-model')
  assert.equal(resolveActivePaneId(fixtureBrief, null), 'step-model')
})

run('sourceIdentity and fileWhyLine render plain human strings', () => {
  // design-tokens-allow: "#482" is a pull-request number in an expected string, not a color literal
  assert.equal(sourceIdentity(fixtureChangeSet), 'acme/web-app #482 · 4f2c19a')
  const branch = sourceIdentity({
    ...fixtureChangeSet,
    source: { kind: 'branch', repoRoot: '/x', baseRef: 'main', headRef: 'feature' },
    headRef: 'feature',
    headSha: undefined,
  })
  assert.equal(branch, 'feature → main')
  assert.equal(fileWhyLine('creates the table', 'mechanical-skim'), 'creates the table — mechanical mirror, safe to skim')
  assert.equal(fileWhyLine('the new endpoints'), 'the new endpoints')
})

console.log('all review model tests passed')
