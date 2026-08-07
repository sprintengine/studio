/**
 * MC-2156 — the main-owned background-mode setting. Real tmpdir, no Electron
 * and no window: this is the exact read the `window-all-closed` handler makes
 * after every renderer is gone.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createBackgroundModeStore } from './background-mode-store'

const FILE_NAME = 'background-mode.json'

async function withUserData(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'multicode-background-mode-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  // no file: off, which is byte-for-byte the pre-MC-2156 behavior
  await withUserData(async (dir) => {
    const store = createBackgroundModeStore({ resolveUserDataDir: () => dir })
    assert.equal(store.isEnabled(), false)
  })

  // a push persists and survives a fresh process (new store over the same dir)
  await withUserData(async (dir) => {
    createBackgroundModeStore({ resolveUserDataDir: () => dir }).set(true)
    const written: unknown = JSON.parse(await readFile(join(dir, FILE_NAME), 'utf8'))
    assert.deepEqual(written, { keepRunningInBackground: true })
    assert.equal(createBackgroundModeStore({ resolveUserDataDir: () => dir }).isEnabled(), true)
  })

  // turning it back off persists too — a stale `true` would keep a process alive
  await withUserData(async (dir) => {
    const store = createBackgroundModeStore({ resolveUserDataDir: () => dir })
    store.set(true)
    store.set(false)
    assert.equal(store.isEnabled(), false)
    assert.equal(createBackgroundModeStore({ resolveUserDataDir: () => dir }).isEnabled(), false)
  })

  // an unchanged push leaves no temp file behind and rewrites nothing
  await withUserData(async (dir) => {
    const store = createBackgroundModeStore({ resolveUserDataDir: () => dir })
    store.set(true)
    store.set(true)
    assert.deepEqual((await readdir(dir)).sort(), [FILE_NAME])
  })

  // the very first push of a session compares against DISK, not an unread cache
  await withUserData(async (dir) => {
    await writeFile(join(dir, FILE_NAME), JSON.stringify({ keepRunningInBackground: true }), 'utf8')
    const store = createBackgroundModeStore({ resolveUserDataDir: () => dir })
    store.set(false)
    assert.equal(store.isEnabled(), false)
    assert.equal(createBackgroundModeStore({ resolveUserDataDir: () => dir }).isEnabled(), false)
  })

  // corrupt / wrong-shaped / hostile payloads all read as off
  for (const payload of ['{ not json', '[]', '"true"', '{"keepRunningInBackground":"yes"}', '{}']) {
    await withUserData(async (dir) => {
      await writeFile(join(dir, FILE_NAME), payload, 'utf8')
      const store = createBackgroundModeStore({ resolveUserDataDir: () => dir })
      assert.equal(store.isEnabled(), false, `payload ${payload} must read as off`)
    })
  }

  // an unwritable location reports the failure and still applies in memory
  await withUserData(async (dir) => {
    const diagnostics: string[] = []
    const store = createBackgroundModeStore({
      resolveUserDataDir: () => join(dir, 'missing-parent', 'nested'),
      logDiagnostic: (input) => diagnostics.push(input.title),
    })
    store.set(true)
    assert.deepEqual(diagnostics, ['Background mode setting not persisted'])
    assert.equal(store.isEnabled(), true, 'the choice still applies for this session')
  })

  console.log('background-mode store tests passed')
}

void main()
