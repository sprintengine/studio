import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'

import {
  EDITOR_REVEAL_ACK_CHANNEL,
  EDITOR_REVEAL_CLAIM_CHANNEL,
  EDITOR_REVEAL_LIST_PENDING_CHANNEL,
  EDITOR_STATE_REPLY_CHANNEL,
  type EditorRevealRequest,
} from '../../shared/editor-reveal'
import type { EditorRevealBroker } from '../editor-reveal/editor-reveal-broker'

/**
 * The windows' half of the editor reveal (`editor-reveal-broker.ts`).
 *
 * Every answer is attributed to the WebContents that sent it, resolved here
 * rather than read from the message, so one window cannot answer for another.
 * Only workspace windows are heard: an aux window never shows a workspace.
 */
export function registerEditorRevealIpc(
  ipcMain: IpcMain,
  broker: EditorRevealBroker,
  options: { senderId: (event: IpcMainEvent | IpcMainInvokeEvent) => unknown | null },
): void {
  ipcMain.on(EDITOR_REVEAL_ACK_CHANNEL, (event, payload: unknown) => {
    const from = options.senderId(event)
    if (from !== null) broker.handleAck(from, payload)
  })
  ipcMain.on(EDITOR_STATE_REPLY_CHANNEL, (event, payload: unknown) => {
    const from = options.senderId(event)
    if (from !== null) broker.handleStateReply(from, payload)
  })
  ipcMain.handle(EDITOR_REVEAL_CLAIM_CHANNEL, (event, workspaceId: unknown): EditorRevealRequest | null => {
    if (options.senderId(event) === null) return null
    if (typeof workspaceId !== 'string' || !workspaceId) return null
    return broker.claimPending(workspaceId)
  })
  ipcMain.handle(EDITOR_REVEAL_LIST_PENDING_CHANNEL, (event): string[] =>
    options.senderId(event) === null ? [] : broker.pendingWorkspaceIds(),
  )
}
