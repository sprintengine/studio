// @vitest-environment jsdom
import React, { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { FindBar, type FindBarProps } from './FindBar'

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { api: unknown }).api = { platform: 'darwin' }
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function mount(overrides: Partial<FindBarProps> = {}) {
  const props: FindBarProps = {
    label: 'Find in chat',
    query: 'deploy',
    onQueryChange: vi.fn(),
    status: '2 of 7',
    hasMatches: true,
    onNext: vi.fn(),
    onPrevious: vi.fn(),
    onClose: vi.fn(),
    inputRef: createRef<HTMLInputElement>(),
    ...overrides,
  }
  host = document.createElement('div')
  document.body.append(host)
  const created = createRoot(host)
  root = created
  await act(async () => created.render(<FindBar {...props} />))
  const input = host.querySelector('input')!
  const press = (key: string, init: KeyboardEventInit = {}) =>
    act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
    })
  return { props, input, press }
}

test('the bar is a labelled search region whose count is announced politely', async () => {
  const { input } = await mount({ rootAttributes: { 'data-terminal-chrome': '' } })
  const region = host!.querySelector('[role="search"]')!
  expect(region.getAttribute('aria-label')).toBe('Find in chat')
  expect(region.hasAttribute('data-terminal-chrome')).toBe(true)
  expect(input.getAttribute('aria-label')).toBe('Find in chat')
  const status = host!.querySelector('[aria-live="polite"]')!
  expect(status.textContent).toBe('2 of 7')
})

test('Enter steps forward, Shift+Enter back, Primary+G forward, and Escape closes', async () => {
  const { props, press } = await mount()
  await press('Enter')
  expect(props.onNext).toHaveBeenCalledTimes(1)
  await press('Enter', { shiftKey: true })
  expect(props.onPrevious).toHaveBeenCalledTimes(1)
  await press('g', { code: 'KeyG', metaKey: true })
  expect(props.onNext).toHaveBeenCalledTimes(2)
  // Primary+Shift+G is the Git panel's; the bar leaves it alone.
  await press('G', { code: 'KeyG', metaKey: true, shiftKey: true })
  expect(props.onPrevious).toHaveBeenCalledTimes(1)
  await press('Escape')
  expect(props.onClose).toHaveBeenCalledTimes(1)
})

test('with nothing to step to, the step buttons are disabled', async () => {
  await mount({ hasMatches: false, status: 'No results' })
  expect(host!.querySelector<HTMLButtonElement>('button[aria-label="Previous match"]')!.disabled).toBe(true)
  expect(host!.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!.disabled).toBe(true)
  expect(host!.querySelector<HTMLButtonElement>('button[aria-label="Close find"]')!.disabled).toBe(false)
})
