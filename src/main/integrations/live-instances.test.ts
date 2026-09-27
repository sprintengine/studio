import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import {
  holdLauncher,
  launcherHeldByOthers,
  leaveLiveInstances,
  registerLiveInstance,
  releaseLauncher,
} from './live-instances'

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sprintengine-instances-'))
}

test('an instance leaving alone takes the list, and the folder, with it', async () => {
  const dir = await home()
  await registerLiveInstance(dir, 101)
  assert.deepEqual(await leaveLiveInstances(dir, 101, { alive: () => true }), { othersRunning: false })
  assert.equal(existsSync(join(dir, '.sprintengine', 'instances')), false)
})

test('another running instance is reported; one that crashed, or whose file went stale, is pruned', async () => {
  const dir = await home()
  for (const pid of [101, 202, 303, 404]) await registerLiveInstance(dir, pid)
  const instances = join(dir, '.sprintengine', 'instances')
  // 404's pid is alive, but its file has not been touched in an hour: the pid names something else now.
  const anHourAgo = new Date(Date.now() - 60 * 60_000)
  await utimes(join(instances, '404'), anHourAgo, anHourAgo)
  const running = new Set([202, 404])
  assert.deepEqual(await leaveLiveInstances(dir, 101, { alive: (pid) => running.has(pid) }), { othersRunning: true })
  assert.deepEqual(await readdir(instances), ['202'])
})

test("a profile's hold on the launcher is seen by the others until it is released", async () => {
  const dir = await home()
  await holdLauncher(dir, 'packaged')
  assert.equal(await launcherHeldByOthers(dir, 'dev'), true)
  assert.equal(await launcherHeldByOthers(dir, 'packaged'), false, 'its own hold does not count')
  await releaseLauncher(dir, 'packaged')
  assert.equal(await launcherHeldByOthers(dir, 'dev'), false)
  assert.equal(existsSync(join(dir, '.sprintengine')), false, 'and nothing of it is left')
})
