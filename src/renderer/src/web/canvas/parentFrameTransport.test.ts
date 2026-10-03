import { expect, test } from 'vitest'

import { CANVAS_FRAME_CHANNEL } from './frameProtocol'
import { hasSameOriginParent, startParentFrameTransport } from './parentFrameTransport'

// The worker document's end, as a web tab's hidden frame.

function frameView(parentOrigin: string) {
  const posted: Array<{ message: unknown; origin: string }> = []
  const listeners: Array<(event: MessageEvent) => void> = []
  const parent = {
    location: { origin: parentOrigin },
    postMessage: (message: unknown, origin: string) => void posted.push({ message, origin }),
  }
  const view = {
    parent,
    location: { origin: 'http://127.0.0.1:4791' },
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => void listeners.push(listener),
    removeEventListener: () => undefined,
  } as unknown as Window
  const send = (data: unknown, origin = 'http://127.0.0.1:4791', source: unknown = parent) =>
    listeners.forEach((listener) => listener({ data, origin, source } as MessageEvent))
  return { view, posted, send }
}

test('a frame serves only a parent of its own origin', () => {
  expect(hasSameOriginParent(frameView('http://127.0.0.1:4791').view)).toBe(true)
  expect(hasSameOriginParent(frameView('https://elsewhere.example').view)).toBe(false)
  const top = { location: { origin: 'http://127.0.0.1:4791' } } as unknown as Window & { parent: Window }
  ;(top as { parent: unknown }).parent = top
  expect(hasSameOriginParent(top)).toBe(false)
})

test('it says ready to its parent, serves requests one at a time, and ignores anyone else', async () => {
  const frame = frameView('http://127.0.0.1:4791')
  const served: string[] = []
  startParentFrameTransport(
    async (request, respond) => {
      served.push(request.requestId)
      respond({ requestId: request.requestId, ok: true } as never)
    },
    { loaded: [], missing: [], errors: [] },
    frame.view,
  )
  expect(frame.posted[0]).toEqual({
    message: { channel: CANVAS_FRAME_CHANNEL, type: 'ready', report: { loaded: [], missing: [], errors: [] } },
    origin: 'http://127.0.0.1:4791',
  })
  frame.send({ channel: CANVAS_FRAME_CHANNEL, type: 'request', request: { requestId: 'a' } })
  frame.send(
    { channel: CANVAS_FRAME_CHANNEL, type: 'request', request: { requestId: 'b' } },
    'https://elsewhere.example',
  )
  frame.send({ channel: CANVAS_FRAME_CHANNEL, type: 'request', request: { requestId: 'c' } }, undefined, {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(served).toEqual(['a'])
  expect(frame.posted.at(-1)?.message).toEqual({
    channel: CANVAS_FRAME_CHANNEL,
    type: 'response',
    response: { requestId: 'a', ok: true },
  })
})
