import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'

import { STUDIO_MCP_SERVER_NAME } from '../../shared/product-identity'
import {
  createTailnetPeerScanner,
  parseTailscaleStatus,
  probeStudioListener,
  readHealthPayload,
} from './tailnet/tailnet-peers'
import { test } from 'vitest'

test('tailnet-peers', async () => {
  // Peer discovery (MC-2163): the client half of tailnet remote control.
  //
  // Two boundaries are worth pinning, because both are places where something
  // outside this app becomes something inside it:
  //
  //  1. `tailscale status --json` — the shape is Tailscale's, so our reading of
  //     it is the only thing we can test. A node we cannot dial must not appear
  //     in a picker, and a Tailscale that is absent or down must be reported as
  //     itself rather than as an empty tailnet.
  //  2. The health probe — another machine's bytes. It decides whether a peer
  //     goes in the picker as drivable, so a stray 200 from some other service
  //     must not qualify, and what we keep from the payload must be only the
  //     product and the versions.

  let failures = 0
  // Tests are queued in declaration order and run one at a time: several of them
  // bind a real socket, and interleaving those would make a port conflict look
  // like a discovery bug.
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

  function statusJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      BackendState: 'Running',
      Self: {
        ID: 'node-self',
        HostName: 'studio-desktop',
        DNSName: 'studio-desktop.tail1234.ts.net.',
        OS: 'macOS',
        TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'],
      },
      Peer: {
        'key-a': {
          ID: 'node-laptop',
          HostName: 'studio-laptop',
          DNSName: 'studio-laptop.tail1234.ts.net.',
          OS: 'linux',
          Online: true,
          TailscaleIPs: ['100.64.0.2'],
        },
        'key-b': {
          ID: 'node-phone',
          HostName: 'a-phone',
          DNSName: 'a-phone.tail1234.ts.net.',
          OS: 'iOS',
          Online: false,
          LastSeen: '2026-09-08T09:15:00Z',
          TailscaleIPs: ['100.64.0.3'],
        },
      },
      ...overrides,
    })
  }

  // ── Reading Tailscale's status ───────────────────────────────────────────────

  check('the node list is read from Tailscale, self first and reachable before asleep', () => {
    const parsed = parseTailscaleStatus(statusJson())
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(parsed.backendRunning, true)
    assert.deepEqual(
      parsed.peers.map((peer) => peer.hostName),
      ['studio-desktop', 'studio-laptop', 'a-phone'],
    )

    const self = parsed.peers[0]
    assert.equal(self.isSelf, true)
    // Self carries no Online field; a machine reading its own status is up.
    assert.equal(self.online, true)
    // IPv4 wins when a node has both: it is what a person recognises and what the
    // pairing URL carries.
    assert.equal(self.address, '100.64.0.1')
    // The trailing dot MagicDNS puts on a name is not part of the name.
    assert.equal(self.dnsName, 'studio-desktop.tail1234.ts.net')
    assert.equal(parsed.peers[2].online, false)
  })

  check('a sleeping peer carries the last time Tailscale heard from it', () => {
    const parsed = parseTailscaleStatus(statusJson())
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    const phone = parsed.peers.filter((peer) => peer.hostName === 'a-phone')
    assert.ok(phone.length === 1, 'the sleeping phone is listed')
    // Normalised to an ISO string, so the merge and the relative-time formatter
    // read one shape whatever Tailscale wrote.
    assert.ok(phone[0].lastSeenAt === '2026-09-08T09:15:00.000Z', `got ${phone[0].lastSeenAt}`)
  })

  check('an unknown or zero LastSeen is null rather than a date two thousand years old', () => {
    const parsed = parseTailscaleStatus(
      statusJson({
        Peer: {
          // Tailscale writes the zero timestamp for a node it has never heard
          // from; showing that as a last-seen would be a lie with a date on it.
          zero: {
            ID: 'n-zero',
            HostName: 'never-seen',
            Online: false,
            LastSeen: '0001-01-01T00:00:00Z',
            TailscaleIPs: ['100.64.0.4'],
          },
          absent: { ID: 'n-absent', HostName: 'no-field', Online: true, TailscaleIPs: ['100.64.0.5'] },
          junk: {
            ID: 'n-junk',
            HostName: 'garbled',
            Online: false,
            LastSeen: 'yesterday',
            TailscaleIPs: ['100.64.0.6'],
          },
        },
      }),
    )
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    for (const name of ['never-seen', 'no-field', 'garbled']) {
      const found = parsed.peers.filter((entry) => entry.hostName === name)
      assert.ok(found.length === 1, `expected exactly one peer named ${name}`)
      assert.ok(found[0].lastSeenAt === null, `${name} should carry no last-seen, got ${found[0].lastSeenAt}`)
    }
  })

  check('a node with no dialable tailnet address is not offered', () => {
    const parsed = parseTailscaleStatus(
      statusJson({
        Peer: {
          'no-address': { ID: 'node-x', HostName: 'ghost', Online: true, TailscaleIPs: [] },
          // An address outside Tailscale's ranges is not a tailnet address,
          // whatever the daemon called it — probing it would send a request
          // somewhere this feature has no business reaching.
          'lan-address': { ID: 'node-y', HostName: 'router', Online: true, TailscaleIPs: ['192.168.1.1'] },
          'no-id': { HostName: 'anonymous', Online: true, TailscaleIPs: ['100.64.0.9'] },
          good: { ID: 'node-z', HostName: 'real', Online: true, TailscaleIPs: ['100.64.0.8'] },
        },
      }),
    )
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.deepEqual(
      parsed.peers.filter((peer) => !peer.isSelf).map((peer) => peer.hostName),
      ['real'],
    )
  })

  check('a peer with only an IPv6 tailnet address is still dialable', () => {
    const parsed = parseTailscaleStatus(
      statusJson({
        Peer: { six: { ID: 'n6', HostName: 'v6only', Online: true, TailscaleIPs: ['fd7a:115c:a1e0::5'] } },
      }),
    )
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(parsed.peers[1].address, 'fd7a:115c:a1e0::5')
  })

  check('an unreadable status is reported as itself, not as an empty tailnet', () => {
    const parsed = parseTailscaleStatus('not json at all')
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    assert.match(parsed.reason, /could not read/u)
  })

  check('Tailscale being absent and being down are different, stated answers', async () => {
    const absent = await createTailnetPeerScanner({ runStatus: async () => null }).scan({ port: 8471 })
    assert.equal(absent.tailscaleAvailable, false)
    assert.deepEqual(absent.peers, [])
    assert.match(absent.unavailableReason ?? '', /Install Tailscale/u)

    const down = await createTailnetPeerScanner({
      runStatus: async () => statusJson({ BackendState: 'Stopped' }),
    }).scan({ port: 8471 })
    assert.equal(down.tailscaleAvailable, false)
    assert.deepEqual(down.peers, [], 'a stopped daemon lists nothing, however many nodes it remembers')
    assert.match(down.unavailableReason ?? '', /not connected/u)
    // The two reasons must not be the same sentence: the fix differs.
    assert.notEqual(absent.unavailableReason, down.unavailableReason)
  })

  // ── Probing ──────────────────────────────────────────────────────────────────

  check('only reachable peers are probed, and the answer rides on the peer', async () => {
    const probed: string[] = []
    const scan = await createTailnetPeerScanner({
      runStatus: async () => statusJson(),
      probe: async (address) => {
        probed.push(address)
        return address === '100.64.0.2'
          ? { product: STUDIO_MCP_SERVER_NAME, transportVersion: 1, protocolVersions: ['2025-06-18'] }
          : null
      },
    }).scan({ port: 8471 })

    assert.equal(scan.tailscaleAvailable, true)
    assert.equal(scan.probedPort, 8471)
    // The offline phone is listed but never dialled: the probe could only time out.
    assert.deepEqual(probed.sort(), ['100.64.0.1', '100.64.0.2'])
    const byHost = new Map(scan.peers.map((peer) => [peer.hostName, peer]))
    assert.equal(byHost.get('studio-laptop')?.studio?.product, STUDIO_MCP_SERVER_NAME)
    assert.equal(byHost.get('studio-desktop')?.studio, null)
    assert.equal(byHost.get('a-phone')?.studio, null)
  })

  check('a probe that throws leaves the peer listed and undrivable', async () => {
    const scan = await createTailnetPeerScanner({
      runStatus: async () => statusJson(),
      probe: async () => {
        throw new Error('connection reset')
      },
    }).scan({ port: 8471 })
    assert.equal(scan.peers.length, 3)
    assert.equal(
      scan.peers.every((peer) => peer.studio === null),
      true,
    )
  })

  check('only the health shape counts as a Studio', () => {
    const valid = readHealthPayload(
      JSON.stringify({ product: STUDIO_MCP_SERVER_NAME, transportVersion: 1, protocolVersions: ['2025-06-18'] }),
    )
    assert.deepEqual(valid, {
      product: STUDIO_MCP_SERVER_NAME,
      transportVersion: 1,
      protocolVersions: ['2025-06-18'],
    })
    // An older Studio, which says no `capabilities` at all, is still a Studio:
    // discovery predates the field and must not start refusing machines over it.

    // Anything else on that port — another service, an error page, a captive
    // portal — is not a Studio. Treating a stray 200 as one would put an
    // undrivable machine in the picker.
    for (const body of [
      '<html>hello</html>',
      '"a string"',
      '[1,2,3]',
      JSON.stringify({ transportVersion: 1, protocolVersions: [] }),
      JSON.stringify({ product: 'x', protocolVersions: [] }),
      JSON.stringify({ product: 'x', transportVersion: 'one', protocolVersions: [] }),
      JSON.stringify({ product: 'x', transportVersion: 1.5, protocolVersions: [] }),
      JSON.stringify({ product: 'x', transportVersion: 1 }),
      JSON.stringify({ product: 'x', transportVersion: 1, protocolVersions: [1, 2] }),
    ]) {
      assert.equal(readHealthPayload(body), null, `must refuse: ${body.slice(0, 40)}`)
    }
  })

  check('nothing beyond product and protocol version is carried out of a peer’s answer', () => {
    // The health endpoint is written to say no more than this (pinned by the
    // gateway's own test). This is the other side of that contract: even if a
    // peer volunteered more, discovery would not carry it into this app.
    const payload = readHealthPayload(
      JSON.stringify({
        product: STUDIO_MCP_SERVER_NAME,
        transportVersion: 2,
        protocolVersions: ['2025-06-18'],
        // A field a newer Studio publishes (2026-09-06) and one it does not: the
        // prober must read past both, since it probes whatever is out there.
        capabilities: ['events', 'sliced-frames'],
        somethingLater: true,
        userEmail: 'someone@example.com',
        workspaces: ['/Users/someone/secret-project'],
        pairedDevices: 3,
      }),
    )
    assert.ok(payload)
    assert.deepEqual(Object.keys(payload).sort(), ['product', 'protocolVersions', 'transportVersion'])
    assert.equal(payload.transportVersion, 2)
    assert.equal(JSON.stringify(payload).includes('someone@example.com'), false)
    assert.equal(JSON.stringify(payload).includes('secret-project'), false)
  })

  // ── The probe against a real socket ──────────────────────────────────────────

  async function withServer(
    handler: (path: string) => { status: number; body: string },
    run: (port: number) => Promise<void>,
  ): Promise<void> {
    const server: Server = createServer((request, response) => {
      const answer = handler(request.url ?? '')
      response.writeHead(answer.status, { 'content-type': 'application/json' })
      response.end(answer.body)
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

  check('the probe reads a real listener over a real socket', async () => {
    await withServer(
      (path) =>
        path === '/tailnet/v1/health'
          ? {
              status: 200,
              body: JSON.stringify({
                product: STUDIO_MCP_SERVER_NAME,
                transportVersion: 1,
                protocolVersions: ['2025-06-18'],
              }),
            }
          : { status: 404, body: '{}' },
      async (port) => {
        const answer = await probeStudioListener('127.0.0.1', port)
        assert.equal(answer?.product, STUDIO_MCP_SERVER_NAME)
        assert.equal(answer?.transportVersion, 1)
      },
    )
  })

  check('a listener that answers something else is not a Studio', async () => {
    await withServer(
      () => ({ status: 500, body: 'nope' }),
      async (port) => assert.equal(await probeStudioListener('127.0.0.1', port), null),
    )
    await withServer(
      () => ({ status: 200, body: '<html>some other service</html>' }),
      async (port) => assert.equal(await probeStudioListener('127.0.0.1', port), null),
    )
  })

  check('a peer that answers but never finishes cannot hold the sweep open', async () => {
    // The socket timeout fires on inactivity, so a peer trickling a byte at a
    // time would satisfy it forever while holding a concurrency slot. The hard
    // deadline is what bounds this; without it the probe never resolves.
    const server: Server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"product":"x",')
      const drip = setInterval(() => response.write(' '), 200)
      response.on('close', () => clearInterval(drip))
      // Never ends.
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      const startedAt = Date.now()
      assert.equal(await probeStudioListener('127.0.0.1', port), null)
      // Bounded by the probe's own deadline, not by the test runner giving up.
      assert.ok(Date.now() - startedAt < 5000, 'the probe gave up on its own')
    } finally {
      server.close()
      server.closeAllConnections?.()
      await once(server, 'close')
    }
  })

  check('a port with nothing on it resolves null rather than rejecting', async () => {
    // One dead peer must not fail the whole sweep, so a refused connection is an
    // answer ("not a Studio"), not an error.
    let released = 0
    await withServer(
      () => ({ status: 200, body: '{}' }),
      async (port) => {
        released = port
      },
    )
    assert.equal(await probeStudioListener('127.0.0.1', released), null)
  })

  const suiteRun = queue.then(() => {
    if (failures > 0) {
      console.error(`${failures} test(s) failed`)
      process.exit(1)
    }
    console.log('tailnet peer discovery tests passed')
  })

  await suiteRun
})
