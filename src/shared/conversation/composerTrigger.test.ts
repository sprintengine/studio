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
  ['x /plugin:review|', 'slash', 'plugin:review'],
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
test('mid-token replacement consumes the entire token and rejects invalid carets', () => {
  expect(detectComposerTrigger('one @file.ts two', 7)?.range).toEqual({ start: 4, end: 12 })
  expect(detectComposerTrigger('@file', -1)).toBeNull()
  expect(detectComposerTrigger('@file', 8)).toBeNull()
  expect(detectComposerTrigger('@file', 1.5)).toBeNull()
})
