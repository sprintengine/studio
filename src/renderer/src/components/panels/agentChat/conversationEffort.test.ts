import { expect, test } from 'vitest'
import { nextConversationEffort } from './conversationEffort'

test('effort cycles through the levels and back to the CLI default', () => {
  expect(nextConversationEffort(['low', 'high'])).toBe('low')
  expect(nextConversationEffort(['low', 'high'], 'low')).toBe('high')
  expect(nextConversationEffort(['low', 'high'], 'high')).toBeUndefined()
  expect(nextConversationEffort([], 'high')).toBeUndefined()
})
