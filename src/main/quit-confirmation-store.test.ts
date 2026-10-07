/**
 * The main-owned "Ask before quitting" switch. Real tmpdir, no Electron: this
 * is the read a quit makes, and the write "Don't ask again" makes.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { test } from 'vitest'

import { createQuitConfirmationStore } from './quit-confirmation-store'

const FILE_NAME = 'quit-confirmation.json'

async function withUserData(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sprintengine-quit-confirmation-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('no file reads as on: the question is the default', async () => {
  await withUserData(async (dir) => {
    assert.equal(createQuitConfirmationStore({ resolveUserDataDir: () => dir }).isEnabled(), true)
  })
})

test('turning it off persists and survives a fresh process', async () => {
  await withUserData(async (dir) => {
    createQuitConfirmationStore({ resolveUserDataDir: () => dir }).set(false)
    assert.deepEqual(JSON.parse(await readFile(join(dir, FILE_NAME), 'utf8')), { askBeforeQuit: false })
    const reread = createQuitConfirmationStore({ resolveUserDataDir: () => dir })
    assert.equal(reread.isEnabled(), false)
    reread.set(true)
    assert.equal(createQuitConfirmationStore({ resolveUserDataDir: () => dir }).isEnabled(), true)
  })
})

test('a malformed file reads as on', async () => {
  await withUserData(async (dir) => {
    await writeFile(join(dir, FILE_NAME), 'not json', 'utf8')
    assert.equal(createQuitConfirmationStore({ resolveUserDataDir: () => dir }).isEnabled(), true)
  })
  await withUserData(async (dir) => {
    await writeFile(join(dir, FILE_NAME), '[false]', 'utf8')
    assert.equal(createQuitConfirmationStore({ resolveUserDataDir: () => dir }).isEnabled(), true)
  })
})

test('a write that fails still applies for the session, and says so', async () => {
  await withUserData(async (dir) => {
    const warnings: string[] = []
    const store = createQuitConfirmationStore({
      resolveUserDataDir: () => join(dir, 'missing', 'nested'),
      logDiagnostic: (input) => void warnings.push(input.title),
    })
    store.set(false)
    assert.equal(store.isEnabled(), false)
    assert.deepEqual(warnings, ['Quit confirmation setting not persisted'])
  })
})
