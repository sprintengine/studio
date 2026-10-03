// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { ConversationView } from '../src/ConversationView.js'
import { safeTokenValue, themeStyle } from '../src/theme.js'
import type { ConversationFollowSource } from '../src/timeline.js'

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
})

const event = (seq: number, type: string, payload: Record<string, unknown>) => ({
  id: `e${seq}`,
  sessionId: 's1',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  providerId: 'mock-provider',
  type,
  createdAt: 1_000 + seq,
  seq,
  payload,
})

function source(): ConversationFollowSource {
  return {
    follow: (_ref, _options, onFrame) => {
      queueMicrotask(() => {
        onFrame({
          type: 'snapshot',
          page: {
            events: [
              event(1, 'user_message', { turnId: 't1', text: 'Is the build green?' }),
              event(2, 'turn_started', { turnId: 't1' }),
              event(3, 'content_delta', {
                turnId: 't1',
                text: 'Yes. See [the run](https://example.com/run) and `npm test`.',
              }),
              event(4, 'turn_completed', { turnId: 't1' }),
            ],
            hasMore: false,
            beforeCursor: null,
          },
        } as never)
        onFrame({ type: 'synchronized', seq: 4 })
      })
      return () => undefined
    },
    loadEarlier: async () => ({ ok: false, message: 'none' }),
  }
}

test('draws a conversation read-only in a shadow root of its own, links going to the page', async () => {
  const onLink = vi.fn()
  await act(async () =>
    root?.render(
      <ConversationView source={source()} conversation={{ workspaceId: 'ws-1', agentId: 'agent-1' }} onLink={onLink} />,
    ),
  )
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  const shadow = host?.querySelector('div')?.shadowRoot
  expect(shadow).toBeTruthy()
  // Nothing of it leaks into the page's own DOM.
  expect(host?.textContent).toBe('')
  const text = shadow?.textContent ?? ''
  expect(text).toContain('Is the build green?')
  expect(text).toContain('npm test')
  expect(shadow?.querySelector('button, input, textarea, form')).toBeNull()
  const link = shadow?.querySelector('a') as HTMLAnchorElement
  await act(async () => link.click())
  expect(onLink).toHaveBeenCalledWith('https://example.com/run')
})

test('agent-written markup is text, never HTML', async () => {
  const unsafe: ConversationFollowSource = {
    ...source(),
    follow: (_ref, _options, onFrame) => {
      queueMicrotask(() => {
        onFrame({
          type: 'snapshot',
          page: {
            events: [event(1, 'user_message', { turnId: 't1', text: '<img src=x onerror=alert(1)>' })],
            hasMore: false,
            beforeCursor: null,
          },
        } as never)
        onFrame({ type: 'synchronized', seq: 1 })
      })
      return () => undefined
    },
  }
  await act(async () =>
    root?.render(
      <ConversationView source={unsafe} conversation={{ workspaceId: 'ws-1', agentId: 'agent-1' }} isolation="none" />,
    ),
  )
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  expect(host?.querySelector('img')).toBeNull()
  expect(host?.textContent).toContain('<img src=x onerror=alert(1)>')
})

test('a token value cannot escape its declaration', () => {
  expect(safeTokenValue('#123456')).toBe('#123456')
  expect(safeTokenValue('red; } body { display: none')).toBeNull()
  expect(themeStyle('dark', { bg: '#000000' })['--se-bg']).toBe('#000000')
  expect(themeStyle('light', { bg: 'red;}' })['--se-bg']).toBe('#eaeef2')
})
