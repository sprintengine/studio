// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'

import type { CanvasWorkerResponse } from '../../../../shared/canvas/worker-protocol'
import { CANVAS_FRAME_CHANNEL, readFrameMessage } from './frameProtocol'
import { createFrameWorkerTransport } from './frameWorkerTransport'

afterEach(() => {
  document.body.replaceChildren()
  vi.useRealTimers()
})

function frame(): HTMLIFrameElement {
  const found = document.querySelector('iframe')
  if (!found) throw new Error('no worker frame')
  return found
}

function fromFrame(data: unknown, origin = window.location.origin, source: unknown = frame().contentWindow): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: source as Window }))
}

test('the worker frame is laid out off-screen, and ready is the handshake with its fonts report', async () => {
  const transport = createFrameWorkerTransport({ src: () => 'about:blank' })
  const started = transport.ensureStarted()
  expect(frame().getAttribute('aria-hidden')).toBe('true')
  expect(frame().style.width).toBe('800px')
  fromFrame({
    channel: CANVAS_FRAME_CHANNEL,
    type: 'ready',
    report: { loaded: ['Excalifont'], missing: [], errors: [] },
  })
  await started
  expect(transport.report()?.loaded).toEqual(['Excalifont'])
})

test('a message from another origin, another window or off the wire is not heard', async () => {
  const transport = createFrameWorkerTransport({ src: () => 'about:blank', readyTimeoutMs: 50 })
  const started = transport.ensureStarted()
  const ready = { channel: CANVAS_FRAME_CHANNEL, type: 'ready', report: {} }
  fromFrame(ready, 'https://elsewhere.example')
  fromFrame(ready, window.location.origin, window)
  fromFrame({ ...ready, channel: 'something-else' })
  await expect(started).rejects.toThrow(/did not report ready/u)
  expect(document.querySelector('iframe')).toBeNull()
})

test('responses reach the host, and a stop removes the frame without counting as a crash', async () => {
  const transport = createFrameWorkerTransport({ src: () => 'about:blank' })
  const started = transport.ensureStarted()
  fromFrame({ channel: CANVAS_FRAME_CHANNEL, type: 'ready', report: {} })
  await started
  const heard: CanvasWorkerResponse[] = []
  const crashes: string[] = []
  transport.onResponse((response) => heard.push(response))
  transport.onCrashed((reason) => crashes.push(reason))
  const posted = vi.spyOn(frame().contentWindow!, 'postMessage')
  transport.post({ requestId: 'r1', kind: 'lint' } as never)
  expect(posted).toHaveBeenCalledWith(
    { channel: CANVAS_FRAME_CHANNEL, type: 'request', request: { requestId: 'r1', kind: 'lint' } },
    window.location.origin,
  )
  fromFrame({ channel: CANVAS_FRAME_CHANNEL, type: 'response', response: { requestId: 'r1', ok: true } })
  expect(heard).toEqual([{ requestId: 'r1', ok: true }])
  transport.stop()
  expect(document.querySelector('iframe')).toBeNull()
  expect(crashes).toEqual([])
  expect(() => transport.post({ requestId: 'r2' } as never)).toThrow(/gone/u)
})

test('the wire reads only its own shapes', () => {
  const expected = { source: null, origin: 'http://localhost' }
  const event = (data: unknown) => ({ data, origin: 'http://localhost', source: null })
  expect(readFrameMessage(event({ channel: CANVAS_FRAME_CHANNEL, type: 'request', request: {} }), expected)).toBeNull()
  expect(readFrameMessage(event({ channel: CANVAS_FRAME_CHANNEL, type: 'shutdown' }), expected)).toBeNull()
  expect(
    readFrameMessage(
      event({ channel: CANVAS_FRAME_CHANNEL, type: 'ready', report: { loaded: [1, 'Nunito'] } }),
      expected,
    ),
  ).toEqual({ channel: CANVAS_FRAME_CHANNEL, type: 'ready', report: { loaded: ['Nunito'], missing: [], errors: [] } })
})
