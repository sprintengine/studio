import { beforeEach, expect, test, vi } from 'vitest'

import type { CanvasServiceInternal } from '../../../../main/canvas/canvas-service'

type PaneModule = typeof import('./webCanvasPane')
let pane: PaneModule

beforeEach(async () => {
  vi.resetModules()
  pane = await import('./webCanvasPane')
})

function fakeService() {
  const calls: unknown[][] = []
  const service = {
    listBoards: async (workspaceId: string) => (calls.push(['list', workspaceId]), { ok: true, value: [] }),
    openBoard: async (ref: unknown, opts: unknown) => (calls.push(['open', ref, opts]), { ok: true, value: {} }),
    closeBoard: (ref: unknown, id: number) => calls.push(['close', ref, id]),
    commitScene: async (input: unknown, id: number) => (calls.push(['commit', input, id]), { ok: true, value: {} }),
    noteHumanInput: (ref: unknown, id: number) => calls.push(['human', ref, id]),
  }
  return { service: service as unknown as CanvasServiceInternal, calls }
}

test("the pane speaks to the tab's own canvas service, as the tab's one subscriber", async () => {
  const api = pane.webCanvasPaneApi()
  const { service, calls } = fakeService()
  // A call made before the toolset starts waits for the service.
  const opening = api.canvasOpenBoard({ workspaceId: 'ws-1', path: 'boards/plan.excalidraw', create: true })
  pane.provideWebCanvasService(service)
  expect((await opening).ok).toBe(true)
  expect(calls[0]).toEqual([
    'open',
    { workspaceId: 'ws-1', path: 'boards/plan.excalidraw' },
    { create: true, subscriberId: 1 },
  ])
  await api.canvasCloseBoard({ workspaceId: 'ws-1', path: 'boards/plan.excalidraw' })
  expect(calls.at(-1)?.[0]).toBe('close')
})

test("what the pane sends is checked as the desktop's IPC checks it, before the service sees it", async () => {
  const api = pane.webCanvasPaneApi()
  const { service, calls } = fakeService()
  pane.provideWebCanvasService(service)
  const escaping = await api.canvasOpenBoard({ workspaceId: 'ws-1', path: '../../etc/passwd' })
  expect(escaping.ok).toBe(false)
  const shapeless = await api.canvasCommitScene({
    workspaceId: 'ws-1',
    path: 'boards/plan.excalidraw',
    baseRevision: 0,
    elements: [{ id: 'a' }] as never,
    appState: {},
    files: {},
  })
  expect(!shapeless.ok && shapeless.error.code).toBe('invalid_scene')
  expect(calls).toEqual([])
})

test("the service's pushes reach the pane's listeners, and only the tab's", () => {
  const api = pane.webCanvasPaneApi()
  const scenes: unknown[] = []
  const opens: unknown[] = []
  const stop = api.onCanvasScene((push) => scenes.push(push))
  api.onCanvasOpenRequest((ref) => opens.push(ref))
  pane.webCanvasPaneBus.sendTo(1, 'canvas:scene', { revision: 2 })
  pane.webCanvasPaneBus.sendTo(7, 'canvas:scene', { revision: 3 })
  pane.webCanvasPaneBus.broadcast('canvas:open-request', { workspaceId: 'ws-1', path: 'boards/plan.excalidraw' })
  stop()
  pane.webCanvasPaneBus.sendTo(1, 'canvas:scene', { revision: 4 })
  expect(scenes).toEqual([{ revision: 2 }])
  expect(opens).toEqual([{ workspaceId: 'ws-1', path: 'boards/plan.excalidraw' }])
})

test('a tab that runs no canvas service says so, and never waits for good', async () => {
  const api = pane.webCanvasPaneApi()
  pane.provideWebCanvasService(null)
  const listed = await api.canvasListBoards('ws-1')
  expect(!listed.ok && listed.error.code).toBe('forbidden')
  const exported = await api.canvasExportBoard({ workspaceId: 'ws-1', path: 'boards/plan.excalidraw' })
  expect(exported.ok).toBe(false)
})
