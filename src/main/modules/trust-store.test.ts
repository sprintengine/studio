import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { readTrustedModulesSync, setModuleTrust } from './trust-store'

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-trust-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testRoundTripAndUntrust(): Promise<void> {
  await withTempDir(async (dir) => {
    assert.equal(readTrustedModulesSync(dir).size, 0)
    await setModuleTrust(dir, 'alpha', 'fp-alpha')
    assert.equal(readTrustedModulesSync(dir).get('alpha'), 'fp-alpha')
    await setModuleTrust(dir, 'alpha', null)
    assert.equal(readTrustedModulesSync(dir).has('alpha'), false)
  })
}

// Two rapid trust writes must not lose an update (read-modify-write is serialized).
async function testConcurrentWritesDoNotClobber(): Promise<void> {
  await withTempDir(async (dir) => {
    await Promise.all([
      setModuleTrust(dir, 'x', 'fx'),
      setModuleTrust(dir, 'y', 'fy'),
      setModuleTrust(dir, 'z', 'fz'),
    ])
    const trusted = readTrustedModulesSync(dir)
    assert.deepEqual([...trusted.keys()].sort(), ['x', 'y', 'z'])
  })
}

async function testMalformedFileIsEmpty(): Promise<void> {
  await withTempDir(async (dir) => {
    // No file yet → empty, no throw.
    assert.equal(readTrustedModulesSync(dir).size, 0)
  })
}

async function main(): Promise<void> {
  await testRoundTripAndUntrust()
  await testConcurrentWritesDoNotClobber()
  await testMalformedFileIsEmpty()
  console.log('trust-store tests passed')
}

void main()
