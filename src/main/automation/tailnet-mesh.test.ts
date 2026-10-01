import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { toolError, toolSuccess, type McpToolRegistration } from '../../shared/modules/mcp-tools'
import type { TailnetScope } from '../../shared/tailnet'
import type { MeshEvent } from '../../shared/tailnet-mesh'
import { createTailnetDeviceStore, type TailnetDeviceStore } from './tailnet/tailnet-devices'
import { createTailnetMeshService, type TailnetMeshService } from './tailnet/tailnet-mesh-service'
import { createTailnetMeshStore, TAILNET_MESH_FILENAME } from './tailnet/tailnet-mesh-store'
import { createTailnetGatewayServer, type TailnetGatewayServer } from './tailnet/tailnet-gateway-server'
import { createTailnetPeerResolver } from './tailnet/tailnet-peer-identity'
import { pairingUrl } from './tailnet/tailnet-service'
import { parseTailnetEndpoint } from './tailnet/tailnet-remote-client'
import { test } from 'vitest'
import { createSecretCipherStandIn } from '../../../tests/stubs/secret-cipher'

test('tailnet-mesh', async () => {
  // The Mesh client: this Studio driving another machine.
  //
  // Every test drives the REAL listener over a real TCP socket on loopback, with
  // the real outbound client, the real pairing exchange, and the real change
  // feed. The thing under test IS the wire between two machines, so a fake on
  // either side would prove nothing about it.

  type Harness = {
    server: TailnetGatewayServer
    devices: TailnetDeviceStore
    /**
     * THIS machine's inbound device store — the mirror of `devices`, which is the
     * remote's. `forgetMachine` is the only operation that touches both stores at
     * once, so the test needs both ends of the pairing to be real.
     */
    localDevices: TailnetDeviceStore
    port: number
    remoteDir: string
    localDir: string
    mesh: TailnetMeshService
    /** Every whole-app mesh event the service broadcast, in order. */
    events: MeshEvent[]
    /** Pair the mesh service with the harness's listener under the given scopes. */
    pair(scopes: TailnetScope[]): Promise<string>
    close(): Promise<void>
  }

  async function startHarness(): Promise<Harness> {
    const remoteDir = mkdtempSync(join(tmpdir(), 'sprintengine-mesh-remote-'))
    const localDir = mkdtempSync(join(tmpdir(), 'sprintengine-mesh-local-'))
    const devices = createTailnetDeviceStore({ resolveUserDataDir: () => remoteDir })

    const server = createTailnetGatewayServer({
      bindAddress: '127.0.0.1',
      port: 0,
      serverName: 'sprintengine-studio',
      serverVersion: '9.9.9',
      resolveTools: () => remoteTools(),
      isMutation: () => false,
      devices,
      // whois is injected: these tests must not depend on a Tailscale install.
      peers: createTailnetPeerResolver({ runWhois: async () => null }),
    })
    await server.start()
    const address = server.address()
    assert.ok(address, 'the harness listener reports a bound address')
    const port = address.port

    const events: MeshEvent[] = []
    const localDevices = createTailnetDeviceStore({ resolveUserDataDir: () => localDir })
    const mesh = createTailnetMeshService({
      resolveUserDataDir: () => localDir,
      // A stand-in keychain, so the credential file is written the way the app
      // writes it: sealed, never as plaintext.
      createStore: (options) => createTailnetMeshStore({ ...options, cipher: createSecretCipherStandIn() }),
      resolveDeviceName: () => 'laptop',
      // No Tailscale in a test, so no name: the machine is listed by address, and
      // the point is that this degrades rather than blocking the pairing.
      resolvePeerName: async () => null,
      onEvent: (event) => events.push(event),
      // Wired exactly as the app wires it: the inbound half of `forgetMachine`
      // reaches this machine's own listener store.
      revokeInboundDevice: (deviceId) => localDevices.revokeDevice(deviceId),
    })

    return {
      server,
      devices,
      localDevices,
      port,
      remoteDir,
      localDir,
      mesh,
      events,
      async pair(scopes): Promise<string> {
        const offer = devices.offerPairing({ scopes })
        const result = await mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', port, offer.token) })
        assert.equal(result.ok, true, result.ok ? '' : result.message)
        assert.ok(result.ok)
        return result.connection.id
      },
      async close(): Promise<void> {
        mesh.shutdown()
        await server.stop().catch(() => {})
        rmSync(remoteDir, { recursive: true, force: true })
        rmSync(localDir, { recursive: true, force: true })
      },
    }
  }

  // What the remote's `conversation.create` was asked, and whether it refuses
  // `newChat` by name, as a build with a strict reading of its schema would.
  const conversationCreates: Array<Record<string, unknown>> = []
  let refuseNewChat = false

  /** The remote machine's tool surface, answering the shapes the Mesh reads. */
  function remoteTools(): McpToolRegistration[] {
    const tool = (name: string, structured: Record<string, unknown>): McpToolRegistration => ({
      name,
      description: `Test tool ${name}`,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => toolSuccess({ ok: true, ...structured }),
    })
    return [
      tool('workspace.list', {
        workspaces: [
          {
            id: 'ws-1',
            name: 'Atlas',
            mode: 'code',
            folderPath: '/repos/atlas',
            repository: {
              canonicalKey: 'github.com/acme/atlas',
              remoteUrl: 'git@github.com:acme/atlas.git',
              name: 'atlas',
            },
          },
          // An older build, or a folder with no remote: no identity, still a workspace.
          { id: 'ws-2', name: 'Scratch', mode: 'code', folderPath: '/repos/scratch' },
        ],
      }),
      tool('workspace.checkout', {
        workspaceId: 'ws-1',
        git: true,
        branch: 'main',
        defaultBranch: 'main',
        branches: [
          { name: 'feat/x', current: false },
          { name: 'main', current: true },
        ],
        worktrees: [{ path: '/repos/atlas', branch: 'main', isMain: true }],
      }),
      {
        name: 'conversation.create',
        description: 'Test tool conversation.create',
        inputSchema: { type: 'object', properties: {} },
        handler: async (args) => {
          conversationCreates.push(args)
          if (refuseNewChat && 'newChat' in args) return toolError('invalid_arguments', 'Unknown argument "newChat".')
          return toolSuccess({
            ok: true,
            conversation: { workspaceId: 'ws-9', agentId: 'agent-1', name: 'Ada', providerId: 'claude-agent' },
          })
        },
      },
    ]
  }

  const failures: string[] = []
  const queued: Array<{ name: string; run: () => Promise<void> }> = []

  /** Queued rather than awaited: the bundle these tests run as is CJS, which has no top-level await. */
  function test(name: string, run: () => Promise<void>): void {
    queued.push({ name, run })
  }

  // A pairing link from another machine's Settings is redeemed over the real
  // listener, and what comes back is a credential this machine keeps — at 0600,
  // and never where a window could read it.
  test('pairing with a machine stores a usable credential and never exposes it', async () => {
    const harness = await startHarness()
    try {
      const connectionId = await harness.pair(['workspace:read', 'conversation:operate'])
      const listed = harness.mesh.listConnections()
      assert.equal(listed.length, 1)
      assert.equal(listed[0].id, connectionId)
      assert.equal(listed[0].endpoint, `127.0.0.1:${harness.port}`)
      assert.deepEqual(listed[0].scopes, ['workspace:read', 'conversation:operate'])
      // The public view is what IPC returns; a token in it would be a token in
      // the renderer.
      assert.equal('deviceToken' in listed[0], false)

      const storePath = join(harness.localDir, TAILNET_MESH_FILENAME)
      const raw = readFileSync(storePath, 'utf8')
      const stored = JSON.parse(raw) as { connections: Array<{ deviceId: string; sealedToken: string }> }
      assert.equal(typeof stored.connections[0].sealedToken, 'string')
      assert.equal('deviceToken' in stored.connections[0], false, 'the credential is sealed, never plaintext')
      assert.doesNotMatch(raw, /mctn_/u)
      if (process.platform !== 'win32') {
        assert.equal(statSync(storePath).mode & 0o777, 0o600, 'the credential file is owner-only')
      }

      // The other machine sees exactly one device, named as this machine.
      const devices = harness.devices.listDevices()
      assert.equal(devices.length, 1)
      assert.equal(devices[0].name, 'laptop')
    } finally {
      await harness.close()
    }
  })

  // A bad link is refused with the reason, never accepted into a record that
  // would fail later somewhere less explicable.
  test('a link that is not a pairing link is refused before anything is dialled', async () => {
    const harness = await startHarness()
    try {
      const result = await harness.mesh.pair({ pairingUrl: 'https://example.com/pair?token=abc' })
      assert.equal(result.ok, false)
      assert.ok(!result.ok && result.code === 'invalid_pairing_link')
      assert.equal(harness.mesh.listConnections().length, 0)
    } finally {
      await harness.close()
    }
  })

  // The browse is the Mesh's read of another machine's workspaces, over the
  // real tool surface, behind the real scopes.
  test('browsing a machine reads its workspaces', async () => {
    const harness = await startHarness()
    try {
      const connectionId = await harness.pair(['workspace:read', 'backlog:read'])
      const browse = await harness.mesh.browse(connectionId)
      assert.equal(browse.reachable, true)
      assert.equal(browse.unauthorized, false)
      assert.deepEqual(browse.scopes, ['workspace:read', 'backlog:read'])
      assert.deepEqual(
        browse.workspaces.map((workspace) => workspace.name),
        ['Atlas', 'Scratch'],
      )
      assert.deepEqual(browse.gaps, [])

      // one-project-across-machines: the identity the remote served is kept,
      // and its absence is kept as null rather than invented.
      assert.equal(
        browse.workspaces.find((entry) => entry.id === 'ws-1')?.repository?.canonicalKey,
        'github.com/acme/atlas',
      )
      assert.equal(browse.workspaces.find((entry) => entry.id === 'ws-2')?.repository, null)
    } finally {
      await harness.close()
    }
  })

  // The change feed (2026-09-05): pairing opens a watch on the machine, and the
  // machine saying "workspaces changed" or "conversations changed" lands here as
  // a mesh event a surface re-reads on — no timer, no browse in between.
  // Forgetting the machine closes the watch, so a forgotten machine cannot keep
  // pushing.
  test("a paired machine's change feed lands as remote-changed events, and forgetting closes it", async () => {
    const harness = await startHarness()
    try {
      const connectionId = await harness.pair(['workspace:read', 'conversation:read'])
      for (let i = 0; i < 100 && harness.server.eventStreamCount() === 0; i += 1) await delay(20)
      assert.equal(harness.server.eventStreamCount(), 1, 'pairing opened one watch on the machine')

      const changes = () => harness.events.flatMap((event) => (event.kind === 'remote-changed' ? [event] : []))
      harness.server.notifyWorkspacesChanged()
      harness.server.notifyConversationsChanged()
      for (let i = 0; i < 100 && changes().length < 2; i += 1) await delay(20)
      assert.deepEqual(
        changes().map((event) => [event.connectionId, event.what]),
        [
          [connectionId, 'workspaces'],
          [connectionId, 'conversations'],
        ],
        'each push became a mesh event',
      )

      harness.mesh.forget(connectionId)
      for (let i = 0; i < 100 && harness.server.eventStreamCount() > 0; i += 1) await delay(20)
      assert.equal(harness.server.eventStreamCount(), 0, 'forgetting the machine closed its watch')
    } finally {
      await harness.close()
    }
  })

  // A pairing granted no workspace scope is TOLD why there are no workspaces.
  // An empty list would state something false about the other machine.
  test('a part this pairing may not read is reported as a gap, not an empty list', async () => {
    const harness = await startHarness()
    try {
      const connectionId = await harness.pair(['conversation:read'])
      const browse = await harness.mesh.browse(connectionId)
      assert.equal(browse.reachable, true)
      assert.equal(browse.workspaces.length, 0)
      assert.equal(browse.gaps.length, 1)
      assert.equal(browse.gaps[0].part, 'workspaces')
      assert.match(browse.gaps[0].message, /may not read/u)
    } finally {
      await harness.close()
    }
  })

  // Revocation at the other end is the one failure re-pairing fixes, so it is
  // reported as itself rather than as "unreachable".
  test('a revoked pairing is reported as revoked, not as an unreachable machine', async () => {
    const harness = await startHarness()
    try {
      const connectionId = await harness.pair(['workspace:read'])
      harness.devices.revokeDevice(harness.devices.listDevices()[0].id)
      const browse = await harness.mesh.browse(connectionId)
      assert.equal(browse.reachable, false)
      assert.equal(browse.unauthorized, true)
      assert.match(browse.unreachableReason ?? '', /no longer accepts/u)
    } finally {
      await harness.close()
    }
  })

  // checkout-and-branch-on-remote-create: the checkout facts behind the launch
  // panel's checkout · branch segments, read over the wire and parsed as the
  // panel consumes them; a pairing without workspace:read gets the refusal.
  test("a remote workspace's checkout is read over workspace.checkout, and refused without workspace:read", async () => {
    const harness = await startHarness()
    try {
      const connectionId = await harness.pair(['workspace:read'])
      const read = await harness.mesh.workspaceCheckout(connectionId, 'ws-1')
      assert.ok(read.ok, read.ok ? '' : read.message)
      assert.equal(read.checkout.branch, 'main')
      assert.equal(read.checkout.defaultBranch, 'main')
      assert.deepEqual(
        read.checkout.branches.map((entry) => entry.name),
        ['feat/x', 'main'],
      )
      assert.equal(read.checkout.worktrees[0]?.isMain, true)

      const conversationsOnly = await harness.pair(['conversation:operate'])
      const refused = await harness.mesh.workspaceCheckout(conversationsOnly, 'ws-1')
      assert.equal(refused.ok, false)
      assert.equal(refused.ok ? '' : refused.code, 'tailnet_scope_required')
      assert.match(
        refused.ok ? '' : refused.message,
        /workspace:read/u,
        'the gateway names the missing scope, verbatim',
      )

      const nameless = await harness.mesh.workspaceCheckout(connectionId, '')
      assert.equal(nameless.ok, false)
    } finally {
      await harness.close()
    }
  })

  // The picker names a project by one of the workspaces in its folder; the
  // chat started there is a new one, not one added to that workspace's chat.
  test('a remote New chat asks for a chat of its own, and asks the old way of a machine that refuses that', async () => {
    const harness = await startHarness()
    try {
      const connectionId = await harness.pair(['conversation:operate'])
      conversationCreates.length = 0
      const created = await harness.mesh.createConversation({ connectionId, workspaceId: 'ws-1', prompt: 'hi' })
      assert.ok(created.ok, created.ok ? '' : created.message)
      assert.equal(created.workspaceId, 'ws-9')
      assert.deepEqual(conversationCreates, [{ workspaceId: 'ws-1', prompt: 'hi', newChat: true }])

      refuseNewChat = true
      conversationCreates.length = 0
      const fallback = await harness.mesh.createConversation({ connectionId, workspaceId: 'ws-1' })
      assert.ok(fallback.ok, fallback.ok ? '' : fallback.message)
      assert.deepEqual(conversationCreates, [{ workspaceId: 'ws-1', newChat: true }, { workspaceId: 'ws-1' }])
    } finally {
      refuseNewChat = false
      await harness.close()
    }
  })

  // The endpoint parser is the boundary where a stored string becomes an address
  // this machine dials, so what it will and will not read is worth pinning.
  test('endpoints are read exactly, or refused', async () => {
    assert.deepEqual(parseTailnetEndpoint('100.64.0.5:8787'), { host: '100.64.0.5', port: 8787 })
    assert.deepEqual(parseTailnetEndpoint('[fd7a:115c:a1e0::1]:8787'), { host: 'fd7a:115c:a1e0::1', port: 8787 })
    // A bare IPv6 literal is ambiguous with the port separator; truncating it
    // would send a credential to an address nobody chose.
    assert.equal(parseTailnetEndpoint('fd7a:115c:a1e0::1:8787'), null)
    assert.equal(parseTailnetEndpoint('100.64.0.5'), null)
    assert.equal(parseTailnetEndpoint('100.64.0.5:notaport'), null)
    assert.equal(parseTailnetEndpoint('100.64.0.5:70000'), null)
  })

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // The whole-app broadcast (remote-sessions-ux / tailnet-live-state-push):
  // machine paired and forgotten, and a snapshot read that agrees with the
  // events — every one stamped with a revision that only goes up.
  test('the mesh broadcasts machine paired/forgotten with a matching snapshot and rising revisions', async () => {
    const harness = await startHarness()
    try {
      assert.deepEqual(
        harness.mesh.getLiveState(),
        { revision: 0, requests: [], reachability: [] },
        'nothing paired, revision 0',
      )
      const connectionId = await harness.pair(['workspace:read'])
      const paired = harness.events.find((event) => event.kind === 'machine-paired')
      assert.ok(paired && paired.kind === 'machine-paired', 'pairing is broadcast')
      assert.equal(paired.connection.id, connectionId)
      assert.equal(paired.revision, 1, 'the first broadcast is revision 1')
      assert.equal(
        'deviceToken' in paired.connection,
        false,
        'the broadcast carries the public view, never the credential',
      )

      const snapshot = harness.mesh.getLiveState()
      assert.equal(
        snapshot.revision,
        harness.events[harness.events.length - 1].revision,
        'the snapshot carries the latest revision',
      )
      assert.deepEqual(
        snapshot.reachability.map((entry) => [entry.connectionId, entry.reachable]),
        [[connectionId, true]],
        'the snapshot lists the machine that just answered',
      )

      harness.mesh.forget(connectionId)
      const forgotten = harness.events.find((event) => event.kind === 'machine-forgotten')
      assert.ok(forgotten && forgotten.kind === 'machine-forgotten' && forgotten.connectionId === connectionId)
      assert.deepEqual(harness.mesh.getLiveState().reachability, [], 'a forgotten machine has no record left')

      harness.events.forEach((event, index) => {
        if (index === 0) return
        assert.ok(event.revision > harness.events[index - 1].revision, `revision rises at event ${index}`)
      })
    } finally {
      await harness.close()
    }
  })

  test('forgetting a machine ends both halves of the pairing at once', async () => {
    const harness = await startHarness()
    try {
      const connectionId = await harness.pair(['workspace:read'])
      // The other direction: a device THIS machine granted that one, as a
      // both-ways pairing or an approved request would have left behind.
      const inbound = harness.localDevices.mintDevice({
        name: 'mac-mini',
        scopes: ['workspace:read'],
        origin: { kind: 'reverse', by: 'mac-mini.tail1234.ts.net' },
      })
      assert.equal(harness.localDevices.listDevices().length, 1)
      assert.equal(harness.mesh.listConnections().length, 1)

      const result = harness.mesh.forgetMachine({ deviceId: inbound.device.id, connectionId })
      assert.deepEqual(result.connections, [])
      assert.equal(result.revokedDeviceId, inbound.device.id)
      assert.equal(result.forgottenConnectionId, connectionId)
      // Both stores, not just the report.
      assert.equal(harness.localDevices.listDevices().length, 0)
      assert.equal(harness.mesh.listConnections().length, 0)
      // And every window hears it, exactly as a one-sided forget announces.
      assert.ok(harness.events.some((event) => event.kind === 'machine-forgotten'))
    } finally {
      await harness.close()
    }
  })

  test('forgetting tolerates a machine that is only paired one way', async () => {
    const harness = await startHarness()
    try {
      // Outbound only: this machine drives that one, and was never granted a
      // device here. Nothing to revoke, and that is not a failure.
      const connectionId = await harness.pair(['workspace:read'])
      const outboundOnly = harness.mesh.forgetMachine({ connectionId })
      assert.equal(outboundOnly.revokedDeviceId, null)
      assert.equal(outboundOnly.forgottenConnectionId, connectionId)
      assert.deepEqual(outboundOnly.connections, [])

      // Inbound only: that machine drives this one, and there is no credential
      // here to forget.
      const inbound = harness.localDevices.mintDevice({
        name: 'a-phone',
        scopes: ['workspace:read'],
        origin: { kind: 'approval', by: null },
      })
      const inboundOnly = harness.mesh.forgetMachine({ deviceId: inbound.device.id })
      assert.equal(inboundOnly.revokedDeviceId, inbound.device.id)
      assert.equal(inboundOnly.forgottenConnectionId, null)
      assert.equal(harness.localDevices.listDevices().length, 0)

      // Neither half left, or ids that were never real: the caller asked for "we
      // are not paired any more", which is already true, so it is not an error.
      const nothing = harness.mesh.forgetMachine({ deviceId: 'tnd_gone', connectionId: 'tnc_gone' })
      assert.deepEqual(nothing, { connections: [], revokedDeviceId: null, forgottenConnectionId: null })
      assert.deepEqual(harness.mesh.forgetMachine({}), {
        connections: [],
        revokedDeviceId: null,
        forgottenConnectionId: null,
      })
    } finally {
      await harness.close()
    }
  })

  async function runAll(): Promise<void> {
    for (const entry of queued) {
      try {
        await entry.run()
        console.log(`ok - ${entry.name}`)
      } catch (error) {
        failures.push(entry.name)
        console.error(`not ok - ${entry.name}`)
        console.error(error)
      }
    }
    if (failures.length > 0) {
      console.error(`\n${failures.length} failing: ${failures.join(', ')}`)
      process.exit(1)
    }
    console.log('\ntailnet mesh client contracts ok')
  }

  const suiteRun = runAll()

  await suiteRun
})
