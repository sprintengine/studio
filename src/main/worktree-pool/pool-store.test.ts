import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { acquireInstanceLock, POOL_LOCK_FILE } from './pool-store'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function container(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pool-lock-'))
  directories.push(dir)
  return dir
}

/** A lock left by a Studio on this machine whose process is gone. */
async function deadHolder(dir: string): Promise<void> {
  await writeFile(
    join(dir, POOL_LOCK_FILE),
    JSON.stringify({ pid: 999_999_999, host: 'mac-mini', instanceId: 'dead', startedAt: 0 }),
  )
}

const deps = { host: 'mac-mini', pidAlive: (pid: number) => pid === process.pid }

test('two Studios taking over one dead holder’s lock at once: exactly one gets it', async () => {
  for (let round = 0; round < 40; round += 1) {
    const dir = await container()
    await deadHolder(dir)
    const [first, second, third] = await Promise.all([
      acquireInstanceLock(dir, 'studio-a', deps),
      acquireInstanceLock(dir, 'studio-b', deps),
      acquireInstanceLock(dir, 'studio-c', deps),
    ])
    const winners = [first, second, third].filter((result) => result.ok)
    assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify([first, second, third])}`)
    const holder = JSON.parse(await readFile(join(dir, POOL_LOCK_FILE), 'utf8')) as { instanceId: string }
    const winner = ['studio-a', 'studio-b', 'studio-c'][[first, second, third].findIndex((result) => result.ok)]
    assert.equal(holder.instanceId, winner, 'the lock names the one that got it')
  }
})

test('a lock taken over is never left missing, so no third Studio can slip in with a fresh one', async () => {
  const dir = await container()
  await deadHolder(dir)
  const taking = acquireInstanceLock(dir, 'studio-a', deps)
  // Whatever moment the takeover is at, a lock file is there to read.
  for (let check = 0; check < 20; check += 1) {
    const text = await readFile(join(dir, POOL_LOCK_FILE), 'utf8').catch(() => null)
    assert.notEqual(text, null)
    await new Promise((resolveTick) => setImmediate(resolveTick))
  }
  assert.equal((await taking).ok, true)
})

test('a lock held by a live Studio is not taken over', async () => {
  const dir = await container()
  assert.equal((await acquireInstanceLock(dir, 'studio-a', deps)).ok, true)
  const refused = await acquireInstanceLock(dir, 'studio-b', deps)
  assert.equal(refused.ok, false)
  assert.equal((await acquireInstanceLock(dir, 'studio-a', deps)).ok, true, 'the holder confirms its own')
})
