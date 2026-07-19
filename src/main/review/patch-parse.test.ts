import assert from 'node:assert/strict'
import { validateReviewChangeSet, type ReviewChangeSet } from '../../shared/review'
import { parsePatch } from './patch-parse'

const tests: Array<{ name: string; body: () => void }> = []
function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

// Wraps parsed files in a minimal valid ReviewChangeSet so every fixture also
// proves the parser output satisfies the T1 validator, not just our assertions.
function asChangeSet(files: ReviewChangeSet['files'], stats: ReviewChangeSet['stats']): ReviewChangeSet {
  return {
    schemaVersion: 1,
    id: 'cs-test',
    source: { kind: 'patch' },
    title: 'fixture',
    baseRef: '(patch)',
    files,
    stats,
    fetchedAt: '2026-07-18T00:00:00Z',
  }
}

function parseOk(text: string): { files: ReviewChangeSet['files']; stats: ReviewChangeSet['stats'] } {
  const result = parsePatch(text)
  assert.ok(result.ok, `expected parse to succeed, got: ${result.ok ? '' : result.error}`)
  if (!result.ok) throw new Error('unreachable')
  const validation = validateReviewChangeSet(asChangeSet(result.files, result.stats))
  assert.ok(validation.ok, `parser output failed validation: ${validation.ok ? '' : validation.errors.join('; ')}`)
  return { files: result.files, stats: result.stats }
}

run('simple modify with one hunk', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' const a = 1',
    '-const b = 2',
    '+const b = 3',
    '+const c = 4',
    ' const d = 5',
    '',
  ].join('\n')
  const { files, stats } = parseOk(patch)
  assert.equal(files.length, 1)
  const file = files[0]
  assert.equal(file.path, 'src/a.ts')
  assert.equal(file.status, 'modified')
  assert.equal(file.binary, false)
  assert.equal(file.additions, 2)
  assert.equal(file.deletions, 1)
  assert.equal(file.hunks.length, 1)
  assert.deepEqual(
    file.hunks[0].lines.map((line) => line.kind),
    ['context', 'del', 'add', 'add', 'context']
  )
  assert.equal(file.hunks[0].oldStart, 1)
  assert.equal(file.hunks[0].oldLines, 3)
  assert.equal(file.hunks[0].newStart, 1)
  assert.equal(file.hunks[0].newLines, 4)
  assert.deepEqual(stats, { files: 1, additions: 2, deletions: 1 })
})

run('new file uses /dev/null old side', () => {
  const patch = [
    'diff --git a/new.ts b/new.ts',
    'new file mode 100644',
    'index 0000000..3333333',
    '--- /dev/null',
    '+++ b/new.ts',
    '@@ -0,0 +1,2 @@',
    '+line one',
    '+line two',
    '',
  ].join('\n')
  const { files } = parseOk(patch)
  assert.equal(files[0].status, 'added')
  assert.equal(files[0].path, 'new.ts')
  assert.equal(files[0].additions, 2)
  assert.equal(files[0].deletions, 0)
})

run('deleted file uses /dev/null new side', () => {
  const patch = [
    'diff --git a/gone.ts b/gone.ts',
    'deleted file mode 100644',
    'index 3333333..0000000',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-line one',
    '-line two',
    '',
  ].join('\n')
  const { files } = parseOk(patch)
  assert.equal(files[0].status, 'deleted')
  assert.equal(files[0].path, 'gone.ts')
  assert.equal(files[0].deletions, 2)
})

run('pure rename with no body', () => {
  const patch = [
    'diff --git a/old/name.ts b/new/name.ts',
    'similarity index 100%',
    'rename from old/name.ts',
    'rename to new/name.ts',
    '',
  ].join('\n')
  const { files } = parseOk(patch)
  assert.equal(files[0].status, 'renamed')
  assert.equal(files[0].path, 'new/name.ts')
  assert.equal(files[0].oldPath, 'old/name.ts')
  assert.equal(files[0].hunks.length, 0)
})

run('rename with edits keeps rename status and counts', () => {
  const patch = [
    'diff --git a/old.ts b/renamed.ts',
    'similarity index 80%',
    'rename from old.ts',
    'rename to renamed.ts',
    'index 4444444..5555555 100644',
    '--- a/old.ts',
    '+++ b/renamed.ts',
    '@@ -1,2 +1,2 @@',
    ' keep',
    '-was',
    '+now',
    '',
  ].join('\n')
  const { files } = parseOk(patch)
  assert.equal(files[0].status, 'renamed')
  assert.equal(files[0].path, 'renamed.ts')
  assert.equal(files[0].oldPath, 'old.ts')
  assert.equal(files[0].additions, 1)
  assert.equal(files[0].deletions, 1)
})

run('binary file is flagged with no hunks', () => {
  const patch = [
    'diff --git a/logo.png b/logo.png',
    'new file mode 100644',
    'index 0000000..6666666',
    'Binary files /dev/null and b/logo.png differ',
    '',
  ].join('\n')
  const { files } = parseOk(patch)
  assert.equal(files[0].binary, true)
  assert.equal(files[0].status, 'added')
  assert.equal(files[0].path, 'logo.png')
  assert.equal(files[0].hunks.length, 0)
  assert.equal(files[0].additions, 0)
  assert.equal(files[0].deletions, 0)
})

run('CRLF line endings parse the same as LF', () => {
  const patch = [
    'diff --git a/crlf.ts b/crlf.ts',
    '--- a/crlf.ts',
    '+++ b/crlf.ts',
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
    '',
  ].join('\r\n')
  const { files } = parseOk(patch)
  assert.equal(files.length, 1)
  assert.equal(files[0].additions, 1)
  assert.equal(files[0].deletions, 1)
  assert.equal(files[0].hunks[0].lines[1].text, 'new')
})

run('multi-hunk file accumulates every hunk', () => {
  const patch = [
    'diff --git a/multi.ts b/multi.ts',
    '--- a/multi.ts',
    '+++ b/multi.ts',
    '@@ -1,2 +1,3 @@',
    ' top',
    '+added-top',
    ' second',
    '@@ -10,2 +11,2 @@',
    ' ninth',
    '-tenth',
    '+tenth-changed',
    '',
  ].join('\n')
  const { files } = parseOk(patch)
  assert.equal(files[0].hunks.length, 2)
  assert.equal(files[0].additions, 2)
  assert.equal(files[0].deletions, 1)
  assert.equal(files[0].hunks[1].oldStart, 10)
  assert.equal(files[0].hunks[1].newStart, 11)
})

run('multiple files in one patch', () => {
  const patch = [
    'diff --git a/one.ts b/one.ts',
    '--- a/one.ts',
    '+++ b/one.ts',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+b',
    'diff --git a/two.ts b/two.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/two.ts',
    '@@ -0,0 +1,1 @@',
    '+hello',
    '',
  ].join('\n')
  const { files, stats } = parseOk(patch)
  assert.equal(files.length, 2)
  assert.equal(files[0].path, 'one.ts')
  assert.equal(files[1].path, 'two.ts')
  assert.deepEqual(stats, { files: 2, additions: 2, deletions: 1 })
})

run('format-patch preamble is skipped', () => {
  const patch = [
    'From 1234567 Mon Sep 17 00:00:00 2001',
    'From: Dev <dev@example.com>',
    'Subject: [PATCH] tweak',
    '',
    'A commit message.',
    '---',
    ' one.ts | 2 +-',
    ' 1 file changed',
    '',
    'diff --git a/one.ts b/one.ts',
    '--- a/one.ts',
    '+++ b/one.ts',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+b',
    '-- ',
    '2.40.0',
    '',
  ].join('\n')
  const { files } = parseOk(patch)
  assert.equal(files.length, 1)
  assert.equal(files[0].path, 'one.ts')
  assert.equal(files[0].additions, 1)
  assert.equal(files[0].deletions, 1)
})

run('no-newline-at-eof marker does not count as a line', () => {
  const patch = [
    'diff --git a/eof.ts b/eof.ts',
    '--- a/eof.ts',
    '+++ b/eof.ts',
    '@@ -1,1 +1,1 @@',
    '-old',
    '\\ No newline at end of file',
    '+new',
    '\\ No newline at end of file',
    '',
  ].join('\n')
  const { files } = parseOk(patch)
  assert.equal(files[0].additions, 1)
  assert.equal(files[0].deletions, 1)
  assert.equal(files[0].hunks[0].lines.length, 2)
})

run('nonsense text is rejected with an actionable message', () => {
  const result = parsePatch('this is definitely not a diff\njust some prose')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /Not a unified diff/)
})

run('empty text is a valid empty change set', () => {
  const result = parsePatch('')
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.files.length, 0)
    assert.deepEqual(result.stats, { files: 0, additions: 0, deletions: 0 })
  }
})

run('plain unified diff without diff --git header', () => {
  const patch = [
    '--- a/plain.ts',
    '+++ b/plain.ts',
    '@@ -1,1 +1,1 @@',
    '-x',
    '+y',
    '',
  ].join('\n')
  const { files } = parseOk(patch)
  assert.equal(files.length, 1)
  assert.equal(files[0].path, 'plain.ts')
})

run('plain unified diff: a deleted "--- " line is not a false file boundary', () => {
  // Without diff --git headers, a hunk that deletes a line rendering as "--- x"
  // must not be mistaken for a new file header (it lacks a following "+++ ").
  const patch = [
    '--- a/only.md',
    '+++ b/only.md',
    '@@ -1,3 +1,2 @@',
    ' keep',
    '--- a dashed list item that got removed',
    ' tail',
    '',
  ].join('\n')
  const { files } = parseOk(patch)
  assert.equal(files.length, 1)
  assert.equal(files[0].path, 'only.md')
  assert.equal(files[0].deletions, 1)
  assert.equal(files[0].hunks.length, 1)
})

function main(): void {
  for (const test of tests) {
    try {
      test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      console.error(`not ok - ${test.name}`)
      throw error
    }
  }
  console.log('patch-parse.test.ts: ok')
}

main()
