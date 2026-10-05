import assert from 'node:assert/strict'

import { test } from 'vitest'

import { createLocalServerRunner } from './local-server-runner'

// A run is the shell and everything it started: it has ended when the whole
// process group has, and a stop reaches what the shell left behind.

const posix = process.platform !== 'win32'

/** A plain sh and this process's environment, so no login shell is asked. */
const runner = () =>
  createLocalServerRunner({ shell: () => '/bin/sh', env: async () => ({ ...process.env }) as Record<string, string> })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test.skipIf(!posix)('a run whose shell exits lives on while what it started does', async () => {
  const run = runner()({ command: 'sleep 1.5 & echo started', cwd: process.cwd() })
  await sleep(700)
  assert.equal(run.alive(), true, 'the backgrounded child still runs')
  assert.match(run.output(), /started/)
  const exit = await run.exited
  assert.equal(exit.code, 0)
  assert.equal(run.alive(), false)
})

test.skipIf(!posix)('a stop reaches a child the shell left behind', async () => {
  const run = runner()({ command: 'sleep 30 & echo started', cwd: process.cwd() })
  await sleep(500)
  assert.equal(run.alive(), true)
  run.terminate()
  const ended = await Promise.race([run.exited.then(() => true), sleep(5_000).then(() => false)])
  assert.equal(ended, true, 'the group ended')
  assert.equal(run.alive(), false)
})

test.skipIf(!posix)('a kill ends a child that ignores SIGTERM', async () => {
  const run = runner()({ command: "(trap '' TERM; exec sleep 30) & wait", cwd: process.cwd() })
  await sleep(500)
  run.terminate()
  await sleep(700)
  assert.equal(run.alive(), true, 'it ignored the request')
  run.kill()
  const ended = await Promise.race([run.exited.then(() => true), sleep(5_000).then(() => false)])
  assert.equal(ended, true)
})
