import { expect, test } from 'vitest'

import { isBenignRendererError } from './rendererErrors'

test("Chromium's ResizeObserver loop notice is not a renderer error", () => {
  expect(isBenignRendererError('ResizeObserver loop completed with undelivered notifications.')).toBe(true)
})

test('every other message, near misses included, is still reported', () => {
  expect(isBenignRendererError('ResizeObserver loop limit exceeded')).toBe(false)
  expect(isBenignRendererError('ResizeObserver loop completed with undelivered notifications')).toBe(false)
  expect(isBenignRendererError('Uncaught TypeError: x is not a function')).toBe(false)
  expect(isBenignRendererError('')).toBe(false)
  expect(isBenignRendererError(undefined)).toBe(false)
})
