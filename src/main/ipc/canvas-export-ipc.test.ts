/**
 * The export channel: the folder comes from the picker main shows, and never
 * from the payload.
 *
 * The service is a stub, as in `canvas-ipc.test.ts`; what an export writes is
 * proved in `canvas/canvas-storage.test.ts`.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { registerCanvasIpc, type CanvasIpcOptions } from './canvas-ipc'
import type { CanvasServiceInternal } from '../canvas/canvas-service'
import type { CanvasSubscriberRegistry } from '../canvas/canvas-subscribers'
import { canvasOk, type CanvasResult } from '../../shared/canvas/types'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const sender = { id: 42 }
const event = { sender }
const ref = { workspaceId: 'workspace-1', path: 'architecture' }

function setup(options: CanvasIpcOptions = {}): {
  exportBoard: Handler
  exports: unknown[][]
  pickerCalls: unknown[][]
} {
  const handlers = new Map<string, Handler>()
  const ipcMain = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    on: () => {},
  }
  const exports: unknown[][] = []
  const service = {
    exportBoard: async (...args: unknown[]) => {
      exports.push(args)
      return canvasOk({ directory: args[1], files: [`${String(args[1])}/architecture.excalidraw`] })
    },
    dropSubscriber: () => {},
  } as unknown as CanvasServiceInternal
  const subscribers = { add: () => 42, onGone: () => () => {} } as unknown as CanvasSubscriberRegistry
  const pickerCalls: unknown[][] = []
  const wrapped: CanvasIpcOptions = options.pickExportDirectory
    ? {
        pickExportDirectory: async (from, defaultPath) => {
          pickerCalls.push([from, defaultPath])
          return options.pickExportDirectory!(from, defaultPath)
        },
      }
    : {}
  registerCanvasIpc(ipcMain as unknown as Parameters<typeof registerCanvasIpc>[0], service, subscribers, wrapped)
  return { exportBoard: handlers.get('canvas:export-board')!, exports, pickerCalls }
}

test('the export writes into the folder the picker answered, whatever the payload names', async () => {
  const { exportBoard, exports, pickerCalls } = setup({ pickExportDirectory: async () => '/Users/dev/project/docs' })
  const result = (await exportBoard(event, {
    ...ref,
    defaultDirectory: '/Users/dev/project',
    directory: '/etc',
    images: { png: 'iVBORw0KGgo=', svg: '<svg></svg>', gif: 'nope' },
  })) as CanvasResult<{ cancelled: boolean; directory: string; files: string[] }>

  assert.deepEqual(pickerCalls, [[sender, '/Users/dev/project']], 'the picker opens at the suggested folder')
  assert.equal(exports.length, 1)
  const [boardRef, directory, images] = exports[0]
  assert.deepEqual(boardRef, { workspaceId: 'workspace-1', path: '.sprintengine/canvas/architecture.excalidraw' })
  assert.equal(directory, '/Users/dev/project/docs', 'a `directory` in the payload is ignored')
  assert.deepEqual(images, { png: 'iVBORw0KGgo=', svg: '<svg></svg>' }, 'only the two picture kinds pass')
  assert.deepEqual(result, {
    ok: true,
    value: {
      cancelled: false,
      directory: '/Users/dev/project/docs',
      files: ['/Users/dev/project/docs/architecture.excalidraw'],
    },
  })
})

test('a dismissed picker is an answer, and nothing is written', async () => {
  const { exportBoard, exports } = setup({ pickExportDirectory: async () => null })
  assert.deepEqual(await exportBoard(event, ref), { ok: true, value: { cancelled: true } })
  assert.equal(exports.length, 0)
})

test('a bad board path is refused before any picker is shown', async () => {
  const { exportBoard, pickerCalls, exports } = setup({ pickExportDirectory: async () => '/Users/dev/out' })
  const refused = (await exportBoard(event, { workspaceId: 'workspace-1', path: '../escape' })) as CanvasResult<never>
  assert.equal(!refused.ok && refused.error.code, 'invalid_path')
  assert.equal(pickerCalls.length, 0)
  assert.equal(exports.length, 0)
})

test('without a picker there is no export at all', async () => {
  const { exportBoard, exports } = setup()
  const refused = (await exportBoard(event, ref)) as CanvasResult<never>
  assert.equal(!refused.ok && refused.error.code, 'forbidden')
  assert.equal(exports.length, 0)
})

test('a picker that throws is reported, not raised', async () => {
  const { exportBoard, exports } = setup({
    pickExportDirectory: async () => {
      throw new Error('no window')
    },
  })
  const refused = (await exportBoard(event, ref)) as CanvasResult<never>
  assert.equal(!refused.ok && refused.error.code, 'forbidden')
  assert.match(!refused.ok ? refused.error.message : '', /no window/)
  assert.equal(exports.length, 0)
})
