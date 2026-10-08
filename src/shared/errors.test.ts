import { expect, test } from 'vitest'
import { errorMessage } from './errors'

test('an Error says its message, whatever the fallback', () => {
  expect(errorMessage(new Error('disk full'))).toBe('disk full')
  expect(errorMessage(new TypeError('bad'), 'Something failed.')).toBe('bad')
})

test('anything else is the value as a string, or the fallback when one is given', () => {
  expect(errorMessage('plain words')).toBe('plain words')
  expect(errorMessage(42)).toBe('42')
  expect(errorMessage(undefined)).toBe('undefined')
  expect(errorMessage({ code: 'EIO' }, 'Unknown error.')).toBe('Unknown error.')
})
