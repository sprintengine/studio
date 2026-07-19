import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ElectronApi,
  ReviewAskGuideInput,
  ReviewAskGuideResult,
  ReviewBriefReadResult,
  ReviewBriefRunEvent,
  ReviewBriefRunInput,
  ReviewBriefRunResult,
  ReviewChangeSetReadResult,
  ReviewIngestResult,
  ReviewProbeResult,
  ReviewSourceInput,
  ReviewSourceProbe,
  ReviewTarget,
} from '../../shared/electron-api'

export const reviewApi = {
  reviewDetectSource: (input: ReviewSourceInput): Promise<ReviewSourceProbe> =>
    ipcRenderer.invoke('review:detect-source', input),
  reviewIngestSource: (input: ReviewSourceInput, target: ReviewTarget): Promise<ReviewIngestResult> =>
    ipcRenderer.invoke('review:ingest-source', input, target),
  reviewReadChangeset: (target: ReviewTarget): Promise<ReviewChangeSetReadResult> =>
    ipcRenderer.invoke('review:read-changeset', target),
  reviewReadBrief: (target: ReviewTarget): Promise<ReviewBriefReadResult> =>
    ipcRenderer.invoke('review:read-brief', target),
  reviewProbeChangeset: (input: ReviewSourceInput): Promise<ReviewProbeResult> =>
    ipcRenderer.invoke('review:probe-changeset', input),
  reviewStartBriefRun: (input: ReviewBriefRunInput): Promise<ReviewBriefRunResult> =>
    ipcRenderer.invoke('review:start-brief-run', input),
  reviewAskGuide: (input: ReviewAskGuideInput): Promise<ReviewAskGuideResult> =>
    ipcRenderer.invoke('review:ask-guide', input),
  onReviewBriefRunEvent: (cb: (event: ReviewBriefRunEvent) => void) => {
    const handler = (_: IpcRendererEvent, event: ReviewBriefRunEvent) => cb(event)
    ipcRenderer.on('review:brief-run-event', handler)
    return () => ipcRenderer.removeListener('review:brief-run-event', handler)
  },
} satisfies Pick<
  ElectronApi,
  | 'reviewDetectSource'
  | 'reviewIngestSource'
  | 'reviewReadChangeset'
  | 'reviewReadBrief'
  | 'reviewProbeChangeset'
  | 'reviewStartBriefRun'
  | 'reviewAskGuide'
  | 'onReviewBriefRunEvent'
>
