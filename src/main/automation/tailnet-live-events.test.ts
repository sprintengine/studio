import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hashSecret } from '../mobile/bridge/crypto'
import { createTailnetDeviceStore } from './tailnet/tailnet-devices'
import { toolSuccess, type McpToolRegistration } from '../../shared/modules/mcp-tools'
import {
  TAILNET_PAIR_PATH,
  TAILNET_PAIR_REQUEST_PATH,
  TAILNET_STREAM_PATH,
  TAILNET_TERMINAL_PATH,
  TAILNET_WS_TICKET_PATH,
} from './tailnet/tailnet-routes'
import { createTailnetRemoteService } from './tailnet/tailnet-service'
import { writeTailnetSettings } from './tailnet/tailnet-settings'
import type { TailnetPushPayload } from '../../shared/tailnet'
import type { TerminalRemoteHost } from '../terminal-remote-attach'
import { test } from 'vitest'

test('tailnet-live-events', async () => {
  // The live-state push (remote-sessions-ux / tailnet-live-state-push).
  //
  // Like every other tailnet test, this drives the REAL listener over a real
  // loopback socket: the thing under test is that socket lifecycle and wire
  // events become renderer-facing pushes, and a faked server would only prove
  // the fake pushes. Expiry is driven for real too, on a request minted with a
  // sub-second TTL: the timer that announces "nobody answered" is the one path
  // no person ever exercises by hand, so it is the one a test must.

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
    options: { token?: string; body?: unknown } = {},
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
        },
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
    const waiters: Array<{
      predicate: (payload: TailnetPushPayload) => boolean
      resolve: (payload: TailnetPushPayload) => void
    }> = []
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

  /** Upgrade a raw socket onto a WS route and resolve once the 101 lands. */
  async function openStreamSocket(
    port: number,
    ticket: string,
    path = TAILNET_STREAM_PATH,
    extraQuery = '',
  ): Promise<Socket> {
    const key = randomBytes(16).toString('base64')
    const socket = connect({ host: '127.0.0.1', port })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    socket.write(
      [
        `GET ${path}?ticket=${encodeURIComponent(ticket)}${extraQuery} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'),
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

  /** The smallest honest TerminalRemoteHost: one session, attach always works. */
  function stubTerminalHost(sessionId: string): TerminalRemoteHost {
    const session = {
      sessionId,
      processAlive: true,
      kind: 'agent',
      activity: { kind: 'idle', since: 0 },
    } as unknown as ReturnType<TerminalRemoteHost['listSessions']>[number]
    return {
      listSessions: () => [session],
      attach: ({ scope }) => ({
        ok: true,
        attachment: {
          sessionId,
          scope,
          session,
          write: () => ({ ok: true }),
          resize: () => ({ ok: true }),
          detach: () => {},
        },
      }),
    }
  }

  check('a disabled service initializes silently: no listener, no events, nothing running', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'sprintengine-tailnet-live-off-'))
    const port = await freePort()
    // enabled: false — every build's resting state.
    writeTailnetSettings(userDataDir, { enabled: false, port, notifications: true })
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
      const status = await service.initialize()
      assert.equal(status.enabled, false)
      assert.equal(status.running, false)
      assert.equal(events.payloads.length, 0, 'a disabled startup emits nothing at all')
    } finally {
      await service.shutdown()
      rmSync(userDataDir, { recursive: true, force: true })
      assert.equal(events.payloads.length, 0, 'shutdown of a never-started listener stays silent too')
    }
  })

  check('a terminal attach narrates drive begin and end, named by device and session', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'sprintengine-tailnet-live-drive-'))
    const port = await freePort()
    writeTailnetSettings(userDataDir, { enabled: true, port, notifications: true })
    const events = eventCollector()
    const service = createTailnetRemoteService({
      resolveUserDataDir: () => userDataDir,
      serverName: 'sprintengine-studio',
      serverVersion: '9.9.9',
      resolveTools: testTools,
      isMutation: () => false,
      resolveBindAddress: () => '127.0.0.1',
      terminals: stubTerminalHost('agent-standup'),
      onEvent: events.onEvent,
    })
    try {
      await service.initialize()
      const offer = service.offerPairing({ scopes: ['workspace:read', 'terminal:control'] })
      const paired = await call(port, TAILNET_PAIR_PATH, {
        body: { pairingToken: offer.token, deviceName: 'air' },
      })
      assert.equal(paired.status, 200)
      const deviceToken = paired.body.deviceToken as string
      const ticketed = await call(port, TAILNET_WS_TICKET_PATH, { token: deviceToken })
      const socket = await openStreamSocket(
        port,
        ticketed.body.ticket as string,
        TAILNET_TERMINAL_PATH,
        `&sessionId=${encodeURIComponent('agent-standup')}`,
      )
      const begin = await events.waitFor(
        (p) => p.event.kind === 'terminal-drive' && p.event.phase === 'begin',
        'drive begin',
      )
      assert.equal(begin.event.kind === 'terminal-drive' && begin.event.deviceName, 'air')
      assert.equal(
        begin.event.kind === 'terminal-drive' && begin.event.terminalSessionId,
        'agent-standup',
        'the driven session is named',
      )
      // The device connects BEFORE it drives — the narrated order.
      const kinds = events.payloads.map((p) => p.event.kind)
      assert.ok(
        kinds.indexOf('device-connection') < kinds.indexOf('terminal-drive'),
        'connection precedes drive in the story',
      )
      assert.deepEqual(
        begin.live.devices[0]?.attachedTerminalSessions,
        ['agent-standup'],
        'the live snapshot carries the attachment',
      )

      socket.destroy()
      const end = await events.waitFor((p) => p.event.kind === 'terminal-drive' && p.event.phase === 'end', 'drive end')
      assert.equal(end.event.kind === 'terminal-drive' && end.event.terminalSessionId, 'agent-standup')
      await events.waitFor(
        (p) => p.event.kind === 'device-connection' && !p.event.connected,
        'disconnect follows drive end',
      )
    } finally {
      await service.shutdown()
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  check('the push channel narrates listener, pairing, connection, and pair-request changes', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'sprintengine-tailnet-live-'))
    const port = await freePort()
    writeTailnetSettings(userDataDir, { enabled: true, port, notifications: true })
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
      assert.equal(up.revision, 1, 'the first push is revision 1')

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
        'device connected',
      )
      assert.equal(connected.event.kind === 'device-connection' && connected.event.deviceName, 'laptop')
      assert.equal(connected.live.devices.length, 1)
      assert.equal(connected.live.devices[0].connected, true)
      assert.deepEqual(
        service.getLiveState().devices.map((d) => d.deviceName),
        ['laptop'],
      )
      // Liveness metadata: when the socket opened, the last activity, and the
      // peer as the TRANSPORT saw it — never a self-declared platform, because
      // nothing on this transport sends one.
      const device = connected.live.devices[0]
      assert.equal(typeof device.connectedSince, 'number', 'connectedSince is stamped on the first socket')
      assert.equal(typeof device.lastActivityAt, 'number')
      assert.equal(device.peerAddress, '127.0.0.1', 'the peer address the socket arrived from')
      assert.equal(device.peerNode, null, 'no whois in a test — null, not invented')
      assert.equal(service.getLiveState().revision, connected.revision, 'a snapshot read carries the current revision')
      // An authenticated HTTP call while the socket is open is activity too.
      const before = device.lastActivityAt ?? 0
      await new Promise((resolve) => setTimeout(resolve, 5))
      const identity = await call(port, TAILNET_WS_TICKET_PATH, { token: deviceToken })
      assert.equal(identity.status, 200)
      assert.ok(
        (service.getLiveState().devices[0]?.lastActivityAt ?? 0) >= before,
        'HTTP activity refreshes lastActivityAt on a connected device',
      )

      // Dropping the socket announces the disconnect and empties the snapshot.
      socket.destroy()
      const dropped = await events.waitFor(
        (p) => p.event.kind === 'device-connection' && !p.event.connected,
        'device disconnected',
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
        'pair request received',
      )
      assert.equal(received.event.kind === 'pair-request' && received.event.deviceName, 'stranger')
      assert.equal(received.status.pairRequests.length, 1)

      service.denyPairRequest(asked.body.requestId as string)
      const denied = await events.waitFor(
        (p) => p.event.kind === 'pair-request' && p.event.phase === 'denied',
        'pair request denied',
      )
      assert.equal(denied.status.pairRequests.length, 0)
      assert.equal(
        events.payloads.some(
          (p) => p.event.kind === 'pair-request' && p.event.phase !== 'received' && p.event.phase !== 'denied',
        ),
        false,
        'denial is announced as denied and nothing else',
      )

      // Turning the listener off is announced exactly once — the transition,
      // with no unconditional echo behind it — and a requested stop carries
      // no error.
      const listenerEventsBefore = events.payloads.filter((p) => p.event.kind === 'listener').length
      await service.setEnabled(false)
      const down = await events.waitFor((p) => p.event.kind === 'listener' && !p.event.running, 'listener stopped')
      assert.equal(down.status.running, false)
      assert.deepEqual(
        down.event,
        { kind: 'listener', running: false, error: null },
        'a requested stop carries no error',
      )
      assert.equal(
        events.payloads.filter((p) => p.event.kind === 'listener').length - listenerEventsBefore,
        1,
        'one stop announcement, not the transition plus an unconditional echo',
      )

      // Revisions only ever go up, by exactly one per push.
      events.payloads.forEach((p, index) =>
        assert.equal(p.revision, index + 1, `payload ${index} is revision ${index + 1}`),
      )
    } finally {
      await service.shutdown()
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  check('approving a request announces the resolution and the device change', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'sprintengine-tailnet-live-approve-'))
    const port = await freePort()
    writeTailnetSettings(userDataDir, { enabled: true, port, notifications: true })
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

      const answer = service.approvePairRequest({
        id: asked.body.requestId as string,
        scopes: ['workspace:read'],
        code: asked.body.comparisonCode as string,
      })
      assert.equal(answer.ok, true)
      const resolved = await events.waitFor(
        (p) => p.event.kind === 'pair-request' && p.event.phase === 'approved',
        'approved',
      )
      assert.equal(resolved.status.pairRequests.length, 0)
      await events.waitFor((p) => p.event.kind === 'devices-changed', 'devices changed')
      // The approved device is in the status every later payload carries.
      assert.equal(
        service.getStatus().devices.some((device) => device.name === 'macbook-air'),
        true,
      )
    } finally {
      await service.shutdown()
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  check('stopping the listener cancels a request still waiting, and says so', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'sprintengine-tailnet-live-cancel-'))
    const port = await freePort()
    writeTailnetSettings(userDataDir, { enabled: true, port, notifications: true })
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
      const waiting = await call(port, TAILNET_PAIR_REQUEST_PATH, {
        body: { deviceName: 'stranger', collectHash: hashSecret('secret') },
      })
      assert.equal(waiting.status, 200, JSON.stringify(waiting.body))
      await events.waitFor((p) => p.event.kind === 'pair-request' && p.event.phase === 'received', 'received')
      // A request nobody can collect through a dead listener must not stay
      // answerable: it is CANCELLED, distinct from denied (an answer) and
      // expired (nobody answered).
      await service.setEnabled(false)
      const cancelled = await events.waitFor(
        (p) => p.event.kind === 'pair-request' && p.event.phase === 'cancelled',
        'pending request cancelled by the stop',
      )
      assert.equal(cancelled.event.kind === 'pair-request' && cancelled.event.requestId, waiting.body.requestId)
      assert.equal(service.getStatus().pairRequests.length, 0, 'nothing is left answerable')
      const kinds = events.payloads.map((p) => (p.event.kind === 'pair-request' ? p.event.phase : p.event.kind))
      assert.ok(
        kinds.indexOf('cancelled') < kinds.lastIndexOf('listener'),
        'the cancellation precedes the stop announcement',
      )
    } finally {
      await service.shutdown()
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  check('a request nobody answers lapses on its own timer and is announced as expired', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'sprintengine-tailnet-live-expire-'))
    const port = await freePort()
    writeTailnetSettings(userDataDir, { enabled: true, port, notifications: true })
    const events = eventCollector()
    const service = createTailnetRemoteService({
      resolveUserDataDir: () => userDataDir,
      serverName: 'sprintengine-studio',
      serverVersion: '9.9.9',
      resolveTools: testTools,
      isMutation: () => false,
      resolveBindAddress: () => '127.0.0.1',
      // The real store with a sub-second TTL: the service's expiry timer fires
      // just after the deadline, and the store's own prune agrees.
      createDeviceStore: (storeOptions) => createTailnetDeviceStore({ ...storeOptions, pairRequestTtlMs: 300 }),
      onEvent: events.onEvent,
    })
    try {
      await service.initialize()
      const asked = await call(port, TAILNET_PAIR_REQUEST_PATH, {
        body: { deviceName: 'slowpoke', collectHash: hashSecret('secret') },
      })
      assert.equal(asked.status, 200)
      await events.waitFor((p) => p.event.kind === 'pair-request' && p.event.phase === 'received', 'received')
      const expired = await events.waitFor(
        (p) => p.event.kind === 'pair-request' && p.event.phase === 'expired',
        'expired on the timer',
      )
      assert.equal(expired.event.kind === 'pair-request' && expired.event.requestId, asked.body.requestId)
      assert.equal(expired.status.pairRequests.length, 0, 'the lapsed request is gone from status')
      assert.equal(
        events.payloads.filter((p) => p.event.kind === 'pair-request').length,
        2,
        'received and expired — one terminal phase, nothing else',
      )
    } finally {
      await service.shutdown()
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  check('a listener that cannot start at boot announces the error without waiting for a knock', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'sprintengine-tailnet-live-porttaken-'))
    const port = await freePort()
    // Take the port first, as a stale process or another app would have.
    const squatter = createServer()
    squatter.listen(port, '127.0.0.1')
    await once(squatter, 'listening')
    writeTailnetSettings(userDataDir, { enabled: true, port, notifications: true })
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
      const status = await service.initialize()
      assert.equal(status.running, false)
      assert.ok(status.lastError, 'the failure is reported in status')
      const failed = await events.waitFor((p) => p.event.kind === 'listener', 'listener error pushed at boot')
      assert.ok(failed.event.kind === 'listener' && !failed.event.running, 'announced as not running')
      assert.equal(failed.event.kind === 'listener' && !failed.event.running && failed.event.error, status.lastError)
      assert.equal(events.payloads.length, 1, 'one announcement for one failure')

      // Re-enabling while the port is still taken fails again — and is still
      // announced exactly once, not once by the start and once by an echo.
      await service.setEnabled(true)
      assert.equal(events.payloads.filter((p) => p.event.kind === 'listener').length, 2)
      assert.ok(events.payloads[1].event.kind === 'listener' && !events.payloads[1].event.running)
    } finally {
      await service.shutdown()
      squatter.close()
      await once(squatter, 'close')
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  const suiteRun = queue.then(() => {
    if (failures > 0) {
      console.error(`tailnet-live-events.test.ts: ${failures} failing`)
      process.exit(1)
    }
    console.log('tailnet-live-events.test.ts: ok')
  })

  await suiteRun
})
