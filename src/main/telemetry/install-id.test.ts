/**
 * The install identifier: stable across reads, minted once, and never fatal.
 * Real tmpdir, no Electron — this is the exact read the sender makes before its
 * first batch.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readInstallId } from './install-id'
import { test } from 'vitest'

test('install-id', async () => {
  const FILE_NAME = 'telemetry-install-id.json'
  const VALID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

  async function withUserData(body: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'multicode-telemetry-id-'))
    try {
      await body(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async function main(): Promise<void> {
    // first read mints, persists, and reports itself as the first run
    await withUserData(async (dir) => {
      const first = readInstallId({ resolveUserDataDir: () => dir })
      assert.equal(first.created, true)
      assert.equal(first.persisted, true)
      assert.match(first.value, /^[0-9a-f-]{36}$/u)

      const onDisk = JSON.parse(await readFile(join(dir, FILE_NAME), 'utf8')) as { installId: string }
      assert.equal(onDisk.installId, first.value)

      // a second read is the SAME id and is no longer a first run — this is what
      // keeps one install from counting as a new one on every launch
      const second = readInstallId({ resolveUserDataDir: () => dir })
      assert.equal(second.value, first.value)
      assert.equal(second.created, false)
    })

    // a stored id is adopted verbatim
    await withUserData(async (dir) => {
      await writeFile(join(dir, FILE_NAME), JSON.stringify({ installId: VALID }), 'utf8')
      const read = readInstallId({ resolveUserDataDir: () => dir })
      assert.equal(read.value, VALID)
      assert.equal(read.created, false)
    })

    // anything that is not a v4 UUID is replaced rather than reported as identity
    for (const payload of [
      '{ not json',
      '[]',
      '{}',
      '{"installId":""}',
      '{"installId":42}',
      '{"installId":"not-a-uuid"}',
      // a v1 UUID: the right shape, the wrong kind — it encodes a MAC address and
      // a timestamp, which is exactly what this identity must not carry
      '{"installId":"3f2b1c4d-5e6f-1a7b-8c9d-0e1f2a3b4c5d"}',
    ]) {
      await withUserData(async (dir) => {
        await writeFile(join(dir, FILE_NAME), payload, 'utf8')
        const read = readInstallId({ resolveUserDataDir: () => dir, newId: () => VALID })
        assert.equal(read.value, VALID, `payload ${payload} must be replaced`)
        assert.equal(read.created, true)
      })
    }

    // an unwritable location still yields an id, marked as not persisted, so the
    // caller never has to handle "there is no identity"
    await withUserData(async (dir) => {
      const read = readInstallId({ resolveUserDataDir: () => join(dir, 'missing-parent', 'nested') })
      assert.equal(read.persisted, false)
      assert.equal(read.created, true)
      assert.match(read.value, /^[0-9a-f-]{36}$/u)
    })

    // a userData dir that cannot even be resolved is survivable too
    const unresolvable = readInstallId({
      resolveUserDataDir: () => {
        throw new Error('no userData in this host')
      },
    })
    assert.equal(unresolvable.persisted, false)
    assert.match(unresolvable.value, /^[0-9a-f-]{36}$/u)

    console.log('telemetry install-id tests passed')
  }

  const suiteRun = main()

  await suiteRun
})
