// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'

import { NARROW_VIEWPORT_QUERY, useNarrowViewport } from './useNarrowViewport'

test('follows the phone-width query as the window crosses it', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  let matches = false
  const listeners = new Set<() => void>()
  window.matchMedia = ((query: string) => {
    expect(query).toBe(NARROW_VIEWPORT_QUERY)
    return {
      get matches() {
        return matches
      },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }
  }) as unknown as typeof window.matchMedia
  const seen: boolean[] = []
  function Probe() {
    seen.push(useNarrowViewport())
    return null
  }
  const host = document.createElement('div')
  const root = createRoot(host)
  await act(async () => root.render(<Probe />))
  expect(seen.at(-1)).toBe(false)
  matches = true
  await act(async () => listeners.forEach((listener) => listener()))
  expect(seen.at(-1)).toBe(true)
  await act(async () => root.unmount())
  expect(listeners.size).toBe(0)
})
