import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkspaceBackupService } from './workspace-backup'
import { test } from 'vitest'

test('workspace-backup', async () => {
  async function main(): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'multicode-workspace-backup-'))
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
