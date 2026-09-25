import { ipcRenderer, type IpcRendererEvent } from 'electron'

import type { ElectronApi } from '../../shared/electron-api'
import type {
  LiveTour,
  TourAsk,
  TourChangedEvent,
  TourGotoAnswer,
  TourGotoRequest,
  TourPlayback,
  TourResult,
  TourRevealRequest,
  TourSummary,
} from '../../shared/tours/tour-types'

// Diff tours' passthrough: the Diff viewer reads and plays a tour, reports what
// it is showing, and sends the owner's questions; the workspace window docks a
// tour's tab when main asks.

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

export const toursApi = {
  tourList: (workspaceId: string): Promise<TourSummary[]> => ipcRenderer.invoke('tours:list', workspaceId),
  tourRead: (workspaceId: string, tourId: string): Promise<TourResult<LiveTour>> =>
    ipcRenderer.invoke('tours:read', workspaceId, tourId),
  tourReportPlayback: (workspaceId: string, tourId: string, playback: TourPlayback): Promise<void> =>
    ipcRenderer.invoke('tours:playback', workspaceId, tourId, playback),
  tourAsk: (
    workspaceId: string,
    tourId: string,
    stepId: string,
    question: string,
  ): Promise<TourResult<TourAsk> & { authorGone?: boolean }> =>
    ipcRenderer.invoke('tours:ask', workspaceId, tourId, stepId, question),
  tourCancelAsk: (workspaceId: string, tourId: string, askId: string): Promise<void> =>
    ipcRenderer.invoke('tours:cancel-ask', workspaceId, tourId, askId),
  tourAskNewAgent: (
    workspaceId: string,
    tourId: string,
    stepId: string,
    question: string,
  ): Promise<TourResult<{ agentId: string }>> =>
    ipcRenderer.invoke('tours:ask-new-agent', workspaceId, tourId, stepId, question),
  tourAcknowledgeReveal: (requestId: string): void => {
    ipcRenderer.send('tours:reveal-ack', requestId)
  },
  tourAnswerGoto: (answer: TourGotoAnswer): void => {
    ipcRenderer.send('tours:goto-answer', answer)
  },
  onTourChanged: (cb: (event: TourChangedEvent) => void): (() => void) => subscribe('tours:changed', cb),
  onTourRevealRequest: (cb: (request: TourRevealRequest) => void): (() => void) =>
    subscribe('tours:reveal-request', cb),
  onTourGotoRequest: (cb: (request: TourGotoRequest) => void): (() => void) => subscribe('tours:goto-request', cb),
} satisfies Pick<
  ElectronApi,
  | 'tourList'
  | 'tourRead'
  | 'tourReportPlayback'
  | 'tourAsk'
  | 'tourCancelAsk'
  | 'tourAskNewAgent'
  | 'tourAcknowledgeReveal'
  | 'tourAnswerGoto'
  | 'onTourChanged'
  | 'onTourRevealRequest'
  | 'onTourGotoRequest'
>
