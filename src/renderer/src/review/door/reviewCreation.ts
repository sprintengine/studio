import type { ReviewGuideConfig, WorkspaceId } from '../../types/workspace'
import type { ReviewIngestResult, ReviewSourceInput } from '../../../../shared/electron-api'

export type ReviewControllerInput = {
  name: string
  folderPath: string | null
  source: ReviewSourceInput
  guideConfig: ReviewGuideConfig
}

export type ReviewControllerPorts = {
  // Creates the `review` workspace and returns its id (the id the change set is
  // stored under). The panel wires this to the store's addWorkspace with the
  // review template + mode + guide config.
  addReviewWorkspace: (args: { name: string; folderPath: string; guideConfig: ReviewGuideConfig }) => WorkspaceId
  removeWorkspace: (id: WorkspaceId) => void
  ingestSource: (
    input: ReviewSourceInput,
    target: { workspaceRoot: string; workspaceId: WorkspaceId },
  ) => Promise<ReviewIngestResult>
}

export class ReviewControllerError extends Error {
  constructor(public readonly code: 'missing-folder' | 'ingest-failed', message?: string) {
    super(message ?? code)
    this.name = 'ReviewControllerError'
  }
}

// Materialize a review workspace ("Start walkthrough"): create the workspace to
// mint the id its change set is persisted under, then ingest the source into
// that id's directory. Ingestion failing rolls the just-created workspace back,
// so a failed create never leaves an empty review behind. The creation flow's
// probe already validated the source; this path covers the source changing
// between probe and create, or an unregistered provider (pull-request until
// MC-1678). Returns the new workspace id on success.
export async function runReviewCreation(
  input: ReviewControllerInput,
  ports: ReviewControllerPorts,
): Promise<WorkspaceId> {
  if (!input.folderPath) throw new ReviewControllerError('missing-folder')
  const folderPath = input.folderPath
  const workspaceId = ports.addReviewWorkspace({
    name: input.name.trim() || 'Review',
    folderPath,
    guideConfig: input.guideConfig,
  })
  let result: ReviewIngestResult
  try {
    result = await ports.ingestSource(input.source, { workspaceRoot: folderPath, workspaceId })
  } catch (error) {
    ports.removeWorkspace(workspaceId)
    throw new ReviewControllerError('ingest-failed', error instanceof Error ? error.message : String(error))
  }
  if (!result.ok) {
    ports.removeWorkspace(workspaceId)
    throw new ReviewControllerError('ingest-failed', result.error)
  }
  return workspaceId
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
