import { expect, test } from 'vitest'
import { isNearConversationEnd } from './useStickToBottom'

test('follow-end threshold keeps scrollback independent from incoming output', () => {
  expect(isNearConversationEnd(0, 300, 600)).toBe(true)
  expect(isNearConversationEnd(700, 1000, 300)).toBe(true)
  expect(isNearConversationEnd(653, 1000, 300)).toBe(true)
  expect(isNearConversationEnd(652, 1000, 300)).toBe(false)
  expect(isNearConversationEnd(0, 1000, 300)).toBe(false)
})
