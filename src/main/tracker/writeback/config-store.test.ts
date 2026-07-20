import assert from 'node:assert/strict'

import { DEFAULT_TRACKER_WRITEBACK_CONFIG } from '../../../shared/tracker/writeback'
import { TrackerWriteBackConfigStore } from './config-store'

// Verifies the per-connection write-back config store (MC-1640 / T10): default is
// opt-in off, set/get round-trips, remove drops a connection's config, the
// persisted JSON carries no secret, anyActive gates the engine, and a malformed
// file degrades to defaults instead of corrupting gating.

const CONFIG_PATH = '/ud/tracker-writeback-config.json'

async function main(): Promise<void> {
  await testDefaultIsOptInOff()
  await testSetGetRoundTripAndNoSecret()
  await testRemoveDropsConfig()
  await testAnyActiveGate()
  await testMalformedFileDegradesToDefault()

  console.log('tracker-writeback-config-store tests passed')
}

async function testDefaultIsOptInOff(): Promise<void> {
  const store = new TrackerWriteBackConfigStore({ resolveUserDataDir: () => '/ud', files: memoryFs().adapter })
  const config = await store.get('unknown-connection')
  assert.equal(config.enabled, false)
  assert.deepEqual(config, DEFAULT_TRACKER_WRITEBACK_CONFIG)
}

async function testSetGetRoundTripAndNoSecret(): Promise<void> {
  const fs = memoryFs()
  const store = new TrackerWriteBackConfigStore({ resolveUserDataDir: () => '/ud', files: fs.adapter })
  await store.set('conn-1', {
    enabled: true,
    comments: { started: true, pr: false, done: true },
    transitions: { onStart: 'trans-5', onComplete: null },
  })
  const read = await store.get('conn-1')
  assert.equal(read.enabled, true)
  assert.equal(read.comments.pr, false)
  assert.equal(read.transitions.onStart, 'trans-5')

  // The persisted file holds only booleans and transition ids — never a secret.
  const raw = fs.files.get(CONFIG_PATH) ?? ''
  assert.doesNotMatch(raw, /secret|token|password|Authorization/i)
}

async function testRemoveDropsConfig(): Promise<void> {
  const store = new TrackerWriteBackConfigStore({ resolveUserDataDir: () => '/ud', files: memoryFs().adapter })
  await store.set('conn-1', { ...DEFAULT_TRACKER_WRITEBACK_CONFIG, enabled: true })
  await store.remove('conn-1')
  const read = await store.get('conn-1')
  assert.equal(read.enabled, false, 'a removed connection reverts to the opt-in default')
}

async function testAnyActiveGate(): Promise<void> {
  const store = new TrackerWriteBackConfigStore({ resolveUserDataDir: () => '/ud', files: memoryFs().adapter })
  assert.equal(await store.anyActive(), false)

  // Enabled but every comment off and no transition ⇒ still inactive.
  await store.set('conn-1', { enabled: true, comments: { started: false, pr: false, done: false }, transitions: { onStart: null, onComplete: null } })
  assert.equal(await store.anyActive(), false)

  await store.set('conn-1', { ...DEFAULT_TRACKER_WRITEBACK_CONFIG, enabled: true })
  assert.equal(await store.anyActive(), true)
}

async function testMalformedFileDegradesToDefault(): Promise<void> {
  const fs = memoryFs()
  fs.files.set(CONFIG_PATH, '{ not valid json')
  const store = new TrackerWriteBackConfigStore({ resolveUserDataDir: () => '/ud', files: fs.adapter })
  const config = await store.get('conn-1')
  assert.deepEqual(config, DEFAULT_TRACKER_WRITEBACK_CONFIG)
}

function memoryFs(): { files: Map<string, string>; adapter: { mkdir: any; readFile: any; writeFile: any; rename: any } } {
  const files = new Map<string, string>()
  return {
    files,
    adapter: {
      mkdir: async () => undefined,
      readFile: async (path: string) => {
        if (!files.has(path)) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException
          err.code = 'ENOENT'
          throw err
        }
        return files.get(path) as string
      },
      writeFile: async (path: string, data: string) => {
        files.set(path, typeof data === 'string' ? data : String(data))
      },
      rename: async (from: string, to: string) => {
        const value = files.get(from)
        if (value === undefined) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException
          err.code = 'ENOENT'
          throw err
        }
        files.set(to, value)
        files.delete(from)
      },
    },
  }
}

void main()
