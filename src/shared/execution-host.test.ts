import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  distroOfHostId,
  executionHostLabel,
  hostCliCommand,
  hostIdForFolder,
  isWslHostId,
  LOCAL_HOST_ID,
  normalizeExecutionHostId,
  normalizeExecutionHostSettings,
  pathStyleOfHost,
  resolveLaunchHostId,
} from './execution-host'
import { parseAgentLaunchSettingsRecord } from './launch-settings'

test('a WSL host id names its distribution, and nothing else is one', () => {
  assert.equal(distroOfHostId('wsl:Ubuntu'), 'Ubuntu')
  assert.equal(distroOfHostId('wsl:Ubuntu-24.04'), 'Ubuntu-24.04')
  assert.equal(distroOfHostId('local'), null)
  assert.equal(distroOfHostId('wsl:'), null)
  assert.equal(distroOfHostId('wsl:two words'), null, 'WSL refuses such a name, so -d never gets one')
  assert.equal(distroOfHostId('wsl:a;rm -rf /'), null)
  assert.equal(isWslHostId('wsl:Debian'), true)
  assert.equal(isWslHostId(undefined), false)
  assert.equal(normalizeExecutionHostId('local'), LOCAL_HOST_ID)
  assert.equal(normalizeExecutionHostId('wsl:Debian'), 'wsl:Debian')
  assert.equal(normalizeExecutionHostId('wsl:bad name'), null)
  assert.equal(normalizeExecutionHostId(42), null)
})

test('a folder inside a distribution belongs to it, whichever share names it', () => {
  assert.equal(hostIdForFolder('\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'), 'wsl:Ubuntu')
  assert.equal(hostIdForFolder('\\\\wsl$\\Debian\\srv\\app'), 'wsl:Debian')
  assert.equal(hostIdForFolder('//wsl.localhost/Ubuntu-24.04/home/dev'), 'wsl:Ubuntu-24.04')
  assert.equal(hostIdForFolder('C:\\Users\\dev\\repo'), null)
  assert.equal(hostIdForFolder('/home/dev/repo'), null, 'a bare Linux path names no distribution')
  assert.equal(hostIdForFolder(null), null)
})

test('resolveLaunchHostId: bound, then requested, then the folder, then this machine — on Windows only', () => {
  const unc = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'
  const cases: Array<[Parameters<typeof resolveLaunchHostId>[0], string, string]> = [
    [{ platform: 'win32' }, 'local', 'nothing said: this machine'],
    [{ platform: 'win32', folder: 'C:\\Users\\dev\\repo' }, 'local', 'a Windows folder: this machine'],
    [{ platform: 'win32', folder: unc }, 'wsl:Ubuntu', 'a folder inside a distribution runs there'],
    [{ platform: 'win32', folder: unc, requested: 'wsl:Debian' }, 'wsl:Debian', "the workspace's machine wins"],
    [{ platform: 'win32', folder: unc, requested: 'local' }, 'local', 'an explicit local wins too'],
    [
      { platform: 'win32', folder: unc, requested: 'wsl:Debian', bound: 'wsl:Alpine' },
      'wsl:Alpine',
      'a session keeps the machine its transcript lives on',
    ],
    [{ platform: 'win32', requested: 'wsl:bad name', folder: unc }, 'wsl:Ubuntu', 'an invalid id is ignored'],
    [{ platform: 'darwin', requested: 'wsl:Ubuntu', bound: 'wsl:Ubuntu', folder: unc }, 'local', 'macOS has one'],
    [{ platform: 'linux', requested: 'wsl:Ubuntu' }, 'local', 'so does Linux'],
  ]
  for (const [input, expected, why] of cases) assert.equal(resolveLaunchHostId(input), expected, why)
})

test('path style and label follow the host and the platform', () => {
  assert.equal(pathStyleOfHost('local', 'darwin'), 'posix')
  assert.equal(pathStyleOfHost('local', 'win32'), 'windows')
  assert.equal(pathStyleOfHost('wsl:Ubuntu', 'win32'), 'wsl')
  assert.equal(executionHostLabel('local', 'darwin'), 'This Mac')
  assert.equal(executionHostLabel('local', 'win32'), 'This PC (Windows)')
  assert.equal(executionHostLabel('local', 'linux'), 'This computer')
  assert.equal(executionHostLabel('wsl:Ubuntu', 'win32'), 'WSL: Ubuntu')
})

test('host settings normalize fail-soft', () => {
  assert.deepEqual(normalizeExecutionHostSettings(null), { enabled: false, cliCommands: {}, env: {} })
  assert.deepEqual(
    normalizeExecutionHostSettings({
      enabled: true,
      cliCommands: { codex: '/home/dev/bin/codex', bad: 3 },
      env: { OK_NAME: 'v', 'bad-name': 'x', N: 1 },
      shell: '  ',
    }),
    { enabled: true, cliCommands: { codex: '/home/dev/bin/codex' }, env: { OK_NAME: 'v' } },
  )
  assert.equal(normalizeExecutionHostSettings({ shell: ' zsh -l ' }).shell, 'zsh -l')
})

test("a CLI's command on a machine: this one keeps the runtime's, a WSL one its own", () => {
  const wsl = { enabled: true, cliCommands: { codex: ' /home/dev/bin/codex ' }, env: {} }
  assert.equal(hostCliCommand(wsl, 'codex', 'C:\\tools\\codex.cmd', 'local'), 'C:\\tools\\codex.cmd')
  assert.equal(hostCliCommand(wsl, 'codex', 'C:\\tools\\codex.cmd', 'wsl:Ubuntu'), '/home/dev/bin/codex')
  assert.equal(hostCliCommand(wsl, 'claude-code', 'claude', 'wsl:Ubuntu'), '', 'blank runs the manifest binary')
})

test('a version-1 launch settings record is read, without the retired WSL switch', () => {
  const record = parseAgentLaunchSettingsRecord({
    schemaVersion: 1,
    revision: 4,
    settings: { cliRuntimes: { codex: { command: '/Users/dev/bin/codex', useWsl: true } } },
    changedAt: 1,
    lastWrite: { actor: 'ui', at: '' },
  })
  assert.ok(record)
  assert.equal(record.schemaVersion, 2)
  assert.equal(record.revision, 4, 'the revision survives, so no window re-offers a migration')
  assert.deepEqual(record.settings.cliRuntimes, { codex: { command: '/Users/dev/bin/codex' } })
  assert.deepEqual(record.settings.hosts, {})
  assert.equal(parseAgentLaunchSettingsRecord({ schemaVersion: 3, revision: 1, settings: {} }), null)
})
