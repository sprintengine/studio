import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

import { createStudioConnectionApi } from './studio-connection'

// The preload keeps a connection's port and lends the page functions over it:
// whichever of the port and the answer naming it arrives first, the page gets
// a connection id and a ticket, never the port.

class FakePort extends EventTarget {
  sent: unknown[] = []
  started = false
  closed = false
  postMessage(data: unknown) {
    this.sent.push(data)
  }
  start() {
    this.started = true
  }
  close() {
    this.closed = true
  }
}

function harness(order: 'port-first' | 'answer-first') {
  let deliver!: (event: { ports: FakePort[] }, payload: unknown) => void
  const port = new FakePort()
  const ipc = {
    on: (_channel: string, listener: typeof deliver) => {
      deliver = listener
    },
    invoke: async () => {
      if (order === 'port-first') deliver({ ports: [port] }, { connectionId: 'w1' })
      else queueMicrotask(() => deliver({ ports: [port] }, { connectionId: 'w1' }))
      return { connectionId: 'w1', ticket: 'seport_ticket_000000000000' }
    },
  }
  return { api: createStudioConnectionApi(ipc as never, { mode: 'studio' }), port }
}

test('a connection is the page’s once its port is here, whichever arrived first', async () => {
  for (const order of ['port-first', 'answer-first'] as const) {
    const { api, port } = harness(order)
    assert.equal(api.studioChatTransport, 'studio')
    assert.deepEqual(await api.studioConnect(), { connectionId: 'w1', ticket: 'seport_ticket_000000000000' })
    const frames: string[] = []
    let ended = 0
    api.studioPortListen(
      'w1',
      (frame) => frames.push(frame),
      () => ended++,
    )
    assert.equal(port.started, true, `${order}: frames flow once the page listens`)
    port.dispatchEvent(new MessageEvent('message', { data: '{"t":"welcome"}' }))
    port.dispatchEvent(new MessageEvent('message', { data: { not: 'text' } }))
    assert.deepEqual(frames, ['{"t":"welcome"}'])
    api.studioPortSend('w1', '{"t":"req"}')
    assert.deepEqual(port.sent, ['{"t":"req"}'])
    port.dispatchEvent(new Event('close'))
    assert.equal(ended, 1)
    api.studioPortSend('w1', '{"t":"late"}')
    assert.deepEqual(port.sent, ['{"t":"req"}'], `${order}: a closed connection sends nothing`)
  }
})

test('a port that never comes fails the connect, and an unknown connection is closed at once', async () => {
  vi.useFakeTimers()
  try {
    const api = createStudioConnectionApi(
      { on: () => undefined, invoke: async () => ({ connectionId: 'w9', ticket: 'seport_ticket_000000000000' }) },
      { portWaitMs: 50 },
    )
    assert.equal(api.studioChatTransport, 'ipc', 'the IPC stays the default')
    const connecting = api.studioConnect()
    const failed = assert.rejects(connecting, /did not hand this window its connection/)
    await vi.advanceTimersByTimeAsync(60)
    await failed
    let ended = 0
    api.studioPortListen(
      'nope',
      () => undefined,
      () => ended++,
    )
    assert.equal(ended, 1)
  } finally {
    vi.useRealTimers()
  }
})
