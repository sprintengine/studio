import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { connectLineClient, createFakeBackend, hello } from '../../server/rpc/studio-rpc.test-helper'
import { createStudioRpcService } from './studio-rpc-service'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function harness(nested = '') {
  const root = await mkdtemp(join(tmpdir(), 'studio-rpc-service-'))
  const dir = join(root, nested)
  await mkdir(dir, { recursive: true })
  let clock = Date.parse('2026-10-01T10:00:00Z')
  const records: Array<{ tool: string; args: Record<string, unknown>; ok: boolean }> = []
  const service = createStudioRpcService({
    paths: { dataDir: () => dir },
    identity: { version: () => '0.0.0-test' },
    clients: { publish: () => undefined },
    backend: () => createFakeBackend(),
    audit: () =>
      ({
        record: (input: { tool: string; args: Record<string, unknown>; result?: { isError?: boolean } }) =>
          void records.push({ tool: input.tool, args: input.args, ok: !input.result?.isError }),
      }) as never,
    now: () => clock,
  })
  await service.start()
  assert.equal(service.getStatus().lastError, null)
  cleanups.push(async () => {
    await service.stop()
    await rm(root, { recursive: true, force: true })
  })
  return {
    dir,
    service,
    records,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

async function refuse(path: string): Promise<void> {
  const client = await connectLineClient(path)
  client.send(hello({ token: 'sest_not_a_real_token_000' }))
  await client.next((frame) => frame.t === 'bye')
  await client.closed
}

test('a loop of bad credentials is audited a few a minute, with a count of what was left out', async () => {
  const { service, records, advance } = await harness()
  const path = service.getStatus().socketPath!
  for (let index = 0; index < 8; index++) await refuse(path)
  const refused = () => records.filter((record) => record.tool === 'studio.auth_refused')
  assert.equal(refused().length, 5)
  advance(60_000)
  await refuse(path)
  assert.equal(refused().length, 6)
  assert.equal(refused().at(-1)?.args.suppressed, 3)
})

test('minting a pairing code and revoking an app from Settings are audited', async () => {
  const { service, records } = await harness()
  const { code } = service.offer({ name: 'release-bot', scopes: ['conversation:read'], ceiling: 'manual' })
  const client = await connectLineClient(service.getStatus().socketPath!)
  cleanups.push(() => client.close())
  client.send(hello({ pairingCode: code }))
  const welcome = await client.next((frame) => frame.t === 'welcome')
  const id = welcome.t === 'welcome' ? welcome.grant.clientId : ''
  service.revoke(id)
  assert.deepEqual(
    records.map((record) => [record.tool, record.ok]),
    [
      ['studio.settings.pairing_code', true],
      ['studio.paired', true],
      ['studio.settings.revoke', true],
    ],
  )
})

test('a Studio whose socket is not the live one neither pairs nor revokes', async () => {
  // A data directory long enough that the socket falls back to a temp
  // directory with a random name: the second Studio finds the first through
  // the discovery file, not the path.
  const { dir } = await harness(`${'long-profile-name-'.repeat(4)}x`)
  const second = createStudioRpcService({
    paths: { dataDir: () => dir },
    identity: { version: () => '0.0.0-second' },
    clients: { publish: () => undefined },
    backend: () => createFakeBackend(),
    audit: () => ({ record: () => undefined }) as never,
  })
  await second.start()
  cleanups.push(() => second.stop())
  assert.equal(second.getStatus().running, false)
  assert.match(second.getStatus().lastError ?? '', /Another Studio is already serving/)
  assert.throws(() => second.offer({ name: 'x', scopes: ['conversation:read'], ceiling: 'manual' }), /not serving/)
  assert.throws(() => second.revoke('sla_1'), /not serving/)
})
