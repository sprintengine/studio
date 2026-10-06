import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'

import { test } from 'vitest'

import { runCommand } from './run-command'

// A cancelled draft stops its CLI at once, rather than leaving it to run to
// the deadline for an answer nobody will read.

const SLEEPER = { file: process.execPath, args: ['-e', 'setTimeout(() => {}, 20000)'], cwd: tmpdir() }

test('aborting the signal kills the process and says it was cancelled', async () => {
  const controller = new AbortController()
  const started = Date.now()
  const running = runCommand({
    ...SLEEPER,
    env: { ...process.env } as Record<string, string>,
    stdin: '',
    timeoutMs: 20_000,
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 100)
  const outcome = await running
  assert.equal(outcome.cancelled, true)
  assert.equal(outcome.timedOut, false)
  assert.ok(Date.now() - started < 10_000, 'stopped long before its deadline')
})

test('a signal already aborted stops the process as it starts', async () => {
  const controller = new AbortController()
  controller.abort()
  const outcome = await runCommand({
    ...SLEEPER,
    env: { ...process.env } as Record<string, string>,
    stdin: '',
    timeoutMs: 20_000,
    signal: controller.signal,
  })
  assert.equal(outcome.cancelled, true)
})
