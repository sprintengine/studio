import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test, vi } from 'vitest'

import { SshEnvironments } from './ssh-environments'

// The askpass broker a connect waits for, when it cannot start: the connect
// answers in words, and the next one tries the broker again.

const broker = vi.hoisted(() => ({ failures: 0, made: 0 }))
vi.mock('./askpass', async (original) => ({
  ...(await original<typeof import('./askpass')>()),
  createAskpassBroker: async () => {
    broker.made++
    if (broker.failures > 0) {
      broker.failures--
      throw new Error('The askpass socket could not be opened.')
    }
    return { env: () => ({}), close: () => undefined }
  },
}))

const HAS_SSH = spawnSync('ssh', ['-V']).status === 0
let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'se-sshask-'))
  writeFileSync(join(dir, 'ssh_config'), 'Host build-box\n  HostName 192.0.2.10\n  User dev\n')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function store(): SshEnvironments {
  return new SshEnvironments({
    userDataDir: join(dir, `user-data-${Math.random().toString(36).slice(2)}`),
    app: { version: '0.4.0', channel: 'latest' },
    packaged: false,
    resourcesDir: null,
    appRoot: null,
    isDefaultProfile: true,
    startedBy: 'Studio on dev-macbook-air',
    broadcast: () => undefined,
    configFile: join(dir, 'ssh_config'),
  })
}

test('a broker that failed to start is started again by the next caller', async () => {
  broker.failures = 1
  broker.made = 0
  const machines = store() as unknown as { askpass(): Promise<unknown> }
  await assert.rejects(machines.askpass(), /askpass socket/u)
  await machines.askpass()
  assert.equal(broker.made, 2)
})

test.skipIf(!HAS_SSH)('a connect whose broker cannot start answers in words rather than throwing', async () => {
  broker.failures = 1
  const machines = store()
  const added = await machines.add({ destination: 'build-box' })
  assert.ok(added.ok && added.id)
  assert.deepEqual(await machines.connect(added.id!), {
    ok: false,
    message: 'The askpass socket could not be opened.',
  })
})
