import { expect, test } from 'vitest'

import { conversationCommandsFolderKey } from './commands'

test.each([
  ['/Users/dev/app', '/Users/dev/app'],
  ['/Users/dev/app/', '/Users/dev/app'],
  ['/Users/dev//app/./', '/Users/dev/app'],
  ['/', '/'],
  ['C:\\Users\\dev\\App\\', 'c:/users/dev/app'],
  ['c:/Users/dev/app', 'c:/users/dev/app'],
  ['C:\\', 'c:/'],
  ['\\\\build-box\\share\\app\\', '//build-box/share/app'],
])('the folder %s is kept as %s', (cwd, key) => {
  expect(conversationCommandsFolderKey(cwd)).toBe(key)
})

test('a POSIX folder keeps its case, since the file system may not ignore it', () => {
  expect(conversationCommandsFolderKey('/Users/dev/App')).not.toBe(conversationCommandsFolderKey('/Users/dev/app'))
})
