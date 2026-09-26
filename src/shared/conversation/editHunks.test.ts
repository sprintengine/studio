import { test, expect } from 'vitest'
import { deriveEditHunks, emphasizeChangedWords } from './editHunks'

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
