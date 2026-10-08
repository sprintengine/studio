import { beforeEach, expect, test, vi } from 'vitest'

type FakeWindow = {
  name: string
  destroyed: boolean
  contentsDestroyed: boolean
  focused: boolean
  sent: unknown[][]
  isDestroyed(): boolean
  isFocused(): boolean
  webContents: { isDestroyed(): boolean; send(...args: unknown[]): void }
}

const state = vi.hoisted(() => ({ windows: [] as unknown[], canvasWorker: null as unknown }))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => state.windows } }))
vi.mock('./canvas/canvas-worker-window', () => ({ isCanvasWorkerWindow: (win: unknown) => win === state.canvasWorker }))

const { anyWindowFocused, broadcastToAllWindows } = await import('./window-broadcast')

function fakeWindow(name: string, patch: Partial<Pick<FakeWindow, 'destroyed' | 'contentsDestroyed' | 'focused'>> = {}) {
  const win: FakeWindow = {
    name,
    destroyed: false,
    contentsDestroyed: false,
    focused: false,
    ...patch,
    sent: [],
    isDestroyed: () => win.destroyed,
    isFocused: () => win.focused,
    webContents: {
      isDestroyed: () => win.contentsDestroyed,
      send: (...args) => void win.sent.push(args),
    },
  }
  return win
}

let live: FakeWindow
let closed: FakeWindow
let closing: FakeWindow
let worker: FakeWindow

beforeEach(() => {
  live = fakeWindow('live')
  closed = fakeWindow('closed', { destroyed: true })
  closing = fakeWindow('closing', { contentsDestroyed: true })
  worker = fakeWindow('worker')
  state.windows = [live, closed, closing, worker]
  state.canvasWorker = worker
})

test('a push reaches every live window, the canvas worker included by default', () => {
  broadcastToAllWindows('thing:changed', { id: 1 })
  expect(live.sent).toEqual([['thing:changed', { id: 1 }]])
  expect(worker.sent).toEqual([['thing:changed', { id: 1 }]])
  expect(closed.sent).toEqual([])
  expect(closing.sent).toEqual([])
})

test('skipCanvasWorker leaves the hidden worker out', () => {
  broadcastToAllWindows('thing:changed', null, { skipCanvasWorker: true })
  expect(live.sent).toHaveLength(1)
  expect(worker.sent).toEqual([])
})

test('the app is focused when a live window is, and the worker counts only when asked to', () => {
  expect(anyWindowFocused()).toBe(false)
  worker.focused = true
  expect(anyWindowFocused()).toBe(true)
  expect(anyWindowFocused({ skipCanvasWorker: true })).toBe(false)
  closed.focused = true
  expect(anyWindowFocused({ skipCanvasWorker: true })).toBe(false)
  live.focused = true
  expect(anyWindowFocused({ skipCanvasWorker: true })).toBe(true)
})
