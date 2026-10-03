import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'vitest'

import { createServerLog } from '../../main/server-supervisor/server-log'
import { keepStderrIn } from './stdio'

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
