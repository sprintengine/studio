import { expect, test, vi } from 'vitest'

import { postToHost, readHostMessage } from './embedProtocol'

const parent = { name: 'parent' }
const origins = ['https://dashboard.example.com']
const from = (data: unknown, overrides: Partial<{ origin: string; source: unknown }> = {}) => ({
  origin: 'https://dashboard.example.com',
  source: parent,
  data,
  ...overrides,
})

test('a message from the parent on a registered origin, in a known shape, is accepted', () => {
  expect(readHostMessage(from({ v: 1, type: 'theme', mode: 'dark' }), origins, parent)).toEqual({
    kind: 'accept',
    message: { v: 1, type: 'theme', mode: 'dark' },
  })
})

test('the wrong origin, or another window on the right one, is ignored', () => {
  expect(
    readHostMessage(from({ v: 1, type: 'theme', mode: 'dark' }, { origin: 'https://evil.example' }), origins, parent)
      .kind,
  ).toBe('ignore')
  expect(readHostMessage(from({ v: 1, type: 'theme', mode: 'dark' }, { source: {} }), origins, parent).kind).toBe(
    'ignore',
  )
})

test('an unknown type is ignored, an unknown version refused, an oversized message dropped', () => {
  expect(readHostMessage(from({ v: 1, type: 'send', message: 'hi' }), origins, parent).kind).toBe('ignore')
  expect(readHostMessage(from({ v: 2, type: 'theme', mode: 'dark' }), origins, parent)).toEqual({
    kind: 'refuse',
    code: 'unsupported_version',
  })
  expect(readHostMessage(from({ v: 1, type: 'scrollTo', turnId: 'x'.repeat(20_000) }), origins, parent).kind).toBe(
    'ignore',
  )
  expect(readHostMessage(from({ v: 1, type: 'token', token: 'not-a-token' }), origins, parent).kind).toBe('ignore')
})

test('the iframe posts to its registered origins only, never to every origin', () => {
  const target = { postMessage: vi.fn() }
  postToHost({ v: 1, type: 'ready', embedId: 'e1' }, origins, target)
  expect(target.postMessage).toHaveBeenCalledWith(
    { v: 1, type: 'ready', embedId: 'e1' },
    'https://dashboard.example.com',
  )
  expect(target.postMessage.mock.calls.every(([, origin]) => origin !== '*')).toBe(true)
  const silent = { postMessage: vi.fn() }
  postToHost({ v: 1, type: 'ready', embedId: 'e1' }, [], silent)
  expect(silent.postMessage).not.toHaveBeenCalled()
})
