/**
 * The main-owned "Keep the computer awake while agents work" switch. Real
 * tmpdir, no Electron.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { test } from 'vitest'

import { createKeepAwakeStore } from './keep-awake-store'

async function withUserData(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sprintengine-keep-awake-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('no file reads as on', async () => {
  await withUserData(async (dir) => {
    assert.equal(createKeepAwakeStore({ resolveUserDataDir: () => dir }).isEnabled(), true)
  })
})

test('turning it off persists and survives a fresh process', async () => {
  await withUserData(async (dir) => {
    createKeepAwakeStore({ resolveUserDataDir: () => dir }).set(false)
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'keep-awake.json'), 'utf8')), {
      keepAwakeWhileAgentsWork: false,
    })
    assert.equal(createKeepAwakeStore({ resolveUserDataDir: () => dir }).isEnabled(), false)
  })
})
