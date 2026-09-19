import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createTerminalSnapshotSidecarStore,
  TERMINAL_SNAPSHOT_SIDECAR_DIR_NAME,
  TERMINAL_SNAPSHOT_SIDECAR_TTL_MS,
  type TerminalSnapshotSidecar,
} from './terminal-snapshot-sidecar'
import { test } from 'vitest'

test('terminal-snapshot-sidecar', async () => {
  function makeStore(ttlMs?: number): {
    store: ReturnType<typeof createTerminalSnapshotSidecarStore>
    dir: string
  } {
    const userDataDir = mkdtempSync(join(tmpdir(), 'sprintengine-terminal-sidecar-'))
    return {
      store: createTerminalSnapshotSidecarStore({ resolveUserDataDir: () => userDataDir, ttlMs }),
      dir: join(userDataDir, TERMINAL_SNAPSHOT_SIDECAR_DIR_NAME),
    }
  }

  function sampleSidecar(overrides: Partial<TerminalSnapshotSidecar> = {}): TerminalSnapshotSidecar {
    return {
      version: 1,
      sessionId: 'session-abc',
      savedAt: 1_700_000_000_000,
      cols: 120,
      rows: 30,
      kind: 'agent',
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      cli: 'claude-code',
      cliSessionId: 'session-abc',
      // The turn end rides the sidecar so rehydration idles from the finish.
      lastTurnEndedAt: 1_699_999_000_000,
      // As do the prompts, so a parked chat on a runtime with no readable
      // transcript still knows what it was asked.
      prompts: [{ text: 'Port voice dictation to Studio', at: 1_699_998_000_000 }],
      snapshot: 'painted screen content',
      ...overrides,
    }
  }

  function assertWriteReadRoundTrip(): void {
    const { store } = makeStore()
    const sidecar = sampleSidecar()
    store.write(sidecar)
    assert.deepEqual(store.read('session-abc'), sidecar, 'write/read must round-trip verbatim')
  }

  function assertMissingReadsNull(): void {
    const { store } = makeStore()
    assert.equal(store.read('session-missing'), null, 'a missing sidecar reads as null, not an error')
  }

  function assertMalformedReadsNull(): void {
    const { store, dir } = makeStore()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session-bad.json'), 'not json at all')
    assert.equal(store.read('session-bad'), null, 'unparseable sidecar reads as null')

    // A parseable file whose sessionId does not match its file name is rejected:
    // the id is the durable key and a mismatch means a copied/tampered file.
    store.write(sampleSidecar({ sessionId: 'session-other' }))
    writeFileSync(join(dir, 'session-mismatch.json'), JSON.stringify(sampleSidecar({ sessionId: 'session-other' })))
    assert.equal(store.read('session-mismatch'), null, 'sessionId/file-name mismatch reads as null')

    writeFileSync(
      join(dir, 'session-empty.json'),
      JSON.stringify({ version: 1, sessionId: 'session-empty', savedAt: 1, cols: 80, rows: 24, kind: 'agent' }),
    )
    assert.equal(
      store.read('session-empty'),
      null,
      'a sidecar with neither snapshot nor rawReplay is useless and reads as null',
    )
  }

  function assertUnsafeSessionIdsAreInert(): void {
    const { store, dir } = makeStore()
    store.write(sampleSidecar({ sessionId: '../evil' }))
    store.write(sampleSidecar({ sessionId: 'a/b' }))
    store.write(sampleSidecar({ sessionId: '' }))
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      // dir never created — exactly what we want
    }
    assert.deepEqual(entries, [], 'path-unsafe session ids must never produce files')
    assert.equal(store.read('../evil'), null)
    store.remove('../evil')
  }

  function assertRemoveDeletes(): void {
    const { store } = makeStore()
    store.write(sampleSidecar())
    store.remove('session-abc')
    assert.equal(store.read('session-abc'), null, 'remove must delete the sidecar')
    store.remove('session-abc')
  }

  async function assertSweepExpiredRemovesOnlyOldSidecars(): Promise<void> {
    const { store, dir } = makeStore()
    store.write(sampleSidecar({ sessionId: 'session-fresh' }))
    store.write(sampleSidecar({ sessionId: 'session-stale' }))
    // Writes are queued off the main thread; the sweep reads the disk.
    await store.flush()
    const staleAge = new Date(Date.now() - TERMINAL_SNAPSHOT_SIDECAR_TTL_MS - 60_000)
    utimesSync(join(dir, 'session-stale.json'), staleAge, staleAge)

    const removed = store.sweepExpired()
    assert.deepEqual(removed, ['session-stale.json'], 'only the past-TTL sidecar sweeps')
    assert.equal(store.read('session-stale'), null)
    assert.ok(store.read('session-fresh'), 'fresh sidecars survive the sweep')
  }

  function assertSweepWithoutDirIsSilent(): void {
    const { store } = makeStore()
    assert.deepEqual(store.sweepExpired(), [], 'sweeping a never-created dir is a silent no-op')
  }

  async function assertRawReplayRoundTrip(): Promise<void> {
    const { store } = makeStore()
    const sidecar = sampleSidecar({
      sessionId: 'session-raw',
      snapshot: undefined,
      rawReplay: 'raw pty bytes [1mbold[0m',
    })
    store.write(sidecar)
    // Read the disk copy, not the queued object, since the point is what
    // serialization kept.
    await store.flush()
    // Compare with JSON round-trip semantics: undefined-valued keys are dropped
    // by serialization, which is exactly what the disk copy should contain.
    assert.deepEqual(
      store.read('session-raw'),
      JSON.parse(JSON.stringify(sidecar)),
      'quit-path raw-replay sidecars round-trip too',
    )
  }

  async function assertQueuedWritesLandInOrderAndRemoveWins(): Promise<void> {
    const { store } = makeStore()
    // Two writes for one session land in order: the later one is what is read,
    // before and after the flush.
    store.write(sampleSidecar({ sessionId: 'session-order', cols: 80 }))
    store.write(sampleSidecar({ sessionId: 'session-order', cols: 200 }))
    assert.equal(store.read('session-order')?.cols, 200, 'the queued newest write is readable at once')
    await store.flush()
    assert.equal(store.read('session-order')?.cols, 200, 'and it is what landed on disk')
    // A remove after a queued write wins: nothing resurrects the sidecar.
    store.write(sampleSidecar({ sessionId: 'session-gone' }))
    store.remove('session-gone')
    assert.equal(store.read('session-gone'), null, 'removed at once')
    await store.flush()
    assert.equal(store.read('session-gone'), null, 'and the queued write did not bring it back')
  }

  async function main(): Promise<void> {
    assertWriteReadRoundTrip()
    assertMissingReadsNull()
    assertMalformedReadsNull()
    assertUnsafeSessionIdsAreInert()
    assertRemoveDeletes()
    await assertSweepExpiredRemovesOnlyOldSidecars()
    assertSweepWithoutDirIsSilent()
    await assertRawReplayRoundTrip()
    await assertQueuedWritesLandInOrderAndRemoveWins()
    console.log('terminal-snapshot-sidecar tests passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
