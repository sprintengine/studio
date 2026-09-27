import { test, expect } from 'vitest'
import { deriveEditHunks, emphasizeChangedWords, pairReplacedLines } from './editHunks'

test('replacement, insertion, deletion and new files count the displayed lines', () => {
  for (const [oldText, newText, added, removed] of [
    ['a\n', 'b\n', 1, 1],
    ['a\n', 'a\nb\n', 1, 0],
    ['a\nb\n', 'a\n', 0, 1],
    ['', 'a\nb\n', 2, 0],
  ] as const) {
    const [edit] = deriveEditHunks({ path: 'app.ts', oldText, newText })
    expect(edit).toMatchObject({ added, removed })
  }
})
test('multi-edits retain order and support native tool field names', () => {
  const edits = deriveEditHunks({
    file_path: 'app.ts',
    edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'c', new_string: 'd' },
    ],
  })
  expect(edits).toHaveLength(2)
  expect(edits[1]?.hunks[0]?.lines).toContain('+d')
})
test('CRLF bytes and missing final newline survive in hunk bodies', () => {
  const [edit] = deriveEditHunks({ path: 'app.ts', oldText: 'a\r\n', newText: 'b\r\n' })
  expect(edit?.hunks[0]?.lines).toContain('+b\r')
  const [unterminated] = deriveEditHunks({ path: 'app.ts', oldText: 'a\n', newText: 'a' })
  expect(unterminated?.hunks[0]?.lines).toContain('\\ No newline at end of file')
})
test('patch input and word emphasis preserve source', () => {
  const [edit] = deriveEditHunks({ path: 'app.ts', patch: '--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new\n' })
  expect(edit).toMatchObject({ added: 1, removed: 1 })
  const words = emphasizeChangedWords('const old = 1', 'const next = 1')
  expect(
    words.next
      .filter((part) => part.changed)
      .map((part) => part.text)
      .join(''),
  ).toBe('next')
})
test('a whole-file write is not claimed as a new file unless the previous version was empty', () => {
  const [write] = deriveEditHunks({ file_path: 'app.ts', content: 'a\nb\n' })
  expect(write).toMatchObject({ newFile: false, contentsOnly: true, added: 2 })
  const [created] = deriveEditHunks({ path: 'app.ts', oldText: '', newText: 'a\n' })
  expect(created).toMatchObject({ newFile: true })
  expect(created?.contentsOnly).toBeUndefined()
})
test('replaced lines pair by position within a run of removals and additions', () => {
  const pairs = pairReplacedLines(['-a', '-b', '+A', '+B', ' c', '-d', '+D', '+E', '-f'])
  expect([...pairs].sort((x, y) => x[0] - y[0])).toEqual([
    [0, 2],
    [1, 3],
    [2, 0],
    [3, 1],
    [5, 6],
    [6, 5],
  ])
})
