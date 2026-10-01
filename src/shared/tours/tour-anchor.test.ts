import assert from 'node:assert/strict'
import { test } from 'vitest'

import { hunkFingerprint, parseUnifiedDiff, type DiffHunk } from '../git/hunks'
import { findMatch, relocateAnchor, resolveTourSteps, splitLines, type TourFileSnapshot } from './tour-anchor'
import type { TourStepInput } from './tour-types'

// Anchors resolved against real text, and found again after the text moved.

const OLD = ['export function retry() {', '  for (;;) {', '    await sleep(100)', '  }', '}', ''].join('\n')
const NEW = [
  'export type RetryOptions = {',
  '  attempts: number',
  '}',
  '',
  'export function retry() {',
  '  for (;;) {',
  '    await sleep(backoff(attempt))',
  '  }',
  '}',
  '',
].join('\n')

function hunksOf(diff: string): DiffHunk[] {
  return parseUnifiedDiff(diff)[0]?.hunks ?? []
}

// `git diff -U0` of OLD → NEW, as git writes it.
const RETRY_HUNKS = hunksOf(
  [
    'diff --git a/src/retry.ts b/src/retry.ts',
    '--- a/src/retry.ts',
    '+++ b/src/retry.ts',
    '@@ -0,0 +1,4 @@',
    '+export type RetryOptions = {',
    '+  attempts: number',
    '+}',
    '+',
    '@@ -3 +7 @@',
    '-    await sleep(100)',
    '+    await sleep(backoff(attempt))',
    '',
  ].join('\n'),
)

const RETRY: TourFileSnapshot = {
  path: 'src/retry.ts',
  status: 'modified',
  unreadable: null,
  oldText: OLD,
  newText: NEW,
  hunks: RETRY_HUNKS,
}
const GONE_FILE: TourFileSnapshot = {
  path: 'src/legacy.ts',
  status: 'deleted',
  unreadable: null,
  oldText: 'export const legacy = 1\n',
  newText: null,
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-export const legacy = 1'] }],
}
const ADDED: TourFileSnapshot = {
  path: 'src/new.ts',
  status: 'new',
  unreadable: null,
  oldText: null,
  newText: 'export const fresh = 2\n',
  hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+export const fresh = 2'] }],
}
const RENAMED: TourFileSnapshot = {
  path: 'src/queue-names.ts',
  oldPath: 'src/names.ts',
  status: 'renamed',
  unreadable: null,
  oldText: "export const NAME = 'jobs'\n",
  newText: "export const NAME = 'queue'\n",
  hunks: [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ["-export const NAME = 'jobs'", "+export const NAME = 'queue'"],
    },
  ],
}
const BINARY: TourFileSnapshot = {
  path: 'assets/logo.png',
  status: 'modified',
  unreadable: 'binary',
  oldText: null,
  newText: null,
  hunks: [],
}
const FILES = [RETRY, GONE_FILE, ADDED, RENAMED, BINARY]

function step(partial: Partial<TourStepInput> & Pick<TourStepInput, 'id' | 'path'>): TourStepInput {
  return { title: partial.id, body: 'why', side: 'new', ...partial }
}

test('a match anchor lands on the one line that holds it, extended by lineCount', () => {
  const result = resolveTourSteps(
    [step({ id: 'options', path: 'src/retry.ts', match: 'export type RetryOptions', lineCount: 3 })],
    FILES,
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  const anchor = result.steps[0].anchor
  assert.deepEqual([anchor.startLine, anchor.endLine], [1, 3])
  assert.deepEqual(anchor.snippet, {
    first: 'export type RetryOptions = {',
    last: '}',
    body: 'export type RetryOptions = {\nattempts: number\n}',
  })
  assert.equal(anchor.hunk?.fingerprint, hunkFingerprint(RETRY_HUNKS[0]), 'the lines keep the hunk they sat in')
  assert.deepEqual(result.steps[0].excerpt, ['+export type RetryOptions = {', '+  attempts: number', '+}'])
})

test('a hunk anchor takes the hunk span on the chosen side', () => {
  const result = resolveTourSteps(
    [
      step({ id: 'new-side', path: 'src/retry.ts', hunk: 2 }),
      step({ id: 'old-side', path: 'src/retry.ts', hunk: 2, side: 'old' }),
    ],
    FILES,
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual([result.steps[0].anchor.startLine, result.steps[0].anchor.endLine], [7, 7])
  assert.deepEqual([result.steps[1].anchor.startLine, result.steps[1].anchor.endLine], [3, 3])
})

test('a lines anchor is taken as given when it is inside the file', () => {
  const result = resolveTourSteps([step({ id: 'loop', path: 'src/retry.ts', lines: [5, 9] })], FILES)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual([result.steps[0].anchor.startLine, result.steps[0].anchor.endLine], [5, 9])
})

test('every problem in a tour is reported in one answer, each naming its step', () => {
  const result = resolveTourSteps(
    [
      step({ id: 'missing', path: 'src/nope.ts', match: 'x' }),
      step({ id: 'no-match', path: 'src/retry.ts', match: 'not in the file' }),
      step({ id: 'twice', path: 'src/retry.ts', match: '}' }),
      step({ id: 'past-end', path: 'src/retry.ts', lines: [8, 40] }),
      step({ id: 'no-hunk', path: 'src/retry.ts', hunk: 9 }),
      step({ id: 'fine', path: 'src/retry.ts', hunk: 1 }),
    ],
    FILES,
  )
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors.length, 5, result.errors.join('\n'))
  assert.match(result.errors[0], /"missing".*not in this tour's changes.*src\/retry\.ts/)
  assert.match(result.errors[1], /"no-match".*does not appear/)
  assert.match(result.errors[2], /"twice".*appears 3 times .*lines 3, 8, 9/)
  assert.match(result.errors[3], /"past-end".*has 9 lines/)
  assert.match(result.errors[4], /"no-hunk".*2 hunks/)
})

test('a match that appears on more than one line is refused, with the lines it appears on', () => {
  const doubled: TourFileSnapshot = { ...ADDED, newText: 'const a = 1\nconst a = 1\n' }
  const result = resolveTourSteps([step({ id: 'dup', path: 'src/new.ts', match: 'const a = 1' })], [doubled])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.errors[0], /appears 2 times .*lines 1, 2/)
})

test('a deleted file has only an old side, and an added file only a new one', () => {
  const result = resolveTourSteps(
    [
      step({ id: 'deleted-new', path: 'src/legacy.ts', hunk: 1 }),
      step({ id: 'added-old', path: 'src/new.ts', side: 'old', hunk: 1 }),
    ],
    FILES,
  )
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.errors[0], /deleted.*Use side "old"/)
  assert.match(result.errors[1], /new file.*Use side "new"/)

  const fixed = resolveTourSteps([step({ id: 'deleted-old', path: 'src/legacy.ts', side: 'old', hunk: 1 })], FILES)
  assert.equal(fixed.ok, true)
  if (fixed.ok) {
    assert.equal(fixed.steps[0].fileStatus, 'deleted')
    assert.deepEqual([fixed.steps[0].anchor.startLine, fixed.steps[0].anchor.endLine], [1, 1])
  }
})

test('a renamed file is named by its new path, and the old name says so', () => {
  const byOld = resolveTourSteps([step({ id: 'old-name', path: 'src/names.ts', hunk: 1 })], FILES)
  assert.equal(byOld.ok, false)
  if (!byOld.ok) assert.match(byOld.errors[0], /renamed to src\/queue-names\.ts.*oldPath "src\/names\.ts"/)
  const byNew = resolveTourSteps([step({ id: 'new-name', path: 'src/queue-names.ts', hunk: 1 })], FILES)
  assert.equal(byNew.ok, true)
  if (byNew.ok) assert.equal(byNew.steps[0].anchor.oldPath, 'src/names.ts')
})

test('a binary file takes a file-level step and nothing else', () => {
  const refused = resolveTourSteps([step({ id: 'lines', path: 'assets/logo.png', lines: [1, 1] })], FILES)
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.match(refused.errors[0], /binary; only a file-level step/)
  const accepted = resolveTourSteps([step({ id: 'file', path: 'assets/logo.png', fileOnly: true })], FILES)
  assert.equal(accepted.ok, true)
  if (accepted.ok) {
    assert.equal(accepted.steps[0].anchor.startLine, null)
    assert.equal(accepted.steps[0].unreadable, 'binary')
  }
})

test('findMatch reads a multi-line needle as consecutive lines, ignoring the ends of each', () => {
  const lines = splitLines(NEW)
  assert.deepEqual(findMatch(lines, '  for (;;) {\n    await sleep(backoff(attempt))'), [6])
  assert.deepEqual(findMatch(lines, 'await sleep'), [7])
  assert.deepEqual(findMatch(lines, '   '), [])
})

/* ── relocation ─────────────────────────────────────────────────────────── */

function anchored(input: TourStepInput) {
  const result = resolveTourSteps([input], FILES)
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('unreachable')
  return result.steps[0].anchor
}

test('unchanged lines stay where they are', () => {
  const anchor = anchored(step({ id: 'loop', path: 'src/retry.ts', match: 'await sleep(backoff', lineCount: 1 }))
  assert.deepEqual(relocateAnchor(anchor, RETRY), { status: 'ok', startLine: 7, endLine: 7 })
})

test('lines pushed down by an edit above them are found again by their text', () => {
  const anchor = anchored(step({ id: 'loop', path: 'src/retry.ts', match: 'await sleep(backoff', lineCount: 1 }))
  const shifted: TourFileSnapshot = { ...RETRY, newText: `// a new header\n// and another\n${NEW}` }
  assert.deepEqual(relocateAnchor(anchor, shifted), { status: 'ok', startLine: 9, endLine: 9 })
})

test('a snippet that appears twice is resolved to the occurrence inside the anchor’s hunk', () => {
  const anchor = anchored(step({ id: 'close', path: 'src/retry.ts', lines: [3, 3] }))
  assert.equal(anchor.snippet?.first, '}')
  // The file gains a line above, so line 3 is no longer the brace; the brace
  // also closes the function further down. The hunk puts it back on line 4.
  const moved: TourFileSnapshot = {
    ...RETRY,
    newText: `// header\n${NEW}`,
    hunks: [{ ...RETRY_HUNKS[0], newStart: 2 }, RETRY_HUNKS[1]],
  }
  assert.deepEqual(relocateAnchor(anchor, moved), { status: 'ok', startLine: 4, endLine: 4 })
})

test('lines whose text changed are moved, drawn where they were, clamped to the file', () => {
  const anchor = anchored(step({ id: 'loop', path: 'src/retry.ts', match: 'await sleep(backoff', lineCount: 1 }))
  const rewritten: TourFileSnapshot = {
    ...RETRY,
    newText: NEW.replace('await sleep(backoff(attempt))', 'await pause()'),
  }
  assert.deepEqual(relocateAnchor(anchor, rewritten), { status: 'moved', startLine: 7, endLine: 7 })
  const shrunk: TourFileSnapshot = { ...RETRY, newText: 'x\ny\n' }
  assert.deepEqual(relocateAnchor(anchor, shrunk), { status: 'moved', startLine: 2, endLine: 2 })
})

test('a step whose file left the diff is gone, and keeps its lines', () => {
  const anchor = anchored(step({ id: 'loop', path: 'src/retry.ts', hunk: 2 }))
  assert.deepEqual(relocateAnchor(anchor, null), { status: 'gone', startLine: 7, endLine: 7 })
  const fileLevel = anchored(step({ id: 'file', path: 'src/retry.ts', fileOnly: true }))
  assert.equal(relocateAnchor(fileLevel, RETRY).status, 'ok')
  assert.equal(relocateAnchor(fileLevel, null).status, 'gone')
})

test('a bare line is not re-found by coincidence: inserted code above a lone brace makes it moved', () => {
  const anchor = anchored(step({ id: 'brace', path: 'src/retry.ts', lines: [3, 3] }))
  // Code inserted above the type, and the hunk rewritten so its fingerprint no
  // longer matches: a `}` still sits on line 3, but it is not the step's `}`.
  const rewritten: TourFileSnapshot = {
    ...RETRY,
    newText: `export const a = {\n  b: 1\n}\n${NEW}`,
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 8, lines: ['+x'] }],
  }
  assert.equal(relocateAnchor(anchor, rewritten).status, 'moved')
})

test('a range is compared whole: a changed middle line is moved, not ok', () => {
  const anchor = anchored(step({ id: 'type', path: 'src/retry.ts', match: 'export type RetryOptions', lineCount: 3 }))
  const middle: TourFileSnapshot = {
    ...RETRY,
    newText: NEW.replace('  attempts: number', '  tries: number'),
    hunks: [],
  }
  assert.equal(relocateAnchor(anchor, middle).status, 'moved')
})
