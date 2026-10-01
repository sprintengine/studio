import { expect, test } from 'vitest'
import { detectComposerTrigger } from './composerTrigger'

const cases: Array<[string, string | null, string?]> = [
  ['|', null],
  ['hello|', null],
  ['@|', 'mention', ''],
  ['@src|', 'mention', 'src'],
  [' @src|', 'mention', 'src'],
  ['hello @src|', 'mention', 'src'],
  ['hello\n@src|', 'mention', 'src'],
  ['\t@src|', 'mention', 'src'],
  ['dev@example.com|', null],
  ['hello dev@example.com|', null],
  ['x@|', null],
  ['word@src|', null],
  ['/|', 'slash', ''],
  ['/review|', 'slash', 'review'],
  [' /review|', 'slash', 'review'],
  ['word/review|', null],
  ['$|', 'skill', ''],
  ['$review|', 'skill', 'review'],
  [' $review|', 'skill', 'review'],
  ['word$review|', null],
  ['@src/app.ts|', 'mention', 'src/app.ts'],
  ['@README.md|', 'mention', 'README.md'],
  ['@café|', 'mention', 'café'],
  ['@日本語|', 'mention', '日本語'],
  ['🙂 @file|', 'mention', 'file'],
  ['🙂@file|', null],
  ['你好 @文件|', 'mention', '文件'],
  ['你好@文件|', null],
  ['@foo |', null],
  ['/review |', null],
  ['$review |', null],
  ['hello |@file', null],
  ['@fi|le', 'mention', 'fi'],
  ['one @fi|le two', 'mention', 'fi'],
  ['@|file', 'mention', ''],
  ['|@file', null],
  ['@@file|', null],
  ['//review|', null],
  ['$$review|', null],
  ['@$review|', null],
  ['\r\n@file|', 'mention', 'file'],
  ['\u00a0@file|', 'mention', 'file'],
  ['\u2003$review|', 'skill', 'review'],
  ['/@bad|', null],
  ['@a-b_c.test|', 'mention', 'a-b_c.test'],
  ['/plugin:review|', 'slash', 'plugin:review'],
  ['$scope:review|', 'skill', 'scope:review'],
  ['a@example.com |next', null],
]
test.each(cases)('composer trigger at %s', (marked, kind, query) => {
  const caret = marked.indexOf('|'),
    text = marked.replace('|', '')
  const result = detectComposerTrigger(text, caret)
  if (!kind) expect(result).toBeNull()
  else {
    expect(result).toMatchObject({ kind, query })
    expect(text[result!.range.start]).toMatch(/[/@$]/u)
  }
})
// `/` opens the command menu only where a CLI would read a command: as the
// first non-blank character of the message, with the caret still in the name.
const commandCases: Array<[string, string | null]> = [
  ['/rev|', 'rev'],
  ['  /rev|', 'rev'],
  ['\n  /rev|', 'rev'],
  ['first line\n/rev|', null],
  ['first line\n  /rev|', null],
  ['first line\r\n/rev|', null],
  ['/rev|iew', 'rev'],
  ['/review 12|', null],
  ['/review |', null],
  ['please /review|', null],
  ['x /plugin:review|', null],
  ['first line\nplease /review|', null],
  ['and/or|', null],
  ['src/foo|', null],
  ['see src/foo|', null],
  ['/src/foo|', null],
  ['/Users/dev/app|', null],
  ['dev@example.com/x|', null],
]
test.each(commandCases)('command trigger at %s', (marked, query) => {
  const caret = marked.indexOf('|'),
    text = marked.replace('|', '')
  const result = detectComposerTrigger(text, caret)
  if (query === null) expect(result).toBeNull()
  else expect(result).toMatchObject({ kind: 'slash', query })
})

test('the command token spans the whole name, so a pick replaces what the caret sits in', () => {
  expect(detectComposerTrigger('\n/rev', 3)).toEqual({ kind: 'slash', query: 'r', range: { start: 1, end: 5 } })
})

test('$ and @ still open anywhere after whitespace, including mid-line', () => {
  expect(detectComposerTrigger('please use $review', 18)).toMatchObject({ kind: 'skill', query: 'review' })
  expect(detectComposerTrigger('look at @src', 12)).toMatchObject({ kind: 'mention', query: 'src' })
})

test('mid-token replacement consumes the entire token and rejects invalid carets', () => {
  expect(detectComposerTrigger('one @file.ts two', 7)?.range).toEqual({ start: 4, end: 12 })
  expect(detectComposerTrigger('@file', -1)).toBeNull()
  expect(detectComposerTrigger('@file', 8)).toBeNull()
  expect(detectComposerTrigger('@file', 1.5)).toBeNull()
})
