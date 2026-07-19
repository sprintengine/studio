import assert from 'node:assert/strict'

import type { ReviewIngestResult, ReviewSourceInput } from '../../../../../../shared/electron-api'
import {
  ingestReviewChange,
  ReviewControllerError,
} from '../../newWorkspace/controllers/reviewController'

function run(name: string, body: () => Promise<void>): Promise<void> {
  return body().then(
    () => console.log(`ok - ${name}`),
    (error) => {
      console.error(`not ok - ${name}`)
      throw error
    },
  )
}

// ingestReviewChange only reads `result.ok`, so the change set body is irrelevant.
const okResult = (): ReviewIngestResult => ({ ok: true, changeset: {} as never })

async function main(): Promise<void> {
  // The Reviews-door "Review a change" entry ingests WITHOUT minting a workspace
  // row: a fresh review id keys the on-disk dir, and the source is ingested into
  // it. This is the exact path the surface's form drives.
  await run('mints a review id, ingests into it, and returns the id', async () => {
    const calls: { source: ReviewSourceInput; target: { workspaceRoot: string; workspaceId: string } }[] = []
    const source: ReviewSourceInput = { kind: 'pull-request', url: 'https://github.com/o/r/pull/1' }
    const reviewId = await ingestReviewChange(
      { folderPath: '/proj/multicode', source },
      {
        ingestSource: async (input, target) => {
          calls.push({ source: input, target })
          return okResult()
        },
      },
    )
    assert.equal(calls.length, 1, 'ingestion is reached exactly once')
    assert.equal(calls[0].target.workspaceRoot, '/proj/multicode', 'ingests into the chosen project root')
    assert.match(reviewId, /^rv_/, 'the returned id is a fresh review id, not a workspace id')
    assert.equal(calls[0].target.workspaceId, reviewId, 'the change set is stored under that review id')
    assert.deepEqual(calls[0].source, source, 'the source is passed through untouched')
  })

  await run('surfaces an ingest failure as a ReviewControllerError, leaving no orphan', async () => {
    await assert.rejects(
      ingestReviewChange(
        { folderPath: '/proj/multicode', source: { kind: 'patch', text: 'bad' } },
        { ingestSource: async () => ({ ok: false, error: 'unreadable patch' }) },
      ),
      (error: unknown) =>
        error instanceof ReviewControllerError && error.code === 'ingest-failed' && /unreadable patch/.test(error.message),
    )
  })

  await run('a thrown transport error is wrapped as ingest-failed', async () => {
    await assert.rejects(
      ingestReviewChange(
        { folderPath: '/proj/multicode', source: { kind: 'pull-request', url: 'x' } },
        {
          ingestSource: async () => {
            throw new Error('network down')
          },
        },
      ),
      (error: unknown) => error instanceof ReviewControllerError && error.code === 'ingest-failed',
    )
  })

  console.log('reviewChangeFlow tests passed')
}

void main()
