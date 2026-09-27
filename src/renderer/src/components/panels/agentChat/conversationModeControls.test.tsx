import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { ConversationModeControls, nextConversationEffort } from './conversationModeControls'
import { MOCK_CONVERSATION_CAPABILITIES } from '../../../../../main/providers/mock-conversation-provider'

test('capability-disabled mode controls render nothing and effort cycles through the adapter default', () => {
  expect(
    renderToStaticMarkup(
      <ConversationModeControls
        capabilities={{ ...MOCK_CONVERSATION_CAPABILITIES, planMode: false, reasoningEfforts: null }}
        mode="default"
        compact={false}
        onMode={() => undefined}
        onEffort={() => undefined}
      />,
    ),
  ).toBe('')
  expect(nextConversationEffort(['low', 'high'])).toBe('low')
  expect(nextConversationEffort(['low', 'high'], 'low')).toBe('high')
  expect(nextConversationEffort(['low', 'high'], 'high')).toBeUndefined()
  expect(nextConversationEffort([], 'high')).toBeUndefined()
})
