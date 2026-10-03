import { createHash as nodeCreateHash } from 'node:crypto'
import { posix as nodePosix } from 'node:path'
import { expect, test } from 'vitest'

import { createHash, randomInt, randomUUID } from './nodeCryptoShim'
import { posix as path } from './nodePathShim'

// The browser's stand-ins for the two Node modules the canvas service imports
// answer as Node does, for every call the service makes.

test('SHA-256 matches Node for empty, short, block-edge, long and non-ASCII text', () => {
  const texts = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x'.repeat(100_000), 'board · 図 🙂']
  for (const text of texts) {
    expect(createHash('sha256').update(text).digest('hex')).toBe(nodeCreateHash('sha256').update(text).digest('hex'))
  }
})

test('ids are version-4 UUIDs, and random integers stay in range', () => {
  expect(randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  for (let index = 0; index < 200; index++) {
    const value = randomInt(2 ** 31)
    expect(value >= 0 && value < 2 ** 31 && Number.isInteger(value)).toBe(true)
  }
})

test('POSIX paths answer as Node’s posix', () => {
  const cases: Array<[keyof typeof path, string[]]> = [
    ['normalize', ['/boards/w1/./a/../b.excalidraw']],
    ['normalize', ['a/../../b/']],
    ['join', ['/workspace/w1', 'docs', '../board.excalidraw']],
    ['join', ['', 'a', '']],
    ['resolve', ['/boards/w1', 'x/y', '..']],
    ['resolve', ['/a', '/b', 'c']],
    ['dirname', ['/boards/w1/board.excalidraw']],
    ['dirname', ['/boards']],
    ['dirname', ['board']],
    ['basename', ['/boards/w1/board.excalidraw']],
    ['extname', ['/boards/w1/board.excalidraw']],
    ['relative', ['/workspace/w1', '/workspace/w1/docs/a.excalidraw']],
    ['relative', ['/workspace/w1/docs', '/workspace/w1/other']],
    ['isAbsolute', ['/workspace']],
    ['isAbsolute', ['workspace']],
  ]
  for (const [name, args] of cases) {
    const ours = (path[name] as (...input: string[]) => unknown)(...args)
    const theirs = (nodePosix[name as keyof typeof nodePosix] as (...input: string[]) => unknown)(...args)
    expect(ours, `${name}(${args.join(', ')})`).toEqual(theirs)
  }
})
