import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkspaceBackupService, type WorkspaceBackupRegistry } from './workspace-backup'
import { test } from 'vitest'

test('workspace-backup', async () => {
  async function main(): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'sprintengine-workspace-backup-'))
    try {
      const service = createWorkspaceBackupService({ resolveUserDataDir: () => dir })

      // 1. Missing file reads as { ok: false, reason: 'missing' }.
      const missing = await service.read()
      assert.equal(missing.ok, false)
      if (missing.ok === false) assert.equal(missing.reason, 'missing')

      // 2. Successful write + read roundtrip.
      const payload = {
        version: 44,
        writtenAt: '2026-05-19T12:00:00.000Z',
        data: { state: { workspaces: [{ id: 'ws-1' }] }, version: 44 },
      }
      const writeResult = await service.write(payload)
      assert.equal(writeResult.ok, true)

      const read = await service.read()
      assert.equal(read.ok, true)
      if (read.ok) {
        assert.equal(read.payload.version, 44)
        assert.equal(read.payload.writtenAt, '2026-05-19T12:00:00.000Z')
        assert.deepEqual(read.payload.data, payload.data)
      }

      // 3. Tmp file is removed after rename.
      const tmpPath = join(dir, 'workspace-backup.json.tmp')
      let tmpStillThere = true
      try {
        await readFile(tmpPath)
      } catch {
        tmpStillThere = false
      }
      assert.equal(tmpStillThere, false, 'tmp file should be renamed away on successful write')

      // 4. Corrupt file is reported as parse_error rather than crashing.
      const backupPath = join(dir, 'workspace-backup.json')
      await writeFile(backupPath, 'not-json {{{', 'utf8')
      const corrupt = await service.read()
      assert.equal(corrupt.ok, false)
      if (corrupt.ok === false) assert.equal(corrupt.reason, 'parse_error')

      // 5. Schema-malformed JSON is also reported as parse_error.
      await writeFile(backupPath, JSON.stringify({ version: 'not-a-number' }), 'utf8')
      const malformed = await service.read()
      assert.equal(malformed.ok, false)
      if (malformed.ok === false) assert.equal(malformed.reason, 'parse_error')

      // 6. Concurrent writes serialize through the in-flight promise, last-write wins.
      const writes = [
        service.write({ version: 44, writtenAt: 't1', data: 'one' }),
        service.write({ version: 44, writtenAt: 't2', data: 'two' }),
        service.write({ version: 44, writtenAt: 't3', data: 'three' }),
      ]
      const results = await Promise.all(writes)
      for (const r of results) assert.equal(r.ok, true)
      const final = await service.read()
      assert.equal(final.ok, true)
      if (final.ok) assert.equal(final.payload.writtenAt, 't3')

      console.log('workspace-backup.test.ts: ok')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})

// A window sends only the settings envelope it owns; main fills the registry
// half in from its own registry, so the window never serializes it.
test('a settings-only write takes its registry from main', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sprintengine-workspace-backup-'))
  try {
    let registry: WorkspaceBackupRegistry = {
      workspaces: [{ id: 'ws-main', name: 'From main', folderPath: '/Users/dev/app', agents: {} } as never],
      activeWorkspaceId: 'ws-main',
      workspaceWindows: [],
      primaryWorkspaceWindowId: 'primary',
    }
    const service = createWorkspaceBackupService({ resolveUserDataDir: () => dir, readRegistry: () => registry })
    const settings = JSON.stringify({ state: { sidebarCollapsed: true }, version: 80 })

    assert.equal((await service.write({ version: 80, writtenAt: 't1', data: { settings } })).ok, true)
    const read = await service.read()
    assert.ok(read.ok)
    const data = read.payload.data as { registry: string; settings: string }
    assert.equal(data.settings, settings, 'the settings envelope is written as the window sent it')
    const envelope = JSON.parse(data.registry) as {
      state: { workspaces: { id: string }[]; activeWorkspaceId: string; workspaceRegistryEmptyState: null }
      version: number
    }
    assert.deepEqual(
      envelope.state.workspaces.map((workspace) => workspace.id),
      ['ws-main'],
      'the registry half is main’s',
    )
    assert.equal(envelope.state.activeWorkspaceId, 'ws-main')
    assert.equal(envelope.state.workspaceRegistryEmptyState, null)
    assert.equal(envelope.version, 80, 'stamped with the version the window sent')

    // An empty registry never replaces the last good copy.
    registry = { ...registry, workspaces: [], activeWorkspaceId: null }
    assert.equal((await service.write({ version: 80, writtenAt: 't2', data: { settings } })).ok, true)
    const kept = await service.read()
    assert.ok(kept.ok)
    assert.equal(kept.payload.writtenAt, 't1', 'the non-empty backup is kept')

    // An older build's full pair is written as it arrived.
    const pair = { registry: '{"state":{"workspaces":[{"id":"ws-old"}]},"version":79}', settings }
    await service.write({ version: 79, writtenAt: 't3', data: pair })
    const legacy = await service.read()
    assert.ok(legacy.ok)
    assert.deepEqual(legacy.payload.data, pair)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// Each registry backup serializes the whole registry, so main writes at most
// one per interval: a request inside it is held, the newest wins, and it lands
// when the interval ends.
test('registry backups inside the interval are held, and the newest is written when it ends', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sprintengine-workspace-backup-'))
  try {
    let reads = 0
    let clock = 1_000
    const registry: WorkspaceBackupRegistry = {
      workspaces: [{ id: 'ws-main', name: 'From main', folderPath: '/Users/dev/app', agents: {} } as never],
      activeWorkspaceId: 'ws-main',
      workspaceWindows: [],
      primaryWorkspaceWindowId: 'primary',
    }
    const service = createWorkspaceBackupService({
      resolveUserDataDir: () => dir,
      readRegistry: () => {
        reads += 1
        return registry
      },
      minRegistryIntervalMs: 40,
      // A clock the test moves, so however long the first write's disk takes,
      // the next two land inside the interval.
      now: () => clock,
    })
    const settings = JSON.stringify({ state: {}, version: 80 })

    assert.deepEqual(await service.write({ version: 80, writtenAt: 't1', data: { settings } }), { ok: true })
    const second = await service.write({ version: 80, writtenAt: 't2', data: { settings } })
    const third = await service.write({ version: 80, writtenAt: 't3', data: { settings } })
    assert.equal(second.message, 'deferred')
    assert.equal(third.message, 'deferred')
    assert.equal(reads, 1, 'the registry is serialized once inside the interval')
    const first = await service.read()
    assert.ok(first.ok)
    assert.equal(first.payload.writtenAt, 't1')

    // The held write lands once the interval has passed and its timer fires.
    clock += 40
    let latest = await service.read()
    for (let tries = 0; tries < 100 && !(latest.ok && latest.payload.writtenAt === 't3'); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      latest = await service.read()
    }
    assert.ok(latest.ok)
    assert.equal(latest.payload.writtenAt, 't3', 'the newest held request is the one written')
    assert.equal(reads, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
