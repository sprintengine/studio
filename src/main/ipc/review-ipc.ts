// Review ingestion IPC. Registered by the `review` capability module (MC-1677),
// which owns the ReviewChangeSetService lifecycle and passes it in here. The
// renderer reaches these handlers only through the preload bridge
// (src/preload/api/review.ts) — never generic file IPC.

import type { IpcMain } from 'electron'
import type {
  ReviewChangeSetReadResult,
  ReviewIngestResult,
  ReviewSourceInput,
  ReviewSourceProbe,
  ReviewTarget,
} from '../../shared/electron-api'
import { ReviewChangeSetService, reviewChangeSetDir } from '../review/changeset-service'
// Side-effect import: registers the 'pull-request' source provider (MC-1678) so
// the service can ingest GitHub PR URLs. The local branch/patch providers register
// from within changeset-service itself.
import '../review/providers/github-pr-provider'

export interface ReviewIpcDeps {
  changeSetService: ReviewChangeSetService
}

export function registerReviewIpc(ipcMain: IpcMain, { changeSetService }: ReviewIpcDeps): void {
  ipcMain.handle('review:detect-source', (_event, input: ReviewSourceInput): Promise<ReviewSourceProbe> => {
    return changeSetService.detect(input)
  })

  ipcMain.handle(
    'review:ingest-source',
    async (_event, input: ReviewSourceInput, target: ReviewTarget): Promise<ReviewIngestResult> => {
      try {
        const changeset = await changeSetService.ingest(
          input,
          reviewChangeSetDir(target.workspaceRoot, target.workspaceId)
        )
        return { ok: true, changeset }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle('review:read-changeset', async (_event, target: ReviewTarget): Promise<ReviewChangeSetReadResult> => {
    try {
      return await changeSetService.read(reviewChangeSetDir(target.workspaceRoot, target.workspaceId))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
