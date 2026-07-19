import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  ReviewChangeSetReadResult,
  ReviewIngestResult,
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
} satisfies Pick<ElectronApi, 'reviewDetectSource' | 'reviewIngestSource' | 'reviewReadChangeset'>
