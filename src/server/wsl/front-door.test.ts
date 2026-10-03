import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { afterEach, test } from 'vitest'

import type { HelperProcess } from '../../main/hosts/wsl-helper-client'
import { BRIDGE_READY, connectLoopback, openBridge } from './front-door-client'
import {
  assertFrontDoorBindAddress,
  frontDoorSocketPath,
  startFrontDoorListeners,
  type FrontDoorListeners,
} from './front-door-listener'
import {
  admitFrontDoor,
  enterFrontDoor,
  FrontDoorRefusedError,
  ownerTokenHash,
  serverProof,
  type FrontDoorPurpose,
} from './front-door-proof'

const TOKEN = 'seown_test-owner-token-0123456789abcdef'
const BRIDGE = join(process.cwd(), 'resources', 'wsl-server', 'bridge.mjs')

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// A socket path must stay short (about 100 bytes), so fixtures live in /tmp.
function shortTemp(): string {
  const dir = mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'se-fd-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function readLine(stream: Duplex): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      stream.off('data', onData)
      resolve(buffer.slice(0, newline))
    }
    stream.on('data', onData)
    stream.once('error', reject)
  })
}

async function listeners(
  admitted: Array<{ purpose: FrontDoorPurpose; stream: Duplex }>,
  overrides: Partial<Parameters<typeof startFrontDoorListeners>[0]> = {},
): Promise<FrontDoorListeners> {
  const runDir = join(shortTemp(), 'run')
  const started = await startFrontDoorListeners({
    tokenHash: ownerTokenHash(TOKEN),
    runDir,
    loopback: true,
    onAdmitted: (purpose, stream) => {
      admitted.push({ purpose, stream })
      // Speaks first after the proof, as a backend's event would.
      stream.write('{"after":"admitted"}\n')
      stream.on('data', (chunk: Buffer) => stream.write(`echo:${chunk.toString('utf8')}`))
    },
    ...overrides,
  })
  cleanups.push(() => started.close())
  return started
}

test('the bind guard admits the literal IPv4 loopback and nothing else', () => {
  assertFrontDoorBindAddress('127.0.0.1')
  for (const host of ['0.0.0.0', '::', '::1', 'localhost', '100.101.102.103', '192.168.1.20', '']) {
    assert.throws(() => assertFrontDoorBindAddress(host), /127\.0\.0\.1 only/u, host)
  }
})

test('both ends prove themselves over loopback TCP, and the first bytes after the proof arrive intact', async () => {
  const admitted: Array<{ purpose: FrontDoorPurpose; stream: Duplex }> = []
  const doors = await listeners(admitted)
  assert.ok(doors.port && doors.port > 0)
  const socket = await connectLoopback(doors.port)
  cleanups.push(() => socket.destroy())
  const stream = await enterFrontDoor(socket, { token: TOKEN, purpose: 'backend' })
  assert.equal(await readLine(stream), '{"after":"admitted"}', 'a line sent with the admission is not lost')
  stream.write('hello\n')
  assert.equal(await readLine(stream), 'echo:hello')
  assert.deepEqual(
    admitted.map((entry) => entry.purpose),
    ['backend'],
  )
})

test('a front door with the wrong token learns nothing and is refused; the server never admits it', async () => {
  const admitted: Array<{ purpose: FrontDoorPurpose; stream: Duplex }> = []
  const doors = await listeners(admitted)
  const socket = await connectLoopback(doors.port!)
  await assert.rejects(
    enterFrontDoor(socket, { token: 'seown_some-other-token', purpose: 'backend' }),
    (error: unknown) => error instanceof FrontDoorRefusedError && /could not prove/u.test(error.message),
  )
  assert.equal(admitted.length, 0)
})

test('a squatter on the port gets a nonce and nothing derived from the token', async () => {
  // A decoy that answers like a server would, with a proof it cannot make.
  const heard: string[] = []
  const decoy: Server = createServer((socket: Socket) => {
    socket.on('data', (chunk) => {
      heard.push(chunk.toString('utf8'))
      socket.write(`${JSON.stringify({ t: 'challenge', serverNonce: 'A'.repeat(43), proof: '0'.repeat(64) })}\n`)
    })
  })
  await new Promise<void>((resolve) => decoy.listen({ host: '127.0.0.1', port: 0 }, resolve))
  cleanups.push(() => new Promise<void>((resolve) => decoy.close(() => resolve())))
  const port = (decoy.address() as { port: number }).port
  const socket = await connectLoopback(port)
  await assert.rejects(enterFrontDoor(socket, { token: TOKEN, purpose: 'studio' }), FrontDoorRefusedError)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const said = heard.join('')
  assert.equal(said.trim().split('\n').length, 1, 'the front door said one line')
  const line = JSON.parse(said) as Record<string, unknown>
  assert.deepEqual(Object.keys(line).sort(), ['nonce', 'purpose', 't', 'v'])
  assert.ok(!said.includes(TOKEN) && !said.includes(ownerTokenHash(TOKEN)))
})

test('the server refuses a proof for another purpose than the one it proved', async () => {
  const tokenHash = ownerTokenHash(TOKEN)
  const server = createServer((socket) => {
    void admitFrontDoor(socket, { tokenHash }).catch(() => undefined)
  })
  const dir = shortTemp()
  const path = join(dir, 's.sock')
  await new Promise<void>((resolve) => server.listen(path, resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const socket = connect(path)
  await new Promise((resolve) => socket.once('connect', resolve))
  const nonce = 'B'.repeat(43)
  socket.write(`${JSON.stringify({ t: 'front-door', v: 1, purpose: 'backend', nonce })}\n`)
  const challenge = JSON.parse(await readLine(socket)) as { serverNonce: string; proof: string }
  assert.equal(challenge.proof, serverProof(tokenHash, nonce, challenge.serverNonce, 'backend'))
  // Replaying the server's own proof as the client's is refused.
  socket.write(`${JSON.stringify({ t: 'prove', proof: challenge.proof })}\n`)
  await new Promise((resolve) => socket.once('close', resolve))
})

test('a door that cannot bind its port retries a fresh one on EADDRINUSE, and only then', async () => {
  let attempts = 0
  const admitted: Array<{ purpose: FrontDoorPurpose; stream: Duplex }> = []
  const doors = await listeners(admitted, {
    listenTcp: (server, host) => {
      attempts++
      if (attempts < 3) return Promise.reject(Object.assign(new Error('taken'), { code: 'EADDRINUSE' }))
      return new Promise((resolve) => server.listen({ host, port: 0 }, () => resolve()))
    },
  })
  assert.equal(attempts, 3)
  assert.ok(doors.port)

  let refused = 0
  const logged: string[] = []
  const closed = await listeners(admitted, {
    listenTcp: () => {
      refused++
      return Promise.reject(Object.assign(new Error('not allowed'), { code: 'EACCES' }))
    },
    log: (message) => logged.push(message),
  })
  assert.equal(refused, 1, 'a failure a retry cannot fix is not retried')
  assert.equal(closed.port, null)
  assert.ok(closed.socketPath, 'the bridge socket opens without the TCP door')
  assert.match(logged.join('\n'), /loopback door did not open/u)
})

test('connections that never prove themselves on loopback cannot shut the bridge door', async () => {
  const admitted: Array<{ purpose: FrontDoorPurpose; stream: Duplex }> = []
  const doors = await listeners(admitted)
  const idle: Socket[] = []
  cleanups.push(() => idle.forEach((socket) => socket.destroy()))
  for (let index = 0; index < 8; index++) {
    const socket = await connectLoopback(doors.port!)
    socket.on('error', () => undefined)
    idle.push(socket)
  }
  // Accepted in order: once a ninth is turned away, the eight are all proving.
  const ninth = await connectLoopback(doors.port!)
  ninth.on('error', () => undefined)
  await new Promise((resolve) => ninth.once('close', resolve))

  const bridged = connect(doors.socketPath!)
  await new Promise((resolve) => bridged.once('connect', resolve))
  cleanups.push(() => bridged.destroy())
  const stream = await enterFrontDoor(bridged, { token: TOKEN, purpose: 'backend' })
  assert.equal(await readLine(stream), '{"after":"admitted"}')
  assert.deepEqual(
    admitted.map((entry) => entry.purpose),
    ['backend'],
  )
})

test("the bridge socket is its owner's alone, and moves to a private temp directory when the path is long", async () => {
  const doors = await listeners([])
  assert.ok(doors.socketPath)
  assert.equal(statSync(doors.socketPath).mode & 0o777, 0o600)
  const long = `/home/dev/${'x'.repeat(100)}/run`
  const moved = frontDoorSocketPath(long, '/tmp')
  assert.match(moved, /^\/tmp\/sprintengine-[0-9a-f]{12}\/front-door\.sock$/u)
  assert.equal(
    frontDoorSocketPath('/home/dev/.local/share/sprintengine-studio/data/run', '/tmp').endsWith('run/front-door.sock'),
    true,
  )
})

test('the stdio bridge carries the proof and the bytes after it, through a real sh standing in for wsl.exe', async () => {
  const admitted: Array<{ purpose: FrontDoorPurpose; stream: Duplex }> = []
  const doors = await listeners(admitted, { loopback: false })
  assert.equal(doors.port, null)
  const home = shortTemp()
  const spawnShell = (): HelperProcess =>
    spawn('sh', ['-s'], { cwd: home, env: { PATH: process.env.PATH, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
  // A profile that prints before the relay starts is read past, not taken as bytes.
  const script = `echo 'motd from a login profile'\nexec '${process.execPath}' '${BRIDGE}'`
  const bridged = await openBridge(spawnShell, script, doors.socketPath!)
  cleanups.push(() => bridged.destroy())
  const stream = await enterFrontDoor(bridged, { token: TOKEN, purpose: 'studio' })
  assert.equal(await readLine(stream), '{"after":"admitted"}')
  stream.write('through the bridge\n')
  assert.equal(await readLine(stream), 'echo:through the bridge')
  assert.deepEqual(
    admitted.map((entry) => entry.purpose),
    ['studio'],
  )
})

test('the bridge refuses anything but a socket path, and the marker matches the relay', async () => {
  assert.ok(readFileSync(BRIDGE, 'utf8').includes(`const BRIDGE_READY = '${BRIDGE_READY}'`))
  const home = shortTemp()
  const spawnShell = (): HelperProcess =>
    spawn('sh', ['-s'], { cwd: home, env: { PATH: process.env.PATH, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
  await assert.rejects(openBridge(spawnShell, 'exit 0', 'relative.sock'), /absolute Linux path/u)
  await assert.rejects(
    openBridge(spawnShell, 'echo nope; exit 3', '/tmp/x.sock', { readyTimeoutMs: 5_000 }),
    /ended before it was ready/u,
  )
})
