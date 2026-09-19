import assert from 'node:assert/strict'

import { createTailnetShareService } from './tailnet/tailnet-share-service'
import { SERVE_PORT_LADDER } from './tailnet/tailscale-serve'
import type { TailscaleRun } from './tailnet/tailscale-cli'
import { test } from 'vitest'

test('tailnet-share-service', async () => {
  // The service that turns the serve wrapper into the document every client
  // reads. What is worth pinning here is not the happy path — the wrapper's own
  // test covers that — but the REFUSALS, because each one is a boundary on what
  // this app is allowed to do to a machine's network configuration.

  let failures = 0
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

  const STATUS_JSON = JSON.stringify({
    BackendState: 'Running',
    // 100.64.0.0/10 — an address outside that range is not a tailnet address and
    // the peer parser drops the node, which is exactly what it should do.
    Self: {
      ID: 'self',
      DNSName: 'studio-mac.tail1a2b.ts.net.',
      HostName: 'studio-mac',
      TailscaleIPs: ['100.101.102.103'],
    },
    Peer: {},
  })

  /** A fake daemon: `status --json` answers, `serve status --json` reports `served`. */
  function fakeTailscale(served: ReadonlyMap<number, number>, onServe?: (args: readonly string[]) => void) {
    const web: Record<string, unknown> = {}
    for (const [servePort, localPort] of served) {
      web[`studio-mac.tail1a2b.ts.net:${servePort}`] = { Handlers: { '/': { Proxy: `http://127.0.0.1:${localPort}` } } }
    }
    return {
      read: async (args: readonly string[]): Promise<string | null> =>
        args[0] === 'serve' ? JSON.stringify({ Web: web }) : STATUS_JSON,
      run: async (args: readonly string[]): Promise<TailscaleRun> => {
        onServe?.(args)
        return { ok: true, stdout: '' }
      },
    }
  }

  check('a machine without Tailscale reports unavailable, not an error', async () => {
    const service = createTailnetShareService({ read: async () => null })
    const status = await service.readStatus()
    assert.equal(status.available, false)
    assert.deepEqual(status.shares, [])
  })

  check('status lists what the daemon serves, sorted by local port', async () => {
    const service = createTailnetShareService(
      fakeTailscale(
        new Map([
          [10000, 5173],
          [8443, 3000],
        ]),
      ),
    )
    const status = await service.readStatus()
    assert.equal(status.available, true)
    assert.equal(status.dnsName, 'studio-mac.tail1a2b.ts.net')
    assert.deepEqual(
      status.shares.map((share) => share.localPort),
      [3000, 5173],
    )
    assert.equal(status.shares[0]?.url, 'https://studio-mac.tail1a2b.ts.net:8443/')
  })

  check('sharing allocates a ladder port and reports the URL', async () => {
    let served: readonly string[] = []
    const service = createTailnetShareService(fakeTailscale(new Map(), (args) => (served = args)))
    const result = await service.share(5173)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.share?.localPort, 5173)
    assert.equal(result.share?.servePort, SERVE_PORT_LADDER[0])
    assert.ok(served.includes('--bg'), 'the mapping outlives this process')
  })

  check('a full ladder refuses with a sentence, not a crash', async () => {
    const full = new Map(SERVE_PORT_LADDER.map((port, index) => [port, 3000 + index]))
    const service = createTailnetShareService(fakeTailscale(full))
    const result = await service.share(9999)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.message, /already sharing/i)
    // The refusal still carries the truth, so the UI can show what IS shared.
    assert.equal(result.status.ladderFull, true)
  })

  check('Studio never takes down a serve mapping it did not create', async () => {
    // 443 is the tailnet front door, and a person may have pointed it anywhere
    // from a terminal. A port outside the ladder is not ours to withdraw.
    const service = createTailnetShareService(fakeTailscale(new Map([[443, 8080]])))
    const result = await service.unshare(443)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.message, /not shared from Studio/i)
  })

  check('a nonsense port is refused before Tailscale is ever run', async () => {
    let ran = false
    const service = createTailnetShareService({
      read: async () => STATUS_JSON,
      run: async () => {
        ran = true
        return { ok: true, stdout: '' }
      },
    })
    for (const port of [0, -1, 70000, Number.NaN]) {
      const result = await service.share(port)
      assert.equal(result.ok, false, `${port} refused`)
    }
    assert.equal(ran, false, 'no serve command was spawned for an invalid port')
  })

  check('unsharing a ladder port succeeds and returns fresh status', async () => {
    const service = createTailnetShareService(fakeTailscale(new Map([[SERVE_PORT_LADDER[0]!, 5173]])))
    const result = await service.unshare(SERVE_PORT_LADDER[0]!)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.share, null, 'an unshare leaves nothing behind')
  })

  const suiteRun = queue.then(() => {
    if (failures > 0) {
      console.error(`${failures} test(s) failed`)
      process.exit(1)
    }
    console.log('tailnet share service tests passed')
  })

  await suiteRun
})
