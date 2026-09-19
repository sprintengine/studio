import assert from 'node:assert/strict'

import {
  formatHunkHeader,
  hunkFingerprint,
  hunkGutterLine,
  locateHunk,
  parseUnifiedDiff,
  summariseInclusion,
  type DiffHunk,
} from './hunks'

// Reading `git diff -U0` (git-commit-window T7). The fixtures are real git
// output, copied byte for byte from a scratch repository — including the two
// shapes that are easiest to invent wrongly from memory: a deletion's
// `+N,0` range, whose N is the line BEFORE the gap, and the `\ No newline at
// end of file` marker, which belongs to the hunk it follows.

let failures = 0
function run(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

const TWO_HUNKS = [
  'diff --git a/f.txt b/f.txt',
  'index 9405325..b4cc66a 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -1 +1 @@',
  '-a',
  '+A',
  '@@ -3 +2,0 @@ b',
  '-c',
  '',
].join('\n')

run('a two-hunk diff parses into its header and its hunks', () => {
  const files = parseUnifiedDiff(TWO_HUNKS)
  assert.equal(files.length, 1)
  const file = files[0]
  assert.deepEqual(file.header, [
    'diff --git a/f.txt b/f.txt',
    'index 9405325..b4cc66a 100644',
    '--- a/f.txt',
    '+++ b/f.txt',
  ])
  assert.equal(file.oldPath, 'f.txt')
  assert.equal(file.newPath, 'f.txt')
  assert.equal(file.binary, false)
  assert.equal(file.hunks.length, 2)
  // `@@ -1 +1 @@` — a missing count is 1, not 0. Reading it as 0 would build a
  // patch that says "remove nothing here".
  assert.deepEqual(file.hunks[0], { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A'] })
  // A pure deletion: two lines survive before the gap, so the NEW side is `+2,0`.
  assert.deepEqual(file.hunks[1], { oldStart: 3, oldLines: 1, newStart: 2, newLines: 0, lines: ['-c'] })
})

run('the function context after the second @@ is not mistaken for content', () => {
  const [file] = parseUnifiedDiff(TWO_HUNKS)
  assert.deepEqual(file.hunks[1].lines, ['-c'], 'the trailing " b" is git\'s context hint, not a line of the file')
})

run('a CRLF file keeps its carriage returns, because they are the content', () => {
  const crlf =
    'diff --git a/c.txt b/c.txt\nindex 415a78b..ce5d508 100644\n--- a/c.txt\n+++ b/c.txt\n@@ -2 +2 @@ x\n-y\r\n+Y\r\n'
  const [file] = parseUnifiedDiff(crlf)
  assert.deepEqual(file.hunks[0].lines, ['-y\r', '+Y\r'])
  // And the fingerprint round-trips them, so the patch built from it matches
  // the index byte for byte.
  assert.equal(hunkFingerprint(file.hunks[0]), '-y\r\n+Y\r')
})

run('the no-newline marker belongs to the hunk it follows', () => {
  const noEol = [
    'diff --git a/n.txt b/n.txt',
    'index 8d7864f..79cb5ec 100644',
    '--- a/n.txt',
    '+++ b/n.txt',
    '@@ -2 +2 @@ p',
    '-q',
    '\\ No newline at end of file',
    '+Q',
    '\\ No newline at end of file',
    '',
  ].join('\n')
  const [file] = parseUnifiedDiff(noEol)
  assert.deepEqual(file.hunks[0].lines, ['-q', '\\ No newline at end of file', '+Q', '\\ No newline at end of file'])
})

run('a new file has no a/ side and a deletion has no b/ side', () => {
  const created = [
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    'index 0000000..2fe4df4',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,2 @@',
    '+n1',
    '+n2',
    '',
  ].join('\n')
  const [file] = parseUnifiedDiff(created)
  assert.equal(file.oldPath, null)
  assert.equal(file.newPath, 'new.txt')
  assert.ok(file.header.includes('new file mode 100644'), 'the mode line is part of the header a patch replays')
  assert.deepEqual(file.hunks[0], { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+n1', '+n2'] })

  const removed = [
    'diff --git a/f.txt b/f.txt',
    'deleted file mode 100644',
    'index 9405325..0000000',
    '--- a/f.txt',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-a',
    '-b',
    '',
  ].join('\n')
  const [gone] = parseUnifiedDiff(removed)
  assert.equal(gone.oldPath, 'f.txt')
  assert.equal(gone.newPath, null)
  assert.ok(gone.header.includes('deleted file mode 100644'))
})

run('a binary file is a file with no hunks and a flag, not a parse failure', () => {
  const binary = [
    'diff --git a/b.bin b/b.bin',
    'index 1a23e4b..659b724 100644',
    'Binary files a/b.bin and b/b.bin differ',
    '',
  ].join('\n')
  const [file] = parseUnifiedDiff(binary)
  assert.equal(file.binary, true)
  assert.equal(file.hunks.length, 0)
})

run('an empty diff is no files at all', () => {
  assert.deepEqual(parseUnifiedDiff(''), [])
  assert.deepEqual(parseUnifiedDiff('\n'), [])
})

run('a hunk header is written back the way git writes it', () => {
  const hunk = (patch: Partial<DiffHunk>): DiffHunk => ({
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: [],
    ...patch,
  })
  assert.equal(formatHunkHeader(hunk({})), '@@ -1 +1 @@')
  assert.equal(formatHunkHeader(hunk({ oldStart: 3, oldLines: 1, newStart: 2, newLines: 0 })), '@@ -3 +2,0 @@')
  assert.equal(formatHunkHeader(hunk({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 })), '@@ -0,0 +1,2 @@')
  assert.equal(formatHunkHeader(hunk({ oldStart: 10, oldLines: 4, newStart: 10, newLines: 3 })), '@@ -10,4 +10,3 @@')
})

/* ── Finding a hunk again after the offsets have moved ────────────────────── */

function body(...lines: string[]): DiffHunk {
  return { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }
}

run('a hunk is found by its body even when every line number moved', () => {
  const before = [body('-a', '+A'), body('-c')]
  // The first hunk was staged: the second one is now hunk 0 and sits elsewhere.
  const after = [{ ...body('-c'), oldStart: 3, newStart: 2, newLines: 0 }]
  const found = locateHunk(after, 1, hunkFingerprint(before[1]))
  assert.equal(found.ok, true)
  assert.equal(found.ok && found.index, 0, 'the position hint was wrong and the content won')
})

run('the position hint is only ever accepted when the content agrees', () => {
  const hunks = [body('-a', '+A'), body('-b', '+B')]
  const hit = locateHunk(hunks, 1, hunkFingerprint(hunks[1]))
  assert.equal(hit.ok && hit.index, 1)
  const miss = locateHunk(hunks, 1, hunkFingerprint(hunks[0]))
  assert.equal(miss.ok && miss.index, 0, 'the hint pointed at the wrong hunk and was overruled')
})

run('a hunk that is gone, and two that cannot be told apart, both refuse', () => {
  const hunks = [body('-a', '+A')]
  assert.deepEqual(locateHunk(hunks, 0, '-z\n+Z'), { ok: false, reason: 'gone' })
  assert.deepEqual(locateHunk([], 0, '-a\n+A'), { ok: false, reason: 'gone' })
  // Two byte-identical hunks with a hint that fits neither: staging a guess
  // here would stage the wrong lines, so nothing is staged.
  const twins = [body('-x', '+X'), body('-x', '+X')]
  assert.deepEqual(locateHunk(twins, 5, '-x\n+X'), { ok: false, reason: 'ambiguous' })
  // With a hint that DOES fit, the twins are no longer ambiguous.
  assert.equal(locateHunk(twins, 1, '-x\n+X').ok, true)
})

/* ── The counter ──────────────────────────────────────────────────────────── */

run('the counter is the two diffs added up, and the included half is the index', () => {
  assert.deepEqual(summariseInclusion([], []), { total: 0, included: 0 })
  assert.deepEqual(summariseInclusion([], [body('-a'), body('-b')]), { total: 2, included: 0 })
  assert.deepEqual(summariseInclusion([body('-a'), body('-b')], []), { total: 2, included: 2 })
})

run('a partly included file never reads as all-in or all-out', () => {
  // The state the file box draws as a dash. Whatever the two diffs contain, the
  // counter must land strictly between 0 and the total, or the sentence beside
  // the box would contradict it.
  const summary = summariseInclusion([body('-c')], [body('-a', '+A')])
  assert.deepEqual(summary, { total: 2, included: 1 })
  assert.ok(summary.included > 0 && summary.included < summary.total)
})

/* ── Where the box is drawn ───────────────────────────────────────────────── */

run('the box sits on the modified side, and above the gap for a deletion', () => {
  assert.equal(hunkGutterLine({ newStart: 12, newLines: 3 }), 12)
  // `@@ -3 +2,0 @@` — line 2 is the last line before the removed text.
  assert.equal(hunkGutterLine({ newStart: 2, newLines: 0 }), 2)
  // `@@ -1 +0,0 @@` — the file's first line was removed; there is no line 0.
  assert.equal(hunkGutterLine({ newStart: 0, newLines: 0 }), 1)
})

if (failures > 0) {
  console.error(`${failures} failing`)
  process.exit(1)
}
console.log('hunks.test.ts: ok')
