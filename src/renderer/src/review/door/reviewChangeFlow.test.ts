import assert from 'node:assert/strict'

import type { ReviewIngestResult, ReviewSourceInput } from '../../../../shared/electron-api'
import {
  ingestReviewChange,
  ReviewControllerError,
} from '../../components/workspace/newWorkspace/controllers/reviewController'
import { controlDefaultRoot, looksLikePrUrl, resolvePrProject } from './reviewController'

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

  // ── PR tab URL-first project inference (MC-1787 T10) ──────────────────────
  // The controller turns T9's match result into the one project control the form
  // renders, so the form never shows an up-front project picker for a PR link.

  const ROOTS = ['/proj/a', '/proj/b', '/proj/c']

  await run('looksLikePrUrl gates the match call to real PR links, not half-typed URLs', () => {
    // Complete PR/MR links across the three hosts the URL field accepts.
    assert.equal(looksLikePrUrl('https://github.com/o/r/pull/123'), true)
    assert.equal(looksLikePrUrl('https://gitlab.com/o/r/-/merge_requests/9'), true)
    assert.equal(looksLikePrUrl('https://bitbucket.org/o/r/pull-requests/4'), true)
    assert.equal(looksLikePrUrl('  https://github.com/o/r/pull/7  '), true, 'tolerates surrounding whitespace')
    // Partial / non-PR URLs must NOT trigger a match call (else the no-match
    // picker flashes while the reviewer is still typing).
    assert.equal(looksLikePrUrl(''), false)
    assert.equal(looksLikePrUrl('https://github.com/o/r'), false)
    assert.equal(looksLikePrUrl('https://github.com/o/r/pull/'), false)
    assert.equal(looksLikePrUrl('github.com/o/r/pull/1'), false, 'needs a scheme')
    return Promise.resolve()
  })

  await run('one match → confirmed silently, resolving to that project', () => {
    const control = resolvePrProject({ ok: true, matches: ['/proj/b'] }, ROOTS)
    assert.deepEqual(control, { kind: 'confirmed', root: '/proj/b' })
    assert.equal(controlDefaultRoot(control), '/proj/b', 'the storage root needs no interaction')
    return Promise.resolve()
  })

  await run('many matches → picker limited to just those checkouts, first is default', () => {
    const control = resolvePrProject({ ok: true, matches: ['/proj/a', '/proj/c'] }, ROOTS)
    assert.deepEqual(control, { kind: 'choose', roots: ['/proj/a', '/proj/c'], reason: 'many' })
    assert.equal(controlDefaultRoot(control), '/proj/a')
    return Promise.resolve()
  })

  await run('zero matches → still creatable via a picker of every open project (T9 D5 fallback)', () => {
    const control = resolvePrProject({ ok: true, matches: [] }, ROOTS)
    assert.deepEqual(control, { kind: 'choose', roots: ROOTS, reason: 'none' })
    assert.equal(controlDefaultRoot(control), '/proj/a')
    return Promise.resolve()
  })

  await run('a failed match check falls back to the full picker, flagged as an error not a clean no-match', () => {
    const control = resolvePrProject({ ok: false, error: 'git unavailable' }, ROOTS)
    assert.deepEqual(control, { kind: 'choose', roots: ROOTS, reason: 'error' })
    return Promise.resolve()
  })

  await run('no open projects → nowhere to store the review, even on a match answer', () => {
    assert.deepEqual(resolvePrProject({ ok: true, matches: [] }, []), { kind: 'no-projects' })
    assert.deepEqual(resolvePrProject({ ok: false, error: 'x' }, []), { kind: 'no-projects' })
    assert.equal(controlDefaultRoot({ kind: 'no-projects' }), null)
    assert.equal(controlDefaultRoot({ kind: 'matching' }), null)
    return Promise.resolve()
  })

  console.log('reviewChangeFlow tests passed')
}

void main()
