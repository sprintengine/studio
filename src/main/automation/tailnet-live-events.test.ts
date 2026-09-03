import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hashSecret } from '../mobile/bridge/crypto'
import { toolSuccess, type McpToolRegistration } from '../../shared/modules/mcp-tools'
import { TAILNET_PAIR_PATH, TAILNET_PAIR_REQUEST_PATH, TAILNET_STREAM_PATH, TAILNET_WS_TICKET_PATH } from './tailnet/tailnet-routes'
import { createTailnetRemoteService } from './tailnet/tailnet-service'
import { writeTailnetSettings } from './tailnet/tailnet-settings'
import type { TailnetPushPayload } from '../../shared/tailnet'

// The live-state push (remote-sessions-ux / tailnet-live-state-push).
//
// Like every other tailnet test, this drives the REAL listener over a real
// loopback socket: the thing under test is that socket lifecycle and wire
// events become renderer-facing pushes, and a faked server would only prove
// the fake pushes. Expiry timers are exercised through the resolution diff
// (deny), not by waiting five minutes — the diff is one code path for every
// way a request stops existing.

let failures = 0
let queue: Promise<void> = Promise.resolve()

function check(name: string, run: () => Promise<void>): void {
  queue = queue.then(async () => {
    try {
      await run()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures++
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  })
}

function testTools(): McpToolRegistration[] {
  return [
    {
      name: 'terminal.list',
      description: 'Test tool',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => toolSuccess({ sessions: [] }),
    },
  ]
}

async function freePort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  probe.close()
  await once(probe, 'close')
  return port
}

function call(
  port: number,
  path: string,
  options: { token?: string; body?: unknown } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        agent: false,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
      },
      (response) => {
        let raw = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          raw += chunk
        })
        response.on('end', () => {
          let body: unknown = {}
          try {
            body = JSON.parse(raw)
          } catch {
            body = { raw }
          }
          resolve({ status: response.statusCode ?? 0, body: (body ?? {}) as Record<string, unknown> })
        })
      }
    )
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

/** Collects pushed payloads and lets a test await the one it is waiting for. */
function eventCollector(): {
  onEvent: (payload: TailnetPushPayload) => void
  payloads: TailnetPushPayload[]
  waitFor: (predicate: (payload: TailnetPushPayload) => boolean, label: string) => Promise<TailnetPushPayload>
} {
  const payloads: TailnetPushPayload[] = []
  const waiters: Array<{ predicate: (payload: TailnetPushPayload) => boolean; resolve: (payload: TailnetPushPayload) => void }> = []
  return {
    payloads,
    onEvent(payload) {
      payloads.push(payload)
      for (const waiter of [...waiters]) {
        if (waiter.predicate(payload)) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(payload)
        }
      }
    },
    waitFor(predicate, label) {
      const already = payloads.find(predicate)
      if (already) return Promise.resolve(already)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5000)
        waiters.push({
          predicate,
          resolve: (payload) => {
            clearTimeout(timer)
            resolve(payload)
          },
        })
      })
    },
  }
}

/** Upgrade a raw socket onto the RPC stream and resolve once the 101 lands. */
async function openStreamSocket(port: number, ticket: string): Promise<Socket> {
  const key = randomBytes(16).toString('base64')
  const socket = connect({ host: '127.0.0.1', port })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.write(
    [
      `GET ${TAILNET_STREAM_PATH}?ticket=${encodeURIComponent(ticket)} HTTP/1.1`,
      'Host: 127.0.0.1',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n')
  )
  const head = await new Promise<string>((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.indexOf('\r\n\r\n') !== -1) {
        socket.removeListener('data', onData)
        resolve(buffer.toString('utf8'))
      }
    }
    socket.on('data', onData)
    socket.once('error', reject)
  })
  assert.ok(head.startsWith('HTTP/1.1 101'), `the upgrade was accepted: ${head.split('\r\n')[0]}`)
  return socket
}

check('the push channel narrates listener, pairing, connection, and pair-request changes', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'multicode-tailnet-live-'))
  const port = await freePort()
  writeTailnetSettings(userDataDir, { enabled: true, port })
  const events = eventCollector()
  const service = createTailnetRemoteService({
    resolveUserDataDir: () => userDataDir,
    serverName: 'sprintengine-studio',
    serverVersion: '9.9.9',
    resolveTools: testTools,
    isMutation: () => false,
    resolveBindAddress: () => '127.0.0.1',
    onEvent: events.onEvent,
  })
  try {
    // Listener up is the first push, and its payload's status agrees.
    const started = await service.initialize()
    assert.equal(started.running, true, started.lastError ?? '')
    const up = await events.waitFor((p) => p.event.kind === 'listener', 'listener event')
    assert.deepEqual(up.event, { kind: 'listener', running: true })
    assert.equal(up.status.running, true)

    // Pair a device over the wire, open its RPC stream: device-connection true,
    // and the live snapshot carries the device.
    const offer = service.offerPairing()
    const paired = await call(port, TAILNET_PAIR_PATH, {
      body: { pairingToken: offer.token, deviceName: 'laptop' },
    })
    assert.equal(paired.status, 200)
    const deviceToken = paired.body.deviceToken as string
    const ticketed = await call(port, TAILNET_WS_TICKET_PATH, { token: deviceToken })
    assert.equal(ticketed.status, 200)
    const socket = await openStreamSocket(port, ticketed.body.ticket as string)
    const connected = await events.waitFor(
      (p) => p.event.kind === 'device-connection' && p.event.connected,
      'device connected'
    )
    assert.equal(connected.event.kind === 'device-connection' && connected.event.deviceName, 'laptop')
    assert.equal(connected.live.devices.length, 1)
    assert.equal(connected.live.devices[0].connected, true)
    assert.deepEqual(service.getLiveState().devices.map((d) => d.deviceName), ['laptop'])

    // Dropping the socket announces the disconnect and empties the snapshot.
    socket.destroy()
    const dropped = await events.waitFor(
      (p) => p.event.kind === 'device-connection' && !p.event.connected,
      'device disconnected'
    )
    assert.equal(dropped.live.devices.length, 0)
    assert.equal(service.getLiveState().devices.length, 0)

    // A pair request from a stranger announces itself; denying it resolves it,
    // and the resolving payload's status no longer lists it.
    const asked = await call(port, TAILNET_PAIR_REQUEST_PATH, {
      body: { deviceName: 'stranger', collectHash: hashSecret('secret') },
    })
    assert.equal(asked.status, 200)
    const received = await events.waitFor(
      (p) => p.event.kind === 'pair-request' && p.event.phase === 'received',
      'pair request received'
    )
    assert.equal(received.event.kind === 'pair-request' && received.event.deviceName, 'stranger')
    assert.equal(received.status.pairRequests.length, 1)

    service.denyPairRequest(asked.body.requestId as string)
    const resolved = await events.waitFor(
      (p) => p.event.kind === 'pair-request' && p.event.phase === 'resolved',
      'pair request resolved'
    )
    assert.equal(resolved.status.pairRequests.length, 0)

    // Turning the listener off is the last push.
    await service.setEnabled(false)
    const down = await events.waitFor(
      (p) => p.event.kind === 'listener' && !p.event.running,
      'listener stopped'
    )
    assert.equal(down.status.running, false)
  } finally {
    await service.shutdown()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

check('approving a request announces the resolution and the device change', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'multicode-tailnet-live-approve-'))
  const port = await freePort()
  writeTailnetSettings(userDataDir, { enabled: true, port })
  const events = eventCollector()
  const service = createTailnetRemoteService({
    resolveUserDataDir: () => userDataDir,
    serverName: 'sprintengine-studio',
    serverVersion: '9.9.9',
    resolveTools: testTools,
    isMutation: () => false,
    resolveBindAddress: () => '127.0.0.1',
    onEvent: events.onEvent,
  })
  try {
    await service.initialize()
    const asked = await call(port, TAILNET_PAIR_REQUEST_PATH, {
      body: { deviceName: 'macbook-air', collectHash: hashSecret('secret') },
    })
    assert.equal(asked.status, 200)
    await events.waitFor((p) => p.event.kind === 'pair-request' && p.event.phase === 'received', 'received')

    const answer = service.approvePairRequest({ id: asked.body.requestId as string, scopes: ['workspace:read'] })
    assert.equal(answer.ok, true)
    const resolved = await events.waitFor(
      (p) => p.event.kind === 'pair-request' && p.event.phase === 'resolved',
      'resolved on approval'
    )
    assert.equal(resolved.status.pairRequests.length, 0)
    await events.waitFor((p) => p.event.kind === 'devices-changed', 'devices changed')
    // The approved device is in the status every later payload carries.
    assert.equal(service.getStatus().devices.some((device) => device.name === 'macbook-air'), true)
  } finally {
    await service.shutdown()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

void queue.then(() => {
  if (failures > 0) {
    console.error(`tailnet-live-events.test.ts: ${failures} failing`)
    process.exit(1)
  }
  console.log('tailnet-live-events.test.ts: ok')
})
