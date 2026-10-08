// The relay's multiplexer (resources/wsl-server/relay-mux.mjs) in memory:
// both ends over a pair of pipes, as the desktop and an SSH machine's relay
// speak it, with no processes. The relay against a real server and real
// sockets is in detached-start.test.ts.

import assert from 'node:assert/strict'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { PassThrough, type Duplex } from 'node:stream'
import { test } from 'vitest'

import {
  encodeFrame,
  FRAME,
  FrameDecoder,
  INITIAL_WINDOW,
  MAX_DATA,
  MAX_TCP_STREAMS,
  MuxEndpoint,
  serveRelay,
} from '../../../resources/wsl-server/relay-mux.mjs'

/** Two endpoints joined by pipes; `onOpen` serves the far end's streams. */
function pair(onOpen: (request: Record<string, unknown>, stream: Duplex) => Promise<void> | void) {
  const toFar = new PassThrough()
  const toNear = new PassThrough()
  const near = new MuxEndpoint({ input: toNear, output: toFar })
  const far = new MuxEndpoint({ input: toFar, output: toNear, onOpen })
  return { near, far, toFar, toNear }
}

const readAll = (stream: Duplex): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    stream.on('data', (chunk: Buffer) => parts.push(chunk))
    stream.once('end', () => resolve(Buffer.concat(parts)))
    stream.once('error', reject)
  })

test('frames survive being cut anywhere, and a frame no sender writes closes the pipe', () => {
  const frames = Buffer.concat([
    encodeFrame(FRAME.open, 1, '{"kind":"tcp"}'),
    encodeFrame(FRAME.data, 7, Buffer.alloc(1000, 1)),
    encodeFrame(FRAME.fin, 7),
  ])
  for (let cut = 1; cut < frames.length; cut += 97) {
    const decoder = new FrameDecoder()
    const got = [...decoder.push(frames.subarray(0, cut)), ...decoder.push(frames.subarray(cut))]
    assert.deepEqual(
      got.map((frame) => [frame.type, frame.id, frame.payload.length]),
      [
        [FRAME.open, 1, 14],
        [FRAME.data, 7, 1000],
        [FRAME.fin, 7, 0],
      ],
    )
  }
  const huge = Buffer.alloc(4)
  huge.writeUInt32BE(10 * 1024 * 1024, 0)
  assert.throws(() => new FrameDecoder().push(huge), /is not one/u)

  const input = new PassThrough()
  const endpoint = new MuxEndpoint({ input, output: new PassThrough() })
  let reason = ''
  endpoint.onClosed((why: string) => (reason = why))
  input.write(huge)
  assert.match(reason, /is not one/u)
})

test('streams interleave, each whole and in order, half-closed each way', async () => {
  const { near } = pair((request, stream) => {
    // An echo with a tag, so the answers cannot be swapped unnoticed.
    const tag = String(request.host)
    stream.on('data', (chunk: Buffer) => stream.write(Buffer.concat([Buffer.from(tag), chunk])))
    stream.on('end', () => stream.end())
  })
  const streams = await Promise.all(
    ['a', 'b', 'c'].map((host) => near.open({ kind: 'tcp', host, port: 1 }) as Promise<Duplex>),
  )
  const answers = streams.map(readAll)
  for (let round = 0; round < 20; round++) for (const stream of streams) stream.write(`${round};`)
  for (const stream of streams) stream.end()
  const text = (await Promise.all(answers)).map((buffer) => buffer.toString())
  assert.ok(text[0]!.startsWith('a0;'))
  assert.equal(text[1]!.split('b').join('').split(';').filter(Boolean).length, 20)
  assert.ok(!text[2]!.includes('a') && !text[2]!.includes('b'))
})

test('a stream that is not read holds only its own window, not the streams beside it', async () => {
  let stalled: Duplex | null = null
  const { near } = pair((request, stream) => {
    if (request.host === 'stalled') {
      // Never read: the sender must stop at its window.
      stalled = stream
      stream.pause()
      return
    }
    stream.on('data', (chunk: Buffer) => stream.write(chunk))
    stream.on('end', () => stream.end())
  })
  const slow = (await near.open({ kind: 'tcp', host: 'stalled', port: 1 })) as Duplex
  const big = Buffer.alloc(INITIAL_WINDOW * 3, 7)
  let flushed = false
  slow.write(big, () => (flushed = true))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(flushed, false, 'the write waits for credit')
  assert.ok(stalled)

  // The other stream still flows.
  const fast = (await near.open({ kind: 'tcp', host: 'fast', port: 1 })) as Duplex
  const echoed = readAll(fast)
  fast.end(Buffer.alloc(MAX_DATA * 4 + 3, 9))
  assert.equal((await echoed).length, MAX_DATA * 4 + 3)

  // Reading the stalled one lets the rest through.
  const received = readAll(stalled! as Duplex)
  ;(stalled! as Duplex).resume()
  slow.end()
  assert.equal((await received).length, big.length)
  assert.equal(flushed, true)
})

test('a refusal carries its code and words, and a pipe that closes ends every stream', async () => {
  const { near, toNear } = pair((request) => {
    if (request.host === 'nope') throw Object.assign(new Error('Nothing is listening there.'), { code: 'refused' })
  })
  await assert.rejects(near.open({ kind: 'tcp', host: 'nope', port: 1 }), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'refused')
    assert.equal(error.message, 'Nothing is listening there.')
    return true
  })
  const open = (await near.open({ kind: 'tcp', host: 'yes', port: 1 })) as Duplex
  const closed = new Promise<void>((resolve) => open.once('close', () => resolve()))
  toNear.end()
  await closed
  await assert.rejects(near.open({ kind: 'tcp', host: 'yes', port: 1 }), /not connected|closed/u)
})

test("a name that resolves to the relay machine's loopback is refused; localhost and other names are not", async () => {
  const echo: Server = createServer((socket) => socket.pipe(socket))
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
  const port = (echo.address() as AddressInfo).port
  try {
    const toRelay = new PassThrough()
    const fromRelay = new PassThrough()
    const answers: Record<string, Array<{ address: string; family: number }>> = {
      'rebound.example': [{ address: '127.0.0.1', family: 4 }],
      'mapped.example': [{ address: '::ffff:127.0.0.1', family: 6 }],
      'mixed.example': [
        { address: '192.0.2.10', family: 4 },
        { address: '::1', family: 6 },
      ],
      'unspecified.example': [{ address: '0.0.0.0', family: 4 }],
    }
    serveRelay({
      input: toRelay,
      output: fromRelay,
      runDir: '/nonexistent',
      resolve: async (host) => answers[host] ?? Promise.reject(Object.assign(new Error(host), { code: 'ENOTFOUND' })),
    })
    const desktop = new MuxEndpoint({ input: fromRelay, output: toRelay })
    for (const host of Object.keys(answers))
      await assert.rejects(desktop.open({ kind: 'tcp', host, port }), (error: Error & { code?: string }) => {
        assert.equal(error.code, 'refused', host)
        assert.match(error.message, /resolves to this machine's own loopback/u)
        return true
      })
    // Named as the loopback, it is the loopback.
    const named = (await desktop.open({ kind: 'tcp', host: 'localhost', port })) as Duplex
    named.destroy()
    await assert.rejects(desktop.open({ kind: 'tcp', host: 'host.invalid', port: 80 }), { code: 'unreachable' })
  } finally {
    echo.close()
  }
})

test("the relay's tcp streams: opened, a closed port refused, localhost resolved there, the limit", async () => {
  const echo: Server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('data', (chunk) => socket.write(chunk))
    socket.on('end', () => socket.end())
  })
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
  const port = (echo.address() as AddressInfo).port
  const closedPort = await new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const free = (probe.address() as AddressInfo).port
      probe.close(() => resolve(free))
    })
  })
  try {
    const toRelay = new PassThrough()
    const fromRelay = new PassThrough()
    const { stats } = serveRelay({ input: toRelay, output: fromRelay, runDir: '/nonexistent' })
    const desktop = new MuxEndpoint({ input: fromRelay, output: toRelay })

    const stream = (await desktop.open({ kind: 'tcp', host: '127.0.0.1', port })) as Duplex
    const back = readAll(stream)
    stream.end('hello, build-box')
    assert.equal((await back).toString(), 'hello, build-box', 'half-closed: the echo ended after our end')

    const named = (await desktop.open({ kind: 'tcp', host: 'localhost', port })) as Duplex
    const namedBack = readAll(named)
    named.end('by name')
    assert.equal((await namedBack).toString(), 'by name')

    await assert.rejects(desktop.open({ kind: 'tcp', host: '127.0.0.1', port: closedPort }), { code: 'refused' })
    await assert.rejects(desktop.open({ kind: 'tcp', host: 'host.invalid', port: 80 }), { code: 'unreachable' })
    await assert.rejects(desktop.open({ kind: 'tcp', host: 'a b', port: 80 }), { code: 'refused' })
    await assert.rejects(desktop.open({ kind: 'owner', purpose: 'backend' }), { code: 'no-server' })

    // The streams before have closed on both sides by now; only these count.
    await new Promise((resolve) => setTimeout(resolve, 100))
    const held = await Promise.all(
      Array.from({ length: MAX_TCP_STREAMS }, () => desktop.open({ kind: 'tcp', host: '127.0.0.1', port })),
    )
    await assert.rejects(desktop.open({ kind: 'tcp', host: '127.0.0.1', port }), { code: 'limit' })
    for (const open of held) open.destroy()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const again = (await desktop.open({ kind: 'tcp', host: '127.0.0.1', port })) as Duplex
    again.destroy()
    assert.ok(stats.tcp >= MAX_TCP_STREAMS + 2)
    assert.ok(stats.targets.has(`localhost:${port}`))
    assert.ok(stats.bytesIn > 0 && stats.bytesOut > 0)
  } finally {
    echo.close()
  }
})
