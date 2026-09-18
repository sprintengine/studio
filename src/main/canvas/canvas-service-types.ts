// The interface the canvas service and the canvas tools both code against.
//
// It lives in its own file, with no implementation behind it, so the tools can
// be built and tested against a stub: `createCanvasTools` takes a service, and a
// tool test that had to stand up a real fs watcher and a hidden window to assert
// on an error message would not be worth writing.

import type {
  CanvasActionEntry,
  CanvasBoardRef,
  CanvasBoardState,
  CanvasBoardSummary,
  CanvasEditRequest,
  CanvasEditResult,
  CanvasImage,
  CanvasImportRequest,
  CanvasLayoutRequest,
  CanvasResult,
} from '../../shared/canvas/types'

/** The closed set of failures a canvas call answers with, wherever it was raised. */
export type { CanvasErrorCode, CanvasError, CanvasResult } from '../../shared/canvas/types'

/**
 * Who asked. An agent's identity comes from the gateway connection, so the
 * action log and the presence badge can name it; a person's gesture arrives
 * through the pane and needs no identity beyond "not an agent" — that alone is
 * what makes an agent action in flight give way.
 */
export type CanvasActor =
  { kind: 'agent'; workspaceId: string; agentId?: string; agentName?: string } | { kind: 'human' }

/**
 * The key a board's "what changed since you last looked" is tracked against.
 *
 * It lives here, next to the interface, because BOTH sides have to spell it the
 * same way and they are in different files: the tools ask with it on every
 * describe, and the service writes a fresh snapshot under it after an agent's
 * own successful write — which is what stops an agent being told its own edits
 * were "changed by the person". Two spellings of this key is a bug with no
 * symptom until an agent reads back its own work, so there is one spelling.
 *
 * Scoped by workspace as well as agent: agent ids are handed out per connection
 * and nothing promises they are unique across two projects open at once.
 */
export function canvasReaderKey(workspaceId: string, agentId?: string | null): string {
  return `${workspaceId}\u0000${agentId || 'anonymous'}`
}

export interface CanvasService {
  listBoards(workspaceId: string): Promise<CanvasResult<CanvasBoardSummary[]>>
  readBoard(ref: CanvasBoardRef, opts?: { create?: boolean }): Promise<CanvasResult<CanvasBoardState>>
  edit(
    ref: CanvasBoardRef,
    edit: CanvasEditRequest,
    actor: CanvasActor,
  ): Promise<CanvasResult<{ state: CanvasBoardState; result: CanvasEditResult }>>
  /** `warnings` names what the operation could not arrange, and is empty when it arranged everything. */
  layout(
    ref: CanvasBoardRef,
    request: CanvasLayoutRequest,
    actor: CanvasActor,
  ): Promise<CanvasResult<{ state: CanvasBoardState; warnings: string[] }>>
  importContent(
    ref: CanvasBoardRef,
    request: CanvasImportRequest,
    actor: CanvasActor,
  ): Promise<CanvasResult<{ state: CanvasBoardState; result: CanvasEditResult }>>
  screenshot(
    ref: CanvasBoardRef,
    opts: { elementIds?: string[]; maxEdge?: number; background?: boolean; dark?: boolean },
  ): Promise<CanvasResult<CanvasImage>>
  /** Reveal the board's tab. `revealed: false` when no window shows the workspace. */
  requestOpen(ref: CanvasBoardRef): Promise<CanvasResult<{ revealed: boolean }>>
  /**
   * What the person changed on this board since `readerKey` last looked, and
   * marks it read. Synchronous and in-memory: it reads the snapshot the service
   * already holds, and an agent asks for it on every describe.
   */
  changesSinceLastRead(ref: CanvasBoardRef, readerKey: string): string[]
  /** The board's recent action log, newest last. */
  actions(ref: CanvasBoardRef): CanvasActionEntry[]
  dispose(): Promise<void>
}
