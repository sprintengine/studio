import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ProviderSecretValueResult } from '../../secret-store'
import { TrackerProviderError, type TrackerConnection } from '../../../shared/tracker/types'
import { GitHubTrackerProvider, type TrackerConnectionAccess } from './client'

// GitHub tracker provider tests (MC-1634). Normalization runs against the
// recorded-payload fixtures (REFRESH.md documents recapture); pagination, the
// SSRF cursor guard, typed-error mapping, the GHES base-URL path, and token-
// optional public reads are exercised with a routed fake fetch. No live call.

// The fixtures are loaded from disk (cwd-relative, run from the repo root) so the
// test exercises the recorded files themselves rather than an inlined copy.
const FIXTURE_DIR = join('src', 'main', 'tracker', 'github', 'fixtures')
function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'))
}
const searchIssuesFixture = loadFixture('search-issues.json')
const issueFixture = loadFixture('issue.json')
const issueCommentsFixture = loadFixture('issue-comments.json')

const GITHUB_COM: TrackerConnection = {
  id: 'trk-gh-1',
  provider: 'github',
  baseUrl: null,
  authMode: 'github_pat',
  label: 'github.com',
}

const GHES: TrackerConnection = {
  id: 'trk-gh-ghes',
  provider: 'github',
  baseUrl: 'https://ghe.example.com/api/v3',
  authMode: 'github_pat',
  label: 'Enterprise',
}

const PAT = 'ghp_test_token'

const OK_SECRET: ProviderSecretValueResult = { ok: true, providerId: GITHUB_COM.id, value: PAT, source: 'settings' }

function connectionsFor(connection: TrackerConnection, secret: ProviderSecretValueResult): TrackerConnectionAccess {
  return {
    getConnection: async () => connection,
    resolveSecret: async () => secret,
  }
}

type RecordedRequest = { url: string; authorization: string | undefined }

function ghResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => text,
  } as unknown as Response
}

// A fake fetch that matches a request URL against `routes` (first substring hit
// wins) and records what was sent. A route value may be a Response or a function
// of the URL, so a route can vary its own Link header per page.
function routedFetch(
  routes: Array<[match: string, response: Response | ((url: string) => Response)]>
): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const fetchImpl = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input)
    requests.push({ url, authorization: init?.headers?.Authorization })
    const hit = routes.find(([match]) => url.includes(match))
    if (!hit) throw new Error(`no route for ${url}`)
    return typeof hit[1] === 'function' ? hit[1](url) : hit[1]
  }) as unknown as typeof fetch
  return { fetchImpl, requests }
}

function makeProvider(
  fetchImpl: typeof fetch,
  connection: TrackerConnection = GITHUB_COM,
  secret: ProviderSecretValueResult = OK_SECRET
): GitHubTrackerProvider {
  return new GitHubTrackerProvider({ connections: connectionsFor(connection, secret), fetchImpl })
}

async function testSearchNormalizesFixtureExcludesPRsAndDisambiguates(): Promise<void> {
  const { fetchImpl, requests } = routedFetch([['/search/issues', ghResponse(200, searchIssuesFixture)]])
  const provider = makeProvider(fetchImpl)
  const page = await provider.searchIssues({ connectionId: GITHUB_COM.id, query: 'org:acme alerting' })

  // is:issue appended to the query; PAT sent as Bearer.
  assert.match(decodeURIComponent(requests[0].url), /is:issue/)
  assert.equal(requests[0].authorization, `Bearer ${PAT}`)

  // The pull request (#150) never surfaces as an issue.
  assert.equal(page.issues.length, 2)
  assert.ok(!page.issues.some((i) => i.nativeKey.includes('150')), 'pull request excluded')

  const web = page.issues[0]
  assert.equal(web.provider, 'github')
  // Two distinct repos in the page ⇒ ambiguous ⇒ the repo slug is shown.
  assert.equal(web.externalId, 'acme/web#142')
  assert.equal(web.nativeKey, 'acme/web#142')
  assert.equal(web.title, 'Consumer lag alerting fires late')
  assert.match(web.bodyMarkdown, /^## Context/)
  assert.deepEqual(web.state, { category: 'open', nativeName: 'open' })
  assert.deepEqual(web.labels, ['bug', 'alerting'])
  assert.deepEqual(web.assignee, { id: '55123', displayName: 'dana-ops' })
  assert.equal(web.url, 'https://github.com/acme/web/issues/142')
  assert.equal(web.updatedAt, '2026-07-18T10:00:00Z')
  // Search results never carry comments (fetch-on-demand), never a fake value.
  assert.deepEqual(web.comments, [])

  const api = page.issues[1]
  assert.equal(api.nativeKey, 'acme/api#17')
  // Closed by structural state, and a string-form label normalizes too.
  assert.deepEqual(api.state, { category: 'closed', nativeName: 'closed' })
  assert.deepEqual(api.labels, ['backend'])
  // No assignee ⇒ the optional key is omitted, never null.
  assert.equal(api.assignee, undefined)
}

async function testPaginationFollowsLinkHeaderAndThreadsCursor(): Promise<void> {
  const page2Url = 'https://api.github.com/search/issues?q=x+is%3Aissue&per_page=100&page=2'
  const { fetchImpl, requests } = routedFetch([
    ['page=2', ghResponse(200, { total_count: 1, items: [singleRepoIssue(200)] })],
    ['/search/issues', ghResponse(200, searchIssuesFixture, { link: `<${page2Url}>; rel="next"` })],
  ])
  const provider = makeProvider(fetchImpl)

  const first = await provider.searchIssues({ connectionId: GITHUB_COM.id, query: 'x' })
  assert.equal(first.nextCursor, page2Url, 'next page URL threads out as the cursor')

  const second = await provider.searchIssues({ connectionId: GITHUB_COM.id, query: 'x', cursor: first.nextCursor })
  // The cursor URL is fetched verbatim, and the page with no Link header ends it.
  assert.equal(requests[1].url, page2Url)
  assert.equal(second.nextCursor, undefined)
  // Single repo on the last page ⇒ the short `#123` form.
  assert.equal(second.issues[0].nativeKey, '#200')
}

async function testCursorFromForeignHostIsRejected(): Promise<void> {
  const { fetchImpl } = routedFetch([['/search/issues', ghResponse(200, searchIssuesFixture)]])
  const provider = makeProvider(fetchImpl)
  await assert.rejects(
    () =>
      provider.searchIssues({
        connectionId: GITHUB_COM.id,
        query: 'x',
        cursor: 'https://evil.example.com/search/issues?page=2',
      }),
    (err: unknown) => err instanceof TrackerProviderError && err.kind === 'unknown' && /unexpected host/.test(err.message)
  )
}

async function testGhesUsesBaseUrlWithNoOtherBranch(): Promise<void> {
  const { fetchImpl, requests } = routedFetch([['/search/issues', ghResponse(200, searchIssuesFixture)]])
  const provider = makeProvider(fetchImpl, GHES)
  const page = await provider.searchIssues({ connectionId: GHES.id, query: 'alerting' })

  // The ONLY difference from github.com is the base URL.
  assert.ok(
    requests[0].url.startsWith('https://ghe.example.com/api/v3/search/issues'),
    `GHES base URL used: ${requests[0].url}`
  )
  // Normalization is identical — same fixture, same output.
  assert.equal(page.issues.length, 2)
  assert.equal(page.issues[0].externalId, 'acme/web#142')
}

async function testFetchIssueIncludesCommentsAndShortKey(): Promise<void> {
  const { fetchImpl, requests } = routedFetch([
    ['/issues/142/comments', ghResponse(200, issueCommentsFixture)],
    ['/repos/acme/web/issues/142', ghResponse(200, issueFixture)],
  ])
  const provider = makeProvider(fetchImpl)
  const issue = await provider.fetchIssue({ connectionId: GITHUB_COM.id, externalId: 'acme/web#142' })

  assert.ok(requests[0].url.endsWith('/repos/acme/web/issues/142'), 'REST-by-number fetch')
  // A single fetched issue is unambiguous on its own ⇒ short `#142`.
  assert.equal(issue.nativeKey, '#142')
  assert.equal(issue.externalId, 'acme/web#142')
  assert.equal(issue.comments.length, 2)
  assert.deepEqual(issue.comments[0], {
    body: 'Confirmed on staging — the window is 5m, not 1m.',
    author: 'priya-sre',
    createdAt: '2026-07-11T09:00:00Z',
  })
  // A comment missing author/timestamp omits the optional keys rather than nulls.
  assert.deepEqual(issue.comments[1], { body: 'Runbook drafted, linking now.' })
}

async function testFetchPullRequestReferenceIsNotFound(): Promise<void> {
  const prBody = { number: 150, title: 'PR', state: 'open', html_url: 'x', pull_request: { url: 'y' } }
  const { fetchImpl } = routedFetch([['/repos/acme/web/issues/150', ghResponse(200, prBody)]])
  const provider = makeProvider(fetchImpl)
  await assert.rejects(
    () => provider.fetchIssue({ connectionId: GITHUB_COM.id, externalId: 'acme/web#150' }),
    (err: unknown) => err instanceof TrackerProviderError && err.kind === 'not_found'
  )
}

async function testMalformedExternalIdIsNotFound(): Promise<void> {
  const { fetchImpl } = routedFetch([])
  const provider = makeProvider(fetchImpl)
  await assert.rejects(
    () => provider.fetchIssue({ connectionId: GITHUB_COM.id, externalId: 'not-a-ref' }),
    (err: unknown) => err instanceof TrackerProviderError && err.kind === 'not_found'
  )
}

async function testAssignedToMeSearchesOpenIssues(): Promise<void> {
  const { fetchImpl, requests } = routedFetch([['/search/issues', ghResponse(200, searchIssuesFixture)]])
  const provider = makeProvider(fetchImpl)
  const issues = await provider.listAssignedToMe({ connectionId: GITHUB_COM.id })

  assert.match(decodeURIComponent(requests[0].url), /assignee:@me is:open is:issue/)
  assert.equal(issues.length, 2)
}

async function testAuth401PreservesProviderMessage(): Promise<void> {
  const { fetchImpl } = routedFetch([['/search/issues', ghResponse(401, { message: 'Bad credentials' })]])
  const provider = makeProvider(fetchImpl)
  await assert.rejects(
    () => provider.searchIssues({ connectionId: GITHUB_COM.id, query: 'x' }),
    (err: unknown) =>
      err instanceof TrackerProviderError &&
      err.kind === 'auth' &&
      err.provider === 'github' &&
      err.connectionId === GITHUB_COM.id &&
      err.message === 'Bad credentials'
  )
}

async function testPrimaryRateLimit403MapsToRateLimit(): Promise<void> {
  const { fetchImpl } = routedFetch([
    [
      '/search/issues',
      ghResponse(
        403,
        { message: 'API rate limit exceeded.' },
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '4102444800' }
      ),
    ],
  ])
  const provider = makeProvider(fetchImpl)
  await assert.rejects(
    () => provider.searchIssues({ connectionId: GITHUB_COM.id, query: 'x' }),
    (err: unknown) =>
      err instanceof TrackerProviderError &&
      err.kind === 'rate_limit' &&
      err.message === 'API rate limit exceeded.' &&
      typeof err.retryAfterSeconds === 'number'
  )
}

async function testSecondaryRateLimit429ParsesRetryAfter(): Promise<void> {
  const { fetchImpl } = routedFetch([
    ['/search/issues', ghResponse(429, { message: 'You have exceeded a secondary rate limit.' }, { 'retry-after': '60' })],
  ])
  const provider = makeProvider(fetchImpl)
  await assert.rejects(
    () => provider.searchIssues({ connectionId: GITHUB_COM.id, query: 'x' }),
    (err: unknown) => err instanceof TrackerProviderError && err.kind === 'rate_limit' && err.retryAfterSeconds === 60
  )
}

async function test404MapsToNotFound(): Promise<void> {
  const { fetchImpl } = routedFetch([['/repos/acme/web/issues/999', ghResponse(404, { message: 'Not Found' })]])
  const provider = makeProvider(fetchImpl)
  await assert.rejects(
    () => provider.fetchIssue({ connectionId: GITHUB_COM.id, externalId: 'acme/web#999' }),
    (err: unknown) => err instanceof TrackerProviderError && err.kind === 'not_found' && err.message === 'Not Found'
  )
}

async function testNetworkFailureMapsToNetwork(): Promise<void> {
  const fetchImpl = (async () => {
    throw new Error('getaddrinfo ENOTFOUND ghe.example.com')
  }) as unknown as typeof fetch
  const provider = makeProvider(fetchImpl, GHES)
  await assert.rejects(
    () => provider.searchIssues({ connectionId: GHES.id, query: 'x' }),
    (err: unknown) => err instanceof TrackerProviderError && err.kind === 'network' && /ENOTFOUND/.test(err.message)
  )
}

async function testPublicReadWithoutTokenSendsNoAuthHeader(): Promise<void> {
  const { fetchImpl, requests } = routedFetch([['/search/issues', ghResponse(200, searchIssuesFixture)]])
  // A PAT is optional for public github.com reads; a missing secret must not
  // block the call, and no Authorization header is sent.
  const provider = makeProvider(fetchImpl, GITHUB_COM, { ok: false, message: 'no secret' })
  const page = await provider.searchIssues({ connectionId: GITHUB_COM.id, query: 'x' })
  assert.equal(requests[0].authorization, undefined)
  assert.equal(page.issues.length, 2)
}

async function testUnknownConnectionIsNotConfigured(): Promise<void> {
  const provider = new GitHubTrackerProvider({
    connections: { getConnection: async () => undefined, resolveSecret: async () => OK_SECRET },
    fetchImpl: routedFetch([]).fetchImpl,
  })
  await assert.rejects(
    () => provider.searchIssues({ connectionId: 'gone', query: 'x' }),
    (err: unknown) => err instanceof TrackerProviderError && err.kind === 'not_configured'
  )
}

async function testTestConnectionSuccessAndFailure(): Promise<void> {
  const okProvider = makeProvider(routedFetch([['/user', ghResponse(200, { login: 'dana-ops' })]]).fetchImpl)
  assert.deepEqual(await okProvider.testConnection({ connectionId: GITHUB_COM.id }), {
    ok: true,
    summary: 'Signed in as dana-ops.',
  })

  const badProvider = makeProvider(routedFetch([['/user', ghResponse(401, { message: 'Bad credentials' })]]).fetchImpl)
  const probe = await badProvider.testConnection({ connectionId: GITHUB_COM.id })
  assert.equal(probe.ok, false)
  assert.equal(probe.reason, 'Bad credentials')
}

async function testCommentWriteBackPostsAndTransitionUnsupported(): Promise<void> {
  // Comment write-back is on (MC-1640 / T10); named transitions never apply.
  const { fetchImpl, requests } = routedFetch([['/issues/1/comments', ghResponse(201, { id: 12345 })]])
  const provider = makeProvider(fetchImpl)
  assert.deepEqual(provider.capabilities, { canComment: true, canTransition: false, selfHostable: true })

  await provider.postComment({ connectionId: GITHUB_COM.id, externalId: 'acme/web#1', body: 'Sprint started' })
  const posted = requests.find((request) => request.url.includes('/repos/acme/web/issues/1/comments'))
  assert.ok(posted, 'posted to the issue comments endpoint')
  assert.equal(posted?.authorization, `Bearer ${PAT}`, 'the credential authorizes the write')

  // Posting without a credential is an honest auth failure, never a silent no-op.
  const noToken = makeProvider(routedFetch([]).fetchImpl, GITHUB_COM, { ok: false, message: 'No credential configured.' })
  await assert.rejects(
    () => noToken.postComment({ connectionId: GITHUB_COM.id, externalId: 'acme/web#1', body: 'hi' }),
    (err: unknown) => err instanceof TrackerProviderError && err.kind === 'auth'
  )

  // GitHub has no named workflow transitions, so tier-2 write-back never applies.
  await assert.rejects(
    () => provider.transitionIssue(),
    (err: unknown) => err instanceof TrackerProviderError && err.kind === 'unsupported'
  )
}

// A single-repo /search item, so a page of these renders the short `#123` form.
function singleRepoIssue(number: number): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    state: 'open',
    body: '',
    html_url: `https://github.com/acme/web/issues/${number}`,
    repository_url: 'https://api.github.com/repos/acme/web',
    labels: [],
    assignee: null,
    updated_at: '2026-07-18T10:00:00Z',
  }
}

async function main(): Promise<void> {
  await testSearchNormalizesFixtureExcludesPRsAndDisambiguates()
  await testPaginationFollowsLinkHeaderAndThreadsCursor()
  await testCursorFromForeignHostIsRejected()
  await testGhesUsesBaseUrlWithNoOtherBranch()
  await testFetchIssueIncludesCommentsAndShortKey()
  await testFetchPullRequestReferenceIsNotFound()
  await testMalformedExternalIdIsNotFound()
  await testAssignedToMeSearchesOpenIssues()
  await testAuth401PreservesProviderMessage()
  await testPrimaryRateLimit403MapsToRateLimit()
  await testSecondaryRateLimit429ParsesRetryAfter()
  await test404MapsToNotFound()
  await testNetworkFailureMapsToNetwork()
  await testPublicReadWithoutTokenSendsNoAuthHeader()
  await testUnknownConnectionIsNotConfigured()
  await testTestConnectionSuccessAndFailure()
  await testCommentWriteBackPostsAndTransitionUnsupported()
  console.log('github client.test.ts: all assertions passed')
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
