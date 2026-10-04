import { mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import {
  CODEX_LOG_DATABASE_WARN_BYTES,
  codexLogDatabaseBytes,
  codexMachineLabel,
  codexStartTimeoutMessage,
  explainCodexInitializeTimeout,
  formatBytes,
  isCodexInitializeTimeout,
} from './codex-start-failure'

test('only the initialize timeout is explained', () => {
  expect(isCodexInitializeTimeout(new Error('Codex initialize timed out.'))).toBe(true)
  expect(isCodexInitializeTimeout(new Error('Codex thread/resume timed out.'))).toBe(false)
  expect(isCodexInitializeTimeout('Codex initialize timed out.')).toBe(false)
})

test('the log database is summed over logs_*.sqlite* only, and nothing is changed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
  try {
    writeFileSync(join(home, 'logs_1.sqlite'), '')
    truncateSync(join(home, 'logs_1.sqlite'), 3_000)
    writeFileSync(join(home, 'logs_1.sqlite-wal'), '')
    truncateSync(join(home, 'logs_1.sqlite-wal'), 500)
    writeFileSync(join(home, 'history.jsonl'), 'x'.repeat(10_000))
    writeFileSync(join(home, 'state_1.sqlite'), 'x'.repeat(10_000))
    mkdirSync(join(home, 'logs_dir.sqlite'))
    expect(await codexLogDatabaseBytes(home)).toBe(3_500)
    // Read, never moved: every file is where it was, at its size.
    expect(statSync(join(home, 'logs_1.sqlite')).size).toBe(3_000)
    expect(statSync(join(home, 'logs_1.sqlite-wal')).size).toBe(500)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a Codex home that cannot be listed says nothing about the database', async () => {
  expect(await codexLogDatabaseBytes(join(tmpdir(), 'no-such-codex-home-for-this-test'))).toBeNull()
})

test('the message names the wait and the machine, and the database only above the threshold', () => {
  expect(codexStartTimeoutMessage({ seconds: 30, machine: 'WSL: Ubuntu', logBytes: null })).toBe(
    "Codex didn't answer in 30 s. Run `codex` in a terminal on WSL: Ubuntu to see why.",
  )
  expect(
    codexStartTimeoutMessage({ seconds: 30, machine: 'This PC (Windows)', logBytes: CODEX_LOG_DATABASE_WARN_BYTES }),
  ).not.toContain('log database')
  expect(codexStartTimeoutMessage({ seconds: 30, machine: 'build-box', logBytes: 2.5 * 1024 ** 3 })).toBe(
    "Codex didn't answer in 30 s. Run `codex` in a terminal on build-box to see why. Codex's own log database is 2.5 GB, which can make it slow to start. Moving `~/.codex/logs_*.sqlite*` aside fixes it.",
  )
  expect(formatBytes(740 * 1024 ** 2)).toBe('740 MB')
  expect(formatBytes(2 * 1024 ** 3)).toBe('2 GB')
})

test('the machine is the distribution, this desktop, or the server’s own host', () => {
  expect(codexMachineLabel('Ubuntu', {}, 'win32', true)).toBe('WSL: Ubuntu')
  expect(codexMachineLabel(null, { WSL_DISTRO_NAME: 'Debian' }, 'linux', false)).toBe('WSL: Debian')
  expect(codexMachineLabel(null, {}, 'win32', true)).toBe('This PC (Windows)')
  expect(codexMachineLabel(null, {}, 'darwin', true)).toBe('This Mac')
  expect(codexMachineLabel(null, {}, 'linux', false).length).toBeGreaterThan(0)
})

test('the size is asked of the machine the chat ran on, and a failed read still explains the wait', async () => {
  const asked: Array<string | null> = []
  const error = await explainCodexInitializeTimeout({
    timeoutMs: 30_000,
    wslDistro: 'Ubuntu',
    env: {},
    readLogBytes: async (distro) => {
      asked.push(distro)
      throw new Error('the distribution did not answer')
    },
  })
  expect(asked).toEqual(['Ubuntu'])
  expect(error.message).toBe("Codex didn't answer in 30 s. Run `codex` in a terminal on WSL: Ubuntu to see why.")
})
