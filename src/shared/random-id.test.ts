import { expect, test } from 'vitest'
import { prefixedId, randomId } from './random-id'

test('an id is the requested number of random bytes in hex', () => {
  expect(randomId()).toMatch(/^[0-9a-f]{24}$/u)
  expect(randomId(6)).toMatch(/^[0-9a-f]{12}$/u)
  expect(randomId()).not.toBe(randomId())
})

test('a prefixed id says what minted it', () => {
  expect(prefixedId('ssh', 6)).toMatch(/^ssh-[0-9a-f]{12}$/u)
})
