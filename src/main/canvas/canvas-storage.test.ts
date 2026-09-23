/**
 * Where boards live, and how one leaves.
 *
 * New boards go into the app's store in the app's data folder, keyed by
 * project, so drawing never writes anything into the project's working tree.
 * Boards an earlier build made
 * in the project's `diagrams/` folder are the person's files: they keep
 * listing, opening and saving where they are. A board reaches the repository
 * through an export into a folder the person picked.
 *
 * The filesystem is a Map, as in `canvas-service.test.ts`; nothing here needs
 * the worker, so it answers nothing.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createCanvasService, type CanvasDirEntry, type CanvasFileStat, type CanvasFs } from './canvas-service'
import type { CanvasWorkerHost } from './canvas-worker-host'
import { canvasBoardStoreDir } from './canvas-board-store'
import { parseSceneFile, serializeSceneFile, emptyScene } from '../../shared/canvas/scene-file'
import type { CanvasElement } from '../../shared/canvas/types'

const ROOT = '/Users/dev/project'
const WORKSPACE = 'workspace-1'
const USER_DATA = '/Users/dev/Library/Application Support/SprintEngine Studio'
const STORE = canvasBoardStoreDir(USER_DATA, ROOT)
const EXPORT_DIR = '/Users/dev/project/docs/diagrams'

type MemoryFs = CanvasFs & { files: Map<string, string | Uint8Array>; writes: string[] }

function missing(path: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException
  error.code = 'ENOENT'
  return error
}

function createMemoryFs(): MemoryFs {
  const files = new Map<string, string | Uint8Array>()
  const directories = new Set<string>([ROOT])
  const writes: string[] = []
  const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/'
  const addDirs = (path: string): void => {
    const parts = path.split('/')
    for (let i = 2; i <= parts.length; i += 1) directories.add(parts.slice(0, i).join('/'))
  }
  const put = async (path: string, contents: string | Uint8Array): Promise<void> => {
    if (!directories.has(parentOf(path))) throw missing(path)
    writes.push(path)
    files.set(path, contents)
  }
  return {
    files,
    writes,
    readFile: async (path) => {
      const contents = files.get(path)
      if (contents === undefined) throw missing(path)
      return typeof contents === 'string' ? contents : Buffer.from(contents).toString('utf-8')
    },
    writeFile: put,
    writeBytes: put,
    rename: async (from, to) => {
      const contents = files.get(from)
      if (contents === undefined) throw missing(from)
      files.delete(from)
      files.set(to, contents)
    },
    mkdir: async (path) => {
      addDirs(path)
    },
    stat: async (path): Promise<CanvasFileStat> => {
      const contents = files.get(path)
      if (contents !== undefined) return { size: contents.length, mtimeMs: 1_000, isDirectory: false, isFile: true }
      if (directories.has(path)) return { size: 0, mtimeMs: 1_000, isDirectory: true, isFile: false }
      throw missing(path)
    },
    readdir: async (path): Promise<CanvasDirEntry[]> => {
      if (!directories.has(path)) throw missing(path)
      const entries: CanvasDirEntry[] = []
      for (const directory of directories) {
        if (directory !== path && parentOf(directory) === path) {
          entries.push({ name: directory.slice(path.length + 1), isDirectory: true, isFile: false })
        }
      }
      for (const file of files.keys()) {
        if (parentOf(file) === path)
          entries.push({ name: file.slice(path.length + 1), isDirectory: false, isFile: true })
      }
      return entries
    },
    unlink: async (path) => {
      files.delete(path)
    },
  }
}

const idleWorker: CanvasWorkerHost = {
  call: (async () => ({
    ok: false,
    error: { code: 'worker_unavailable', message: 'these cases need no worker' },
  })) as unknown as CanvasWorkerHost['call'],
  report: () => null,
  dispose: async () => {},
}

function harness(options: { store?: boolean } = {}): {
  service: ReturnType<typeof createCanvasService>
  fs: MemoryFs
} {
  const fs = createMemoryFs()
  const service = createCanvasService({
    fs,
    platform: 'linux',
    now: () => 1_000,
    resolveWorkspaceRoot: (workspaceId) => (workspaceId === WORKSPACE ? ROOT : null),
    ...(options.store === false
      ? {}
      : { resolveBoardStore: (_id: string, root: string) => canvasBoardStoreDir(USER_DATA, root) }),
    broadcast: () => {},
    sendTo: () => {},
    worker: idleWorker,
    watch: () => ({ close: () => {} }),
    // Timers never fire: nothing here waits on an idle sweep or a debounce.
    setTimer: () => ({ cancel: () => {} }),
  })
  return { service, fs }
}

function element(id: string): CanvasElement {
  return { id, type: 'rectangle', version: 1, versionNonce: 1, x: 0, y: 0, width: 100, height: 40 }
}

async function seedLegacyBoard(fs: MemoryFs, name: string, elements: CanvasElement[]): Promise<string> {
  const file = `${ROOT}/diagrams/${name}.excalidraw`
  await fs.mkdir(`${ROOT}/diagrams`)
  await fs.writeFile(file, serializeSceneFile({ ...emptyScene(), elements }))
  fs.writes.length = 0
  return file
}

function projectFiles(fs: MemoryFs): string[] {
  return [...fs.files.keys()].filter((path) => path.startsWith(`${ROOT}/`))
}

test('the store is keyed by project, in the app data folder, outside the project', () => {
  assert.equal(STORE.startsWith(`${USER_DATA}/canvas/ws_`), true)
  assert.equal(STORE.startsWith(ROOT), false)
  assert.equal(canvasBoardStoreDir(USER_DATA, ROOT), STORE, 'the same project always finds the same store')
  assert.equal(canvasBoardStoreDir(USER_DATA, `${ROOT}/`), STORE, 'however its folder is spelled')
  assert.notEqual(canvasBoardStoreDir(USER_DATA, '/Users/dev/other'), STORE, 'and another project has its own')
})

test('a new board by bare name is written into the store, and nothing into the project', async () => {
  const { service, fs } = harness()
  const created = await service.readBoard({ workspaceId: WORKSPACE, path: 'architecture' }, { create: true })
  assert.equal(created.ok, true)
  assert.equal(created.ok && created.value.path, 'architecture.excalidraw')
  await service.commitScene(
    {
      workspaceId: WORKSPACE,
      path: 'architecture.excalidraw',
      baseRevision: 0,
      elements: [element('a')],
      appState: {},
      files: {},
    },
    1,
  )
  assert.ok(fs.files.has(`${STORE}/architecture.excalidraw`))
  assert.deepEqual(projectFiles(fs), [], 'no board, no temp and no ignore file in the working tree')
  assert.equal(
    [...fs.files.keys()].some((path) => path.endsWith('.gitignore')),
    false,
    'the store needs no ignore file: it is not in a repository',
  )
  await service.dispose()
})

test('a board in a named project folder is still that file', async () => {
  const { service, fs } = harness()
  await service.readBoard({ workspaceId: WORKSPACE, path: 'docs/flow' }, { create: true })
  assert.deepEqual(projectFiles(fs), [`${ROOT}/docs/flow.excalidraw`])
  await service.dispose()
})

test('without a store, a bare name is refused rather than written into the project', async () => {
  const { service, fs } = harness({ store: false })
  const refused = await service.readBoard({ workspaceId: WORKSPACE, path: 'architecture' }, { create: true })
  assert.equal(!refused.ok && refused.error.code, 'unknown_workspace')
  assert.deepEqual(projectFiles(fs), [])
  await service.dispose()
})

test('the listing finds boards in the store and in project folders, and nothing it could not open', async () => {
  const { service, fs } = harness()
  await seedLegacyBoard(fs, 'legacy', [element('a')])
  await service.readBoard({ workspaceId: WORKSPACE, path: 'fresh' }, { create: true })
  await fs.mkdir(`${ROOT}/.other`)
  await fs.writeFile(`${ROOT}/.other/hidden.excalidraw`, serializeSceneFile(emptyScene()))
  // A board at the project root would list under a folderless path, which
  // names a store board: its row would open a different board.
  await fs.writeFile(`${ROOT}/loose.excalidraw`, serializeSceneFile(emptyScene()))

  const listed = await service.listBoards(WORKSPACE)
  assert.equal(listed.ok, true)
  const paths = listed.ok ? listed.value.map((board) => board.path).sort() : []
  assert.deepEqual(paths, ['diagrams/legacy.excalidraw', 'fresh.excalidraw'])
  await service.dispose()
})

test('a legacy board opens and saves in place, and is never moved into the store', async () => {
  const { service, fs } = harness()
  const file = await seedLegacyBoard(fs, 'legacy', [element('a')])
  const ref = { workspaceId: WORKSPACE, path: 'diagrams/legacy.excalidraw' }

  const opened = await service.openBoard(ref, { subscriberId: 1 })
  assert.equal(opened.ok, true)
  assert.deepEqual(opened.ok && opened.value.elements.map((e) => e.id), ['a'])

  const committed = await service.commitScene(
    { ...ref, baseRevision: 0, elements: [element('a'), element('b')], appState: {}, files: {} },
    1,
  )
  assert.equal(committed.ok, true)
  const saved = parseSceneFile(String(fs.files.get(file)))
  assert.deepEqual(saved.ok && saved.value.elements.map((e) => e.id).sort(), ['a', 'b'])
  assert.equal(
    [...fs.files.keys()].some((path) => path.startsWith(STORE)),
    false,
    'the store is not touched by a legacy board',
  )
  await service.dispose()
})

test('a board exists where its file is, and nowhere else', async () => {
  const { service, fs } = harness()
  await seedLegacyBoard(fs, 'legacy', [])
  const exists = (path: string) => service.boardExists({ workspaceId: WORKSPACE, path })
  assert.deepEqual(await exists('diagrams/legacy.excalidraw'), { ok: true, value: true })
  assert.deepEqual(await exists('legacy'), { ok: true, value: false }, 'the bare name names the store')
  const refused = await exists('../outside')
  assert.equal(refused.ok, false)
  await service.dispose()
})

test('a board is located in the store or the project, for the reveal action alone', async () => {
  const { service } = harness()
  assert.deepEqual(service.boardLocation({ workspaceId: WORKSPACE, path: 'arch' }), {
    ok: true,
    value: `${STORE}/arch.excalidraw`,
  })
  assert.deepEqual(service.boardLocation({ workspaceId: WORKSPACE, path: 'diagrams/arch' }), {
    ok: true,
    value: `${ROOT}/diagrams/arch.excalidraw`,
  })
  await service.dispose()
})

test('an export writes the board file and the pictures into the chosen folder, and leaves the board', async () => {
  const { service, fs } = harness()
  const ref = { workspaceId: WORKSPACE, path: 'architecture' }
  await service.readBoard(ref, { create: true })
  await service.commitScene(
    {
      workspaceId: WORKSPACE,
      path: 'architecture.excalidraw',
      baseRevision: 0,
      elements: [element('api')],
      appState: {},
      files: {},
    },
    1,
  )

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
  const exported = await service.exportBoard(ref, EXPORT_DIR, { png, svg })
  assert.equal(exported.ok, true)
  assert.deepEqual(exported.ok && exported.value.files, [
    `${EXPORT_DIR}/architecture.excalidraw`,
    `${EXPORT_DIR}/architecture.png`,
    `${EXPORT_DIR}/architecture.svg`,
  ])

  const copy = parseSceneFile(String(fs.files.get(`${EXPORT_DIR}/architecture.excalidraw`)))
  assert.deepEqual(copy.ok && copy.value.elements.map((e) => e.id), ['api'], 'the copy is the board as it stands')
  assert.deepEqual([...(fs.files.get(`${EXPORT_DIR}/architecture.png`) as Uint8Array)], [0x89, 0x50, 0x4e, 0x47])
  assert.equal(fs.files.get(`${EXPORT_DIR}/architecture.svg`), svg)
  assert.ok(fs.files.has(`${STORE}/architecture.excalidraw`), 'an export is a copy, not a move')
  assert.equal(
    [...fs.files.keys()].some((path) => path.endsWith('.tmp')),
    false,
    'every file went through a temp and a rename',
  )
  await service.dispose()
})

test('exporting again replaces the earlier copy', async () => {
  const { service, fs } = harness()
  const ref = { workspaceId: WORKSPACE, path: 'flow' }
  await service.readBoard(ref, { create: true })
  await fs.mkdir(EXPORT_DIR)
  await fs.writeFile(`${EXPORT_DIR}/flow.excalidraw`, 'an older export')
  const exported = await service.exportBoard(ref, EXPORT_DIR)
  assert.equal(exported.ok, true)
  assert.equal(parseSceneFile(String(fs.files.get(`${EXPORT_DIR}/flow.excalidraw`))).ok, true)
  await service.dispose()
})

test('a legacy board exported into its own folder is not rewritten', async () => {
  const { service, fs } = harness()
  const file = await seedLegacyBoard(fs, 'legacy', [element('a')])
  const exported = await service.exportBoard(
    { workspaceId: WORKSPACE, path: 'diagrams/legacy.excalidraw' },
    `${ROOT}/diagrams`,
  )
  assert.equal(exported.ok, true)
  assert.deepEqual(exported.ok && exported.value.files, [file])
  assert.equal(fs.writes.includes(file), false)
  await service.dispose()
})

test('an export refuses a relative folder, a board that is not there, and an SVG that is not one', async () => {
  const { service } = harness()
  const ref = { workspaceId: WORKSPACE, path: 'flow' }
  const relative = await service.exportBoard(ref, 'docs')
  assert.equal(relative.ok, false)
  assert.equal(!relative.ok && relative.error.code, 'invalid_path')

  const absent = await service.exportBoard(ref, EXPORT_DIR)
  assert.equal(!absent.ok && absent.error.code, 'not_found', 'an export never creates the board it copies')

  await service.readBoard(ref, { create: true })
  const notSvg = await service.exportBoard(ref, EXPORT_DIR, { svg: '<script>alert(1)</script>' })
  assert.equal(!notSvg.ok && notSvg.error.code, 'invalid_scene')
  await service.dispose()
})
