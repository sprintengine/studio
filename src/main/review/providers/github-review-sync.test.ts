import assert from 'node:assert/strict'
import type { ReviewChangeSet, ReviewComment } from '../../../shared/review'
import type { GhRunner } from './github-pr-provider'
import {
  postReview,
  type GithubReviewSyncDeps,
  type WriteFetchLike,
  type WriteFetchResponseLike,
} from './github-review-sync'
import { registerReviewIpc } from '../review-ipc'

const tests: Array<{ name: string; body: () => Promise<void> | void }> = []
function run(name: string, body: () => Promise<void> | void): void {
  tests.push({ name, body })
}

const OWNER = 'acme'
const REPO = 'app'
const NUMBER = 123
const OLD_HEAD = 'a'.repeat(40)
const NEW_HEAD = 'b'.repeat(40)
const NOW = '2026-07-18T00:00:00.000Z'
const SECRET_TOKEN = 'ghp_SUPERSECRET_should_never_persist'

const GH_UNAVAILABLE: GhRunner = {
  available: async () => false,
  run: async () => ({ found: false, code: -1, stdout: '', stderr: '' }),
}

function prChangeSet(overrides: Partial<ReviewChangeSet> = {}): ReviewChangeSet {
  // A single-file diff whose new side spans lines 1..8 (all commentable). Enough
  // hunk structure for the head-unchanged path to validate line membership locally.
  return {
    schemaVersion: 1,
    id: 'cs_test',
    source: { kind: 'pull-request', provider: 'github', host: 'github.com', owner: OWNER, repo: REPO, number: NUMBER, url: `https://github.com/${OWNER}/${REPO}/pull/${NUMBER}` },
    title: 'Add widget',
    baseRef: 'main',
    baseSha: 'base'.repeat(10),
    headRef: 'feature',
    headSha: OLD_HEAD,
    files: [
      {
        path: 'a.ts',
        status: 'modified',
        binary: false,
        additions: 8,
        deletions: 0,
        hunks: [
          {
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 8,
            lines: Array.from({ length: 8 }, (_, i) => ({ kind: 'add' as const, text: `line ${i + 1}` })),
          },
        ],
      },
    ],
    stats: { files: 1, additions: 8, deletions: 0 },
    fetchedAt: NOW,
    ...overrides,
  }
}

function comment(id: string, startLine: number, endLine = startLine, extra: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id,
    path: 'a.ts',
    anchor: { side: 'new', startLine, endLine, anchoredAtSha: OLD_HEAD },
    body: `comment ${id}`,
    createdAt: NOW,
    sync: { state: 'pending' },
    ...extra,
  }
}

function jsonResponse(status: number, json: unknown): WriteFetchResponseLike {
  return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json) }
}
function textResponse(status: number, text: string): WriteFetchResponseLike {
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text || 'null'), text: async () => text }
}

interface StubOptions {
  headSha?: string
  headStatus?: number // non-200 forces an auth/transport error on the head fetch
  prDiff?: string // base...newHead diff (moved path, for line membership)
  compareDiff?: string // oldHead...newHead diff (moved path, for re-anchoring)
  reviewStatus?: number
  reviewId?: number
  reviewUrl?: string
  commentUrls?: Array<{ path: string; line: number; side: 'RIGHT' | 'LEFT'; url: string }>
}

interface StubHandle {
  fetchImpl: WriteFetchLike
  posts: Array<{ url: string; body: unknown }>
  authHeaders: Array<string | undefined>
}

function fetchStub(options: StubOptions): StubHandle {
  const posts: Array<{ url: string; body: unknown }> = []
  const authHeaders: Array<string | undefined> = []
  const reviewId = options.reviewId ?? 99
  const reviewUrl = options.reviewUrl ?? `https://github.com/${OWNER}/${REPO}/pull/${NUMBER}#pullrequestreview-${reviewId}`
  const fetchImpl: WriteFetchLike = async (url, init) => {
    authHeaders.push(init?.headers?.Authorization)
    const accept = init?.headers?.Accept
    const isDiff = accept === 'application/vnd.github.v3.diff'
    if (url.includes('/compare/')) return textResponse(200, options.compareDiff ?? '')
    if (init?.method === 'POST' && url.endsWith(`/pulls/${NUMBER}/reviews`)) {
      posts.push({ url, body: JSON.parse(init.body ?? 'null') })
      if (options.reviewStatus && options.reviewStatus >= 300) return jsonResponse(options.reviewStatus, { message: 'rejected' })
      return jsonResponse(200, { id: reviewId, html_url: reviewUrl })
    }
    if (/\/reviews\/\d+\/comments$/.test(url)) {
      return jsonResponse(200, (options.commentUrls ?? []).map((c) => ({ path: c.path, line: c.line, side: c.side, html_url: c.url })))
    }
    if (url.endsWith(`/pulls/${NUMBER}`)) {
      if (isDiff) return textResponse(200, options.prDiff ?? '')
      if (options.headStatus && options.headStatus >= 300) return jsonResponse(options.headStatus, { message: 'boom' })
      return jsonResponse(200, { head: { sha: options.headSha ?? OLD_HEAD } })
    }
    throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${url}`)
  }
  return { fetchImpl, posts, authHeaders }
}

function deps(stub: StubHandle, resolveToken: () => Promise<string | null> = async () => null): GithubReviewSyncDeps {
  return { gh: GH_UNAVAILABLE, fetchImpl: stub.fetchImpl, resolveToken, now: () => NOW }
}

run('happy path posts ONE review with N anchored comments and records their URLs', async () => {
  const stub = fetchStub({
    commentUrls: [
      { path: 'a.ts', line: 2, side: 'RIGHT', url: 'https://gh/c/2' },
      { path: 'a.ts', line: 4, side: 'RIGHT', url: 'https://gh/c/4' },
    ],
  })
  const result = await postReview(prChangeSet(), [comment('c1', 2), comment('c2', 4)], deps(stub, async () => SECRET_TOKEN))

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(stub.posts.length, 1, 'exactly one review is created')
  const body = stub.posts[0].body as { event: string; commit_id: string; comments: Array<Record<string, unknown>> }
  assert.equal(body.event, 'COMMENT', 'event is COMMENT, never APPROVE/REQUEST_CHANGES')
  assert.equal(body.commit_id, OLD_HEAD)
  assert.equal(body.comments.length, 2)
  assert.deepEqual(
    body.comments.map((c) => c.line),
    [2, 4]
  )
  assert.equal(body.comments[0].side, 'RIGHT')
  assert.ok(!('start_line' in body.comments[0]), 'single-line comment omits start_line')

  const byId = new Map(result.outcomes.map((o) => [o.id, o]))
  assert.equal(byId.get('c1')?.sync.state, 'posted')
  assert.equal((byId.get('c1')?.sync as { url: string }).url, 'https://gh/c/2')
  assert.equal((byId.get('c1')?.sync as { postedAt: string }).postedAt, NOW)
  assert.equal((byId.get('c2')?.sync as { url: string }).url, 'https://gh/c/4')
  assert.ok(stub.authHeaders.includes(`Bearer ${SECRET_TOKEN}`), 'token is sent as a bearer credential')
})

run('a multi-line comment carries start_line and start_side', async () => {
  const stub = fetchStub({})
  const result = await postReview(prChangeSet(), [comment('c1', 3, 5)], deps(stub))
  assert.equal(result.ok, true)
  const body = stub.posts[0].body as { comments: Array<Record<string, unknown>> }
  assert.equal(body.comments[0].start_line, 3)
  assert.equal(body.comments[0].start_side, 'RIGHT')
  assert.equal(body.comments[0].line, 5)
})

run('moved head re-anchors a new-side comment and posts at the shifted line', async () => {
  // Two lines inserted at old-head line 3 shift a comment at line 5 down to line 7.
  const compareDiff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -3,0 +3,2 @@', '+inserted x', '+inserted y', ''].join('\n')
  // The refreshed PR diff (base...newHead) makes new-side line 7 commentable.
  const prDiff = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,0 +1,8 @@',
    ...Array.from({ length: 8 }, (_, i) => `+line ${i + 1}`),
    '',
  ].join('\n')
  const stub = fetchStub({ headSha: NEW_HEAD, compareDiff, prDiff, commentUrls: [{ path: 'a.ts', line: 7, side: 'RIGHT', url: 'https://gh/c/7' }] })

  const result = await postReview(prChangeSet(), [comment('c1', 5)], deps(stub))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(stub.posts.length, 1)
  const body = stub.posts[0].body as { commit_id: string; comments: Array<Record<string, unknown>> }
  assert.equal(body.commit_id, NEW_HEAD, 'the review is posted against the current head')
  assert.equal(body.comments[0].line, 7, 're-anchored to the shifted line')
  assert.equal((result.outcomes[0].sync as { url: string }).url, 'https://gh/c/7')
})

run('a deleted range holds the comment pending with the moved state, never guessing a line', async () => {
  // The comment's own lines (5-6) are removed between the two heads.
  const compareDiff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -5,2 +5,0 @@', '-line 5', '-line 6', ''].join('\n')
  const prDiff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,0 +1,4 @@', '+line 1', '+line 2', '+line 3', '+line 4', ''].join('\n')
  const stub = fetchStub({ headSha: NEW_HEAD, compareDiff, prDiff })

  const result = await postReview(prChangeSet(), [comment('c1', 5, 6)], deps(stub))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(stub.posts.length, 0, 'nothing is posted when the only comment moved')
  assert.equal(result.reviewUrl, undefined)
  assert.equal(result.outcomes.length, 1)
  assert.equal(result.outcomes[0].sync.state, 'pending', 'held comment stays pending (retry-able)')
  assert.equal(result.outcomes[0].anchorStatus, 'moved')
})

run('partial failure: 2 anchorable comments post, the un-anchorable one stays pending', async () => {
  // Head unchanged; c3 anchors at line 99, outside every hunk → not commentable.
  const stub = fetchStub({
    commentUrls: [
      { path: 'a.ts', line: 2, side: 'RIGHT', url: 'https://gh/c/2' },
      { path: 'a.ts', line: 4, side: 'RIGHT', url: 'https://gh/c/4' },
    ],
  })
  const result = await postReview(prChangeSet(), [comment('c1', 2), comment('c2', 4), comment('c3', 99)], deps(stub))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(stub.posts.length, 1)
  const body = stub.posts[0].body as { comments: unknown[] }
  assert.equal(body.comments.length, 2, 'only the anchorable comments are sent')
  const byId = new Map(result.outcomes.map((o) => [o.id, o]))
  assert.equal(byId.get('c1')?.sync.state, 'posted')
  assert.equal(byId.get('c2')?.sync.state, 'posted')
  assert.equal(byId.get('c3')?.sync.state, 'pending')
  assert.equal(byId.get('c3')?.anchorStatus, 'moved')
})

run('re-posting skips comments already on the PR (idempotent by recorded URL)', async () => {
  const stub = fetchStub({ commentUrls: [{ path: 'a.ts', line: 4, side: 'RIGHT', url: 'https://gh/c/4' }] })
  const already = comment('c1', 2, 2, { sync: { state: 'posted', url: 'https://gh/c/2', postedAt: NOW } })
  const result = await postReview(prChangeSet(), [already, comment('c2', 4)], deps(stub))
  assert.equal(result.ok, true)
  if (!result.ok) return
  const body = stub.posts[0].body as { comments: Array<Record<string, unknown>> }
  assert.equal(body.comments.length, 1, 'the already-posted comment is not re-sent')
  assert.equal(body.comments[0].line, 4)
  const ids = result.outcomes.map((o) => o.id)
  assert.deepEqual(ids, ['c2'], 'only the newly-posted comment is reported')
})

run('a comment already flagged moved is never posted from that state', async () => {
  const stub = fetchStub({})
  const stale = comment('c1', 2, 2, { anchorStatus: 'moved' })
  const result = await postReview(prChangeSet(), [stale], deps(stub))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(stub.posts.length, 0)
  assert.equal(result.outcomes[0].sync.state, 'pending')
  assert.equal(result.outcomes[0].anchorStatus, 'moved')
})

run('auth failure maps to the actionable error copy and posts nothing', async () => {
  const stub = fetchStub({ headStatus: 401 })
  const result = await postReview(prChangeSet(), [comment('c1', 2)], deps(stub, async () => SECRET_TOKEN))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.error, /401/)
  assert.match(result.error, /gh auth login/)
  assert.match(result.error, /GH_TOKEN/)
  assert.ok(!result.error.includes(SECRET_TOKEN), 'the error never echoes the token')
  assert.equal(stub.posts.length, 0)
})

run('a whole-batch rejection (422 on create) surfaces an actionable error, posts nothing durable', async () => {
  const stub = fetchStub({ reviewStatus: 422 })
  const result = await postReview(prChangeSet(), [comment('c1', 2)], deps(stub))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.error, /422/)
})

run('branch and patch sources can never post to a remote', async () => {
  const stub = fetchStub({})
  const branch = prChangeSet({ source: { kind: 'branch', repoRoot: '/repo', baseRef: 'main', headRef: 'feature' }, headSha: undefined })
  const result = await postReview(branch, [comment('c1', 2)], deps(stub))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.error, /pull-request/i)
  assert.equal(stub.posts.length, 0)
})

// AC5: no code path lets a non-window sender (the shape any non-renderer caller,
// including a companion/guide agent, would present) reach the write path. The
// handler refuses before touching the change set or the network.
run('the review:post-review IPC handler refuses a sender that is not a real window', async () => {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>()
  const fakeIpcMain = { handle: (channel: string, fn: (event: unknown, input: unknown) => Promise<unknown>) => handlers.set(channel, fn) }
  let readCalled = false
  const changeSetService = {
    read: async () => {
      readCalled = true
      return { ok: true as const, changeset: null }
    },
  }
  const explodingSyncDeps: GithubReviewSyncDeps = {
    gh: GH_UNAVAILABLE,
    fetchImpl: async () => {
      throw new Error('network must never be reached from a refused sender')
    },
    resolveToken: async () => null,
    now: () => NOW,
  }

  registerReviewIpc(fakeIpcMain as never, {
    changeSetService: changeSetService as never,
    guideTerminals: {
      startRun: async () => ({ ok: true }) as never,
      ask: async () => ({ ok: true }) as never,
      stop: () => {},
    },
    isUserWindowSender: () => false, // no window resolves → refuse
    reviewSyncDeps: explodingSyncDeps,
  })

  const handler = handlers.get('review:post-review')
  assert.ok(handler, 'the handler is registered')
  const result = (await handler!({ sender: {} }, { target: { workspaceRoot: '/w', workspaceId: 'ws' }, comments: [] })) as {
    ok: boolean
    error?: string
  }
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /review window/i)
  assert.equal(readCalled, false, 'a refused sender never reaches the change set or the network')
})

async function main(): Promise<void> {
  let failed = false
  for (const test of tests) {
    try {
      await test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      failed = true
      console.error(`not ok - ${test.name}`)
      console.error(error)
    }
  }
  if (failed) process.exit(1)
  console.log('github-review-sync.test.ts: ok')
}

void main()
