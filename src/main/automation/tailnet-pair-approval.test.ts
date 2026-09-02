import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hashSecret } from '../mobile/bridge/crypto'
import { toolSuccess, type McpToolRegistration } from '../../shared/modules/mcp-tools'
import { SUPPORTED_MCP_PROTOCOL_VERSIONS } from '../../shared/mcp/protocol'
import { TAILNET_PAIR_REQUEST_PATH } from './tailnet/tailnet-routes'
import { createTailnetDeviceStore, DEFAULT_PAIR_REQUEST_TTL_MS } from './tailnet/tailnet-devices'
import { createTailnetRemoteService } from './tailnet/tailnet-service'
import { writeTailnetSettings } from './tailnet/tailnet-settings'

// Pairing by approval on the machine being driven (MC-2233).
//
// The half that runs over the wire is exercised against a REAL listener on a
// real socket with a real device store, exactly as the carried-code round trip
// is: the point of the feature is that a stranger can ask and a person can
// answer, and a mocked listener would only prove the mock says yes.
//
// The rules that depend on the clock and on counting — expiry, the caps, the
// post-denial cooldown — are driven at the store, where `now` can be injected.
// Wiring a fake clock through a live HTTP server would test the harness.

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

type HttpAnswer = { status: number; body: Record<string, unknown> }

function call(
  port: number,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {}
): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
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

async function startListener(): Promise<{
  service: ReturnType<typeof createTailnetRemoteService>
  port: number
  close: () => Promise<void>
}> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'multicode-tailnet-approve-'))
  const port = await freePort()
  writeTailnetSettings(userDataDir, { enabled: true, port })
  const service = createTailnetRemoteService({
    resolveUserDataDir: () => userDataDir,
    serverName: 'sprintengine-studio',
    serverVersion: '9.9.9',
    resolveTools: testTools,
    isMutation: () => false,
    // Loopback is on the bind allowlist precisely so tests drive the real server.
    resolveBindAddress: () => '127.0.0.1',
  })
  const status = await service.initialize()
  assert.equal(status.running, true, `the listener started: ${status.lastError ?? ''}`)
  return {
    service,
    port,
    async close() {
      await service.shutdown()
      rmSync(userDataDir, { recursive: true, force: true })
    },
  }
}

/** What a client keeps to itself, and what it is willing to send. */
function askingCredential(): { secret: string; hash: string } {
  const secret = 'test-collect-secret-not-a-real-one'
  return { secret, hash: hashSecret(secret) }
}

check('a machine asks, a person allows it with the terminal tier, and the token drives the gateway', async () => {
  const harness = await startListener()
  try {
    const credential = askingCredential()
    const asked = await call(harness.port, 'POST', TAILNET_PAIR_REQUEST_PATH, {
      body: { deviceName: 'Conal’s MacBook Air', collectHash: credential.hash },
    })
    assert.equal(asked.status, 200, 'the ask is accepted')
    const requestId = asked.body.requestId as string
    assert.ok(requestId, 'the ask is answered with a request id')
    assert.match(String(asked.body.comparisonCode), /^\d{6}$/u, 'six digits come back to show beside the other screen')

    // The person at this machine sees it waiting, with the same digits.
    const waiting = harness.service.getStatus().pairRequests
    assert.equal(waiting.length, 1, 'the request is waiting to be answered here')
    assert.equal(waiting[0].deviceName, 'Conal’s MacBook Air')
    assert.equal(waiting[0].comparisonCode, asked.body.comparisonCode, 'both screens show the same code')

    // Nothing is collectable until someone answers.
    const early = await call(
      harness.port,
      'GET',
      `${TAILNET_PAIR_REQUEST_PATH}?id=${requestId}&secret=${credential.secret}`
    )
    assert.equal(early.body.status, 'pending', 'before the answer, the asker is told to keep waiting')

    const approved = harness.service.approvePairRequest({
      id: requestId,
      scopes: ['workspace:read', 'terminal:control'],
    })
    assert.equal(approved.ok, true, 'approving succeeds')

    const collected = await call(
      harness.port,
      'GET',
      `${TAILNET_PAIR_REQUEST_PATH}?id=${requestId}&secret=${credential.secret}`
    )
    assert.equal(collected.body.status, 'approved')
    const deviceToken = collected.body.deviceToken as string
    assert.ok(deviceToken, 'the device token comes back to the asker')
    assert.deepEqual(
      collected.body.scopes,
      ['workspace:read', 'terminal:control'],
      'the grant is the one the approver chose, including the terminal tier'
    )

    // And it actually works: the whole point is a device that can now drive this machine.
    const call1 = await call(harness.port, 'POST', '/tailnet/v1/mcp', {
      token: deviceToken,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: SUPPORTED_MCP_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: 't', version: '1' } },
      },
    })
    assert.equal(call1.status, 200, 'the minted token authenticates against the gateway')
  } finally {
    await harness.close()
  }
})

check('the token can only be collected by the machine that asked', async () => {
  const harness = await startListener()
  try {
    const credential = askingCredential()
    const asked = await call(harness.port, 'POST', TAILNET_PAIR_REQUEST_PATH, {
      body: { deviceName: 'Laptop', collectHash: credential.hash },
    })
    const requestId = asked.body.requestId as string
    harness.service.approvePairRequest({ id: requestId, scopes: ['workspace:read'] })

    // Someone who learned the id but not the secret is told exactly what a
    // caller with an invented id is told — so they cannot even confirm it is real.
    const stolen = await call(
      harness.port,
      'GET',
      `${TAILNET_PAIR_REQUEST_PATH}?id=${requestId}&secret=wrong-secret`
    )
    assert.equal(stolen.body.status, 'expired', 'a wrong secret learns nothing')
    assert.equal(stolen.body.deviceToken, undefined, 'and takes no token')

    // A wrong guess must not burn the request, exactly as a wrong pairing code does not.
    const rightful = await call(
      harness.port,
      'GET',
      `${TAILNET_PAIR_REQUEST_PATH}?id=${requestId}&secret=${credential.secret}`
    )
    assert.equal(rightful.body.status, 'approved', 'the machine that asked still collects')
    assert.ok(rightful.body.deviceToken, 'and gets its token')
  } finally {
    await harness.close()
  }
})

check('the token is handed over exactly once', async () => {
  const harness = await startListener()
  try {
    const credential = askingCredential()
    const asked = await call(harness.port, 'POST', TAILNET_PAIR_REQUEST_PATH, {
      body: { deviceName: 'Laptop', collectHash: credential.hash },
    })
    const requestId = asked.body.requestId as string
    harness.service.approvePairRequest({ id: requestId, scopes: ['workspace:read'] })

    const first = await call(
      harness.port,
      'GET',
      `${TAILNET_PAIR_REQUEST_PATH}?id=${requestId}&secret=${credential.secret}`
    )
    assert.equal(first.body.status, 'approved')
    const second = await call(
      harness.port,
      'GET',
      `${TAILNET_PAIR_REQUEST_PATH}?id=${requestId}&secret=${credential.secret}`
    )
    assert.equal(second.body.status, 'expired', 'a replay of the collect gets nothing')
  } finally {
    await harness.close()
  }
})

check('a request with no collect hash is refused rather than left unbound', async () => {
  const harness = await startListener()
  try {
    const asked = await call(harness.port, 'POST', TAILNET_PAIR_REQUEST_PATH, {
      body: { deviceName: 'Laptop' },
    })
    assert.equal(asked.status, 400, 'a request that cannot be bound is refused')
    assert.equal(harness.service.getStatus().pairRequests.length, 0, 'and nothing is put in front of a person')
  } finally {
    await harness.close()
  }
})

check('declining is an answer, and the declined peer waits before asking again', async () => {
  const store = createTailnetDeviceStore({ resolveUserDataDir: () => mkdtempSync(join(tmpdir(), 'tnd-')) })
  const asked = store.requestPairing({
    deviceName: 'Laptop',
    peerNode: 'laptop.example.ts.net',
    peerAddress: '100.64.0.9',
    collectHash: hashSecret('s'),
  })
  assert.equal(asked.ok, true)
  const requestId = asked.ok ? asked.request.id : ''

  assert.equal(store.denyPairRequest(requestId), true, 'the decline lands')
  assert.equal(store.collectPairRequest(requestId, 's').status, 'denied', 'the asker is told it was declined')

  const again = store.requestPairing({
    deviceName: 'Laptop',
    peerNode: 'laptop.example.ts.net',
    peerAddress: '100.64.0.9',
    collectHash: hashSecret('s'),
  })
  assert.equal(again.ok, false, 'the same peer cannot immediately ask again')
  assert.equal(again.ok === false ? again.code : '', 'denied_recently')
})

check('one waiting request per peer, so a prompt cannot be spammed', async () => {
  const store = createTailnetDeviceStore({ resolveUserDataDir: () => mkdtempSync(join(tmpdir(), 'tnd-')) })
  const first = store.requestPairing({
    deviceName: 'Laptop',
    peerNode: null,
    peerAddress: '100.64.0.9',
    collectHash: hashSecret('s'),
  })
  assert.equal(first.ok, true)
  const second = store.requestPairing({
    deviceName: 'Laptop again',
    peerNode: null,
    peerAddress: '100.64.0.9',
    collectHash: hashSecret('s'),
  })
  assert.equal(second.ok, false, 'the second is refused')
  assert.equal(second.ok === false ? second.code : '', 'too_many_requests')
  assert.equal(store.listPairRequests().length, 1, 'and only one is in front of the person')
})

check('a request nobody answered lapses, and cannot be approved afterwards', async () => {
  let clock = Date.parse('2026-09-02T21:00:00.000Z')
  const store = createTailnetDeviceStore({
    resolveUserDataDir: () => mkdtempSync(join(tmpdir(), 'tnd-')),
    now: () => new Date(clock),
  })
  const asked = store.requestPairing({
    deviceName: 'Laptop',
    peerNode: null,
    peerAddress: '100.64.0.9',
    collectHash: hashSecret('s'),
  })
  const requestId = asked.ok ? asked.request.id : ''
  clock += DEFAULT_PAIR_REQUEST_TTL_MS + 1000

  assert.equal(store.listPairRequests().length, 0, 'it is no longer in front of anyone')
  const approved = store.approvePairRequest({ id: requestId, scopes: ['workspace:read'] })
  assert.equal(approved.ok, false, 'and approving it does not mint a device')
  assert.equal(store.listDevices().length, 0, 'nothing was granted')
  assert.equal(store.collectPairRequest(requestId, 's').status, 'expired', 'the asker is told it lapsed')
})

check('the asker cannot influence what approving it grants', async () => {
  const store = createTailnetDeviceStore({ resolveUserDataDir: () => mkdtempSync(join(tmpdir(), 'tnd-')) })
  const asked = store.requestPairing({
    // Whatever a client puts in its body, the grant comes from the approver.
    deviceName: 'Laptop',
    peerNode: null,
    peerAddress: '100.64.0.9',
    collectHash: hashSecret('s'),
  })
  const requestId = asked.ok ? asked.request.id : ''
  const approved = store.approvePairRequest({ id: requestId, scopes: ['backlog:read'] })
  assert.equal(approved.ok, true)
  assert.deepEqual(approved.ok ? approved.device.scopes : [], ['backlog:read'], 'exactly what was ticked')
})

void queue.then(() => {
  if (failures > 0) {
    console.error(`${failures} test(s) failed`)
    process.exit(1)
  }
  console.log('all pair-approval tests passed')
})
