import { afterEach, expect, test } from 'vitest'

import type { UsageLimitsState } from '../../../shared/usage-limits'
import { retainUsageLimits, useUsageLimitsStore, usageLimitProviderOf } from './usageLimitsStore'

const state = (percent: number): UsageLimitsState => ({
  snapshots: [
    {
      provider: 'claude',
      billing: 'subscription',
      observedAt: 1,
      windows: [
        {
          id: 'five_hour',
          label: 'Session (5h)',
          usedPercent: percent,
          resetsAt: null,
          status: 'allowed',
          observedAt: 1,
        },
      ],
    },
  ],
})

function fakeApi(answer: Promise<UsageLimitsState>) {
  const listeners = new Set<(state: UsageLimitsState) => void>()
  let reads = 0
  return {
    api: {
      usageLimits: () => {
        reads += 1
        return answer
      },
      onUsageLimitsChanged: (listener: (state: UsageLimitsState) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    push: (next: UsageLimitsState) => listeners.forEach((listener) => listener(next)),
    get listeners() {
      return listeners.size
    },
    get reads() {
      return reads
    },
  }
}

afterEach(() => useUsageLimitsStore.setState({ state: null }))

test('the push is held while anything draws the limits, once, and let go with the last', async () => {
  const fake = fakeApi(Promise.resolve(state(10)))
  const first = retainUsageLimits(fake.api)
  const second = retainUsageLimits(fake.api)
  expect(fake.reads).toBe(1)
  expect(fake.listeners).toBe(1)
  await Promise.resolve()
  expect(useUsageLimitsStore.getState().state).toEqual(state(10))
  first()
  first()
  expect(fake.listeners).toBe(1)
  second()
  expect(fake.listeners).toBe(0)
})

test('a push that lands before the first read answers is not overwritten by it', async () => {
  let answer!: (state: UsageLimitsState) => void
  const fake = fakeApi(new Promise((resolve) => (answer = resolve)))
  const release = retainUsageLimits(fake.api)
  fake.push(state(40))
  answer(state(10))
  await Promise.resolve()
  await Promise.resolve()
  expect(useUsageLimitsStore.getState().state).toEqual(state(40))
  release()
})

test('only the Claude and Codex chats have plan limits here', () => {
  expect(usageLimitProviderOf('claude-agent')).toBe('claude')
  expect(usageLimitProviderOf('codex-agent')).toBe('codex')
  expect(usageLimitProviderOf('openai-compatible')).toBe(null)
  expect(usageLimitProviderOf(undefined)).toBe(null)
})
