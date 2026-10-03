import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'vitest'

import { connect, type StudioClient } from '../../../packages/agent-sdk/src/client'
import type { CanvasElement } from '../../shared/canvas/types'
import { emptyScene, parseSceneFile, serializeSceneFile } from '../../shared/canvas/scene-file'
import { createStudioFiles } from '../../server/rpc/studio-files'
import { createTicketAuthenticator, mintStudioTicket } from '../../server/rpc/studio-frame-port'
import { inProcessStudioTransport } from '../../server/rpc/studio-in-process-port'
import { createStudioRpcServer, type StudioRpcServer } from '../../server/rpc/studio-rpc-server'
import { createFakeAuthenticator, createFakeBackend } from '../../server/rpc/studio-rpc.test-helper'
import { createCanvasService, type CanvasFs, type CanvasServiceDeps } from './canvas-service'
import type { CanvasWorkerHost } from './canvas-worker-host'
import { createNodeCanvasFs, watchCanvasDirectory } from './canvas-node-fs'
import { createProtocolCanvasFs } from './protocol-canvas-fs'

// The canvas service on each filesystem it runs on (the client-tools spec's
// parity tests 4 and 5): a map in memory, this machine's disk, and a Studio's
// files over the protocol, where the service is a client of a server that
// holds the boards. The same cases pass on all three. Then two services over
// the protocol on one board, as two desktops attached to one server: the
// person wins over an agent, edits to different elements both survive, and
// each hears the other.
//
// The service's own suite (canvas-service.test.ts) stays on the map in memory:
// it asserts the order of that filesystem's operations, which is what a map
// can show and a disk cannot.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const WORKSPACE = 'ws-1'
const BOARD = { workspaceId: WORKSPACE, path: 'arch.excalidraw' }

function element(id: string, over: Partial<CanvasElement> = {}): CanvasElement {
  return { id, type: 'rectangle', version: 1, versionNonce: 1_000, x: 0, y: 0, width: 100, height: 50, ...over }
}

function sceneText(elements: CanvasElement[]): string {
  return serializeSceneFile({ ...emptyScene(), elements, appState: {}, files: {} })
}

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

type Worker = { host: CanvasWorkerHost; answer(next: (request: Record<string, unknown>) => unknown): void }

function fakeWorker(): Worker {
  let handler: (request: Record<string, unknown>) => unknown = () => ({
    ok: false,
    error: { code: 'worker_unavailable', message: 'no answer set' },
  })
  return {
    answer: (next) => {
      handler = next
    },
    host: {
      call: (async (request: Record<string, unknown>) => handler(request)) as unknown as CanvasWorkerHost['call'],
      report: () => null,
      dispose: async () => {},
    },
  }
}

/** A worker answer that adds one element to what it was given. */
function adds(added: CanvasElement) {
  return (request: Record<string, unknown>) => ({
    ok: true,
    value: {
      kind: 'apply-edit',
      requestId: 'r',
      ok: true,
      elements: [...(request.elements as CanvasElement[]), added],
      files: {},
      result: { created: [added.id], updated: [], deleted: [], tempIds: {}, warnings: [] },
    },
  })
}

type Disk = { dir: string; workspace: string; store: string }

function disk(): Disk {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-fs-'))
  const workspace = join(dir, 'project')
  const store = join(dir, 'data', 'canvas', 'ws_1')
  mkdirSync(workspace, { recursive: true })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, workspace, store }
}

type Rig = {
  service: ReturnType<typeof createCanvasService>
  worker: Worker
  pushes: Array<{ channel: string; payload: { elements?: CanvasElement[] } }>
  /** The board's elements as the backing store holds them. */
  onDisk(): CanvasElement[]
  /** Another program writes the board. */
  writeOutside(elements: CanvasElement[]): void
}

function service(
  fs: CanvasFs,
  extra: Partial<CanvasServiceDeps> & Pick<CanvasServiceDeps, 'resolveWorkspaceRoot' | 'watch'>,
): { service: ReturnType<typeof createCanvasService>; worker: Worker; pushes: Rig['pushes'] } {
  const worker = fakeWorker()
  const pushes: Rig['pushes'] = []
  const created = createCanvasService({
    fs,
    now: () => Date.now(),
    platform: 'linux',
    broadcast: () => undefined,
    sendTo: (_to, channel, payload) => pushes.push({ channel, payload: payload as { elements?: CanvasElement[] } }),
    worker: worker.host,
    ...extra,
  })
  cleanups.push(() => created.dispose())
  return { service: created, worker, pushes }
}

function readScene(path: string): CanvasElement[] {
  const parsed = parseSceneFile(readFileSync(path, 'utf8'))
  return parsed.ok ? parsed.value.elements : []
}

/** This machine's files, as the desktop runs the service today. */
function nodeRig(): Rig {
  const where = disk()
  const built = service(createNodeCanvasFs(), {
    resolveWorkspaceRoot: (workspaceId) => (workspaceId === WORKSPACE ? where.workspace : null),
    resolveBoardStore: () => where.store,
    watch: watchCanvasDirectory,
  })
  const file = join(where.store, BOARD.path)
  return {
    ...built,
    onDisk: () => readScene(file),
    writeOutside: (elements) => writeFileSync(file, sceneText(elements)),
  }
}

/** A map in memory, with a watch the outside writer fires. */
function memoryRig(): Rig {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const watchers = new Set<{ directory: string; onChange: (name: string | null) => void }>()
  let tick = 1
  const missing = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  const fs: CanvasFs = {
    readFile: async (path) => {
      const found = files.get(path)
      if (!found) throw missing(path)
      return found.text
    },
    writeFile: async (path, text) => void files.set(path, { text, mtimeMs: tick++ }),
    rename: async (from, to) => {
      const found = files.get(from)
      if (!found) throw missing(from)
      files.delete(from)
      files.set(to, { ...found, mtimeMs: tick++ })
    },
    mkdir: async () => {},
    stat: async (path) => {
      const found = files.get(path)
      if (found) return { size: found.text.length, mtimeMs: found.mtimeMs, isDirectory: false, isFile: true }
      if ([...files.keys()].some((key) => key.startsWith(`${path}/`)))
        return { size: 0, mtimeMs: 0, isDirectory: true, isFile: false }
      throw missing(path)
    },
    readdir: async (path) =>
      [...files.keys()]
        .filter((key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'))
        .map((key) => ({ name: key.slice(path.length + 1), isDirectory: false, isFile: true })),
    unlink: async (path) => void files.delete(path),
  }
  const built = service(fs, {
    resolveWorkspaceRoot: (workspaceId) => (workspaceId === WORKSPACE ? '/Users/dev/project' : null),
    resolveBoardStore: () => '/Users/dev/data/canvas/ws_1',
    watch: (directory, onChange) => {
      const watcher = { directory, onChange }
      watchers.add(watcher)
      return { close: () => watchers.delete(watcher) }
    },
  })
  const file = `/Users/dev/data/canvas/ws_1/${BOARD.path}`
  return {
    ...built,
    onDisk: () => {
      const parsed = parseSceneFile(files.get(file)?.text ?? '')
      return parsed.ok ? parsed.value.elements : []
    },
    writeOutside: (elements) => {
      files.set(file, { text: sceneText(elements), mtimeMs: tick++ })
      for (const watcher of watchers) if (file.startsWith(`${watcher.directory}/`)) watcher.onChange(BOARD.path)
    },
  }
}

type Served = { server: StudioRpcServer; where: Disk }

/** A Studio holding the boards on its disk, served by root and relative path. */
async function studioServing(): Promise<Served> {
  const where = disk()
  const files = createStudioFiles({
    resolveRoot: (root) =>
      root.workspaceId !== WORKSPACE ? null : root.kind === 'workspace' ? where.workspace : where.store,
  })
  const server = createStudioRpcServer({
    dataDir: join(where.dir, 'run'),
    version: '0.0.0-test',
    environmentId: 'env-test',
    backend: createFakeBackend(),
    authenticator: createFakeAuthenticator(),
    files,
  })
  cleanups.push(() => server.stop(10))
  return { server, where }
}

/** A desktop attached to that Studio: an owner client over its own port. */
async function attach(served: Served): Promise<StudioClient> {
  const client = await connect({
    transport: async () => {
      const ticket = mintStudioTicket()
      return inProcessStudioTransport(
        (stream) =>
          served.server.attach(stream, {
            authenticator: createTicketAuthenticator(ticket),
            ownWindow: false,
            shell: true,
          }),
        () => ({ token: ticket }),
      )()
    },
    client: { name: 'Studio desktop', kind: 'desktop' },
    heartbeat: false,
  })
  cleanups.push(() => client.close())
  return client
}

function protocolService(client: StudioClient): Omit<Rig, 'onDisk' | 'writeOutside'> {
  const remote = createProtocolCanvasFs(client)
  return service(remote.fs, {
    path: remote.path,
    exportFs: createNodeCanvasFs(),
    resolveWorkspaceRoot: (workspaceId) => remote.resolveWorkspaceRoot(workspaceId),
    resolveBoardStore: (workspaceId) => remote.resolveBoardStore(workspaceId),
    watch: (directory, onChange) => remote.watch(directory, onChange),
    platform: remote.platform(),
  })
}

async function protocolRig(): Promise<Rig> {
  const served = await studioServing()
  const file = join(served.where.store, BOARD.path)
  return {
    ...protocolService(await attach(served)),
    onDisk: () => readScene(file),
    writeOutside: (elements) => {
      mkdirSync(served.where.store, { recursive: true })
      writeFileSync(file, sceneText(elements))
    },
  }
}

const ids = (elements: CanvasElement[]) =>
  elements
    .filter((item) => item.isDeleted !== true)
    .map((item) => item.id)
    .sort()

const RIGS: Array<[string, () => Rig | Promise<Rig>]> = [
  ['a map in memory', memoryRig],
  ["this machine's disk", nodeRig],
  ["a Studio's files over the protocol", protocolRig],
]

for (const [name, make] of RIGS)
  describe(`the canvas service on ${name}`, () => {
    test('creates a board, takes a person’s commit and an agent’s edit, and reads them back', async () => {
      const rig = await make()
      assert.ok((await rig.service.readBoard(BOARD, { create: true })).ok)
      assert.deepEqual(rig.onDisk(), [])
      const committed = await rig.service.commitScene(
        { ...BOARD, baseRevision: 0, elements: [element('a')], appState: {}, files: {} },
        1,
      )
      assert.ok(committed.ok)
      rig.worker.answer(adds(element('b')))
      const edited = await rig.service.edit(
        BOARD,
        { create: [{ tempId: 'b', type: 'rectangle', x: 10, y: 10 }] },
        {
          kind: 'agent',
          workspaceId: WORKSPACE,
          agentId: 'agent-1',
        },
      )
      assert.ok(edited.ok, edited.ok ? '' : edited.error.message)
      assert.deepEqual(ids(rig.onDisk()), ['a', 'b'])
      const read = await rig.service.readBoard(BOARD)
      assert.deepEqual(read.ok && ids(read.value.elements), ['a', 'b'])
      const listed = await rig.service.listBoards(WORKSPACE)
      assert.deepEqual(listed.ok && listed.value.map((board) => board.path), [BOARD.path])
    })

    test('a change made outside the app is merged in and pushed to the board’s windows', async () => {
      const rig = await make()
      assert.ok((await rig.service.openBoard(BOARD, { create: true, subscriberId: 7 })).ok)
      await rig.service.commitScene({ ...BOARD, baseRevision: 0, elements: [element('a')], appState: {}, files: {} }, 7)
      rig.pushes.length = 0
      // Written again while unheard: a platform's watch takes a moment to start
      // hearing, and a change made before then is not this test's.
      let polls = 0
      await until(() => {
        if (polls++ % 10 === 0) rig.writeOutside([element('a'), element('c', { version: 3 })])
        return rig.pushes.some(
          (push) => push.channel === 'canvas:scene' && ids(push.payload.elements ?? []).includes('c'),
        )
      }, 'the outside change to be pushed')
      const read = await rig.service.readBoard(BOARD)
      assert.deepEqual(read.ok && ids(read.value.elements), ['a', 'c'])
    })

    test('a write that an outside change got ahead of loses neither', async () => {
      const rig = await make()
      await rig.service.readBoard(BOARD, { create: true })
      await rig.service.commitScene({ ...BOARD, baseRevision: 0, elements: [element('a')], appState: {}, files: {} }, 1)
      // Written behind the service's back, and a commit made before any watch
      // could have told it: the write must find the change, not overwrite it.
      rig.writeOutside([element('a'), element('d', { version: 2 })])
      const committed = await rig.service.commitScene(
        { ...BOARD, baseRevision: 1, elements: [element('a'), element('e', { version: 2 })], appState: {}, files: {} },
        1,
      )
      assert.ok(committed.ok, committed.ok ? '' : committed.error.message)
      await until(() => ids(rig.onDisk()).includes('d') && ids(rig.onDisk()).includes('e'), 'both edits on disk')
    })
  })

describe('two desktops on one Studio, one board', () => {
  test('two desktops creating one new board at once both open it', async () => {
    const served = await studioServing()
    const first = protocolService(await attach(served))
    const second = protocolService(await attach(served))
    const [one, two] = await Promise.all([
      first.service.readBoard(BOARD, { create: true }),
      second.service.readBoard(BOARD, { create: true }),
    ])
    assert.ok(one.ok, one.ok ? '' : one.error.message)
    assert.ok(two.ok, two.ok ? '' : two.error.message)
  })

  test('edits to different elements both survive, and each desktop hears the other’s', async () => {
    const served = await studioServing()
    const first = protocolService(await attach(served))
    const second = protocolService(await attach(served))
    await first.service.openBoard(BOARD, { create: true, subscriberId: 1 })
    await second.service.openBoard(BOARD, { create: true, subscriberId: 2 })
    // Both watches are live once both desktops have heard a change made
    // outside them; until then, it is made again.
    const file = join(served.where.store, BOARD.path)
    let probe = 0
    await until(() => {
      if (probe++ % 10 === 0) writeFileSync(file, sceneText([element('probe', { version: probe })]))
      const heard = (pushes: Rig['pushes']) => pushes.some((push) => ids(push.payload.elements ?? []).includes('probe'))
      return heard(first.pushes) && heard(second.pushes)
    }, 'both desktops to be watching')
    await first.service.commitScene({ ...BOARD, baseRevision: 0, elements: [element('x')], appState: {}, files: {} }, 1)
    await until(
      () => second.pushes.some((push) => ids(push.payload.elements ?? []).includes('x')),
      'the second desktop to hear the first',
    )
    await second.service.commitScene(
      { ...BOARD, baseRevision: 1, elements: [element('y')], appState: {}, files: {} },
      2,
    )
    await until(
      () => first.pushes.some((push) => ids(push.payload.elements ?? []).includes('y')),
      'the first desktop to hear the second',
    )
    assert.deepEqual(ids(readScene(file)), ['probe', 'x', 'y'])
  })

  test('an agent’s edit in one yields to the person editing the same element in the other', async () => {
    const served = await studioServing()
    const agentSide = protocolService(await attach(served))
    const personSide = protocolService(await attach(served))
    await agentSide.service.readBoard(BOARD, { create: true })
    await agentSide.service.commitScene(
      { ...BOARD, baseRevision: 0, elements: [element('shared')], appState: {}, files: {} },
      1,
    )
    await personSide.service.readBoard(BOARD)
    let personVersion = 1
    // Every time the agent's worker computes, the person moves the same box
    // on the other desktop before the agent can write.
    agentSide.worker.answer(async (request) => {
      personVersion += 2
      const person = element('shared', { version: personVersion, versionNonce: 5_000 + personVersion, x: 999 })
      const committed = await personSide.service.commitScene(
        { ...BOARD, baseRevision: 1, elements: [person], appState: {}, files: {} },
        2,
      )
      assert.ok(committed.ok)
      const base = (request.elements as CanvasElement[]).find((item) => item.id === 'shared')!
      return {
        ok: true,
        value: {
          kind: 'apply-edit',
          requestId: 'r',
          ok: true,
          elements: [{ ...base, x: 10, version: (base.version ?? 1) + 1, versionNonce: 7 }],
          files: {},
          result: { created: [], updated: ['shared'], deleted: [], tempIds: {}, warnings: [] },
        },
      }
    })
    const edited = await agentSide.service.edit(
      BOARD,
      { update: [{ id: 'shared', set: { x: 10 } }] },
      {
        kind: 'agent',
        workspaceId: WORKSPACE,
        agentId: 'agent-1',
      },
    )
    assert.equal(edited.ok ? null : edited.error.code, 'interrupted')
    const onDisk = readScene(join(served.where.store, BOARD.path)).find((item) => item.id === 'shared')
    assert.equal(onDisk?.x, 999, 'the person’s version is the one on disk')
  })
})

describe('a conditional write another client got in ahead of', () => {
  async function racedRig() {
    const served = await studioServing()
    const client = await attach(served)
    const remote = createProtocolCanvasFs(client)
    const file = join(served.where.store, BOARD.path)
    let raceNext: CanvasElement[] | null = null
    let conflicts = 0
    const writeFileAtomic = remote.fs.writeFileAtomic!
    // The other client's write lands between this service's read and its write.
    remote.fs.writeFileAtomic = async (path, contents, options) => {
      if (raceNext) {
        writeFileSync(file, sceneText(raceNext))
        raceNext = null
      }
      const written = await writeFileAtomic(path, contents, options)
      if (!written.ok) conflicts++
      return written
    }
    const built = service(remote.fs, {
      path: remote.path,
      resolveWorkspaceRoot: (workspaceId) => remote.resolveWorkspaceRoot(workspaceId),
      resolveBoardStore: (workspaceId) => remote.resolveBoardStore(workspaceId),
      watch: (directory, onChange) => remote.watch(directory, onChange),
    })
    return {
      ...built,
      file,
      race: (elements: CanvasElement[]) => {
        raceNext = elements
      },
      conflicts: () => conflicts,
    }
  }

  test('a person’s commit is merged again over it, and loses nothing', async () => {
    const rig = await racedRig()
    await rig.service.readBoard(BOARD, { create: true })
    await rig.service.commitScene({ ...BOARD, baseRevision: 0, elements: [element('a')], appState: {}, files: {} }, 1)
    rig.race([element('a'), element('other', { version: 4 })])
    const committed = await rig.service.commitScene(
      { ...BOARD, baseRevision: 1, elements: [element('a'), element('mine', { version: 2 })], appState: {}, files: {} },
      1,
    )
    assert.ok(committed.ok, committed.ok ? '' : committed.error.message)
    assert.equal(rig.conflicts(), 1)
    assert.deepEqual(ids(readScene(rig.file)), ['a', 'mine', 'other'])
  })

  test('an agent’s edit reads the board again and is written beside it', async () => {
    const rig = await racedRig()
    await rig.service.readBoard(BOARD, { create: true })
    await rig.service.commitScene({ ...BOARD, baseRevision: 0, elements: [element('a')], appState: {}, files: {} }, 1)
    rig.worker.answer(adds(element('b')))
    rig.race([element('a'), element('other', { version: 4 })])
    const edited = await rig.service.edit(
      BOARD,
      { create: [{ tempId: 'b', type: 'rectangle', x: 10, y: 10 }] },
      { kind: 'agent', workspaceId: WORKSPACE, agentId: 'agent-1' },
    )
    assert.ok(edited.ok, edited.ok ? '' : edited.error.message)
    assert.equal(rig.conflicts(), 1)
    assert.deepEqual(ids(readScene(rig.file)), ['a', 'b', 'other'])
  })
})

test("the protocol filesystem names the server's platform, not this process's", async () => {
  const served = await studioServing()
  const client = await attach(served)
  const remote = createProtocolCanvasFs(client)
  assert.equal(remote.platform(), client.welcome.environment.os)
  assert.equal(createProtocolCanvasFs(client, { platform: 'win32' }).platform(), 'win32')
  // Before a welcome there is no server to ask: the case-sensitive rule.
  assert.equal(createProtocolCanvasFs({ request: client.request, subscribe: client.subscribe }).platform(), 'linux')
})
