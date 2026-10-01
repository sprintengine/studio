import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, test, vi } from 'vitest'

import { openRemoteConversationSocket } from './tailnet-remote-client'
import { TAILNET_CONVERSATION_PATH, TAILNET_WS_TICKET_PATH } from './tailnet-routes'
import {
  computeWebSocketAcceptKey,
  createWebSocketFrameDecoder,
  encodePingFrame,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  WEBSOCKET_TCP_KEEPALIVE_MS,
} from './websocket-frames'

// The conversation socket's liveness, against a listener that is only as much
// of one as the socket needs: a ticket, an upgrade, and pings when the test
// says. This end listens; it never pings.

type Far = {
  server: Server
  port: number
  /** The far end's side of the upgraded socket, once there is one. */
  socket: () => Socket | null
  /** Control frames this end sent, by kind. */
  received: { ping: number; pong: number }
}

let far: Far | null = null

afterEach(async () => {
  vi.restoreAllMocks()
  far?.socket()?.destroy()
  await new Promise<void>((resolve) => far?.server.close(() => resolve()) ?? resolve())
  far = null
})

async function startFar(): Promise<Far> {
  let upgraded: Socket | null = null
  const received = { ping: 0, pong: 0 }
  const server = createServer((request, response) => {
    if (request.url === TAILNET_WS_TICKET_PATH) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ticket: 'ticket' }))
      return
    }
    response.writeHead(404).end()
  })
  server.on('upgrade', (request, socket: Socket) => {
    assert.ok(request.url?.startsWith(TAILNET_CONVERSATION_PATH))
    const key = String(request.headers['sec-websocket-key'])
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${computeWebSocketAcceptKey(key)}`,
        '',
        '',
      ].join('\r\n'),
    )
    const decoder = createWebSocketFrameDecoder(MAX_WEBSOCKET_MESSAGE_BYTES, 'server')
    socket.on('data', (chunk: Buffer) => {
      const decoded = decoder.push(chunk)
      if (decoded.kind === 'error') return
      for (const frame of decoded.frames) {
        if (frame.kind === 'ping') received.ping += 1
        if (frame.kind === 'pong') received.pong += 1
      }
    })
    socket.on('error', () => undefined)
    upgraded = socket
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, port: address.port, socket: () => upgraded, received }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('a conversation socket listens for the far end instead of pinging it, and ends when the far end goes quiet', async () => {
  far = await startFar()
  const keepAlive = vi.spyOn((await import('node:net')).Socket.prototype, 'setKeepAlive')
  const closes: string[] = []
  const opened = await openRemoteConversationSocket({
    endpoint: { host: '127.0.0.1', port: far.port },
    token: 'token',
    livenessTimeoutMs: 400,
    handlers: { onFrame: () => undefined, onClosed: ({ reason }) => closes.push(reason) },
  })
  assert.ok(opened.ok, opened.ok ? '' : opened.message)
  assert.ok(
    keepAlive.mock.calls.some(([enable, delay]) => enable === true && delay === WEBSOCKET_TCP_KEEPALIVE_MS),
    'the kernel watches the connection',
  )

  // The far end pings well inside the window: the link stays up, and this end
  // only answers.
  const beat = setInterval(() => far?.socket()?.write(encodePingFrame()), 40)
  try {
    await sleep(900)
    assert.equal(opened.value.isOpen(), true, 'a far end that keeps pinging keeps the link')
    assert.equal(far.received.ping, 0, 'this end never pings')
    assert.ok(far.received.pong > 0, 'it answers the far end')
  } finally {
    clearInterval(beat)
  }

  // The far end goes quiet without a close (a lid, a dropped route).
  await sleep(1_500)
  assert.equal(opened.value.isOpen(), false, 'silence past the window ends the link')
  assert.deepEqual(closes, ['That machine stopped answering.'])
})
