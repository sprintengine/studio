import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'

import type { LiveTour, LiveTourStep } from '../../../../../shared/tours/tour-types'
import { takesNavigationKey } from '../diffNavigation'
import {
  forcedLayout,
  gotoDecision,
  mapRangeAcross,
  readingTimeMs,
  stepEditorSide,
  stepFileIndexes,
  stepPositionLabel,
  tourItems,
  tourKeyAction,
  visit,
} from './tourModel'

function liveStep(partial: Partial<LiveTourStep> & { id: string; path: string }): LiveTourStep {
  const { path, ...rest } = partial
  return {
    title: partial.id,
    body: 'why',
    kind: 'explain',
    anchor: { path, side: 'new', startLine: 1, endLine: 2 },
    fileStatus: 'modified',
    unreadable: null,
    excerpt: [],
    status: 'ok',
    startLine: 1,
    endLine: 2,
    ...rest,
  }
}

const TOUR = {
  id: 'tour-1',
  repoRoot: '/Users/dev/app',
  revisions: { base: 'abc123', head: 'worktree' },
  steps: [
    liveStep({ id: 'a', path: 'src/retry.ts' }),
    liveStep({ id: 'b', path: 'src/worker.ts' }),
    liveStep({ id: 'c', path: 'src/retry.ts' }),
    liveStep({
      id: 'd',
      path: 'src/legacy.ts',
      fileStatus: 'deleted',
      anchor: { path: 'src/legacy.ts', side: 'old', startLine: 1, endLine: 1 },
    }),
    liveStep({
      id: 'e',
      path: 'src/queue-names.ts',
      fileStatus: 'renamed',
      anchor: { path: 'src/queue-names.ts', oldPath: 'src/names.ts', side: 'new', startLine: 1, endLine: 1 },
    }),
    liveStep({ id: 'f', path: 'src/fresh.ts', fileStatus: 'new' }),
  ],
} as unknown as LiveTour

test('a tour becomes one item per file, in the order its steps first reach them', () => {
  const items = tourItems(TOUR)
  assert.deepEqual(
    items.map((item) => item.relativePath),
    ['src/retry.ts', 'src/worker.ts', 'src/legacy.ts', 'src/queue-names.ts', 'src/fresh.ts'],
  )
  assert.deepEqual(stepFileIndexes(TOUR, items), [0, 1, 0, 2, 3, 4])
  const [retry, , legacy, renamed, fresh] = items
  assert.equal(retry.path, '/Users/dev/app/src/retry.ts')
  assert.deepEqual([retry.originalRev, retry.modifiedRev], ['abc123', 'worktree'])
  assert.equal(legacy.mirrorOriginal, true, 'a deleted file plays as its old text')
  assert.equal(legacy.modifiedRev, null)
  assert.equal(renamed.originalRelativePath, 'src/names.ts')
  assert.equal(fresh.originalRev, null, 'an added file has no old side to read')
})

test('old-side steps play side by side, deleted files unified, the rest in the owner’s layout', () => {
  assert.equal(forcedLayout(TOUR.steps[0]), null)
  assert.equal(forcedLayout(TOUR.steps[3]), 'unified')
  assert.equal(forcedLayout({ ...TOUR.steps[0], anchor: { ...TOUR.steps[0].anchor, side: 'old' } }), 'side-by-side')
  assert.equal(stepEditorSide(TOUR.steps[3]), 'modified', 'the mirrored deleted file is drawn in the modified editor')
  assert.equal(stepEditorSide({ ...TOUR.steps[0], anchor: { ...TOUR.steps[0].anchor, side: 'old' } }), 'original')
})

test('lines map across the two sides the way the diff aligns them', () => {
  // Original 1–10; modified inserts 3 lines after original line 2 and changes
  // original 6–7 into one line.
  const changes = [
    { originalStartLineNumber: 2, originalEndLineNumber: 0, modifiedStartLineNumber: 3, modifiedEndLineNumber: 5 },
    { originalStartLineNumber: 6, originalEndLineNumber: 7, modifiedStartLineNumber: 9, modifiedEndLineNumber: 9 },
  ]
  assert.deepEqual(mapRangeAcross(changes, 1, 1, 'modified'), [1, 1], 'above every change')
  assert.deepEqual(mapRangeAcross(changes, 3, 5, 'modified'), [2, 2], 'an insertion maps to the line it follows')
  assert.deepEqual(mapRangeAcross(changes, 9, 9, 'modified'), [6, 6], 'into a change, to its start')
  assert.deepEqual(mapRangeAcross(changes, 10, 11, 'modified'), [8, 9], 'below, by the running offset')
  assert.deepEqual(mapRangeAcross(changes, 8, 9, 'original'), [10, 11])
})

test('visiting a step remembers it once, and clamps to the tour', () => {
  let state = visit({ index: null, visited: [] }, TOUR.steps, 1)
  state = visit(state, TOUR.steps, 1)
  state = visit(state, TOUR.steps, 99)
  assert.deepEqual(state, { index: 5, visited: ['b', 'f'] })
  assert.equal(stepPositionLabel(2, 7), 'Step 3 of 7')
  assert.equal(stepPositionLabel(null, 1), '1 step')
})

test('Play dwells long enough to read a step, and never a blink or a stall', () => {
  assert.equal(readingTimeMs({ title: 'x', body: 'y' }), 5_000)
  assert.equal(readingTimeMs({ title: 'x', body: 'word '.repeat(5_000) }), 45_000)
  const middling = readingTimeMs({ title: 'A step', body: 'word '.repeat(60) })
  assert.ok(middling > 15_000 && middling < 25_000)
})

test('the agent pointing moves the view only when the owner follows a tour that is playing on screen', () => {
  assert.deepEqual(gotoDecision({ showing: true, started: true, follow: true }), { moved: true, reason: 'moved' })
  assert.equal(gotoDecision({ showing: true, started: true, follow: false }).reason, 'follow_off')
  assert.equal(gotoDecision({ showing: true, started: false, follow: true }).reason, 'not_started')
  assert.equal(gotoDecision({ showing: false, started: true, follow: true }).reason, 'not_showing')
})

test('] and [ step the tour; F7, ⇧F7 and ⌘↑/⌘↓ are left to the diff’s own steppers', () => {
  assert.equal(tourKeyAction({ key: ']' }), 'next')
  assert.equal(tourKeyAction({ key: '[' }), 'prev')
  assert.equal(tourKeyAction({ key: ']', metaKey: true }), null, '⌘] is not ours')
  assert.equal(tourKeyAction({ key: 'F7' }), null)
  assert.equal(tourKeyAction({ key: 'ArrowDown', metaKey: true }), null)
  assert.equal(tourKeyAction({ key: 'ArrowUp', ctrlKey: true }), null)
  // The ask field lives inside the editor's DOM; the viewer's key handlers
  // never see its keys as navigation.
  const insideEditor = { closest: (selector: string) => (selector.includes('.monaco-editor') ? {} : null) }
  assert.equal(takesNavigationKey(insideEditor), false)
})

test('tour mode never remounts the diff editor: nothing in it renders one, or keys one', () => {
  const dir = __dirname
  for (const name of readdirSync(dir).filter((file) => /\.tsx?$/.test(file) && !file.endsWith('.test.ts'))) {
    const source = readFileSync(join(dir, name), 'utf8')
    assert.equal(/<DiffEditor\b/.test(source), false, `${name} renders its own DiffEditor`)
  }
  const viewer = readFileSync(join(dir, '..', 'DiffViewer.tsx'), 'utf8')
  const element = viewer.slice(viewer.indexOf('<DiffEditor'), viewer.indexOf('/>', viewer.indexOf('<DiffEditor')))
  assert.equal(/\bkey=/.test(element), false, 'the DiffEditor carries no key')
  assert.equal(viewer.match(/<DiffEditor\b/g)?.length, 1, 'one DiffEditor, the one DiffBody renders')
})
