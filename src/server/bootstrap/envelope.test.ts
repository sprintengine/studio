import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  parseServerBootstrapEnvelope,
  SERVER_EXIT,
  serverExitRetryable,
  type ServerBootstrapEnvelope,
} from './envelope'

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: ServerBootstrapEnvelope = {
    v: 1,
    role: 'desktop-local',
    dataDir: '/Users/dev/Library/Application Support/SprintEngine Studio',
    logsDir: '/Users/dev/Library/Logs/SprintEngine Studio',
    runDir: '/Users/dev/Library/Application Support/SprintEngine Studio/run',
    tempDir: '/tmp',
    paths: {
      resourcesDir: '/Applications/SprintEngine Studio.app/Contents/Resources',
      appPath: '/Applications/SprintEngine Studio.app/Contents/Resources/app.asar',
      isPackaged: true,
      appExecPath: '/Applications/SprintEngine Studio.app/Contents/MacOS/SprintEngine Studio',
    },
    app: { version: '0.4.0', buildStamp: 'abc123', channel: 'latest' },
    owner: {},
    listeners: { gateway: true, tailnet: 'from-settings' },
    secrets: { kind: 'shell', available: true },
    flags: { diagnostics: false },
  }
  return { ...base, ...overrides }
}

test('a complete envelope is accepted as it is', () => {
  const parsed = parseServerBootstrapEnvelope(envelope())
  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.envelope.role, 'desktop-local')
})

test('a Windows envelope is accepted wherever it is checked', () => {
  const parsed = parseServerBootstrapEnvelope(
    envelope({
      dataDir: 'C:\\Users\\dev\\AppData\\Roaming\\SprintEngine Studio',
      logsDir: 'C:\\Users\\dev\\AppData\\Roaming\\SprintEngine Studio\\logs',
      runDir: 'C:\\Users\\dev\\AppData\\Roaming\\SprintEngine Studio\\run',
      tempDir: 'C:\\Users\\dev\\AppData\\Local\\Temp',
      paths: {
        resourcesDir: 'C:\\Program Files\\SprintEngine Studio\\resources',
        appPath: null,
        isPackaged: true,
        appExecPath: 'C:\\Program Files\\SprintEngine Studio\\SprintEngine Studio.exe',
      },
    }),
  )
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.message)
})

test('each malformed envelope is refused with a reason', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['not an object', 'hello', /not an object/],
    ['another version', envelope({ v: 2 }), /version 2/],
    ['an unknown role', envelope({ role: 'cloud' }), /role/],
    ['a relative data directory', envelope({ dataDir: 'data' }), /dataDir/],
    ['a missing run directory', envelope({ runDir: undefined }), /runDir/],
    ['no paths', envelope({ paths: null }), /paths is missing/],
    [
      'a relative app binary',
      envelope({ paths: { resourcesDir: null, appPath: null, isPackaged: false, appExecPath: 'electron' } }),
      /appExecPath/,
    ],
    [
      'an installed build without its resources',
      envelope({ paths: { resourcesDir: null, appPath: null, isPackaged: true, appExecPath: '/usr/bin/studio' } }),
      /resources directory/,
    ],
    ['no version', envelope({ app: { version: '', buildStamp: 'x', channel: 'latest' } }), /app.version/],
    ['an unknown channel', envelope({ app: { version: '1', buildStamp: 'x', channel: 'beta' } }), /channel/],
    ['an unknown tailnet mode', envelope({ listeners: { gateway: true, tailnet: 'on' } }), /tailnet/],
    ['an unknown secrets kind', envelope({ secrets: { kind: 'keyring' } }), /secrets.kind/],
    [
      'a headless server sealing through a shell',
      envelope({ role: 'headless', secrets: { kind: 'shell', available: true } }),
      /desktop-local/,
    ],
    ['a flag that is not a boolean', envelope({ flags: { diagnostics: '1' } }), /flags/],
  ]
  for (const [name, value, reason] of cases) {
    const parsed = parseServerBootstrapEnvelope(value)
    assert.equal(parsed.ok, false, `${name} should be refused`)
    assert.match(parsed.ok ? '' : parsed.message, reason, name)
  }
})

test('a headless envelope keeps its key file', () => {
  const parsed = parseServerBootstrapEnvelope(envelope({ role: 'headless', secrets: { kind: 'key-file' } }))
  assert.equal(parsed.ok, true)
})

test('only exits that a second start could fix are retried', () => {
  assert.equal(serverExitRetryable({ code: SERVER_EXIT.ok }), false)
  assert.equal(serverExitRetryable({ code: SERVER_EXIT.usage }), false)
  assert.equal(serverExitRetryable({ code: SERVER_EXIT.dataDirUnusable }), false)
  assert.equal(serverExitRetryable({ code: SERVER_EXIT.dataDirBusy }), false)
  assert.equal(serverExitRetryable({ code: SERVER_EXIT.mismatch }), false)
  assert.equal(serverExitRetryable({ code: SERVER_EXIT.failed }), true)
  assert.equal(serverExitRetryable({ code: SERVER_EXIT.temporary }), true)
  assert.equal(serverExitRetryable({ code: null, signal: 'SIGKILL' }), true)
  // A code nobody documented is a crash of some kind.
  assert.equal(serverExitRetryable({ code: 1 }), true)
})
