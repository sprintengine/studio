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
  ReviewListResult,
  ReviewPostReviewInput,
  ReviewPostReviewResult,
  ReviewProbeResult,
  ReviewSourceInput,
  ReviewSourceProbe,
  ReviewStateReadResult,
  ReviewStateWriteResult,
  ReviewTarget,
} from '../../shared/electron-api'
import type { ReviewWorkspaceState } from '../../shared/review'

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
  reviewPostReview: (input: ReviewPostReviewInput): Promise<ReviewPostReviewResult> =>
    ipcRenderer.invoke('review:post-review', input),
  reviewReadState: (target: ReviewTarget): Promise<ReviewStateReadResult> =>
    ipcRenderer.invoke('review:read-state', target),
  reviewWriteState: (target: ReviewTarget, state: ReviewWorkspaceState): Promise<ReviewStateWriteResult> =>
    ipcRenderer.invoke('review:write-state', target, state),
  reviewList: (roots: string[]): Promise<ReviewListResult> => ipcRenderer.invoke('review:list', roots),
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
  | 'reviewPostReview'
  | 'reviewReadState'
  | 'reviewWriteState'
  | 'reviewList'
  | 'onReviewBriefRunEvent'
>
