import type { ReviewIngestResult, ReviewSourceInput } from '../../../../shared/electron-api'

export class ReviewControllerError extends Error {
  constructor(public readonly code: 'missing-folder' | 'ingest-failed', message?: string) {
    super(message ?? code)
    this.name = 'ReviewControllerError'
  }
}

export type ReviewIngestChangeInput = {
  folderPath: string
  source: ReviewSourceInput
}

export type ReviewIngestChangePorts = {
  ingestSource: (
    input: ReviewSourceInput,
    target: { workspaceRoot: string; workspaceId: string },
  ) => Promise<ReviewIngestResult>
}

// Ingest a change into a brand-new review WITHOUT minting a workspace (MC-1708).
// Reviews are instance-level disk objects now, so the Reviews surface's "Review a
// change" entry (T6) needs to create one from a source (PR URL / branch / patch)
// and land on it by review id — no `review` workspace row involved. This mints a
// fresh review id (the key for `<folderPath>/.multi-code/review/<reviewId>/`,
// matching the id constraint the change-set service enforces) and ingests the
// source into it. On failure nothing is persisted for that id (ingest writes the
// change set as its last step), so a failed ingest leaves no orphan review dir.
export async function ingestReviewChange(
  input: ReviewIngestChangeInput,
  ports: ReviewIngestChangePorts,
): Promise<string> {
  const reviewId = `rv_${crypto.randomUUID()}`
  let result: ReviewIngestResult
  try {
    result = await ports.ingestSource(input.source, { workspaceRoot: input.folderPath, workspaceId: reviewId })
  } catch (error) {
    throw new ReviewControllerError('ingest-failed', error instanceof Error ? error.message : String(error))
  }
  if (!result.ok) throw new ReviewControllerError('ingest-failed', result.error)
  return reviewId
}
