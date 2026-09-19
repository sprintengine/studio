import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTailnetFleetService } from './tailnet/tailnet-fleet-service'
import { createTailnetFleetStore } from './tailnet/tailnet-fleet-store'
import { readRemoteIdentity } from './tailnet/tailnet-remote-client'
import {
  checkTailnetTransportVersion,
  tailnetPeerSupports,
  TAILNET_CAPABILITIES,
  TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION,
  TAILNET_TRANSPORT_VERSION,
} from './tailnet/tailnet-routes'
import { test } from 'vitest'

test('tailnet-transport-version', async () => {
  // The tailnet transport's version window, and the handshake that applies it.
  //
  // Both ends of a tailnet are separate installs that update on their own
  // schedule, so the wire carries a version and the handshake has to compare it.
  // Until it did, a peer on a wire this build could not read was accepted and
  // then failed somewhere downstream on a payload shape — far from its cause, and
  // reading as a bug in whatever tool happened to be called.
  //
  // What is pinned here is the shape of that refusal as much as the fact of it: a
  // person with two Studios has to be able to tell from the message which of the
  // two to update, and that is only possible if it names both versions.
  //
  // The other half is capabilities. A feature question is answered from the list
  // the peer published, never from version arithmetic — see docs/compatibility.md.

  let failures = 0
  // One at a time: several of these bind a real socket, and interleaving them
  // would make a port conflict look like a handshake bug.
  let queue: Promise<void> = Promise.resolve()

  function check(name: string, run: () => void | Promise<void>): void {
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

  // ── The window itself ────────────────────────────────────────────────────────

  check('the window is a window, and it ends at the version this build speaks', () => {
    // A window that ended anywhere else would mean this build advertises a
    // version it would refuse coming back the other way.
    assert.equal(TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION <= TAILNET_TRANSPORT_VERSION, true)
    for (let version = TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION; version <= TAILNET_TRANSPORT_VERSION; version++) {
      assert.equal(checkTailnetTransportVersion(version), null, `version ${version} is inside the window`)
    }
  })

  check('a version outside the window is refused, in both directions', () => {
    const tooOld = checkTailnetTransportVersion(TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION - 1)
    const tooNew = checkTailnetTransportVersion(TAILNET_TRANSPORT_VERSION + 1)
    assert.equal(tooOld?.code, 'unsupported_transport_version')
    assert.equal(tooNew?.code, 'unsupported_transport_version')
    // Too new matters as much as too old: the machine that updated first is the
    // one whose owner is looking at the error.
    assert.match(tooNew?.message ?? '', new RegExp(`version ${TAILNET_TRANSPORT_VERSION + 1}\\b`, 'u'))
  })

  check('a refusal names the version seen and the versions supported', () => {
    const refusal = checkTailnetTransportVersion(99)
    // Both numbers, because either alone is undiagnosable: one says a version is
    // wrong without saying which install to update.
    assert.match(refusal?.message ?? '', /\b99\b/u)
    assert.match(
      refusal?.message ?? '',
      new RegExp(`${TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION}.${TAILNET_TRANSPORT_VERSION}`, 'u'),
    )
  })

  check('a peer that says nothing readable is refused rather than read as a version', () => {
    // Whatever a misconfigured box on that port answers with, it reaches the
    // parser as an unknown. None of it may be coerced into a number.
    for (const seen of [undefined, null, '2', 2.5, Number.NaN, {}, [], Infinity]) {
      const refusal = checkTailnetTransportVersion(seen)
      assert.equal(refusal?.code, 'unsupported_transport_version', `must refuse: ${String(seen)}`)
      // And it must not report a version, since it did not state one.
      assert.match(refusal?.message ?? '', /did not state a transport version/u)
    }
  })

  // ── Capabilities, which are not the version ──────────────────────────────────

  check('a feature is read from the capability list, and an absent list promises nothing', () => {
    assert.equal(tailnetPeerSupports([...TAILNET_CAPABILITIES], 'events'), true)
    assert.equal(tailnetPeerSupports(['upload'], 'events'), false)
    // A peer from before the field shipped has no capabilities, not all of them —
    // the opposite reading would have this build call routes that are not there.
    assert.equal(tailnetPeerSupports(undefined, 'upload'), false)
    assert.equal(tailnetPeerSupports([], 'upload'), false)
  })

  // ── The handshake ────────────────────────────────────────────────────────────

  /** A listener that answers `identity` with exactly the body given. */
  async function withIdentity(body: unknown, run: (port: number) => Promise<void>): Promise<void> {
    const server: Server = createServer((request, response) => {
      if (request.url === '/tailnet/v1/identity') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{}')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      await run(port)
    } finally {
      server.close()
      await once(server, 'close')
    }
  }

  function identityBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      deviceId: 'dev-1',
      deviceName: 'mac-mini',
      scopes: ['workspace:read'],
      transportVersion: TAILNET_TRANSPORT_VERSION,
      capabilities: [...TAILNET_CAPABILITIES],
      ...overrides,
    }
  }

  check('a peer inside the window completes the handshake', async () => {
    await withIdentity(identityBody({ transportVersion: TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION }), async (port) => {
      const identity = await readRemoteIdentity({ endpoint: { host: '127.0.0.1', port }, token: 'tok' })
      assert.equal(identity.ok, true)
      assert.equal(identity.ok && identity.value.deviceName, 'mac-mini')
      assert.equal(identity.ok && identity.value.transportVersion, TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION)
    })
  })

  check('a peer outside the window is refused at the handshake, by name', async () => {
    await withIdentity(identityBody({ transportVersion: TAILNET_TRANSPORT_VERSION + 3 }), async (port) => {
      const identity = await readRemoteIdentity({ endpoint: { host: '127.0.0.1', port }, token: 'tok' })
      assert.equal(identity.ok, false)
      assert.equal(identity.ok === false && identity.code, 'unsupported_transport_version')
      // The refusal a person reads in the Remote panel, naming both versions.
      assert.match(identity.ok === false ? identity.message : '', new RegExp(`${TAILNET_TRANSPORT_VERSION + 3}`, 'u'))
      assert.match(
        identity.ok === false ? identity.message : '',
        new RegExp(`${TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION}.${TAILNET_TRANSPORT_VERSION}`, 'u'),
      )
    })
  })

  check('a handshake that states no version is refused, not assumed current', async () => {
    const body = identityBody()
    delete body.transportVersion
    await withIdentity(body, async (port) => {
      const identity = await readRemoteIdentity({ endpoint: { host: '127.0.0.1', port }, token: 'tok' })
      assert.equal(identity.ok === false && identity.code, 'unsupported_transport_version')
    })
  })

  check('the capability list crosses the handshake, and a malformed one does not throw', async () => {
    await withIdentity(identityBody({ capabilities: ['events', 7, null, 'upload'] }), async (port) => {
      const identity = await readRemoteIdentity({ endpoint: { host: '127.0.0.1', port }, token: 'tok' })
      // A peer is free to publish names this build has never heard of, so the
      // list is not filtered against ours — only the non-strings are dropped.
      assert.deepEqual(identity.ok && identity.value.capabilities, ['events', 'upload'])
    })
    await withIdentity(identityBody({ capabilities: 'events' }), async (port) => {
      const identity = await readRemoteIdentity({ endpoint: { host: '127.0.0.1', port }, token: 'tok' })
      // Not a list at all is null — "this peer named nothing" — which is a
      // different fact from an empty list and must not be an exception thrown at
      // a reachability probe either.
      assert.equal(identity.ok && identity.value.capabilities, null)
    })
  })

  // ── The capability gate, end to end ─────────────────────────────────────────

  /**
   * A listener that answers `identity` and records every other path asked of it.
   *
   * Enough of a machine for the reachability supervisor: it authenticates nothing
   * (the token is never checked) because what is under test is which routes the
   * Fleet decides to dial, not who it is allowed to dial them as.
   */
  async function withFakeMachine(
    capabilities: string[] | null,
    run: (input: { port: number; paths: string[] }) => Promise<void>,
  ): Promise<void> {
    const paths: string[] = []
    const server: Server = createServer((request, response) => {
      paths.push((request.url ?? '').split('?')[0])
      if (request.url === '/tailnet/v1/identity') {
        response.writeHead(200, { 'content-type': 'application/json' })
        const body = identityBody({ capabilities })
        // Null stands for a build that predates the capability list, which says
        // the field not at all rather than saying it empty.
        if (capabilities === null) delete body.capabilities
        response.end(JSON.stringify(body))
        return
      }
      if (request.url === '/tailnet/v1/ws-ticket') {
        // Minted for real, because the change-feed dial asks for one BEFORE it
        // names the events route: refusing it here would hide the very request
        // this test is looking for.
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ticket: 'mctk_test', expiresAt: '2026-09-14T10:00:30.000Z' }))
        return
      }
      // Exactly what a build without the change feed answers: the route is not there.
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{}')
    })
    // The upgrade never reaches the request handler, so the one path the gate is
    // about would otherwise be invisible — and both assertions below would pass
    // for the wrong reason.
    server.on('upgrade', (request, socket) => {
      paths.push((request.url ?? '').split('?')[0])
      socket.destroy()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      await run({ port, paths })
    } finally {
      server.close()
      await once(server, 'close')
    }
  }

  check('a machine that does not advertise the change feed stops being dialled for it', async () => {
    await withFakeMachine([], async ({ port, paths }) => {
      const dir = mkdtempSync(join(tmpdir(), 'sprintengine-fleet-capability-'))
      const store = createTailnetFleetStore({ resolveUserDataDir: () => dir })
      store.add({
        machineName: 'mac-mini',
        endpoint: `127.0.0.1:${port}`,
        deviceId: 'dev-1',
        deviceName: 'dev-macbook-air',
        deviceToken: 'tok',
        scopes: ['workspace:read'],
        pairedVia: 'link',
      })
      const fleet = createTailnetFleetService({
        resolveUserDataDir: () => dir,
        createStore: () => store,
        reachabilityIntervalMs: 50,
        reachabilityTimeoutMs: 500,
      })
      try {
        fleet.start()
        await fleet.checkReachability()
        // Long enough for several retry backoffs, which is what the gate is for:
        // a machine with no events route would otherwise be re-dialled forever.
        await new Promise((resolve) => setTimeout(resolve, 1500))
        const dials = paths.filter((path) => path === '/tailnet/v1/events').length
        // At most one: `start` opens the watch before the first handshake has
        // come back, by design, so that dial may race through. What must not
        // happen is a second one, after the machine has said it has no feed.
        assert.equal(
          dials <= 1,
          true,
          `the change feed was re-dialled ${dials} times on a machine that does not serve it`,
        )
        // And the machine is still a perfectly good machine otherwise.
        assert.equal(paths.includes('/tailnet/v1/identity'), true)
      } finally {
        fleet.shutdown()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  check('a machine that advertises the change feed is dialled for it', async () => {
    await withFakeMachine(['events'], async ({ port, paths }) => {
      const dir = mkdtempSync(join(tmpdir(), 'sprintengine-fleet-capability-on-'))
      const store = createTailnetFleetStore({ resolveUserDataDir: () => dir })
      store.add({
        machineName: 'build-box',
        endpoint: `127.0.0.1:${port}`,
        deviceId: 'dev-2',
        deviceName: 'dev-macbook-air',
        deviceToken: 'tok',
        scopes: ['workspace:read'],
        pairedVia: 'link',
      })
      const fleet = createTailnetFleetService({
        resolveUserDataDir: () => dir,
        createStore: () => store,
        reachabilityIntervalMs: 50,
        reachabilityTimeoutMs: 500,
      })
      try {
        fleet.start()
        await fleet.checkReachability()
        await new Promise((resolve) => setTimeout(resolve, 1500))
        // The other half of the gate, over the same window: a machine that names
        // the capability keeps being retried, which is the behaviour the gate
        // must leave alone. (The fake refuses the upgrade, so what is pinned is
        // that the dial was attempted — the decision under test.)
        const dials = paths.filter((path) => path === '/tailnet/v1/events').length
        assert.equal(dials >= 2, true, `expected the change feed to be retried, saw ${dials} dials`)
      } finally {
        fleet.shutdown()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  check('a machine that publishes no capability list at all is still dialled', async () => {
    // Silence is not a denial. The change feed shipped a day before the
    // capability list did, so a build from that window serves the feed and names
    // nothing — reading that as "no feed" would switch off a feature that works.
    await withFakeMachine(null, async ({ port, paths }) => {
      const dir = mkdtempSync(join(tmpdir(), 'sprintengine-fleet-capability-silent-'))
      const store = createTailnetFleetStore({ resolveUserDataDir: () => dir })
      store.add({
        machineName: 'dev-macbook-air',
        endpoint: `127.0.0.1:${port}`,
        deviceId: 'dev-3',
        deviceName: 'mac-mini',
        deviceToken: 'tok',
        scopes: ['workspace:read'],
        pairedVia: 'link',
      })
      const fleet = createTailnetFleetService({
        resolveUserDataDir: () => dir,
        createStore: () => store,
        reachabilityIntervalMs: 50,
        reachabilityTimeoutMs: 500,
      })
      try {
        fleet.start()
        await fleet.checkReachability()
        await new Promise((resolve) => setTimeout(resolve, 1500))
        const dials = paths.filter((path) => path === '/tailnet/v1/events').length
        assert.equal(dials >= 2, true, `a silent machine must still be watched, saw ${dials} dials`)
      } finally {
        fleet.shutdown()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  const suiteRun = queue.then(() => {
    if (failures > 0) {
      console.error(`${failures} test(s) failed`)
      process.exit(1)
    }
    console.log('tailnet transport version tests passed')
  })

  await suiteRun
})
