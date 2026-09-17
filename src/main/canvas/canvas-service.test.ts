/**
 * The canvas service: what it writes, in what order, and who hears about it.
 *
 * Everything the service touches is injected — a filesystem in a Map, a clock
 * that is a list of callbacks, a worker that answers whatever the case needs
 * and a watcher the test fires by hand — so what is proved here is the
 * ordering and the merge rather than Node's `rename`. The one thing a fake
 * cannot be is the concurrency: the agent-vs-person cases below really do
 * interleave through the service's own queue.
 */
import assert from 'node:assert/strict'

import { createCanvasService, mergeFromDisk, type CanvasDirEntry, type CanvasFileStat, type CanvasFs } from './canvas-service'
import type { CanvasWorkerHost } from './canvas-worker-host'
import { canvasReaderKey } from './canvas-service-types'
import type { CanvasElement } from '../../shared/canvas/types'
import { parseSceneFile } from '../../shared/canvas/scene-file'

const ROOT = '/Users/dev/project'
const WORKSPACE = 'workspace-1'
const BOARD = 'diagrams/canvas.excalidraw'
const BOARD_FILE = `${ROOT}/${BOARD}`
const ref = { workspaceId: WORKSPACE, path: BOARD }

type MemoryFs = CanvasFs & {
  files: Map<string, string>
  ops: string[]
  now: () => number
  setNow: (value: number) => void
}

function missing(path: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException
  error.code = 'ENOENT'
  return error
}

function createMemoryFs(): MemoryFs {
  const files = new Map<string, string>()
  // Per file, because "how old is this" is a real question here: the temp-file
  // sweep only removes litter old enough to be nobody's write in flight.
  const mtimes = new Map<string, number>()
  const directories = new Set<string>([ROOT])
  const ops: string[] = []
  let clock = 1_000

  const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/'
  const addDirs = (path: string): void => {
    const parts = path.split('/')
    for (let i = 2; i <= parts.length; i += 1) directories.add(parts.slice(0, i).join('/'))
  }

  return {
    files,
    ops,
    now: () => clock,
    setNow: (value) => {
      clock = value
    },
    readFile: async (path) => {
      ops.push(`read ${path}`)
      const contents = files.get(path)
      if (contents === undefined) throw missing(path)
      return contents
    },
    writeFile: async (path, contents) => {
      ops.push(`write ${path}`)
      files.set(path, contents)
      mtimes.set(path, clock)
    },
    rename: async (from, to) => {
      ops.push(`rename ${from} -> ${to}`)
      const contents = files.get(from)
      if (contents === undefined) throw missing(from)
      files.delete(from)
      mtimes.delete(from)
      files.set(to, contents)
      mtimes.set(to, clock)
    },
    mkdir: async (path) => {
      ops.push(`mkdir ${path}`)
      addDirs(path)
    },
    stat: async (path): Promise<CanvasFileStat> => {
      const contents = files.get(path)
      if (contents !== undefined) {
        return { size: contents.length, mtimeMs: mtimes.get(path) ?? clock, isDirectory: false, isFile: true }
      }
      if (directories.has(path)) return { size: 0, mtimeMs: clock, isDirectory: true, isFile: false }
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
        if (parentOf(file) === path) entries.push({ name: file.slice(path.length + 1), isDirectory: false, isFile: true })
      }
      return entries
    },
    unlink: async (path) => {
      ops.push(`unlink ${path}`)
      files.delete(path)
      mtimes.delete(path)
    },
  }
}

type WorkerAnswer = { ok: true; value: Record<string, unknown> } | { ok: false; error: { code: string; message: string } }

type FakeWorker = {
  host: CanvasWorkerHost
  calls: Array<Record<string, unknown>>
  disposed: () => boolean
  answer: (handler: (request: Record<string, unknown>) => WorkerAnswer | Promise<WorkerAnswer>) => void
  setFontReport: (report: { loaded: string[]; missing: string[]; errors: string[] } | null) => void
}

function createWorker(): FakeWorker {
  const calls: Array<Record<string, unknown>> = []
  let disposed = false
  let fontReport: { loaded: string[]; missing: string[]; errors: string[] } | null = null
  let handler: (request: Record<string, unknown>) => WorkerAnswer | Promise<WorkerAnswer> = () => ({
    ok: false,
    error: { code: 'worker_unavailable', message: 'this test set no worker answer' },
  })
  return {
    calls,
    disposed: () => disposed,
    answer: (next) => {
      handler = next
    },
    setFontReport: (next) => {
      fontReport = next
    },
    host: {
      call: (async (request: Record<string, unknown>) => {
        calls.push(request)
        return handler(request)
      }) as unknown as CanvasWorkerHost['call'],
      report: () => fontReport,
      dispose: async () => {
        disposed = true
      },
    },
  }
}

type Harness = ReturnType<typeof createHarness>

function createHarness(options: { platform?: string } = {}): {
  service: ReturnType<typeof createCanvasService>
  fs: MemoryFs
  worker: FakeWorker
  pushes: Array<{ to: number; channel: string; payload: Record<string, unknown> }>
  broadcasts: Array<{ channel: string; payload: unknown }>
  fireWatcher: () => void
  watcherCount: () => number
  advance: (ms: number) => void
} {
  const fs = createMemoryFs()
  const worker = createWorker()
  const pushes: Array<{ to: number; channel: string; payload: Record<string, unknown> }> = []
  const broadcasts: Array<{ channel: string; payload: unknown }> = []
  const watchers: Array<{ directory: string; onChange: (filename: string | null) => void; closed: boolean }> = []

  let now = 1_000
  let nextTimer = 0
  const timers = new Map<number, { at: number; fn: () => void }>()

  const service = createCanvasService({
    fs,
    // Case folding is a platform rule, and both halves of it have to be
    // provable on whichever machine the tests happen to run on.
    platform: options.platform ?? 'linux',
    now: () => now,
    resolveWorkspaceRoot: (workspaceId) => (workspaceId === WORKSPACE ? ROOT : null),
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    sendTo: (to, channel, payload) => pushes.push({ to, channel, payload: payload as Record<string, unknown> }),
    worker: worker.host,
    watch: (directory, onChange) => {
      const watcher = { directory, onChange, closed: false }
      watchers.push(watcher)
      return {
        close: () => {
          watcher.closed = true
        },
      }
    },
    setTimer: (fn, ms) => {
      const id = nextTimer++
      timers.set(id, { at: now + ms, fn })
      return { cancel: () => timers.delete(id) }
    },
  })

  return {
    service,
    fs,
    worker,
    pushes,
    broadcasts,
    fireWatcher: () => {
      for (const watcher of watchers) {
        if (!watcher.closed) watcher.onChange('canvas.excalidraw')
      }
    },
    watcherCount: () => watchers.filter((watcher) => !watcher.closed).length,
    advance: (ms) => {
      now += ms
      fs.setNow(now)
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.fn()
      }
    },
  }
}

function element(id: string, over: Partial<CanvasElement> = {}): CanvasElement {
  return { id, type: 'rectangle', version: 1, versionNonce: 1_000, x: 0, y: 0, width: 100, height: 50, ...over }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((settle) => setImmediate(settle))
}

function sceneOnDisk(harness: Harness): CanvasElement[] {
  const text = harness.fs.files.get(BOARD_FILE)
  assert.ok(text, 'the board file exists')
  const parsed = parseSceneFile(text)
  assert.ok(parsed.ok, 'the board file parses')
  return parsed.value.elements
}

// --------------------------------------------------------------------------

async function assertReadCreateAndRefusals(): Promise<void> {
  const harness = createHarness()

  const missingBoard = await harness.service.readBoard(ref)
  assert.equal(missingBoard.ok, false)
  assert.equal(missingBoard.ok === false && missingBoard.error.code, 'not_found')
  assert.equal(harness.fs.files.has(BOARD_FILE), false, 'a read never creates the file')

  const created = await harness.service.readBoard(ref, { create: true })
  assert.ok(created.ok, 'create writes an empty scene')
  assert.equal(created.value.elements.length, 0)
  assert.equal(created.value.revision, 0, 'a board starts at revision zero')
  assert.ok(harness.fs.ops.some((op) => op.startsWith('mkdir ')), 'the folder is made first')
  assert.ok(
    harness.fs.ops.some((op) => op.includes(`rename ${BOARD_FILE}.`)),
    'the write lands through a rename, not in place',
  )

  const escape = await harness.service.readBoard({ workspaceId: WORKSPACE, path: '../outside.excalidraw' })
  assert.equal(escape.ok === false && escape.error.code, 'invalid_path', 'a path out of the project is refused')

  const unknown = await harness.service.readBoard({ workspaceId: 'nobody', path: BOARD })
  assert.equal(unknown.ok === false && unknown.error.code, 'unknown_workspace')

  console.log('ok - a board is created on request, and a path out of the project never reaches the disk')
}

async function assertInvalidSceneIsNeverOverwritten(): Promise<void> {
  const harness = createHarness()
  harness.fs.files.set(BOARD_FILE, '{ this is not json')

  const read = await harness.service.readBoard(ref, { create: true })
  assert.equal(read.ok === false && read.error.code, 'invalid_scene')
  assert.equal(harness.fs.files.get(BOARD_FILE), '{ this is not json', 'the file is left exactly as it was')

  // And an edit — which creates a missing board — still refuses this one.
  const edited = await harness.service.edit(ref, { create: [] }, { kind: 'agent', workspaceId: WORKSPACE })
  assert.equal(edited.ok === false && edited.error.code, 'invalid_scene')
  assert.equal(harness.fs.files.get(BOARD_FILE), '{ this is not json')
  console.log('ok - an unreadable board file is reported, never repaired by overwriting it')
}

async function assertEditPipeline(): Promise<void> {
  const harness = createHarness()
  await harness.service.readBoard(ref, { create: true })
  await harness.service.openBoard(ref, { subscriberId: 7 })
  harness.pushes.length = 0

  // An image element and the blob it names: `files` is pruned at write time to
  // what the elements actually refer to, so an orphan blob is not what this
  // case is about.
  const box = element('box-1', { version: 2, type: 'image', fileId: 'image-1' })
  harness.worker.answer(() => ({
    ok: true,
    value: {
      kind: 'apply-edit',
      requestId: 'r1',
      ok: true,
      elements: [box],
      files: { 'image-1': { id: 'image-1' } },
      result: { created: ['box-1'], updated: [], deleted: [], tempIds: { a: 'box-1' }, warnings: [] },
    },
  }))

  const result = await harness.service.edit(
    ref,
    { create: [{ tempId: 'a', type: 'rectangle', x: 0, y: 0 }] },
    { kind: 'agent', workspaceId: WORKSPACE, agentId: 'agent-1', agentName: 'Scout' },
  )
  assert.ok(result.ok, 'the edit is accepted')
  assert.deepEqual(result.value.result.created, ['box-1'])
  assert.deepEqual(result.value.result.tempIds, { a: 'box-1' })
  assert.ok(result.value.result.lint, 'the lint report rides along with the result')
  assert.equal(result.value.state.revision, 1, 'an accepted write bumps the revision')
  assert.deepEqual(sceneOnDisk(harness).map((item) => item.id), ['box-1'], 'the element is on disk')
  assert.deepEqual(result.value.state.files, { 'image-1': { id: 'image-1' } }, 'files from the worker are merged in')

  const scene = harness.pushes.filter((push) => push.channel === 'canvas:scene')
  assert.equal(scene.length, 1, 'the subscriber is pushed the new scene')
  assert.equal(scene[0].to, 7)
  assert.equal(scene[0].payload.origin, 'agent')
  assert.equal(scene[0].payload.revision, 1)

  const presence = harness.pushes.filter((push) => push.channel === 'canvas:presence')
  assert.equal(presence.length, 1, 'and told who is holding the pen')
  assert.equal(presence[0].payload.controller, 'agent')
  assert.equal(presence[0].payload.agentName, 'Scout')

  harness.advance(1_600)
  const lapsed = harness.pushes.filter((push) => push.channel === 'canvas:presence')
  assert.equal(lapsed.length, 2, 'the agent claim lapses on its own')
  assert.equal(lapsed[1].payload.controller, 'none')

  const log = harness.service.actions(ref)
  assert.equal(log.length, 1)
  assert.equal(log[0].action, 'canvas.edit')
  assert.equal(log[0].status, 'succeeded')
  assert.equal(log[0].actor, 'agent')
  assert.equal(log[0].agentName, 'Scout')

  // An edit naming an element the board does not have is refused before the
  // worker is asked anything.
  const callsBefore = harness.worker.calls.length
  const unknown = await harness.service.edit(ref, { delete: ['ghost'] }, { kind: 'agent', workspaceId: WORKSPACE })
  assert.equal(unknown.ok === false && unknown.error.code, 'unknown_element')
  assert.equal(harness.worker.calls.length, callsBefore, 'a refused edit costs no worker call')

  console.log('ok - an agent edit merges, writes atomically, bumps the revision and reaches the subscribers')
}

async function assertHumanCommitEcho(): Promise<void> {
  const harness = createHarness()
  await harness.service.readBoard(ref, { create: true })
  await harness.service.openBoard(ref, { subscriberId: 1 })
  await harness.service.openBoard(ref, { subscriberId: 2 })
  harness.pushes.length = 0

  const drawn = element('shape-1', { version: 3 })
  const first = await harness.service.commitScene(
    { ...ref, baseRevision: 0, elements: [drawn], appState: { viewBackgroundColor: '#fafafa' }, files: {} },
    1,
  )
  assert.ok(first.ok)
  assert.equal(first.value.elements, null, 'nothing differed, so the sender is not echoed its own scene back')
  assert.equal(first.value.revision, 1)
  const pushed = harness.pushes.filter((push) => push.channel === 'canvas:scene')
  assert.equal(pushed.length, 1, 'only the OTHER window is pushed')
  assert.equal(pushed[0].to, 2)
  assert.equal(pushed[0].payload.origin, 'human')

  const state = await harness.service.readBoard(ref)
  assert.ok(state.ok)
  assert.equal((state.value.appState as { viewBackgroundColor: string }).viewBackgroundColor, '#fafafa')

  // A second window commits from a stale base: the merge keeps both elements,
  // so what it sent is not what the board holds and it is handed the truth.
  const second = await harness.service.commitScene(
    {
      ...ref,
      baseRevision: 1,
      elements: [element('shape-2', { version: 1, type: 'image', fileId: 'blob' })],
      appState: {},
      files: { blob: 1, orphan: 2 },
    },
    2,
  )
  assert.ok(second.ok)
  assert.ok(second.value.elements, 'the merged scene differs from what was sent, so it comes back')
  assert.deepEqual(second.value.elements?.map((item) => item.id).sort(), ['shape-1', 'shape-2'])
  const merged = await harness.service.readBoard(ref)
  assert.ok(merged.ok)
  assert.deepEqual(
    merged.value.files,
    { blob: 1 },
    'a blob an element names is merged by key, and one nothing names is not carried for the board\'s life',
  )

  // Two saves inside the coalescing window are one line in the log.
  const log = harness.service.actions(ref)
  assert.equal(log.length, 1, 'a burst of the person saving is one action entry')
  assert.equal(log[0].actor, 'human')
  console.log("ok - a commit merges, echoes only when the merge differs, and never pushes to its own sender")
}

async function assertQueueOrdersAgentAndHuman(): Promise<void> {
  const harness = createHarness()
  await harness.service.readBoard(ref, { create: true })

  // Seed the board so both writers have something to argue about.
  await harness.service.commitScene({ ...ref, baseRevision: 0, elements: [element('a')], appState: {}, files: {} }, 1)

  const order: string[] = []
  // Assigned synchronously when the worker handler starts waiting; a `null`
  // start would only make the call site fight the narrowing.
  let releaseWorker: () => void = () => {}
  const workerCalled = new Promise<void>((settle) => {
    harness.worker.answer(async () => {
      settle()
      await new Promise<void>((go) => {
        releaseWorker = go
      })
      order.push('worker answered')
      return {
        ok: true,
        value: {
          kind: 'apply-edit',
          requestId: 'r',
          ok: true,
          elements: [element('a'), element('b', { version: 1 })],
          files: {},
          result: { created: ['b'], updated: [], deleted: [], tempIds: {}, warnings: [] },
        },
      }
    })
  })

  const edit = harness.service
    .edit(ref, { create: [{ tempId: 'b', type: 'rectangle', x: 10, y: 10 }] }, { kind: 'agent', workspaceId: WORKSPACE })
    .then((answer) => {
      order.push('agent applied')
      return answer
    })

  await workerCalled
  // The person saves while the agent's geometry call is still out. It must not
  // wait behind it — that is the whole reason the worker call is outside the
  // board's queue.
  const commit = harness.service
    .commitScene({ ...ref, baseRevision: 1, elements: [element('c', { version: 1 })], appState: {}, files: {} }, 1)
    .then((answer) => {
      order.push('human applied')
      return answer
    })
  assert.ok((await commit).ok, 'the person is not blocked by the agent')

  releaseWorker()
  const applied = await edit
  assert.ok(applied.ok)
  assert.deepEqual(order, ['human applied', 'worker answered', 'agent applied'])
  assert.deepEqual(
    sceneOnDisk(harness)
      .map((item) => item.id)
      .sort(),
    ['a', 'b', 'c'],
    "the agent's element and the person's both survive",
  )
  console.log('ok - a save made while an agent call is in flight lands first and is not lost')
}

async function assertRecomputeOnceThenInterrupted(): Promise<void> {
  for (const injectedCommits of [1, 2]) {
    const harness = createHarness()
    await harness.service.readBoard(ref, { create: true })
    await harness.service.commitScene(
      { ...ref, baseRevision: 0, elements: [element('a', { version: 1 })], appState: {}, files: {} },
      1,
    )

    let remaining = injectedCommits
    let humanVersion = 1
    harness.worker.answer(async () => {
      if (remaining > 0) {
        remaining -= 1
        humanVersion += 1
        // The person drags the very element this edit is about to update.
        await harness.service.commitScene(
          { ...ref, baseRevision: 1, elements: [element('a', { version: humanVersion, x: humanVersion * 10 })], appState: {}, files: {} },
          1,
        )
      }
      return {
        ok: true,
        value: {
          kind: 'apply-edit',
          requestId: 'r',
          ok: true,
          elements: [element('a', { version: 99, x: 500 })],
          files: {},
          result: { created: [], updated: ['a'], deleted: [], tempIds: {}, warnings: [] },
        },
      }
    })

    const answer = await harness.service.edit(
      ref,
      { update: [{ id: 'a', set: { x: 500 } }] },
      { kind: 'agent', workspaceId: WORKSPACE },
    )
    if (injectedCommits === 1) {
      assert.ok(answer.ok, 'one collision is recomputed against the fresh board')
      assert.equal(sceneOnDisk(harness).find((item) => item.id === 'a')?.x, 500)
      const log = harness.service.actions(ref).filter((entry) => entry.action === 'canvas.edit')
      assert.equal(log[0]?.status, 'succeeded')
    } else {
      assert.equal(answer.ok, false)
      assert.equal(answer.ok === false && answer.error.code, 'interrupted', 'twice in a row, the person wins')
      const log = harness.service.actions(ref).filter((entry) => entry.action === 'canvas.edit')
      assert.equal(log[0]?.status, 'interrupted')
    }
  }
  console.log('ok - an edit contested by the person recomputes once and then gives way')
}

/**
 * The collision the `updated` list cannot see.
 *
 * Fastening an arrow to a box bumps the BOX — it gains the arrow in
 * `boundElements` — and the edit never named it, so a check that read only what
 * the agent asked to update let the person's concurrent drag of that box be
 * decided by which nonce happened to be lower. Run twice: once with a worker
 * that reports what it changed, and once with one that does not, because the
 * service re-reads the output against the base either way.
 */
async function assertRepairedShapeCountsAsContested(): Promise<void> {
  for (const workerReportsChanged of [true, false]) {
    const harness = createHarness()
    await harness.service.readBoard(ref, { create: true })
    await harness.service.commitScene(
      { ...ref, baseRevision: 0, elements: [element('X', { version: 5, versionNonce: 100 })], appState: {}, files: {} },
      1,
    )

    let release: () => void = () => {}
    let gate: Promise<void> | null = new Promise<void>((settle) => {
      release = settle
    })
    let calls = 0

    harness.worker.answer(async (request) => {
      calls += 1
      const base = request.elements as CanvasElement[]
      const shape = base.find((item) => item.id === 'X') as CanvasElement
      // The first call is held open so the person's commit lands underneath it.
      if (gate) {
        const waiting = gate
        gate = null
        await waiting
      }
      const repaired: CanvasElement = {
        ...shape,
        version: (shape.version ?? 0) + 1,
        versionNonce: 1,
        boundElements: [{ id: 'A', type: 'arrow' }],
      }
      const arrow = element('A', {
        type: 'arrow',
        version: 1,
        versionNonce: 7,
        startBinding: { elementId: 'X', focus: 0, gap: 1 },
      })
      return {
        ok: true,
        value: {
          kind: 'apply-edit',
          requestId: 'r',
          ok: true,
          elements: [repaired, arrow],
          ...(workerReportsChanged ? { changed: ['X', 'A'] } : {}),
          files: {},
          // The agent asked for a create. It never asked about X.
          result: { created: ['A'], updated: [], deleted: [], tempIds: {}, warnings: [] },
        },
      }
    })

    const editing = harness.service.edit(
      ref,
      { create: [{ type: 'arrow', x: 0, y: 0, startElementId: 'X' }] },
      { kind: 'agent', workspaceId: WORKSPACE },
    )
    await flush()
    // The person drags X off the same base: one version up, a different nonce.
    const committed = await harness.service.commitScene(
      { ...ref, baseRevision: 1, elements: [element('X', { version: 6, versionNonce: 999, x: 400 })], appState: {}, files: {} },
      1,
    )
    assert.ok(committed.ok)
    release()

    const result = await editing
    assert.ok(result.ok, 'the edit is recomputed rather than fighting the person for the shape')
    assert.equal(calls, 2, 'exactly one recompute')
    const final = sceneOnDisk(harness)
    const shape = final.find((item) => item.id === 'X')
    assert.equal(shape?.x, 400, "the person's drag survives")
    assert.deepEqual(shape?.boundElements, [{ id: 'A', type: 'arrow' }], 'and the arrow is still listed on it')
    assert.ok(final.some((item) => item.id === 'A'), 'the arrow was drawn')
  }
  console.log('ok - a shape the worker repaired but the edit never named still counts as contested')
}

async function assertDiskChangesAndOwnWrites(): Promise<void> {
  const harness = createHarness()
  await harness.service.readBoard(ref, { create: true })
  await harness.service.openBoard(ref, { subscriberId: 5 })
  await harness.service.commitScene(
    { ...ref, baseRevision: 0, elements: [element('kept'), element('gone')], appState: {}, files: {} },
    5,
  )
  harness.pushes.length = 0

  // The watcher firing on the bytes we just wrote ourselves is not news.
  harness.fireWatcher()
  harness.advance(200)
  await flush()
  assert.equal(harness.pushes.length, 0, 'our own write does not come back as a disk change')

  // Somebody else (a branch switch) replaces the file: one element moved, one
  // gone, one new.
  harness.fs.files.set(
    BOARD_FILE,
    JSON.stringify({
      type: 'excalidraw',
      version: 2,
      source: 'git',
      elements: [element('kept', { version: 9, x: 400 }), element('fresh', { version: 1 })],
      appState: {},
      files: {},
    }),
  )
  harness.fireWatcher()
  harness.advance(200)
  await flush()

  const pushed = harness.pushes.filter((push) => push.channel === 'canvas:scene')
  assert.equal(pushed.length, 1, 'a change we did not make is pushed')
  assert.equal(pushed[0].payload.origin, 'disk')
  const elements = pushed[0].payload.elements as CanvasElement[]
  assert.equal(elements.find((item) => item.id === 'kept')?.x, 400, 'the disk wins for an element it carries')
  assert.equal(elements.find((item) => item.id === 'gone')?.isDeleted, true, 'an element missing from the file is a deletion')
  assert.ok(elements.some((item) => item.id === 'fresh'), 'and a new one arrives')

  // The file disappearing is survivable: memory stands and the next write puts
  // it back.
  harness.fs.files.delete(BOARD_FILE)
  harness.fireWatcher()
  harness.advance(200)
  await flush()
  const rewritten = await harness.service.commitScene(
    { ...ref, baseRevision: 3, elements: [element('kept', { version: 20 })], appState: {}, files: {} },
    5,
  )
  assert.ok(rewritten.ok, 'a deleted board file is rewritten rather than crashing the service')
  assert.ok(harness.fs.files.has(BOARD_FILE))
  console.log('ok - the watcher tells our own writes apart from a change anyone else made')
}

/**
 * The window between the watcher firing and its debounce running.
 *
 * Our own write records the hash of what it wrote, so a commit landing inside
 * that window used to leave the debounced reload reading "our own content" and
 * discarding whatever the other writer had put there — a `git checkout` of a
 * board, lost without a word.
 */
async function assertDiskChangeInsideTheDebounce(): Promise<void> {
  const harness = createHarness()
  await harness.service.readBoard(ref, { create: true })
  await harness.service.openBoard(ref, { subscriberId: 7 })
  await harness.service.commitScene(
    { ...ref, baseRevision: 0, elements: [element('X', { version: 5 })], appState: {}, files: {} },
    7,
  )

  // Another program replaces the file: X moved, and a second element arrived.
  harness.fs.files.set(
    BOARD_FILE,
    JSON.stringify({
      type: 'excalidraw',
      version: 2,
      source: 'git',
      elements: [element('X', { version: 9, x: 900 }), element('Y', { type: 'ellipse', version: 1 })],
      appState: {},
      files: {},
    }),
  )
  harness.fireWatcher()

  // Inside the 150ms debounce, the person's own edit arrives.
  const committed = await harness.service.commitScene(
    { ...ref, baseRevision: 1, elements: [element('X', { version: 6, x: 1 })], appState: {}, files: {} },
    7,
  )
  assert.ok(committed.ok, "the person's commit still goes through")

  harness.advance(200)
  await flush()

  const onDisk = sceneOnDisk(harness)
  assert.equal(onDisk.find((item) => item.id === 'X')?.x, 900, 'the disk edit survived the commit on top of it')
  assert.ok(onDisk.some((item) => item.id === 'Y'), 'and so did the element it brought')

  // The narrower window: the change is made but the watcher has not told us
  // yet, which on a real filesystem is the first few milliseconds of every
  // external write. The file's own size and mtime answer for it.
  harness.advance(1_000)
  harness.fs.files.set(
    BOARD_FILE,
    JSON.stringify({
      type: 'excalidraw',
      version: 2,
      source: 'git',
      elements: [element('X', { version: 30, x: 1_200 }), element('Z', { type: 'ellipse', version: 1 })],
      appState: {},
      files: {},
    }),
  )
  // Deliberately NO fireWatcher() here.
  const silent = await harness.service.commitScene(
    { ...ref, baseRevision: 2, elements: [element('X', { version: 8, x: 2 })], appState: {}, files: {} },
    7,
  )
  assert.ok(silent.ok)
  const second = sceneOnDisk(harness)
  assert.equal(second.find((item) => item.id === 'X')?.x, 1_200, 'a change the watcher has not reported yet is still read first')
  assert.ok(second.some((item) => item.id === 'Z'))
  console.log('ok - a disk change that lands inside the watcher debounce is merged, not discarded')
}

/**
 * The same window, with the file in a state this app cannot read. Nothing is
 * written over it: a half-written file belongs to whoever is writing it, and a
 * hand-broken one is somebody's work in progress.
 */
async function assertUnparseableDiskStopsTheWrite(): Promise<void> {
  const harness = createHarness()
  await harness.service.readBoard(ref, { create: true })
  await harness.service.commitScene(
    { ...ref, baseRevision: 0, elements: [element('X', { version: 5 })], appState: {}, files: {} },
    7,
  )

  harness.fs.files.set(BOARD_FILE, '{ "elements": [')
  harness.fireWatcher()

  const refused = await harness.service.commitScene(
    { ...ref, baseRevision: 1, elements: [element('X', { version: 6, x: 1 })], appState: {}, files: {} },
    7,
  )
  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false && refused.error.code, 'invalid_scene')
  assert.equal(harness.fs.files.get(BOARD_FILE), '{ "elements": [', 'the broken file is left exactly as it was')

  // Repaired on disk: the next write reads it and goes through.
  harness.fs.files.set(
    BOARD_FILE,
    JSON.stringify({ type: 'excalidraw', version: 2, source: 'git', elements: [element('X', { version: 9, x: 900 })], appState: {}, files: {} }),
  )
  const accepted = await harness.service.commitScene(
    { ...ref, baseRevision: 1, elements: [element('X', { version: 6, x: 1 })], appState: {}, files: {} },
    7,
  )
  assert.ok(accepted.ok, 'a readable file is written again')
  assert.equal(sceneOnDisk(harness).find((item) => item.id === 'X')?.x, 900)
  console.log('ok - a board file this app cannot read is never written over')
}

async function assertReplaceImportTombstones(): Promise<void> {
  const harness = createHarness()
  await harness.service.readBoard(ref, { create: true })
  await harness.service.commitScene(
    { ...ref, baseRevision: 0, elements: [element('old-1'), element('old-2')], appState: {}, files: {} },
    1,
  )

  harness.worker.answer(() => ({
    ok: true,
    value: {
      kind: 'import-mermaid',
      requestId: 'r',
      ok: true,
      elements: [element('new-1', { version: 1 })],
      files: {},
    },
  }))

  const imported = await harness.service.importContent(
    ref,
    { mermaid: 'graph TD; A-->B', mode: 'replace' },
    { kind: 'agent', workspaceId: WORKSPACE },
  )
  assert.ok(imported.ok)
  const onDisk = sceneOnDisk(harness)
  for (const id of ['old-1', 'old-2']) {
    const tombstone = onDisk.find((item) => item.id === id)
    assert.equal(tombstone?.isDeleted, true, `${id} is tombstoned rather than dropped`)
    assert.equal(tombstone?.version, 2, 'with a bumped version, so an open editor merges the deletion')
  }
  assert.ok(onDisk.some((item) => item.id === 'new-1' && item.isDeleted !== true))
  console.log('ok - a replacing import tombstones what was there so an open editor converges')
}

async function assertScreenshotBudget(): Promise<void> {
  const harness = createHarness()
  await harness.service.readBoard(ref, { create: true })

  const empty = await harness.service.screenshot(ref, {})
  assert.equal(empty.ok === false && empty.error.code, 'invalid_scene')
  assert.match(empty.ok === false ? empty.error.message : '', /empty/)

  await harness.service.commitScene({ ...ref, baseRevision: 0, elements: [element('a')], appState: {}, files: {} }, 1)

  const image = (bytes: number, mimeType: 'image/png' | 'image/jpeg'): WorkerAnswer => ({
    ok: true,
    value: { kind: 'export-image', requestId: 'r', ok: true, image: { data: 'x'.repeat(bytes), mimeType, width: 100, height: 100 } },
  })

  // PNG over budget, JPEG over budget, and the smaller retry fits.
  harness.worker.calls.length = 0
  harness.worker.answer((request) => {
    if (request.format === 'png') return image(700 * 1024, 'image/png')
    if ((request.maxEdge as number) === 1024) return image(950 * 1024, 'image/jpeg')
    return image(400 * 1024, 'image/jpeg')
  })
  const fallback = await harness.service.screenshot(ref, {})
  assert.ok(fallback.ok, 'the budget chain finds a size that fits')
  assert.equal(fallback.value.mimeType, 'image/jpeg')
  assert.equal(harness.worker.calls.length, 3)
  assert.equal(harness.worker.calls[0].maxEdge, 1024, 'the default longest edge')
  assert.equal(harness.worker.calls[2].maxEdge, 768, 'the retry is three quarters of it')

  // A caller may ask for less; it may not ask for more than the ceiling.
  harness.worker.calls.length = 0
  harness.worker.answer(() => image(10, 'image/png'))
  assert.ok((await harness.service.screenshot(ref, { maxEdge: 4000 })).ok)
  assert.equal(harness.worker.calls[0].maxEdge, 1600, 'the ceiling holds whoever asked')
  harness.worker.calls.length = 0
  assert.ok((await harness.service.screenshot(ref, { maxEdge: 400 })).ok)
  assert.equal(harness.worker.calls[0].maxEdge, 400)

  harness.worker.answer((request) => image(request.format === 'png' ? 700 * 1024 : 950 * 1024, request.format === 'png' ? 'image/png' : 'image/jpeg'))
  const tooLarge = await harness.service.screenshot(ref, {})
  assert.equal(tooLarge.ok === false && tooLarge.error.code, 'too_large')
  console.log('ok - a screenshot walks the budget down and reports too_large rather than blowing the line limit')
}

async function assertChangesSinceLastRead(): Promise<void> {
  const harness = createHarness()
  await harness.service.readBoard(ref, { create: true })

  assert.deepEqual(harness.service.changesSinceLastRead(ref, 'agent-1'), [], 'the first look has nothing to compare to')

  await harness.service.commitScene(
    { ...ref, baseRevision: 0, elements: [element('drawn', { version: 1 })], appState: {}, files: {} },
    1,
  )
  const changes = harness.service.changesSinceLastRead(ref, 'agent-1')
  assert.equal(changes.length, 1)
  assert.match(changes[0], /^Added rectangle/)
  assert.deepEqual(harness.service.changesSinceLastRead(ref, 'agent-1'), [], 'and it is marked read')

  // Another reader has its own place in the story.
  assert.deepEqual(harness.service.changesSinceLastRead(ref, 'agent-2'), [])
  console.log('ok - each reader is told what changed since its own last look')
}

/**
 * The half of that rule the tools depend on: an agent asks under
 * `canvasReaderKey(workspaceId, agentId)`, and the service has to file its
 * post-write snapshot under the SAME spelling — otherwise every agent is told
 * its own drawing is something the person did while it was not looking.
 */
async function assertAgentDoesNotSeeItsOwnEdits(): Promise<void> {
  const harness = createHarness()
  await harness.service.readBoard(ref, { create: true })

  const mine = canvasReaderKey(WORKSPACE, 'agent-1')
  const theirs = canvasReaderKey(WORKSPACE, 'agent-2')
  // Both agents have looked once, so neither's next look is a first look.
  assert.deepEqual(harness.service.changesSinceLastRead(ref, mine), [])
  assert.deepEqual(harness.service.changesSinceLastRead(ref, theirs), [])

  harness.worker.answer(() => ({
    ok: true,
    value: {
      kind: 'apply-edit',
      requestId: 'r1',
      ok: true,
      elements: [element('box-1', { version: 2 })],
      files: {},
      result: { created: ['box-1'], updated: [], deleted: [], tempIds: { a: 'box-1' }, warnings: [] },
    },
  }))
  const edited = await harness.service.edit(
    ref,
    { create: [{ tempId: 'a', type: 'rectangle', x: 0, y: 0 }] },
    { kind: 'agent', workspaceId: WORKSPACE, agentId: 'agent-1', agentName: 'Scout' },
  )
  assert.ok(edited.ok)

  assert.deepEqual(
    harness.service.changesSinceLastRead(ref, mine),
    [],
    'the agent that drew the box is not told the box appeared',
  )
  const otherAgent = harness.service.changesSinceLastRead(ref, theirs)
  assert.equal(otherAgent.length, 1, 'but every other reader still hears about it')
  assert.match(otherAgent[0], /^Added rectangle/)

  // The person's own edit is still news to the agent that drew before it.
  await harness.service.commitScene(
    { ...ref, baseRevision: edited.value.state.revision, elements: [element('drawn', { version: 1 })], appState: {}, files: {} },
    1,
  )
  const afterPerson = harness.service.changesSinceLastRead(ref, mine)
  assert.equal(afterPerson.length, 1, 'what the person did is still reported')
  assert.match(afterPerson[0], /^Added rectangle/)

  // An agent with no id falls in with the anonymous readers rather than
  // colliding with a named one.
  assert.equal(canvasReaderKey(WORKSPACE, undefined), canvasReaderKey(WORKSPACE, ''))
  assert.notEqual(canvasReaderKey(WORKSPACE, 'agent-1'), canvasReaderKey('workspace-2', 'agent-1'))
  console.log('ok - an agent is never told its own edits were somebody else\'s')
}

async function assertRequestOpen(): Promise<void> {
  const answered = createHarness()
  await answered.service.readBoard(ref, { create: true })
  await answered.service.openBoard(ref, { subscriberId: 3 })
  const withSubscriber = await answered.service.requestOpen(ref)
  assert.ok(withSubscriber.ok)
  assert.equal(withSubscriber.value.revealed, true, 'a board a window already holds is revealed at once')
  assert.equal(answered.broadcasts[0]?.channel, 'canvas:open-request')

  const waiting = createHarness()
  await waiting.service.readBoard(ref, { create: true })
  const pending = waiting.service.requestOpen(ref)
  await flush()
  assert.equal(waiting.broadcasts.length, 1, 'the request goes out before anything is awaited')
  await waiting.service.openBoard(ref, { subscriberId: 4 })
  assert.equal((await pending).ok && (await pending).ok, true)
  assert.deepEqual(await pending, { ok: true, value: { revealed: true } }, 'a window that answers is the answer')

  const unanswered = createHarness()
  await unanswered.service.readBoard(ref, { create: true })
  const lonely = unanswered.service.requestOpen(ref)
  await flush()
  unanswered.advance(3_100)
  const result = await lonely
  assert.ok(result.ok, 'no window answering is never an error')
  assert.equal(result.value.revealed, false)
  console.log('ok - opening a board reports whether a window answered, and fails for neither answer')
}

/**
 * Two spellings of one path, where the filesystem reads them as one file.
 *
 * Two registry entries over one file would each hold their own revision, their
 * own watcher and their own idea of the scene, and the atomic write's rename
 * would keep flipping the file's name between them.
 */
/**
 * A worker that came up without its scene fonts measures every label in
 * whatever face the browser substituted, and writes those numbers into the
 * person's file. Nothing on screen says so, so every write does.
 */
/**
 * The litter a crash between the temp file and the rename leaves in somebody's
 * project, and the retention two long-lived maps would otherwise grow without
 * bound.
 */
/**
 * The other half of the drag-versus-arrow race.
 *
 * The agent's arrow lands while the person is moving the very shape it fastens
 * to. The person's copy of that shape wins the merge — `boundElements` and all
 * — so the arrow ends up listed nowhere: it follows the shape, but dragging the
 * shape leaves it behind. Their move stands; the missing half of the binding is
 * put back.
 */
async function assertBindingPairsSurviveTheMerge(): Promise<void> {
  const harness = createHarness()
  await harness.service.readBoard(ref, { create: true })
  await harness.service.openBoard(ref, { subscriberId: 3 })
  await harness.service.commitScene(
    { ...ref, baseRevision: 0, elements: [element('box', { version: 5 })], appState: {}, files: {} },
    3,
  )

  harness.worker.answer(() => ({
    ok: true,
    value: {
      kind: 'apply-edit',
      requestId: 'r',
      ok: true,
      elements: [
        element('box', { version: 6, boundElements: [{ id: 'arrow', type: 'arrow' }] }),
        element('arrow', { type: 'arrow', version: 1, startBinding: { elementId: 'box', focus: 0, gap: 4 } }),
      ],
      changed: ['box', 'arrow'],
      files: {},
      result: { created: ['arrow'], updated: [], deleted: [], tempIds: {}, warnings: [] },
    },
  }))
  const drawn = await harness.service.edit(
    ref,
    { create: [{ type: 'arrow', x: 0, y: 0, startElementId: 'box' }] },
    { kind: 'agent', workspaceId: WORKSPACE },
  )
  assert.ok(drawn.ok)

  // The person's tab applied the push, so it HAS the arrow — but its own copy
  // of the box won the reconcile, and that copy never carried the reference.
  const committed = await harness.service.commitScene(
    {
      ...ref,
      baseRevision: 1,
      elements: [
        element('box', { version: 20, x: 900 }),
        element('arrow', { type: 'arrow', version: 1, startBinding: { elementId: 'box', focus: 0, gap: 4 } }),
      ],
      appState: {},
      files: {},
    },
    3,
  )
  assert.ok(committed.ok)

  const box = sceneOnDisk(harness).find((item) => item.id === 'box')
  assert.equal(box?.x, 900, "the person's drag stands")
  assert.deepEqual(box?.boundElements, [{ id: 'arrow', type: 'arrow' }], 'and the arrow is listed on it again')
  assert.ok(Number(box?.version) > 20, 'on a version above the one the person sent, so their tab hears about it')
  assert.ok(committed.value.elements, 'which is why the answer carries the merged scene back')

  // An arrow whose own binding is gone is an arrow the person detached; there
  // is no half to put back, and the shape is left as they left it.
  const detached = await harness.service.commitScene(
    {
      ...ref,
      baseRevision: 2,
      elements: [
        element('box', { version: 40, x: 900, boundElements: [] }),
        element('arrow', { type: 'arrow', version: 40, startBinding: null }),
      ],
      appState: {},
      files: {},
    },
    3,
  )
  assert.ok(detached.ok)
  assert.deepEqual(
    sceneOnDisk(harness).find((item) => item.id === 'box')?.boundElements,
    [],
    'detaching an arrow is a decision, not a half-binding to repair',
  )
  console.log('ok - a binding split across two writers is made whole rather than left one-way')
}

async function assertHousekeeping(): Promise<void> {
  const harness = createHarness()
  await harness.fs.mkdir(`${ROOT}/diagrams`)
  await harness.fs.writeFile(`${ROOT}/diagrams/canvas.excalidraw.old-crash.tmp`, 'half a scene')
  await harness.fs.writeFile(`${ROOT}/diagrams/canvas.excalidraw.in-flight.tmp`, 'half a scene')
  await harness.fs.writeFile(`${ROOT}/diagrams/notes.txt`, 'not ours')
  // The clock moves past the stale threshold; the second temp file is written
  // again so it is the age of a write actually in flight.
  harness.advance(10 * 60 * 1000)
  await harness.fs.writeFile(`${ROOT}/diagrams/canvas.excalidraw.in-flight.tmp`, 'half a scene')

  await harness.service.readBoard(ref, { create: true })
  assert.equal(harness.fs.files.has(`${ROOT}/diagrams/canvas.excalidraw.old-crash.tmp`), false, 'the stale temp is swept')
  assert.ok(harness.fs.files.has(`${ROOT}/diagrams/canvas.excalidraw.in-flight.tmp`), 'a write in flight is left alone')
  assert.ok(harness.fs.files.has(`${ROOT}/diagrams/notes.txt`), 'and nothing else in the folder is touched')

  // Read snapshots are per reader and unbounded in principle; the oldest goes.
  for (let reader = 0; reader < 20; reader += 1) {
    harness.service.changesSinceLastRead(ref, `reader-${reader}`)
  }
  await harness.service.commitScene(
    { ...ref, baseRevision: 0, elements: [element('a')], appState: {}, files: {} },
    1,
  )
  assert.deepEqual(
    harness.service.changesSinceLastRead(ref, 'reader-0'),
    [],
    'the oldest reader was forgotten, so its next look is a first look',
  )
  assert.deepEqual(
    harness.service.changesSinceLastRead(ref, 'reader-19'),
    ['Added rectangle a at (0,0)'],
    'and the newest readers still get their diff',
  )
  console.log('ok - stale temp files are swept and a board does not remember every reader that ever asked')
}

async function assertFontWarningReachesEveryWrite(): Promise<void> {
  const harness = createHarness()
  harness.worker.setFontReport({ loaded: ['Nunito'], missing: ['Excalifont'], errors: ['it did not load'] })
  await harness.service.readBoard(ref, { create: true })

  harness.worker.answer(() => ({
    ok: true,
    value: {
      kind: 'apply-edit',
      requestId: 'r',
      ok: true,
      elements: [element('a')],
      changed: ['a'],
      files: {},
      result: { created: ['a'], updated: [], deleted: [], tempIds: {}, warnings: [] },
    },
  }))
  const edited = await harness.service.edit(
    ref,
    { create: [{ type: 'rectangle', x: 0, y: 0, text: 'hello' }] },
    { kind: 'agent', workspaceId: WORKSPACE },
  )
  assert.ok(edited.ok)
  assert.ok(
    edited.value.result.warnings.some((warning) => /fallback font/.test(warning) && /Excalifont/.test(warning)),
    'an edit says the text was measured in the wrong face, and which face is missing',
  )

  harness.worker.answer(() => ({
    ok: true,
    value: { kind: 'layout', requestId: 'r', ok: true, elements: [element('a', { version: 2 })], changed: ['a'] },
  }))
  const laid = await harness.service.layout(
    ref,
    { op: 'align', elementIds: ['a'], to: 'left' },
    { kind: 'agent', workspaceId: WORKSPACE },
  )
  assert.ok(laid.ok)
  assert.ok(laid.value.warnings.some((warning) => /fallback font/.test(warning)), 'and so does a layout')

  // A worker with every family loaded says nothing.
  harness.worker.setFontReport({ loaded: ['Excalifont', 'Nunito'], missing: [], errors: [] })
  harness.worker.answer(() => ({
    ok: true,
    value: {
      kind: 'apply-edit',
      requestId: 'r',
      ok: true,
      elements: [element('a', { version: 3 })],
      changed: ['a'],
      files: {},
      result: { created: [], updated: ['a'], deleted: [], tempIds: {}, warnings: [] },
    },
  }))
  const clean = await harness.service.edit(
    ref,
    { update: [{ id: 'a', set: { x: 10 } }] },
    { kind: 'agent', workspaceId: WORKSPACE },
  )
  assert.ok(clean.ok)
  assert.deepEqual(clean.value.result.warnings, [], 'a worker with its fonts is silent about them')
  console.log('ok - a board measured in a fallback font says so on every write')
}

async function assertCaseFoldedBoards(): Promise<void> {
  const upper = { workspaceId: WORKSPACE, path: 'diagrams/Arch.excalidraw' }
  const lower = { workspaceId: WORKSPACE, path: 'diagrams/arch.excalidraw' }

  {
    const harness = createHarness({ platform: 'darwin' })
    const created = await harness.service.readBoard(upper, { create: true })
    assert.ok(created.ok)
    await harness.service.commitScene(
      { ...upper, baseRevision: 0, elements: [element('a')], appState: {}, files: {} },
      1,
    )
    const again = await harness.service.readBoard(lower)
    assert.ok(again.ok, 'the other spelling opens the board that exists')
    assert.equal(again.value.path, 'diagrams/Arch.excalidraw', 'and keeps the spelling the file has')
    assert.equal(again.value.elements.length, 1, 'it is the same board, not a fresh one')
    assert.equal([...harness.fs.files.keys()].filter((name) => name.endsWith('.excalidraw')).length, 1)
  }

  {
    // The file is already on disk under one spelling; the caller names another.
    const harness = createHarness({ platform: 'darwin' })
    await harness.fs.mkdir(`${ROOT}/diagrams`)
    await harness.fs.writeFile(
      `${ROOT}/diagrams/Arch.excalidraw`,
      JSON.stringify({ type: 'excalidraw', version: 2, source: 'git', elements: [element('a')], appState: {}, files: {} }),
    )
    const read = await harness.service.readBoard(lower)
    assert.ok(read.ok, 'the board on disk is found under the other spelling')
    assert.equal(read.value.path, 'diagrams/Arch.excalidraw')
    await harness.service.commitScene(
      { ...lower, baseRevision: 0, elements: [element('a', { version: 2 })], appState: {}, files: {} },
      1,
    )
    assert.deepEqual(
      [...harness.fs.files.keys()].filter((name) => name.endsWith('.excalidraw')),
      [`${ROOT}/diagrams/Arch.excalidraw`],
      'the write lands on the file that was there, under the name it had',
    )
  }

  {
    const harness = createHarness({ platform: 'linux' })
    await harness.service.readBoard(upper, { create: true })
    await harness.service.readBoard(lower, { create: true })
    assert.equal(
      [...harness.fs.files.keys()].filter((name) => name.endsWith('.excalidraw')).length,
      2,
      'where case counts, two spellings really are two boards',
    )
  }
  console.log('ok - two spellings of one board path are one board wherever the filesystem says so')
}

async function assertListBoards(): Promise<void> {
  const harness = createHarness()
  harness.fs.files.set(`${ROOT}/diagrams/one.excalidraw`, JSON.stringify({ type: 'excalidraw', elements: [element('a'), element('b')] }))
  harness.fs.files.set(`${ROOT}/docs/two.excalidraw`, JSON.stringify({ type: 'excalidraw', elements: [] }))
  harness.fs.files.set(`${ROOT}/node_modules/pkg/three.excalidraw`, '{}')
  harness.fs.files.set(`${ROOT}/.git/four.excalidraw`, '{}')
  harness.fs.files.set(`${ROOT}/docs/notes.md`, '# not a board')
  await harness.fs.mkdir(`${ROOT}/diagrams`)
  await harness.fs.mkdir(`${ROOT}/docs`)
  await harness.fs.mkdir(`${ROOT}/node_modules/pkg`)
  await harness.fs.mkdir(`${ROOT}/.git`)

  const listed = await harness.service.listBoards(WORKSPACE)
  assert.ok(listed.ok)
  assert.deepEqual(listed.value.map((board) => board.path), ['diagrams/one.excalidraw', 'docs/two.excalidraw'])
  assert.equal(listed.value[0].name, 'one')
  assert.equal(listed.value[0].elementCount, 2)

  const nowhere = await harness.service.listBoards('nobody')
  assert.equal(nowhere.ok === false && nowhere.error.code, 'unknown_workspace')
  console.log('ok - listing a project finds its boards and skips the folders nobody draws in')
}

async function assertPresenceAndDispose(): Promise<void> {
  const harness = createHarness()
  await harness.service.readBoard(ref, { create: true })
  await harness.service.openBoard(ref, { subscriberId: 1 })
  await harness.service.openBoard(ref, { subscriberId: 2 })
  harness.pushes.length = 0

  harness.service.noteHumanInput(ref, 1)
  const presence = harness.pushes.filter((push) => push.channel === 'canvas:presence')
  assert.equal(presence.length, 1, 'the window that is being drawn on is not told about itself')
  assert.equal(presence[0].to, 2)
  assert.equal(presence[0].payload.controller, 'human')

  assert.equal(harness.watcherCount(), 1, 'an open board is watched')
  await harness.service.dispose()
  assert.equal(harness.watcherCount(), 0, 'and its watcher is closed on shutdown')
  assert.equal(harness.worker.disposed(), true, 'the worker goes with it')

  const after = await harness.service.readBoard(ref)
  assert.equal(after.ok, false, 'a disposed service takes no more work')
  console.log('ok - the person taking the pen is mirrored to the other windows, and dispose lets go of everything')
}

async function assertSubscriberDropped(): Promise<void> {
  const harness = createHarness()
  await harness.service.readBoard(ref, { create: true })
  await harness.service.openBoard(ref, { subscriberId: 1 })
  await harness.service.openBoard(ref, { subscriberId: 2 })
  harness.service.dropSubscriber(2)
  harness.pushes.length = 0

  await harness.service.commitScene({ ...ref, baseRevision: 0, elements: [element('a')], appState: {}, files: {} }, 1)
  assert.equal(harness.pushes.length, 0, 'a window that went away is pushed nothing')

  // The last subscriber leaving eventually drops the board and its watcher.
  harness.service.closeBoard(ref, 1)
  harness.advance(10 * 60 * 1000 + 1)
  assert.equal(harness.watcherCount(), 0, 'an idle board with nobody watching is let go')
  console.log('ok - a closed window stops being pushed, and an idle board is dropped from memory')
}

function assertDiskMerge(): void {
  const local = [element('same', { version: 4 }), element('older', { version: 1 }), element('local-only', { version: 2 })]
  const disk = [element('same', { version: 4, x: 900 }), element('older', { version: 5, x: 50 }), element('disk-only')]
  const merged = mergeFromDisk(local, disk, 5_000)

  assert.equal(merged.find((item) => item.id === 'same')?.x, 900, 'an equal version goes to the disk')
  assert.equal(merged.find((item) => item.id === 'older')?.x, 50, 'and so does a higher one')
  const dropped = merged.find((item) => item.id === 'local-only')
  assert.equal(dropped?.isDeleted, true, 'an element the file no longer has is a deletion')
  assert.equal(dropped?.version, 3)
  assert.equal(dropped?.updated, 5_000)
  assert.ok(merged.some((item) => item.id === 'disk-only'))
  console.log('ok - a scene file is a complete scene, so absence from it merges as a deletion')
}

async function main(): Promise<void> {
  await assertReadCreateAndRefusals()
  await assertInvalidSceneIsNeverOverwritten()
  await assertEditPipeline()
  await assertHumanCommitEcho()
  await assertQueueOrdersAgentAndHuman()
  await assertRecomputeOnceThenInterrupted()
  await assertRepairedShapeCountsAsContested()
  await assertDiskChangesAndOwnWrites()
  await assertDiskChangeInsideTheDebounce()
  await assertUnparseableDiskStopsTheWrite()
  await assertReplaceImportTombstones()
  await assertScreenshotBudget()
  await assertChangesSinceLastRead()
  await assertAgentDoesNotSeeItsOwnEdits()
  await assertRequestOpen()
  await assertBindingPairsSurviveTheMerge()
  await assertHousekeeping()
  await assertFontWarningReachesEveryWrite()
  await assertCaseFoldedBoards()
  await assertListBoards()
  await assertPresenceAndDispose()
  await assertSubscriberDropped()
  assertDiskMerge()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
