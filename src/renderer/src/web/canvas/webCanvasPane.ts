import { canvasCommitOf, canvasRefOf } from '../../../../shared/canvas/commit-checks'
import type { CanvasServiceInternal } from '../../../../main/canvas/canvas-service'
import { canvasFail, type CanvasResult } from '../../../../shared/canvas/types'
import type { ElectronApi } from '../../../../shared/electron-api'

// A web tab's Canvas pane (phase 9 spec, 3.8 and 14.16). On the desktop the
// pane speaks to the canvas service in the shell over `canvas:*` IPC; a tab
// already runs that same service in the page for the `canvas` toolset it
// offers, over the server's `files.*`, so the pane speaks to it directly. The
// checks the desktop's IPC makes on what the pane sends are made here by the
// same functions, and the service's pushes (scenes, presence, an agent's
// `canvas.open`) reach the pane's listeners in the page.
//
// The service exists once the toolset has started, after the app loads; a
// call before then waits for it. A tab that does not run the service (not an
// owner's, or a server without board files) answers that it has no canvas.
//
// This module is small on purpose: it is part of the tab's `window.api`, which
// loads before the app, and the service itself loads later with the toolset.

/** The tab is one window, so it is the service's one subscriber. */
const TAB_SUBSCRIBER = 1
const UNAVAILABLE = 'The canvas is not available in this browser tab: Studio did not start it for this session.'

type Listener = (payload: unknown) => void
const listeners = new Map<string, Set<Listener>>()

let provide: (service: CanvasServiceInternal | null) => void = () => undefined
let provided = false
const ready = new Promise<CanvasServiceInternal | null>((resolve) => {
  provide = resolve
})

/** Hand the pane the service the toolset runs, or null when there is none. The first answer stands. */
export function provideWebCanvasService(service: CanvasServiceInternal | null): void {
  if (provided) return
  provided = true
  provide(service)
}

function emit(channel: string, payload: unknown): void {
  for (const listener of [...(listeners.get(channel) ?? [])]) listener(payload)
}

/** Where the service's pushes go in a tab: the pane's own listeners. */
export const webCanvasPaneBus = {
  broadcast: (channel: string, payload: unknown): void => emit(channel, payload),
  sendTo: (subscriberId: number, channel: string, payload: unknown): void => {
    if (subscriberId === TAB_SUBSCRIBER) emit(channel, payload)
  },
}

function listen<T>(channel: string, callback: (payload: T) => void): () => void {
  let set = listeners.get(channel)
  if (!set) listeners.set(channel, (set = new Set()))
  const listener: Listener = (payload) => callback(payload as T)
  set.add(listener)
  return () => set.delete(listener)
}

async function withService<T>(run: (service: CanvasServiceInternal) => Promise<CanvasResult<T>> | CanvasResult<T>) {
  const service = await ready
  return service ? run(service) : canvasFail<T>('forbidden', UNAVAILABLE)
}

type CanvasPaneApi = Pick<
  ElectronApi,
  | 'canvasListBoards'
  | 'canvasOpenBoard'
  | 'canvasCloseBoard'
  | 'canvasCommitScene'
  | 'canvasExportBoard'
  | 'canvasRevealBoard'
  | 'canvasNoteHumanInput'
  | 'onCanvasScene'
  | 'onCanvasPresence'
  | 'onCanvasOpenRequest'
>

export function webCanvasPaneApi(): CanvasPaneApi {
  return {
    canvasListBoards: (workspaceId) =>
      withService((service) =>
        typeof workspaceId === 'string' && workspaceId.trim()
          ? service.listBoards(workspaceId.trim())
          : canvasFail('no_workspace', 'This call named no workspace.'),
      ),
    canvasOpenBoard: (input) =>
      withService((service) => {
        const ref = canvasRefOf(input)
        if (!ref.ok) return ref
        return service.openBoard(ref.value, { create: input.create === true, subscriberId: TAB_SUBSCRIBER })
      }),
    canvasCloseBoard: async (input) => {
      const service = await ready
      const ref = canvasRefOf(input)
      if (service && ref.ok) service.closeBoard(ref.value, TAB_SUBSCRIBER)
    },
    canvasCommitScene: (input) =>
      withService((service) => {
        const commit = canvasCommitOf(input)
        if (!commit.ok) return commit
        return service.commitScene(commit.value, TAB_SUBSCRIBER)
      }),
    // A folder on the server is not the person's to pick from a browser, and
    // the person's own disk is the browser's download; neither is built yet.
    canvasExportBoard: async () =>
      canvasFail('forbidden', 'Exporting a board to a folder is not available in a browser tab yet.'),
    canvasRevealBoard: async () =>
      canvasFail('forbidden', 'A browser cannot show a file on the server in a file manager.'),
    canvasNoteHumanInput: (input) => {
      void ready.then((service) => {
        const ref = canvasRefOf(input)
        if (service && ref.ok) service.noteHumanInput(ref.value, TAB_SUBSCRIBER)
      })
    },
    onCanvasScene: (callback) => listen('canvas:scene', callback),
    onCanvasPresence: (callback) => listen('canvas:presence', callback),
    onCanvasOpenRequest: (callback) => listen('canvas:open-request', callback),
  }
}
