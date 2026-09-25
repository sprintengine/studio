import { ipcRenderer, type IpcRendererEvent } from 'electron'

import {
  EDITOR_REVEAL_ACK_CHANNEL,
  EDITOR_REVEAL_CLAIM_CHANNEL,
  EDITOR_REVEAL_LIST_PENDING_CHANNEL,
  EDITOR_REVEAL_PENDING_CHANNEL,
  EDITOR_REVEAL_REQUEST_CHANNEL,
  EDITOR_STATE_QUERY_CHANNEL,
  EDITOR_STATE_REPLY_CHANNEL,
  type EditorRevealAck,
  type EditorRevealRequest,
  type EditorStateQuery,
  type EditorStateReply,
} from '../../shared/editor-reveal'
import type { ElectronApi } from '../../shared/electron-api'

// The editor reveal's window half (src/main/editor-reveal): requests in,
// answers out. Every answer is attributed by main to the window that sent it.

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

export const editorRevealApi = {
  onEditorRevealRequest: (cb: (request: EditorRevealRequest) => void): (() => void) =>
    subscribe(EDITOR_REVEAL_REQUEST_CHANNEL, cb),
  ackEditorReveal: (ack: EditorRevealAck): void => {
    ipcRenderer.send(EDITOR_REVEAL_ACK_CHANNEL, ack)
  },
  onEditorRevealPending: (cb: (payload: { workspaceIds: string[] }) => void): (() => void) =>
    subscribe(EDITOR_REVEAL_PENDING_CHANNEL, cb),
  editorRevealClaim: (workspaceId: string): Promise<EditorRevealRequest | null> =>
    ipcRenderer.invoke(EDITOR_REVEAL_CLAIM_CHANNEL, workspaceId),
  editorRevealListPending: (): Promise<string[]> => ipcRenderer.invoke(EDITOR_REVEAL_LIST_PENDING_CHANNEL),
  onEditorStateQuery: (cb: (query: EditorStateQuery) => void): (() => void) =>
    subscribe(EDITOR_STATE_QUERY_CHANNEL, cb),
  replyEditorState: (reply: EditorStateReply): void => {
    ipcRenderer.send(EDITOR_STATE_REPLY_CHANNEL, reply)
  },
} satisfies Pick<
  ElectronApi,
  | 'onEditorRevealRequest'
  | 'ackEditorReveal'
  | 'onEditorRevealPending'
  | 'editorRevealClaim'
  | 'editorRevealListPending'
  | 'onEditorStateQuery'
  | 'replyEditorState'
>
