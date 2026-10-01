import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test, vi } from 'vitest'

import type { StudioFramePort } from '../../server/rpc/studio-frame-port'

// Main's half of a window's connection: a channel per connection, its port
// sent only to an app window's own document, the frames of main's end handed
// to the Studio RPC, and a window that keeps opening connections held to a few.

class FakePort extends EventEmitter {
  other: FakePort | null = null
  sent: string[] = []
  closed = false
  started = false
  postMessage(data: string) {
    this.sent.push(data)
  }
  start() {
    this.started = true
  }
  close() {
    if (this.closed) return
    this.closed = true
    // Electron tells the far end; this end hears nothing of its own close.
    this.other?.emit('close')
  }
}

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  MessageChannelMain: class {
    port1 = new FakePort()
    port2 = new FakePort()
    constructor() {
      this.port1.other = this.port2
      this.port2.other = this.port1
    }
  },
  BrowserWindow: { fromWebContents: (sender: { window?: object }) => sender.window ?? null },
}))

const appUrl = 'file:///Applications/SprintEngine%20Studio.app/Contents/Resources/app.asar/out/renderer/index.html'

function windowEvent(id: number, options: { url?: string; parent?: object | null } = {}) {
  const posted: Array<{ channel: string; payload: unknown; ports: FakePort[] }> = []
  const sender = Object.assign(new EventEmitter(), {
    id,
    window: {},
    postMessage: (channel: string, payload: unknown, ports: FakePort[]) => posted.push({ channel, payload, ports }),
  })
  return { event: { sender, senderFrame: { parent: options.parent ?? null, url: options.url ?? appUrl } }, posted }
}

async function register() {
  const { registerStudioConnectionIpc } = await import('./studio-connection-ipc')
  const connected: StudioFramePort[] = []
  registerStudioConnectionIpc(
    {
      handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      },
    } as never,
    {
      connectWindow: (port) => {
        connected.push(port)
        return { connectionId: `w${connected.length}`, ticket: `seport_ticket_${connected.length}_000000000000` }
      },
    },
  )
  return { connect: handlers.get('studio:connect')!, connected }
}

test('an app window is handed its end of a new channel, and main serves the other', async () => {
  const { connect, connected } = await register()
  const { event, posted } = windowEvent(7)
  const answer = connect(event) as { connectionId: string; ticket: string }
  assert.deepEqual(answer, { connectionId: 'w1', ticket: 'seport_ticket_1_000000000000' })
  assert.equal(posted.length, 1)
  assert.equal(posted[0].channel, 'studio:port')
  assert.deepEqual(posted[0].payload, { connectionId: 'w1' }, 'the ticket is not sent beside the port')
  const windowEnd = posted[0].ports[0]
  const mainEnd = windowEnd.other!
  // Frames posted by the RPC go out on main's end; what the window sends is heard.
  const heard: string[] = []
  connected[0].onFrame((frame) => heard.push(frame))
  assert.equal(mainEnd.started, true)
  connected[0].post('{"t":"welcome"}')
  assert.deepEqual(mainEnd.sent, ['{"t":"welcome"}'])
  mainEnd.emit('message', { data: '{"t":"req"}' })
  mainEnd.emit('message', { data: { not: 'a frame' } })
  assert.deepEqual(heard, ['{"t":"req"}'])
  // A reload or a closed window ends the connection.
  let ended = 0
  connected[0].onClose(() => ended++)
  windowEnd.close()
  assert.equal(ended, 1)
  connected[0].post('{"t":"late"}')
  assert.deepEqual(mainEnd.sent, ['{"t":"welcome"}'], 'nothing goes out once it is closed')
})

test('a subframe, a page the window navigated to, or a guest is given no connection', async () => {
  const { connect, connected } = await register()
  assert.throws(() => connect(windowEvent(1, { parent: {} }).event), /did not come from a SprintEngine Studio window/)
  assert.throws(() => connect(windowEvent(2, { url: 'https://example.com/' }).event), /SprintEngine Studio window/)
  const guest = windowEvent(3)
  ;(guest.event.sender as { window?: object }).window = undefined
  assert.throws(() => connect(guest.event), /SprintEngine Studio window/)
  assert.equal(connected.length, 0)
})

test('a window that keeps connecting is held to a few connections, the oldest closed first', async () => {
  const { connect, connected } = await register()
  const { event } = windowEvent(9)
  const closes: number[] = []
  for (let index = 0; index < 6; index++) {
    connect(event)
    const at = connected.length - 1
    connected[at].onClose(() => closes.push(at))
  }
  assert.deepEqual(closes, [0, 1])
})
