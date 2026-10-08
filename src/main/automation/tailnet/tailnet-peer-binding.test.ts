import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { test } from 'vitest'

import { TAILNET_SCOPES } from '../../../shared/tailnet'
import { toolSuccess, type McpToolRegistration } from '../../../shared/modules/mcp-tools'
import { isStudioGatewayMutation } from '../studio-gateway-tools'
import {
  createGatewayAuditStore,
  isAuditedCall,
  STUDIO_GATEWAY_AUDIT_FILENAME,
  TAILNET_PEER_REFUSED_AUDIT_TOOL,
  type GatewayAuditRecord,
} from '../gateway-audit'
import { hashSecret } from './secret-hash'
import { createTailnetDeviceStore, TAILNET_DEVICES_FILENAME, type TailnetDeviceStore } from './tailnet-devices'
import { createTailnetGatewayServer, type TailnetGatewayServer } from './tailnet-gateway-server'
import { createTailnetMeshService } from './tailnet-mesh-service'
import { createTailnetPeerResolver, peerIdentityFromWhois, type TailnetPeerIdentity } from './tailnet-peer-identity'
import { createTailnetRemoteService } from './tailnet-service'
import { writeTailnetSettings } from './tailnet-settings'
import {
  TAILNET_CONVERSATION_IMAGE_PATH,
  TAILNET_CONVERSATION_PATH,
  TAILNET_EVENTS_PATH,
  TAILNET_IDENTITY_PATH,
  TAILNET_MCP_PATH,
  TAILNET_PAIR_COLLECT_PATH,
  TAILNET_PAIR_PATH,
  TAILNET_PAIR_REQUEST_PATH,
  TAILNET_STREAM_PATH,
  TAILNET_UPLOAD_PATH,
  TAILNET_WS_TICKET_PATH,
} from './tailnet-routes'

// A device token only works from the tailnet node it was paired from.
//
// Every case drives the real listener on loopback. Loopback is one address, so
// "which node is calling" comes from an injected resolver whose answer the case
// sets before each call — the same seam production fills with `tailscale whois`.

const MAC_MINI: TailnetPeerIdentity = {
  name: 'mac-mini.tail1234.ts.net',
  stableNodeId: 'nMacMini1CNTRL',
  loginName: 'dev@example.com',
}
const BUILD_BOX: TailnetPeerIdentity = {
  name: 'build-box.tail1234.ts.net',
  stableNodeId: 'nBuildBox2CNTRL',
  loginName: 'dev@example.com',
}

type Gateway = {
  server: TailnetGatewayServer
  devices: TailnetDeviceStore
  port: number
  dir: string
  /** Who whois says is calling, for every call from here on. Null is whois failing. */
  callFrom(peer: TailnetPeerIdentity | null): void
  auditRecords(): Promise<GatewayAuditRecord[]>
  storedDevices(): Array<{ id: string; node?: { stableNodeId: string; loginName: string | null } | null }>
}

async function withGateway(
  run: (gateway: Gateway) => Promise<void>,
  setup: { seedDir?: (dir: string) => void } = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-binding-'))
  setup.seedDir?.(dir)
  let caller: TailnetPeerIdentity | null = MAC_MINI
  const devices = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
  const audit = createGatewayAuditStore({ resolveUserDataDir: () => dir })
  const tool: McpToolRegistration = {
    name: 'workspace.list',
    description: 'Test tool',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => toolSuccess({ ok: true }),
  }
  const server = createTailnetGatewayServer({
    bindAddress: '127.0.0.1',
    port: 0,
    serverName: 'sprintengine-studio',
    serverVersion: '9.9.9',
    resolveTools: () => [tool],
    isMutation: (name) => isStudioGatewayMutation(name),
    devices,
    // No cache: every call asks, so a case can move the caller between nodes.
    peers: { identify: async () => caller, resolve: async () => caller?.name ?? null },
    // The app's own filter, so a refusal that would not reach the real audit
    // does not reach this one either.
    onToolCall: ({ context, tool: name, args, durationMs, result, error }) => {
      if (!isAuditedCall(name, isStudioGatewayMutation(name))) return
      audit.record({ connection: context.metadata, tool: name, args, durationMs, result, error })
    },
  })
  await server.start()
  try {
    await run({
      server,
      devices,
      port: server.address()!.port,
      dir,
      callFrom: (peer) => {
        caller = peer
      },
      auditRecords: async () => {
        await audit.flush()
        const path = join(dir, STUDIO_GATEWAY_AUDIT_FILENAME)
        if (!existsSync(path)) return []
        return readFileSync(path, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as GatewayAuditRecord)
      },
      storedDevices: () => JSON.parse(readFileSync(join(dir, TAILNET_DEVICES_FILENAME), 'utf8')).devices,
    })
  } finally {
    await audit.close()
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

type Answer = { status: number; body: { error?: { code: string; message: string } } & Record<string, unknown> }

function call(port: number, method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  return new Promise<Answer>((resolve, reject) => {
    const payload = options.body === undefined ? '' : JSON.stringify(options.body)
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : {} })
        })
      },
    )
    request.on('error', reject)
    request.end(payload)
  })
}

/** Open a WebSocket upgrade and return the response head (101, or the refusal that replaced it). */
function upgrade(port: number, path: string, ticket: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(
        [
          `GET ${path}?ticket=${encodeURIComponent(ticket)} HTTP/1.1`,
          'Host: 127.0.0.1',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      )
    })
    let head = ''
    socket.on('data', (chunk: Buffer) => {
      head += chunk.toString('latin1')
      if (head.includes('\r\n\r\n')) {
        socket.destroy()
        resolve(head.slice(0, head.indexOf('\r\n\r\n')))
      }
    })
    socket.on('error', reject)
    socket.on('close', () => resolve(head))
  })
}

async function pair(gateway: Gateway, name = 'laptop'): Promise<{ deviceId: string; deviceToken: string }> {
  const offer = gateway.devices.offerPairing({ scopes: [...TAILNET_SCOPES] })
  const answer = await call(gateway.port, 'POST', TAILNET_PAIR_PATH, {
    body: { pairingToken: offer.token, deviceName: name },
  })
  assert.equal(answer.status, 200)
  return { deviceId: answer.body.deviceId as string, deviceToken: answer.body.deviceToken as string }
}

async function ticketFor(gateway: Gateway, token: string): Promise<string> {
  const answer = await call(gateway.port, 'POST', TAILNET_WS_TICKET_PATH, { token })
  assert.equal(answer.status, 200)
  return answer.body.ticket as string
}

const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list' }

test('whois is read for the node name, its stable id and its owner', () => {
  // The shape `tailscale whois --json` prints (apitype.WhoIsResponse), trimmed.
  const raw = JSON.stringify({
    Node: {
      ID: 1234567,
      StableID: 'nMacMini1CNTRL',
      Name: 'mac-mini.tail1234.ts.net.',
      Addresses: ['100.101.102.103/32'],
    },
    UserProfile: { ID: 42, LoginName: 'dev@example.com', DisplayName: 'Dev' },
    CapMap: {},
  })
  assert.deepEqual(peerIdentityFromWhois(raw), MAC_MINI)
  assert.deepEqual(peerIdentityFromWhois('{"UserProfile":{"LoginName":"dev@example.com"}}'), {
    name: 'dev@example.com',
    stableNodeId: null,
    loginName: 'dev@example.com',
  })
  assert.equal(peerIdentityFromWhois('{}'), null)
  assert.equal(peerIdentityFromWhois('not json'), null)
})

test('a failed whois is retried after seconds, an answer is kept for minutes', async () => {
  let clock = 0
  let calls = 0
  let answer: TailnetPeerIdentity | null = null
  const resolver = createTailnetPeerResolver({
    now: () => clock,
    runWhois: async () => {
      calls += 1
      return answer
    },
  })
  assert.equal(await resolver.identify('100.101.102.103'), null)
  assert.equal(await resolver.identify('100.101.102.103'), null)
  assert.equal(calls, 1, 'a failure is not re-asked on every call')
  clock += 11_000
  answer = MAC_MINI
  assert.deepEqual(await resolver.identify('100.101.102.103'), MAC_MINI, 'but it does not lock a device out for long')
  clock += 60_000
  assert.equal(await resolver.resolve('100.101.102.103'), MAC_MINI.name)
  assert.equal(calls, 2, 'an answer is kept')
})

test('pairing by code binds the device to the node that redeemed it', async () => {
  await withGateway(async (gateway) => {
    const device = await pair(gateway)
    const stored = gateway.storedDevices().find((entry) => entry.id === device.deviceId)
    assert.equal(stored?.node?.stableNodeId, MAC_MINI.stableNodeId)
    assert.equal(stored?.node?.loginName, MAC_MINI.loginName)
    // And the renderer's view of it is unchanged: no binding in the public device.
    assert.equal('node' in gateway.devices.listDevices()[0], false)
  })
})

test('a bound token is served from its own node', async () => {
  await withGateway(async (gateway) => {
    const device = await pair(gateway)
    const identity = await call(gateway.port, 'GET', TAILNET_IDENTITY_PATH, { token: device.deviceToken })
    assert.equal(identity.status, 200)
    const tools = await call(gateway.port, 'POST', TAILNET_MCP_PATH, { token: device.deviceToken, body: listTools })
    assert.equal(tools.status, 200)
    assert.equal(gateway.devices.listDevices()[0].lastPeerNode, MAC_MINI.name)
  })
})

test('a bound token is refused from another node, on every authenticated route', async () => {
  await withGateway(async (gateway) => {
    const device = await pair(gateway)
    gateway.callFrom(BUILD_BOX)
    const routes: Array<[string, string, unknown?]> = [
      ['GET', TAILNET_IDENTITY_PATH],
      ['POST', TAILNET_MCP_PATH, listTools],
      ['POST', TAILNET_WS_TICKET_PATH],
      ['POST', `${TAILNET_UPLOAD_PATH}?conversationId=c1&name=a.png`],
      ['GET', `${TAILNET_CONVERSATION_IMAGE_PATH}?workspaceId=w&agentId=a&path=x.png`],
    ]
    for (const [method, path, body] of routes) {
      const answer = await call(gateway.port, method, path, { token: device.deviceToken, body })
      assert.equal(answer.status, 401, `${method} ${path}`)
      assert.equal(answer.body.error?.code, 'peer_mismatch', `${method} ${path}`)
      assert.match(answer.body.error?.message ?? '', /different machine/u)
    }
    // The device is still paired, and still works from where it belongs.
    gateway.callFrom(MAC_MINI)
    assert.equal((await call(gateway.port, 'GET', TAILNET_IDENTITY_PATH, { token: device.deviceToken })).status, 200)
  })
})

test('a refusal is audited with the device and the node that presented its token', async () => {
  await withGateway(async (gateway) => {
    const device = await pair(gateway)
    gateway.callFrom(BUILD_BOX)
    await call(gateway.port, 'POST', TAILNET_MCP_PATH, { token: device.deviceToken, body: listTools })
    const records = await gateway.auditRecords()
    assert.equal(records.length, 1)
    const [record] = records
    assert.equal(record.tool, TAILNET_PEER_REFUSED_AUDIT_TOOL)
    assert.equal(record.outcome, 'failure')
    assert.equal(record.errorCode, 'peer_mismatch')
    assert.equal(record.connection.kind, 'remote-tailnet')
    assert.equal(record.connection.deviceId, device.deviceId)
    assert.equal(record.connection.peerNode, BUILD_BOX.name)
    assert.deepEqual(record.targets, {
      path: TAILNET_MCP_PATH,
      peerAddress: '127.0.0.1',
      peerNodeId: BUILD_BOX.stableNodeId!,
    })
  })
})

test('a bound token is refused when whois cannot say who is calling', async () => {
  await withGateway(async (gateway) => {
    const device = await pair(gateway)
    gateway.callFrom(null)
    const answer = await call(gateway.port, 'GET', TAILNET_IDENTITY_PATH, { token: device.deviceToken })
    assert.equal(answer.status, 401)
    assert.equal(answer.body.error?.code, 'peer_unverified')
    // A whois answer with no stable id is the same as no answer.
    gateway.callFrom({ name: 'mac-mini.tail1234.ts.net', stableNodeId: null, loginName: null })
    assert.equal((await call(gateway.port, 'GET', TAILNET_IDENTITY_PATH, { token: device.deviceToken })).status, 401)
    const [record] = await gateway.auditRecords()
    assert.equal(record.errorCode, 'peer_unverified')
  })
})

test('a device paired before bindings is bound on its first call and held to it', async () => {
  const token = 'mctn_paired-before-bindings'
  await withGateway(
    async (gateway) => {
      // With whois failing it is served as it always was, and stays unbound.
      gateway.callFrom(null)
      assert.equal((await call(gateway.port, 'GET', TAILNET_IDENTITY_PATH, { token })).status, 200)
      assert.equal(gateway.storedDevices()[0].node ?? null, null)

      // The first call whois can name binds it, on disk.
      gateway.callFrom(MAC_MINI)
      assert.equal((await call(gateway.port, 'GET', TAILNET_IDENTITY_PATH, { token })).status, 200)
      assert.equal(gateway.storedDevices()[0].node?.stableNodeId, MAC_MINI.stableNodeId)

      // From then on it is enforced like any other.
      gateway.callFrom(BUILD_BOX)
      const refused = await call(gateway.port, 'GET', TAILNET_IDENTITY_PATH, { token })
      assert.equal(refused.status, 401)
      assert.equal(refused.body.error?.code, 'peer_mismatch')
      gateway.callFrom(null)
      assert.equal((await call(gateway.port, 'GET', TAILNET_IDENTITY_PATH, { token })).status, 401)
    },
    {
      seedDir: (dir) =>
        writeFileSync(
          join(dir, TAILNET_DEVICES_FILENAME),
          JSON.stringify({
            version: 1,
            devices: [
              {
                id: 'tnd_legacy',
                name: 'dev-macbook-air',
                scopes: ['workspace:read'],
                createdAt: '2026-09-01T00:00:00.000Z',
                lastSeenAt: null,
                lastPeerNode: null,
                origin: { kind: 'code', by: null },
                tokenHash: hashSecret(token),
              },
            ],
          }),
        ),
    },
  )
})

test('an approved request binds the device to the node that asked', async () => {
  await withGateway(async (gateway) => {
    const secret = 'collect-secret'
    const asked = await call(gateway.port, 'POST', TAILNET_PAIR_REQUEST_PATH, {
      body: { deviceName: 'dev-macbook-air', collectHash: hashSecret(secret) },
    })
    assert.equal(asked.status, 200)
    const requestId = asked.body.requestId as string
    const approved = gateway.devices.approvePairRequest({
      id: requestId,
      scopes: ['workspace:read'],
      code: asked.body.comparisonCode,
    })
    assert.ok(approved.ok)
    assert.equal(gateway.storedDevices()[0].node?.stableNodeId, MAC_MINI.stableNodeId)

    // Another node holding the collect secret is not handed the token, and
    // does not use the collect up either.
    gateway.callFrom(BUILD_BOX)
    const elsewhere = await call(gateway.port, 'POST', TAILNET_PAIR_COLLECT_PATH, {
      body: { id: requestId, secret },
    })
    assert.equal(elsewhere.body.status, 'expired')

    gateway.callFrom(MAC_MINI)
    const collected = await call(gateway.port, 'POST', TAILNET_PAIR_COLLECT_PATH, { body: { id: requestId, secret } })
    assert.equal(collected.body.status, 'approved')
    const token = collected.body.deviceToken as string
    assert.equal((await call(gateway.port, 'GET', TAILNET_IDENTITY_PATH, { token })).status, 200)
  })
})

test('a request whois could not name is bound at collect, to the collecting node', async () => {
  await withGateway(async (gateway) => {
    const secret = 'collect-secret'
    gateway.callFrom(null)
    const asked = await call(gateway.port, 'POST', TAILNET_PAIR_REQUEST_PATH, {
      body: { deviceName: 'android-phone', collectHash: hashSecret(secret) },
    })
    const requestId = asked.body.requestId as string
    assert.ok(
      gateway.devices.approvePairRequest({ id: requestId, scopes: ['workspace:read'], code: asked.body.comparisonCode })
        .ok,
    )
    assert.equal(gateway.storedDevices()[0].node ?? null, null, 'nothing to bind to yet')

    gateway.callFrom(MAC_MINI)
    const collected = await call(
      gateway.port,
      'GET',
      `${TAILNET_PAIR_REQUEST_PATH}?id=${encodeURIComponent(requestId)}&secret=${encodeURIComponent(secret)}`,
    )
    assert.equal(collected.body.status, 'approved')
    assert.equal(gateway.storedDevices()[0].node?.stableNodeId, MAC_MINI.stableNodeId)
  })
})

test('a WebSocket upgrade is held to the node too, on every socket route', async () => {
  await withGateway(async (gateway) => {
    const device = await pair(gateway)
    for (const path of [TAILNET_STREAM_PATH, TAILNET_EVENTS_PATH, TAILNET_CONVERSATION_PATH]) {
      // The ticket is taken from the right node, then carried to another one.
      gateway.callFrom(MAC_MINI)
      const ticket = await ticketFor(gateway, device.deviceToken)
      gateway.callFrom(BUILD_BOX)
      const head = await upgrade(gateway.port, path, ticket)
      assert.match(head, /^HTTP\/1\.1 401/u, path)
      assert.match(head, /X-Tailnet-Error: peer_mismatch/u, path)
    }
    // From the right node the same upgrade is accepted.
    gateway.callFrom(MAC_MINI)
    const ticket = await ticketFor(gateway, device.deviceToken)
    assert.match(await upgrade(gateway.port, TAILNET_STREAM_PATH, ticket), /^HTTP\/1\.1 101/u)
    // And a failed whois at the upgrade refuses it.
    const another = await ticketFor(gateway, device.deviceToken)
    gateway.callFrom(null)
    assert.match(await upgrade(gateway.port, TAILNET_EVENTS_PATH, another), /X-Tailnet-Error: peer_unverified/u)
  })
})

test('a reverse grant is bound to the machine being asked', async () => {
  // The asker mints the reverse device on its own listener, for the machine it
  // is asking to drive: that machine will hold the token and dial back in.
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-binding-reverse-'))
  writeTailnetSettings(dir, { enabled: true, port: await freePort(), notifications: true })
  const remote = createTailnetRemoteService({
    resolveUserDataDir: () => dir,
    serverName: 'sprintengine-studio',
    serverVersion: '9.9.9',
    resolveTools: () => [],
    isMutation: () => false,
    resolveBindAddress: () => '127.0.0.1',
    createPeerResolver: () => createTailnetPeerResolver({ runWhois: async () => BUILD_BOX }),
  })
  const mesh = createTailnetMeshService({
    resolveUserDataDir: () => dir,
    resolveDeviceName: () => 'dev-macbook-air',
    // Wired as the app wires them.
    resolvePeerName: (address) => remote.resolvePeerName(address),
    resolvePeerIdentity: (address) => remote.resolvePeerIdentity(address),
    mintReverseDevice: (input) => remote.grantReverseDevice(input),
    revokeReverseDevice: () => undefined,
  })
  try {
    assert.equal((await remote.initialize()).running, true)
    // Nothing listens on port 1, so the ask itself fails — after the reverse
    // half was minted, which is the moment under test.
    await mesh.requestPairing({ endpoint: '127.0.0.1:1', reverseScopes: ['workspace:read'] })
    const stored = JSON.parse(readFileSync(join(dir, TAILNET_DEVICES_FILENAME), 'utf8')).devices
    assert.equal(stored.length, 1)
    assert.equal(stored[0].origin.kind, 'reverse')
    assert.equal(stored[0].node.stableNodeId, BUILD_BOX.stableNodeId)
  } finally {
    mesh.shutdown()
    await remote.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}
