import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'vitest'

import { createServerLog } from '../../main/server-supervisor/server-log'
import { ServerBootstrapError, readEnvelope, type ServerControlChannel } from './control-channel'
import { keepStderrIn, keepStderrInLogsDir } from './stdio'

test('what a stdio server says on stderr is kept in its log as well, and still said', () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'se-stdio-log-'))
  try {
    const stderr = new PassThrough()
    let said = ''
    stderr.on('data', (chunk: Buffer) => (said += chunk.toString('utf8')))
    keepStderrIn(createServerLog({ logsDir, now: () => new Date('2026-10-03T21:07:32.000Z') }), stderr)
    stderr.write('[studio-server] Refused a connection on the loopback door (port 34771): no proof.\n')
    stderr.write(Buffer.from('[studio-server] ready in 812 ms\n'))
    assert.match(said, /Refused a connection on the loopback door/u)
    assert.deepEqual(readdirSync(logsDir), ['server-2026-10-03.log'])
    assert.equal(
      readFileSync(join(logsDir, 'server-2026-10-03.log'), 'utf8'),
      '2026-10-03T21:07:32.000Z [studio-server] Refused a connection on the loopback door (port 34771): no proof.\n' +
        '2026-10-03T21:07:32.000Z [studio-server] ready in 812 ms\n',
    )
  } finally {
    rmSync(logsDir, { recursive: true, force: true })
  }
})

test("a server's log is owner-only, and a logs directory that cannot be made costs the log, not the server", () => {
  const root = mkdtempSync(join(tmpdir(), 'se-stdio-logdir-'))
  try {
    const logsDir = join(root, 'state', 'logs', 'data')
    const stderr = new PassThrough()
    keepStderrInLogsDir(logsDir, stderr)
    stderr.write('[studio-server] ready in 812 ms\n')
    const [file] = readdirSync(logsDir)
    assert.equal(statSync(logsDir).mode & 0o777, 0o700)
    assert.equal(statSync(join(logsDir, file)).mode & 0o777, 0o600)

    // A file where the directory should be: mkdir fails, and nothing throws.
    writeFileSync(join(root, 'blocked'), '')
    const blocked = new PassThrough()
    let said = ''
    blocked.on('data', (chunk: Buffer) => (said += chunk.toString('utf8')))
    assert.doesNotThrow(() => keepStderrInLogsDir(join(root, 'blocked', 'logs'), blocked))
    blocked.write('[studio-server] ready in 812 ms\n')
    assert.match(said, /keeps no log/u)
    assert.match(said, /ready in 812 ms/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a channel already closed before the envelope is a bootstrap error, said as one', async () => {
  const closed: ServerControlChannel = {
    carriesPorts: false,
    send: () => undefined,
    onMessage: () => () => undefined,
    onClose: (listener) => {
      listener()
      return () => undefined
    },
  }
  await assert.rejects(readEnvelope(closed, { unwrap: false }), ServerBootstrapError)
})
