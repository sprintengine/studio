import { ipcRenderer, type IpcRendererEvent } from 'electron'

import type {
  CanvasBoardRef,
  CanvasBoardState,
  CanvasBoardSummary,
  CanvasElement,
  CanvasExportImages,
  CanvasExportResult,
  CanvasPresence,
  CanvasResult,
  CanvasScenePush,
} from '../../shared/canvas/types'
import type { CanvasWorkerReport, CanvasWorkerRequest, CanvasWorkerResponse } from '../../shared/canvas/worker-protocol'
import type { ElectronApi } from '../../shared/electron-api'

// The Canvas pane's passthrough. Two audiences share it: the workspace window's
// Canvas tab (the first ten members) and the hidden worker window (the last
// three). Main decides which is which by who sent the message — the worker's
// channels are ignored from anyone but the worker's own WebContents — so the
// surface being one object costs nothing.

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

export const canvasApi = {
  canvasListBoards: (workspaceId: string): Promise<CanvasResult<CanvasBoardSummary[]>> =>
    ipcRenderer.invoke('canvas:list-boards', workspaceId),
  canvasOpenBoard: (input: {
    workspaceId: string
    path: string
    create?: boolean
  }): Promise<CanvasResult<CanvasBoardState>> => ipcRenderer.invoke('canvas:open-board', input),
  canvasCloseBoard: (input: CanvasBoardRef): Promise<void> => ipcRenderer.invoke('canvas:close-board', input),
  canvasCommitScene: (
    input: CanvasBoardRef & {
      baseRevision: number
      elements: CanvasElement[]
      appState: Record<string, unknown>
      files: Record<string, unknown>
    },
  ): Promise<CanvasResult<{ revision: number; elements: CanvasElement[] | null }>> =>
    ipcRenderer.invoke('canvas:commit-scene', input),
  canvasExportBoard: (
    input: CanvasBoardRef & { defaultDirectory?: string; images?: CanvasExportImages },
  ): Promise<CanvasResult<CanvasExportResult>> => ipcRenderer.invoke('canvas:export-board', input),
  canvasRevealBoard: (input: CanvasBoardRef): Promise<CanvasResult<void>> =>
    ipcRenderer.invoke('canvas:reveal-board', input),
  // `send`, not `invoke`: the person has started drawing, and waiting for main
  // to answer that would put a round trip inside a pointer-down handler.
  canvasNoteHumanInput: (input: CanvasBoardRef): void => {
    ipcRenderer.send('canvas:note-human-input', input)
  },
  onCanvasScene: (cb: (push: CanvasScenePush) => void): (() => void) => subscribe('canvas:scene', cb),
  onCanvasPresence: (cb: (presence: CanvasBoardRef & CanvasPresence) => void): (() => void) =>
    subscribe('canvas:presence', cb),
  onCanvasOpenRequest: (cb: (ref: CanvasBoardRef) => void): (() => void) => subscribe('canvas:open-request', cb),
  canvasWorkerReady: (report: CanvasWorkerReport): void => {
    ipcRenderer.send('canvas-worker:ready', report)
  },
  onCanvasWorkerRequest: (cb: (request: CanvasWorkerRequest) => void): (() => void) =>
    subscribe('canvas-worker:request', cb),
  canvasWorkerRespond: (response: CanvasWorkerResponse): void => {
    ipcRenderer.send('canvas-worker:response', response)
  },
} satisfies Pick<
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
  | 'canvasWorkerReady'
  | 'onCanvasWorkerRequest'
  | 'canvasWorkerRespond'
>
