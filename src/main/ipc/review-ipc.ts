// Review ingestion IPC. Registered by the `review` capability module (MC-1677),
// which owns the ReviewChangeSetService lifecycle and passes it in here. The
// renderer reaches these handlers only through the preload bridge
// (src/preload/api/review.ts) — never generic file IPC.

import { readFile } from 'fs/promises'
import { join } from 'path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type {
  ReviewAskGuideInput,
  ReviewAskGuideResult,
  ReviewBriefReadResult,
  ReviewBriefRunInput,
  ReviewBriefRunResult,
  ReviewChangeSetReadResult,
  ReviewIngestResult,
  ReviewPostReviewInput,
  ReviewPostReviewResult,
  ReviewProbeResult,
  ReviewSourceInput,
  ReviewSourceProbe,
  ReviewTarget,
} from '../../shared/electron-api'
import { validateReviewBrief } from '../../shared/review'
import { ReviewChangeSetService, reviewChangeSetDir } from '../review/changeset-service'
import type { ReviewBriefRunService } from '../review/brief-run-service'
// Side-effect import: registers the 'pull-request' source provider (MC-1678) so
// the service can ingest GitHub PR URLs. The local branch/patch providers register
// from within changeset-service itself.
import '../review/providers/github-pr-provider'
import {
  defaultReviewSyncDeps,
  postReview,
  type GithubReviewSyncDeps,
} from '../review/providers/github-review-sync'

const BRIEF_FILE = 'brief.json'

export interface ReviewIpcDeps {
  changeSetService: ReviewChangeSetService
  briefRunService: Pick<ReviewBriefRunService, 'start' | 'ask'>
  // Gate for outward, human-initiated actions: true only when the invocation came
  // from a real application window. Posting a review is human-outward, so it is
  // refused unless this passes. The module wires a window-sender check; it is
  // injected (rather than importing BrowserWindow here) so this module stays free
  // of an Electron runtime import and the handler is unit-testable. A run that
  // omits it fails closed — the action is refused.
  isUserWindowSender?: (event: IpcMainInvokeEvent) => boolean
  // The GitHub transport postReview uses; injected so tests drive it with a stub.
  reviewSyncDeps?: GithubReviewSyncDeps
}

// Read and validate the guide's brief for a workspace. A missing file is the
// honest "no walkthrough yet" state (brief: null); a present-but-invalid file
// comes back as an error so the panel shows a failure instead of a blank pane.
async function readBrief(targetDir: string): Promise<ReviewBriefReadResult> {
  let raw: string
  try {
    raw = await readFile(join(targetDir, BRIEF_FILE), 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, brief: null }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, error: `brief.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  const validation = validateReviewBrief(parsed)
  if (!validation.ok) return { ok: false, error: validation.errors.join('\n') }
  return { ok: true, brief: validation.value }
}

export function registerReviewIpc(
  ipcMain: IpcMain,
  { changeSetService, briefRunService, isUserWindowSender, reviewSyncDeps }: ReviewIpcDeps
): void {
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

  ipcMain.handle('review:read-brief', async (_event, target: ReviewTarget): Promise<ReviewBriefReadResult> => {
    try {
      return await readBrief(reviewChangeSetDir(target.workspaceRoot, target.workspaceId))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Freshness probe (MC-1682): rebuild the current change set without persisting
  // it, so the panel can detect that the reviewed head moved and which steps that
  // affects, without disturbing the change set the current walkthrough walks.
  ipcMain.handle('review:probe-changeset', async (_event, input: ReviewSourceInput): Promise<ReviewProbeResult> => {
    try {
      return { ok: true, changeset: await changeSetService.build(input) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Start (or restart) the guide run for a workspace. The service enforces one
  // live run per workspace and forwards phase events over BRIEF_RUN_EVENT_CHANNEL;
  // this handler returns only the terminal result — the renderer re-reads the
  // brief on success.
  ipcMain.handle('review:start-brief-run', async (_event, input: ReviewBriefRunInput): Promise<ReviewBriefRunResult> => {
    const result = await briefRunService.start(input)
    if (result.ok) return { ok: true }
    return { ok: false, reason: result.reason, errors: result.errors }
  })

  // Ask-the-guide chat: forward one turn to the workspace's guide companion. The
  // reply streams back over the conversation event channel the chat pane already
  // subscribes to (onConversationEvent), so this handler returns only whether the
  // turn was accepted. The guide answers; it never creates or edits a comment.
  ipcMain.handle('review:ask-guide', async (_event, input: ReviewAskGuideInput): Promise<ReviewAskGuideResult> => {
    return briefRunService.ask(input)
  })

  // Post the pending review to the pull request (MC-1683). This is the ONLY entry
  // point to the write path — there is no programmatic caller — and it is
  // human-outward, so it is gated to a real application window's gesture. The guide
  // companion runs in the main process with no renderer, so it cannot reach an
  // ipcMain handler at all; the sender gate is defence-in-depth on top of that,
  // refusing any invocation that does not resolve to an application window.
  ipcMain.handle('review:post-review', async (event, input: ReviewPostReviewInput): Promise<ReviewPostReviewResult> => {
    if (!isUserWindowSender || !isUserWindowSender(event)) {
      return { ok: false, error: 'Posting a review must be initiated from the review window.' }
    }
    try {
      const read = await changeSetService.read(
        reviewChangeSetDir(input.target.workspaceRoot, input.target.workspaceId)
      )
      if (!read.ok) return { ok: false, error: read.error }
      if (!read.changeset) return { ok: false, error: 'There is no review to post yet.' }
      return await postReview(read.changeset, input.comments, reviewSyncDeps ?? defaultReviewSyncDeps())
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
