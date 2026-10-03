import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { SSH_ENV_CHANNELS } from '../../../shared/ssh-environments'
import { redactDiagnostics, SshEnvironments } from './ssh-environments'

// The desktop's saved SSH machines: added only once `ssh -G` makes sense of
// them, kept with no credential, and their prompts shown in every window,
// the first answer winning. `ssh -G` connects to nothing, so this runs
// anywhere OpenSSH is installed.

const HAS_SSH = spawnSync('ssh', ['-V']).status === 0
let dir = ''
let config = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'se-sshenvs-'))
  config = join(dir, 'ssh_config')
  writeFileSync(
    config,
    'Host build-box\n  HostName 192.0.2.10\n  User dev\n  Port 2222\n  ProxyJump bastion\n  StrictHostKeyChecking no\n',
  )
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function machines() {
  const sent: Array<[string, unknown]> = []
  const store = new SshEnvironments({
    userDataDir: join(dir, 'user-data'),
    app: { version: '0.4.0', channel: 'latest' },
    packaged: false,
    resourcesDir: null,
    appRoot: null,
    isDefaultProfile: true,
    startedBy: 'Studio on dev-macbook-air',
    broadcast: (channel, payload) => sent.push([channel, payload]),
    configFile: config,
  })
  return { store, sent }
}

test.skipIf(!HAS_SSH)('a machine is resolved before it is saved, and saved with no credential', async () => {
  const { store, sent } = machines()
  const resolved = await store.resolve('build-box')
  assert.ok(resolved.ok)
  if (resolved.ok) {
    assert.deepEqual(
      { ...resolved.resolved, notes: resolved.resolved.notes.length },
      { hostname: '192.0.2.10', user: 'dev', port: 2222, proxyJump: 'bastion', notes: 1 },
    )
  }
  assert.equal((await store.resolve('-oProxyCommand=x')).ok, false)
  const added = await store.add({ destination: 'build-box' })
  assert.ok(added.ok && added.id)
  assert.equal((await store.add({ destination: 'build-box' })).ok, false, 'one entry per destination')
  assert.ok(sent.some(([channel]) => channel === SSH_ENV_CHANNELS.changed))
  const file = join(dir, 'user-data', 'ssh-environments.json')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { environments: Array<Record<string, unknown>> }
  assert.deepEqual(Object.keys(saved.environments[0]!).sort(), [
    'addedAt',
    'destination',
    'environmentId',
    'id',
    'label',
    'resolved',
    'settings',
  ])
  const [listed] = store.list()
  assert.equal(listed?.stateText, 'Not connected')
  assert.equal(listed?.action, 'connect')

  // Settings are checked; an install directory with a space is refused.
  assert.equal(store.update(added.id!, { installDir: '/opt/my dir' }).ok, false)
  assert.ok(store.update(added.id!, { installDir: '/opt/dev', keepRunning: true, paneTraffic: 'loopback' }).ok)
  assert.equal(store.get(added.id!)?.settings.paneTraffic, 'loopback')

  // A reload reads the same machine back.
  assert.equal(machines().store.list()[0]?.label, 'build-box')
  assert.ok((await store.forget(added.id!)).ok)
  assert.deepEqual(store.list(), [])
})

test('a prompt goes to every window and closes everywhere on the first answer', async () => {
  const { store, sent } = machines()
  const asking = (store as unknown as { ask: (request: object, signal: AbortSignal) => Promise<string | null> }).ask(
    { kind: 'password', text: "dev@build-box's password:", label: 'build-box' },
    new AbortController().signal,
  )
  const [, shown] = sent.find(([channel]) => channel === SSH_ENV_CHANNELS.prompt)! as [string, { id: string }]
  store.answer('not-a-prompt', 'x')
  store.answer(shown.id, 'pa ss')
  assert.equal(await asking, 'pa ss')
  assert.ok(
    sent.some(
      ([channel, payload]) => channel === SSH_ENV_CHANNELS.promptClosed && (payload as { id: string }).id === shown.id,
    ),
  )
  store.answer(shown.id, 'again')
  // Abandoned by ssh: closed with no answer.
  const controller = new AbortController()
  const gone = (store as unknown as { ask: (request: object, signal: AbortSignal) => Promise<string | null> }).ask(
    { kind: 'remote', text: '(dev@build-box) Code:', label: 'build-box' },
    controller.signal,
  )
  controller.abort()
  assert.equal(await gone, null)
})

test('diagnostics leave out addresses, tokens and the remote user name', () => {
  const text = redactDiagnostics(
    'ssh said: Connection to 203.0.113.7 port 22 closed\nhome /home/devuser\nfe80::1:2 here\nseown_abcdef',
    'devuser',
  )
  assert.ok(!text.includes('203.0.113.7'))
  assert.ok(!text.includes('devuser'))
  assert.ok(!text.includes('fe80::1:2'))
  assert.ok(!text.includes('seown_abcdef'))
})

test('a CLI Studio cannot sign in without a terminal is told the exact command, over the person own SSH', async () => {
  const { signInOverSsh } = await import('./ssh-environments')
  assert.equal(
    signInOverSsh('opencode', { destination: 'dev@build-box.example.com:2222', label: 'build-box' }),
    'Sign opencode in once on build-box over your own SSH session: ssh -t ssh://dev@build-box.example.com:2222 opencode auth login',
  )
  assert.match(signInOverSsh('grok', { destination: 'build-box', label: 'build-box' }), /API key/u)
})
