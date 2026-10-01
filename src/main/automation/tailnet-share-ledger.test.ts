// A `tailscale serve --bg` mapping outlives the app, so each one the app
// publishes is listed in the integration ledger, and one the person stops from
// the app is taken off the list. Never runs the real `tailscale`.

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { createIntegrationLedger, installIntegrationLedger } from '../integrations/ledger'
import { createTailnetShareService } from './tailnet/tailnet-share-service'
import type { TailscaleRun } from './tailnet/tailscale-cli'

afterEach(() => installIntegrationLedger(null))

const STATUS_JSON = JSON.stringify({
  BackendState: 'Running',
  Self: { ID: 'self', DNSName: 'mac-mini.tail1234.ts.net.', HostName: 'mac-mini', TailscaleIPs: ['100.101.102.103'] },
  Peer: {},
})

test('a share is listed with its ports, and stopping it from the app takes it off the list', async () => {
  const ledger = createIntegrationLedger({
    path: join(await mkdtemp(join(tmpdir(), 'sprintengine-tailnet-ledger-')), 'integration-ledger.json'),
  })
  installIntegrationLedger(ledger)
  const served = new Map<number, number>()
  const service = createTailnetShareService({
    read: async (args) =>
      args[0] === 'serve'
        ? JSON.stringify({
            Web: Object.fromEntries(
              [...served].map(([servePort, localPort]) => [
                `mac-mini.tail1234.ts.net:${servePort}`,
                { Handlers: { '/': { Proxy: `http://127.0.0.1:${localPort}` } } },
              ]),
            ),
          })
        : STATUS_JSON,
    run: async (args): Promise<TailscaleRun> => {
      const port = Number(String(args.find((arg) => String(arg).startsWith('--https=')) ?? '').slice('--https='.length))
      if (args.includes('off')) served.delete(port)
      else served.set(port, Number(String(args.at(-1)).split(':').pop()))
      return { ok: true, stdout: '' }
    },
  })

  const shared = await service.share(5173)
  assert.ok(shared.ok && shared.share)
  await ledger.flush()
  const [entry] = await ledger.list()
  assert.equal(entry.kind, 'tailnet-share')
  assert.deepEqual(entry.detail, { servePort: shared.share.servePort, localPort: 5173 })

  assert.ok((await service.unshare(shared.share.servePort)).ok)
  await ledger.flush()
  assert.deepEqual(await ledger.list(), [])
})
