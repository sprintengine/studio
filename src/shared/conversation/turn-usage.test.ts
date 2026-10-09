import { expect, test } from 'vitest'

import { addTurnUsage, turnUsageOf } from './turn-usage'

test('a usage keeps the counts that are there and leaves out the rest', () => {
  expect(turnUsageOf({ inputTokens: 10, outputTokens: 2 })).toEqual({ inputTokens: 10, outputTokens: 2 })
  expect(turnUsageOf({ inputTokens: -1, outputTokens: Number.NaN, cacheReadTokens: '4' })).toBeNull()
  expect(turnUsageOf({ cacheWriteTokens: 0 })).toEqual({ cacheWriteTokens: 0 })
  expect(turnUsageOf({})).toBeNull()
})

test('usages add member by member, and a member either reports is in the sum', () => {
  expect(addTurnUsage(null, null)).toBeNull()
  expect(addTurnUsage(null, { inputTokens: 1 })).toEqual({ inputTokens: 1 })
  expect(addTurnUsage({ inputTokens: 1, cacheReadTokens: 5 }, { inputTokens: 2, outputTokens: 3 })).toEqual({
    inputTokens: 3,
    outputTokens: 3,
    cacheReadTokens: 5,
  })
  const total = { inputTokens: 1 }
  addTurnUsage(total, { inputTokens: 1 })
  expect(total).toEqual({ inputTokens: 1 }, 'neither side is changed')
})
