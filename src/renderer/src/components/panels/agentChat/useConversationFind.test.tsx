// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'

import { useThrottledWhileOpen } from './useConversationFind'

// While a reply streams, every token is a new transcript; the find searches it
// at most every quarter second, and always ends on the latest.

afterEach(() => vi.useRealTimers())

test('an open find takes the streaming transcript at most every 250 ms, and the last one always', async () => {
  vi.useFakeTimers()
  const seen: string[] = []
  function Probe({ value, open }: { value: string; open: boolean }) {
    seen.push(useThrottledWhileOpen(value, open))
    return null
  }
  const host = document.createElement('div')
  const root = createRoot(host)
  await act(async () => root.render(<Probe value="t0" open />))
  for (let token = 1; token <= 10; token++) {
    await act(async () => {
      root.render(<Probe value={`t${token}`} open />)
      vi.advanceTimersByTime(20)
    })
  }
  // Ten tokens in 200 ms: the search moved on far fewer times than that.
  const taken = new Set(seen)
  expect(taken.size).toBeLessThan(5)
  await act(async () => vi.advanceTimersByTime(300))
  expect(seen.at(-1), 'and caught up with the last').toBe('t10')
  // Closed, it reads the value as it is, with no wait.
  await act(async () => root.render(<Probe value="t11" open={false} />))
  expect(seen.at(-1)).toBe('t11')
  await act(async () => root.unmount())
})
