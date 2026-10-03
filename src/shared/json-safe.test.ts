import { expect, test } from 'vitest'

import { assertJsonSafe, NotJsonSafe } from './json-safe'

test('plain data passes, an absent member included', () => {
  expect(() => assertJsonSafe({ a: [1, 'two', true, null], b: { c: undefined } })).not.toThrow()
})

test('what JSON would change is refused, naming the member', () => {
  const cases: Array<[unknown, string]> = [
    [{ at: new Date(0) }, 'value.at'],
    [{ map: new Map() }, 'value.map'],
    [{ bytes: new Uint8Array(2) }, 'value.bytes'],
    [{ n: Number.NaN }, 'value.n'],
    [{ list: [1, undefined] }, 'value.list[1]'],
    [{ f: () => 1 }, 'value.f'],
  ]
  for (const [value, path] of cases) {
    try {
      assertJsonSafe(value)
      throw new Error(`${path} passed`)
    } catch (error) {
      expect(error).toBeInstanceOf(NotJsonSafe)
      expect((error as NotJsonSafe).path).toBe(path)
    }
  }
})
