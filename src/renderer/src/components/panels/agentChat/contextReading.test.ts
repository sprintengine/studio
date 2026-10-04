import { expect, test } from 'vitest'

import { conversationContextReading } from './contextReading'

test('the runtime’s own window and spend come first', () => {
  expect(
    conversationContextReading({
      usage: { inputTokens: 124_000, outputTokens: 900, contextWindow: 200_000, contextUsed: 64_900 },
      catalogWindow: 1_000_000,
      providerContextLength: 128_000,
    }),
  ).toEqual({ used: 64_900, total: 200_000 })
})

test('without a reported window, the CLI catalog’s window for the model, then the provider’s context length', () => {
  const usage = { inputTokens: 30_000, outputTokens: 1_000, contextUsed: 31_000 }
  expect(conversationContextReading({ usage, catalogWindow: 272_000, providerContextLength: 128_000 })).toEqual({
    used: 31_000,
    total: 272_000,
  })
  expect(conversationContextReading({ usage, catalogWindow: null, providerContextLength: 128_000 })).toEqual({
    used: 31_000,
    total: 128_000,
  })
})

test('a provider that reports no spend of its own is read off the last exchange', () => {
  expect(
    conversationContextReading({ usage: { inputTokens: 184_000, outputTokens: 0 }, providerContextLength: 200_000 }),
  ).toEqual({ used: 184_000, total: 200_000 })
})

test('no window, no report, or nothing spent yet is no reading', () => {
  expect(conversationContextReading({ usage: null, catalogWindow: 200_000 })).toBeNull()
  expect(conversationContextReading({ usage: { inputTokens: 10, outputTokens: 2 } })).toBeNull()
  expect(conversationContextReading({ usage: { inputTokens: 0, outputTokens: 0 }, catalogWindow: 200_000 })).toBeNull()
})
