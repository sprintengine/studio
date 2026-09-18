/**
 * The Canvas IPC boundary: what a renderer may say, and what the service is
 * spared.
 *
 * The service itself is a stub here — its behaviour is proved in
 * `canvas/canvas-service.test.ts`. What is proved here is that a malformed
 * payload is answered at the boundary and never becomes a write into somebody's
 * project.
 */
import assert from 'node:assert/strict'

import { registerCanvasIpc } from './canvas-ipc'
import type { CanvasServiceInternal } from '../canvas/canvas-service'
import type { CanvasSubscriberRegistry } from '../canvas/canvas-subscribers'
import { canvasOk } from '../../shared/canvas/types'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function createIpcMain(): {
  handlers: Map<string, Handler>
  listeners: Map<string, Handler>
  handle(channel: string, handler: Handler): void
  on(channel: string, handler: Handler): void
} {
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, Handler>()
  return {
    handlers,
    listeners,
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    on(channel, handler) {
      listeners.set(channel, handler)
    },
  }
}

type Recorded = { call: string; args: unknown[] }

function createService(): { service: CanvasServiceInternal; recorded: Recorded[] } {
  const recorded: Recorded[] = []
  const record =
    (call: string, answer: unknown) =>
    (...args: unknown[]): unknown => {
      recorded.push({ call, args })
      return answer
    }
  const service = {
    listBoards: record('listBoards', Promise.resolve(canvasOk([]))),
    openBoard: record(
      'openBoard',
      Promise.resolve(canvasOk({ path: 'diagrams/a.excalidraw', revision: 1, elements: [], appState: {}, files: {} })),
    ),
    closeBoard: record('closeBoard', undefined),
    commitScene: record('commitScene', Promise.resolve(canvasOk({ revision: 2, elements: null }))),
    noteHumanInput: record('noteHumanInput', undefined),
    dropSubscriber: record('dropSubscriber', undefined),
  } as unknown as CanvasServiceInternal
  return { service, recorded }
}

function createSubscribers(): {
  registry: CanvasSubscriberRegistry
  added: number[]
  gone: Array<(id: number) => void>
} {
  const added: number[] = []
  const gone: Array<(id: number) => void> = []
  const registry = {
    add: (contents: { id: number }) => {
      added.push(contents.id)
      return contents.id
    },
    sendTo: () => {},
    onGone: (listener: (id: number) => void) => {
      gone.push(listener)
      return () => {}
    },
    dispose: () => {},
  } as unknown as CanvasSubscriberRegistry
  return { registry, added, gone }
}

const sender = { id: 42 }
const event = { sender }

const goodRef = { workspaceId: 'workspace-1', path: 'diagrams/a.excalidraw' }

function element(id: string): Record<string, unknown> {
  return { id, type: 'rectangle', version: 1, versionNonce: 7 }
}

async function main(): Promise<void> {
  const ipcMain = createIpcMain()
  const { service, recorded } = createService()
  const subscribers = createSubscribers()
  registerCanvasIpc(ipcMain as unknown as Parameters<typeof registerCanvasIpc>[0], service, subscribers.registry)

  for (const channel of ['canvas:list-boards', 'canvas:open-board', 'canvas:close-board', 'canvas:commit-scene']) {
    assert.ok(ipcMain.handlers.has(channel), `${channel} is registered`)
  }
  assert.ok(ipcMain.listeners.has('canvas:note-human-input'), 'the human-input note is a send, not an invoke')
  console.log('ok - every canvas channel is registered, in the direction the preload speaks it')

  const listBoards = ipcMain.handlers.get('canvas:list-boards')!
  const noWorkspace = (await listBoards(event, 17)) as { ok: false; error: { code: string } }
  assert.equal(noWorkspace.ok, false)
  assert.equal(noWorkspace.error.code, 'no_workspace')
  assert.equal(recorded.length, 0, 'a listing with no workspace never reaches the service')
  await listBoards(event, '  workspace-1  ')
  assert.deepEqual(recorded.pop()?.args, ['workspace-1'], 'and a real one arrives trimmed')

  const openBoard = ipcMain.handlers.get('canvas:open-board')!
  const escape = (await openBoard(event, { workspaceId: 'workspace-1', path: '../../etc/passwd' })) as {
    ok: false
    error: { code: string }
  }
  assert.equal(escape.error.code, 'invalid_path')
  assert.equal(subscribers.added.length, 0, 'a refused open subscribes nobody')

  const wrongType = (await openBoard(event, { workspaceId: 'workspace-1', path: 'diagrams/a.png' })) as {
    ok: false
    error: { code: string }
  }
  assert.equal(wrongType.error.code, 'invalid_path', 'a board is a board file or it is nothing')

  await openBoard(event, { ...goodRef, create: true })
  assert.deepEqual(subscribers.added, [42], 'opening a board subscribes the window that asked')
  const opened = recorded.pop()
  assert.equal(opened?.call, 'openBoard')
  assert.deepEqual(opened?.args[1], { create: true, subscriberId: 42 })
  console.log('ok - opening a board normalizes its path, refuses an escape, and subscribes the sender')

  const commit = ipcMain.handlers.get('canvas:commit-scene')!
  const notAnArray = (await commit(event, { ...goodRef, baseRevision: 1, elements: 'everything' })) as {
    ok: false
    error: { code: string }
  }
  assert.equal(notAnArray.error.code, 'invalid_scene')

  const unmergeable = (await commit(event, {
    ...goodRef,
    baseRevision: 1,
    elements: [{ id: 'a', type: 'rectangle', version: 1 }],
  })) as { ok: false; error: { code: string; message: string } }
  assert.equal(unmergeable.error.code, 'invalid_scene')
  assert.match(unmergeable.error.message, /versionNonce/, 'the merge needs both tie-breaks, and says which is missing')

  const tooMany = (await commit(event, {
    ...goodRef,
    baseRevision: 1,
    elements: Array.from({ length: 20_001 }, (_item, index) => element(`e-${index}`)),
  })) as { ok: false; error: { code: string } }
  assert.equal(tooMany.error.code, 'too_large')
  assert.equal(recorded.length, 0, 'not one of those reached the service')

  const hugeImage = (await commit(event, {
    ...goodRef,
    baseRevision: 1,
    elements: [element('a')],
    files: { 'file-1': { dataURL: 'x'.repeat(16 * 1024 * 1024) } },
  })) as { ok: false; error: { code: string; message: string } }
  assert.equal(hugeImage.error.code, 'too_large')
  assert.match(hugeImage.error.message, /file-1/, 'the message names the image, not the elements')

  const tooManyImages = (await commit(event, {
    ...goodRef,
    baseRevision: 1,
    elements: [element('a')],
    files: Object.fromEntries(
      Array.from({ length: 4 }, (_item, index) => [`file-${index}`, { dataURL: 'x'.repeat(12 * 1024 * 1024) }]),
    ),
  })) as { ok: false; error: { code: string } }
  assert.equal(tooManyImages.error.code, 'too_large', 'and the blobs are capped in total as well as one by one')
  assert.equal(recorded.length, 0, 'not one of those reached the service')

  await commit(event, { ...goodRef, baseRevision: 3, elements: [element('a')], appState: 'nonsense', files: null })
  const committed = recorded.pop()
  assert.equal(committed?.call, 'commitScene')
  const input = committed?.args[0] as { appState: unknown; files: unknown; baseRevision: number }
  assert.deepEqual(input.appState, {}, 'a non-object appState becomes an empty one rather than being passed on')
  assert.deepEqual(input.files, {})
  assert.equal(input.baseRevision, 3)
  assert.equal(committed?.args[1], 42, 'the sender is named so it is not echoed its own scene')
  console.log('ok - a commit is checked for shape and for size before anything is written')

  const note = ipcMain.listeners.get('canvas:note-human-input')!
  note(event, { workspaceId: '', path: 'diagrams/a.excalidraw' })
  assert.equal(recorded.length, 0, 'a note with no workspace is dropped')
  note(event, goodRef)
  const noted = recorded.pop()
  assert.equal(noted?.call, 'noteHumanInput')
  assert.equal(noted?.args[1], 42)

  assert.equal(subscribers.gone.length, 1, 'the registry is asked to report windows that go away')
  subscribers.gone[0](99)
  assert.deepEqual(recorded.pop(), { call: 'dropSubscriber', args: [99] })
  console.log('ok - a window that goes away stops subscribing to every board it held')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
