import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test, vi } from 'vitest'
import { createWorkspaceRegistryStore, WORKSPACE_REGISTRY_FILE_NAME } from './workspace-registry-store'
import {
  emptyWorkspaceRegistryFile,
  parseWorkspaceRegistryFile,
  serializeWorkspaceRegistryFile,
  toWorkspaceRegistryRecord,
  type WorkspaceRegistryFile,
} from '../shared/workspace-registry'
import type { Workspace } from '../renderer/src/types/workspace'

const fileWrites = vi.hoisted(() => ({ count: 0 }))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    writeFile: (...args: Parameters<typeof actual.writeFile>) => {
      fileWrites.count += 1
      return actual.writeFile(...args)
    },
  }
})

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'registry-store-'))
  dirs.push(dir)
  return dir
}

function registry(name: string, revision: number): WorkspaceRegistryFile {
  const workspace = {
    id: 'ws-1',
    name,
    mode: 'standard',
    folderPath: '/repo',
    templateId: 'solo',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    memory: { relativeRoot: null },
    editorState: { openFiles: [], activeFilePath: null },
    createdAt: 1_000,
  } as Workspace
  return {
    ...emptyWorkspaceRegistryFile(5_000),
    revision,
    workspaces: [toWorkspaceRegistryRecord(workspace, revision)],
    activeWorkspaceId: 'ws-1',
  }
}

function persistedName(dir: string): string | undefined {
  const parsed = parseWorkspaceRegistryFile(JSON.parse(readFileSync(join(dir, WORKSPACE_REGISTRY_FILE_NAME), 'utf8')))
  return parsed?.file.workspaces[0]?.name
}

test('a write whose content matches the last one is a no-op, whatever its revision', async () => {
  const dir = tempDir()
  const store = createWorkspaceRegistryStore({ resolveUserDataDir: () => dir, persistDebounceMs: 0 })
  store.write(registry('Alpha', 1))
  await store.flush()
  rmSync(join(dir, WORKSPACE_REGISTRY_FILE_NAME))

  store.write(registry('Alpha', 2))
  await store.flush()
  assert.equal(existsSync(join(dir, WORKSPACE_REGISTRY_FILE_NAME)), false, 'no second write for the same content')
})

test('the file loaded at boot counts as already written', async () => {
  const dir = tempDir()
  writeFileSync(join(dir, WORKSPACE_REGISTRY_FILE_NAME), serializeWorkspaceRegistryFile(registry('Alpha', 3)))
  const store = createWorkspaceRegistryStore({ resolveUserDataDir: () => dir, persistDebounceMs: 0 })
  assert.equal(store.read().status, 'loaded')
  rmSync(join(dir, WORKSPACE_REGISTRY_FILE_NAME))

  store.write(registry('Alpha', 4))
  await store.flush()
  assert.equal(existsSync(join(dir, WORKSPACE_REGISTRY_FILE_NAME)), false)

  store.write(registry('Beta', 5))
  await store.flush()
  assert.equal(persistedName(dir), 'Beta')
})

test('a change reverted inside the debounce replaces the pending write', async () => {
  const dir = tempDir()
  const store = createWorkspaceRegistryStore({ resolveUserDataDir: () => dir, persistDebounceMs: 60_000 })
  store.write(registry('Alpha', 1))
  await store.flush()

  store.write(registry('Beta', 2))
  store.write(registry('Alpha', 3))
  await store.flush()
  assert.equal(persistedName(dir), 'Alpha', 'the disk ends on what memory holds, not on the reverted change')
})

test('a failed write does not make the same content look persisted', async () => {
  let dir = '/dev/null/not-a-directory'
  const diagnostics: string[] = []
  const store = createWorkspaceRegistryStore({
    resolveUserDataDir: () => dir,
    logDiagnostic: (diagnostic) => diagnostics.push(diagnostic.title),
    persistDebounceMs: 0,
  })
  store.write(registry('Alpha', 1))
  await store.flush()
  assert.deepEqual(diagnostics, ['Workspace registry not persisted'])

  dir = tempDir()
  store.write(registry('Alpha', 2))
  await store.flush()
  assert.equal(persistedName(dir), 'Alpha', 'the retry of identical content still writes')
})

test('visit stamps every ten seconds are written once per lazy interval, and quit writes the last', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const dir = tempDir()
    const store = createWorkspaceRegistryStore({
      resolveUserDataDir: () => dir,
      persistDebounceMs: 250,
      lazyPersistMs: 60_000,
    })
    fileWrites.count = 0
    for (let stamp = 1; stamp <= 18; stamp++) {
      store.write(registry(`Visited ${stamp}`, stamp), { lazy: true })
      await vi.advanceTimersByTimeAsync(10_000)
    }
    store.write(registry('Visited at quit', 19), { lazy: true })
    await store.flush()
    assert.equal(persistedName(dir), 'Visited at quit', 'quit writes the stamp still waiting')
    // One per minute of stamping, and the one at quit.
    assert.ok(fileWrites.count <= 4, `${fileWrites.count} writes for 19 stamps over three minutes`)
  } finally {
    vi.useRealTimers()
  }
})

test('an ordinary write takes a waiting lazy one with it on its own short debounce', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const dir = tempDir()
    const store = createWorkspaceRegistryStore({
      resolveUserDataDir: () => dir,
      persistDebounceMs: 250,
      lazyPersistMs: 60_000,
    })
    store.write(registry('Visited', 1), { lazy: true })
    await vi.advanceTimersByTimeAsync(1_000)
    assert.equal(existsSync(join(dir, WORKSPACE_REGISTRY_FILE_NAME)), false, 'a lazy write waits')

    store.write(registry('Renamed', 2))
    // A stamp landing inside the short debounce does not push it back.
    store.write(registry('Renamed and visited', 3), { lazy: true })
    await vi.advanceTimersByTimeAsync(250)
    await store.flush()
    assert.equal(persistedName(dir), 'Renamed and visited')
  } finally {
    vi.useRealTimers()
  }
})
