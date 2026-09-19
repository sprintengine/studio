import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeModuleOverrides } from '../../shared/modules/manifest'
import {
  moduleEnablementPath,
  parseModuleOverrides,
  readModuleOverridesSync,
  writeModuleOverrides,
} from './enablement-store'
import { test } from 'vitest'

test('enablement-store', async () => {
  async function main(): Promise<void> {
    testNormalizeDropsNonBooleans()
    testParseInvalidJson()
    await testMissingFileReturnsEmpty()
    await testRoundTrip()
    await testWriteNormalizes()

    console.log('enablement-store tests passed')
  }

  function testNormalizeDropsNonBooleans(): void {
    const result = normalizeModuleOverrides({ a: true, b: false, c: 'yes', d: 1, '': true })
    assert.deepEqual(result, { a: true, b: false })
  }

  function testParseInvalidJson(): void {
    assert.deepEqual(parseModuleOverrides('not json'), {})
    assert.deepEqual(parseModuleOverrides('[1,2,3]'), {})
    assert.deepEqual(parseModuleOverrides('{"x":true}'), { x: true })
  }

  async function testMissingFileReturnsEmpty(): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'sprintengine-enablement-'))
    assert.deepEqual(readModuleOverridesSync(dir), {})
  }

  async function testRoundTrip(): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'sprintengine-enablement-'))
    const write = await writeModuleOverrides(dir, { 'memory-graph': false, git: true })
    assert.equal(write.ok, true)
    assert.deepEqual(readModuleOverridesSync(dir), { 'memory-graph': false, git: true })

    const onDisk = JSON.parse(await readFile(moduleEnablementPath(dir), 'utf8'))
    assert.deepEqual(onDisk, { 'memory-graph': false, git: true })
  }

  async function testWriteNormalizes(): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'sprintengine-enablement-'))
    // Cast through unknown: callers shouldn't pass junk, but a malformed IPC
    // payload must not poison the file.
    await writeModuleOverrides(dir, { ok: true, junk: 'x' } as unknown as Record<string, boolean>)
    assert.deepEqual(readModuleOverridesSync(dir), { ok: true })

    // Corrupt file on disk degrades to empty, not a throw.
    await writeFile(moduleEnablementPath(dir), '{ broken', 'utf8')
    assert.deepEqual(readModuleOverridesSync(dir), {})
  }

  const suiteRun = main()

  await suiteRun
})
