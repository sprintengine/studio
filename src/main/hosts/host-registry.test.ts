import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ExecutionHostId, ExecutionHostSettings } from '../../shared/execution-host'
import { createHostRegistry } from './host-registry'
import { decodeWslOutput, parseWslListVerbose, type WslListing } from './wsl-distro'

// `wsl.exe --list --verbose` as it arrives on a pipe: UTF-16LE with a byte
// order mark, CRLF, the default marked with `*`.
const LIST_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  Buffer.from(
    [
      '  NAME            STATE           VERSION',
      '* Ubuntu          Running         2',
      '  Debian          Stopped         2',
      '  Alpine          Installing      1',
      '',
    ].join('\r\n'),
    'utf16le',
  ),
])

function listing(): WslListing {
  return { distros: parseWslListVerbose(decodeWslOutput(LIST_BYTES)), at: 0 }
}

function registry(
  settings: Partial<Record<ExecutionHostId, ExecutionHostSettings>>,
  options: { platform?: NodeJS.Platform; listing?: WslListing | null } = {},
) {
  let known: WslListing | null = null
  const reads: boolean[] = []
  const hosts = createHostRegistry({
    platform: options.platform ?? 'win32',
    readHostSettings: () => settings,
    listDistros: async ({ force }) => {
      reads.push(force)
      known = options.listing === undefined ? listing() : (options.listing ?? { distros: null, at: 0 })
      return known
    },
    knownListing: () => known,
  })
  return { hosts, reads }
}

const on = (extra: Partial<ExecutionHostSettings> = {}): ExecutionHostSettings => ({
  enabled: true,
  cliCommands: {},
  env: {},
  ...extra,
})

test('the picker lists this PC, then the enabled distributions, default first', async () => {
  const { hosts } = registry({ 'wsl:Debian': on(), 'wsl:Ubuntu': on() })
  const { hosts: summaries, wsl } = await hosts.list()
  assert.deepEqual(
    summaries.map((host) => [host.id, host.label, host.state]),
    [
      ['local', 'This PC (Windows)', 'ready'],
      ['wsl:Ubuntu', 'WSL: Ubuntu', 'ready'],
      ['wsl:Debian', 'WSL: Debian', 'stopped'],
    ],
  )
  assert.equal(summaries[1].isDefaultDistro, true)
  assert.deepEqual(wsl, { available: true })
})

test('Settings lists every distribution; one turned on and since removed reads unavailable', async () => {
  const { hosts, reads } = registry({ 'wsl:Gone': on() })
  const all = await hosts.list({ all: true, refresh: true })
  assert.deepEqual(reads, [true], 'refresh asks WSL again')
  assert.deepEqual(
    all.hosts.map((host) => [host.id, host.enabled ?? null, host.state]),
    [
      ['local', null, 'ready'],
      ['wsl:Ubuntu', false, 'ready'],
      ['wsl:Alpine', false, 'starting'],
      ['wsl:Debian', false, 'stopped'],
      ['wsl:Gone', true, 'unavailable'],
    ],
  )
  assert.equal(all.hosts.find((host) => host.id === 'wsl:Gone')?.reason, 'This distribution is not installed.')
})

test('WSL that does not answer is said, not shown as an empty list', async () => {
  const { hosts } = registry({}, { listing: null })
  const result = await hosts.list({ all: true })
  assert.deepEqual(
    result.hosts.map((host) => host.id),
    ['local'],
  )
  assert.equal(result.wsl?.available, false)
  assert.match(result.wsl?.reason ?? '', /wsl --install/u)
})

test('a refresh tells subscribers; a plain read does not', async () => {
  const { hosts } = registry({})
  let told = 0
  const unsubscribe = hosts.subscribe(() => (told += 1))
  await hosts.list()
  assert.equal(told, 0)
  await hosts.list({ refresh: true })
  assert.equal(told, 1)
  hosts.notifyChanged()
  assert.equal(told, 2)
  unsubscribe()
  hosts.notifyChanged()
  assert.equal(told, 2)
})

test('resolve and get: a WSL host exists for any valid distribution, listed or not', () => {
  const { hosts } = registry({ 'wsl:Ubuntu': on({ cliCommands: { codex: '/home/dev/bin/codex' } }) })
  const ubuntu = hosts.resolve({ folder: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo' })
  assert.equal(ubuntu.id, 'wsl:Ubuntu')
  assert.equal(ubuntu.pathStyle, 'wsl')
  assert.equal(hosts.get('wsl:Ubuntu'), ubuntu, 'one object per distribution')
  assert.equal(hosts.get('wsl:NeverListed').kind, 'wsl')
  assert.equal(hosts.get('wsl:bad name').id, 'local')
  assert.equal(hosts.resolve({ folder: 'C:\\Users\\dev\\repo' }).kind, 'windows')
  assert.deepEqual(ubuntu.cliRuntime('codex', { command: 'C:\\tools\\codex.cmd', models: ['m'] }), {
    command: '/home/dev/bin/codex',
    models: ['m'],
    hostId: 'wsl:Ubuntu',
  })
  assert.deepEqual(hosts.local().cliRuntime('codex', { command: ' codex ' }), { command: 'codex' })
})

test('off Windows there is one machine, whatever the settings or the request say', async () => {
  const { hosts, reads } = registry({ 'wsl:Ubuntu': on() }, { platform: 'darwin' })
  const result = await hosts.list({ all: true, refresh: true })
  assert.deepEqual(
    result.hosts.map((host) => [host.id, host.kind, host.label]),
    [['local', 'posix', 'This Mac']],
  )
  assert.equal(result.wsl, null)
  assert.deepEqual(reads, [], 'WSL is never asked')
  const host = hosts.resolve({ requested: 'wsl:Ubuntu', bound: 'wsl:Ubuntu' })
  assert.equal(host.kind, 'posix')
  assert.deepEqual(host.launchTarget(), { kind: 'posix' })
  assert.equal(host.toHostPath('/Users/dev/repo'), '/Users/dev/repo')
})

test("a WSL machine's launch target carries its own environment and shell", () => {
  const { hosts } = registry({
    'wsl:Ubuntu': on({ env: { NODE_OPTIONS: '--max-old-space-size=4096' }, shell: 'zsh -l' }),
  })
  assert.deepEqual(hosts.get('wsl:Ubuntu').launchTarget(), {
    kind: 'wsl',
    distro: 'Ubuntu',
    env: { NODE_OPTIONS: '--max-old-space-size=4096' },
    shell: 'zsh -l',
  })
  assert.deepEqual(hosts.get('wsl:Debian').launchTarget(), { kind: 'wsl', distro: 'Debian', env: {} })
  const ubuntu = hosts.get('wsl:Ubuntu')
  assert.equal(ubuntu.toHostPath('\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'), '/home/dev/repo')
  assert.equal(ubuntu.toHostPath('C:\\Users\\dev\\repo'), '/mnt/c/Users/dev/repo')
  assert.equal(ubuntu.toNativePath('/home/dev/repo'), '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo')
  assert.equal(ubuntu.toNativePath('/mnt/c/Users/dev'), 'C:\\Users\\dev')
})
