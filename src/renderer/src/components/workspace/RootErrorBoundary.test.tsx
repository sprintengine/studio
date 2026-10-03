// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { RootErrorBoundary } from './RootErrorBoundary'

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
  vi.restoreAllMocks()
})

function Throws(): React.ReactNode {
  throw new Error('a reply in a shape nobody expected')
}

test('a render that throws leaves a recovery surface instead of a blank window', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const onReload = vi.fn()
  await act(async () =>
    root?.render(
      <RootErrorBoundary onReload={onReload}>
        <Throws />
      </RootErrorBoundary>,
    ),
  )
  const alert = host?.querySelector('[role="alert"]')
  expect(alert?.textContent).toContain('Studio hit a problem')
  const reload = [...(host?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Reload window')
  expect(reload).toBeDefined()
  await act(async () => reload?.click())
  expect(onReload).toHaveBeenCalledOnce()
  expect(logged.mock.calls.some(([tag]) => tag === '[RendererError]')).toBe(true)
})

test('children that render are drawn as they are', async () => {
  await act(async () =>
    root?.render(
      <RootErrorBoundary>
        <p>still here</p>
      </RootErrorBoundary>,
    ),
  )
  expect(host?.textContent).toBe('still here')
})
