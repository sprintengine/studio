import assert from 'node:assert/strict'

import type { ProviderSecretValueResult } from '../../secret-store'
import { TrackerProviderError, type TrackerConnection } from '../../../shared/tracker/types'
import { LinearTrackerProvider, type LinearConnectionAccess } from './linear-provider'
import type { LinearFetch } from './linear-client'

// Fixture-based tests for the Linear provider (MC-1636). A fake fetch returns
// recorded Linear GraphQL response shapes so the query-building, cursor
// pagination, normalization, capability gating, and typed-error paths are all
// exercised without a live workspace. Every fixture mirrors the real Linear
// response envelope ({ data: { … } } / { errors: [...] }).

const CONNECTION: TrackerConnection = {
  id: 'trk-linear-1',
  provider: 'linear',
  baseUrl: null,
  authMode: 'linear_key',
  label: 'Acme Linear',
}

const API_KEY = 'lin_api_test_key'

function connectionsWith(secret: ProviderSecretValueResult): LinearConnectionAccess {
  return {
    getConnection: async () => CONNECTION,
    resolveSecret: async () => secret,
  }
}

const OK_SECRET: ProviderSecretValueResult = {
  ok: true,
  providerId: CONNECTION.id,
  value: API_KEY,
  source: 'settings',
}

type RecordedRequest = { query: string; variables: Record<string, unknown>; authorization: string | undefined }

// Builds a fake fetch that records each request and returns a queued Response.
// The queue lets a test script a multi-page pagination walk deterministically.
function fakeFetch(responses: Response[]): { fetchImpl: LinearFetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const queue = [...responses]
  const fetchImpl: LinearFetch = async (_url, init) => {
    const headers = init.headers as Record<string, string> | undefined
    const parsed = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> }
    requests.push({ query: parsed.query, variables: parsed.variables, authorization: headers?.authorization })
    const next = queue.shift()
    if (!next) throw new Error('fake fetch exhausted')
    return next
  }
  return { fetchImpl, requests }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response
}

function issueNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'issue-uuid-1',
    identifier: 'ENG-423',
    title: 'Kafka consumer lag alerting',
    description: '## Context\n\n`consumer-lag` exceeds threshold. **Fix** the alert.',
    url: 'https://linear.app/acme/issue/ENG-423',
    priority: 2,
    priorityLabel: 'High',
    updatedAt: '2026-07-18T10:00:00.000Z',
    state: { name: 'In Progress', type: 'started' },
    assignee: { id: 'user-1', displayName: 'Dana Ops' },
    labels: { nodes: [{ name: 'backend' }, { name: 'alerting' }] },
    ...overrides,
  }
}

function makeProvider(fetchImpl: LinearFetch, secret: ProviderSecretValueResult = OK_SECRET): LinearTrackerProvider {
  return new LinearTrackerProvider({
    connections: connectionsWith(secret),
    endpoint: 'https://linear.test/graphql',
    fetchImpl,
    timeoutMs: 1000,
  })
}

async function testSearchWithTermNormalizesAndPages(): Promise<void> {
  const { fetchImpl, requests } = fakeFetch([
    jsonResponse(200, {
      data: {
        issueSearch: {
          pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
          nodes: [issueNode()],
        },
      },
    }),
  ])
  const provider = makeProvider(fetchImpl)
  const page = await provider.searchIssues({ connectionId: CONNECTION.id, query: 'lag' })

  assert.equal(requests.length, 1)
  assert.ok(requests[0].query.includes('issueSearch'), 'term search uses issueSearch')
  assert.deepEqual(requests[0].variables, { term: 'lag', first: 50, after: null })
  assert.equal(requests[0].authorization, API_KEY, 'API key sent verbatim, no Bearer prefix')

  assert.equal(page.issues.length, 1)
  const issue = page.issues[0]
  assert.equal(issue.provider, 'linear')
  assert.equal(issue.externalId, 'issue-uuid-1')
  assert.equal(issue.nativeKey, 'ENG-423')
  // Body markdown lands verbatim — no conversion layer.
  assert.equal(issue.bodyMarkdown, '## Context\n\n`consumer-lag` exceeds threshold. **Fix** the alert.')
  // State mapped by structural type, not the display name.
  assert.deepEqual(issue.state, { category: 'open', nativeName: 'In Progress' })
  assert.equal(issue.priority, 'High')
  assert.deepEqual(issue.labels, ['backend', 'alerting'])
  assert.deepEqual(issue.assignee, { id: 'user-1', displayName: 'Dana Ops' })
  assert.equal(issue.url, 'https://linear.app/acme/issue/ENG-423')
  assert.equal(issue.updatedAt, '2026-07-18T10:00:00.000Z')
  // Search results carry no comments (fetch-on-demand), never a fake value.
  assert.deepEqual(issue.comments, [])
  // hasNextPage true → cursor threads out.
  assert.equal(page.nextCursor, 'cursor-2')
}

async function testSearchForwardsCursorAndStopsAtLastPage(): Promise<void> {
  const { fetchImpl, requests } = fakeFetch([
    jsonResponse(200, {
      data: {
        issueSearch: {
          pageInfo: { hasNextPage: false, endCursor: 'cursor-3' },
          nodes: [issueNode({ id: 'issue-uuid-2', identifier: 'ENG-424' })],
        },
      },
    }),
  ])
  const provider = makeProvider(fetchImpl)
  const page = await provider.searchIssues({ connectionId: CONNECTION.id, query: 'lag', cursor: 'cursor-2' })

  assert.deepEqual(requests[0].variables, { term: 'lag', first: 50, after: 'cursor-2' }, 'cursor forwarded as after')
  // hasNextPage false → no nextCursor even though endCursor is present.
  assert.equal(page.nextCursor, undefined)
  assert.equal(page.issues[0].nativeKey, 'ENG-424')
}

async function testEmptyQueryBrowsesRecentIssues(): Promise<void> {
  const { fetchImpl, requests } = fakeFetch([
    jsonResponse(200, {
      data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [issueNode()] } },
    }),
  ])
  const provider = makeProvider(fetchImpl)
  const page = await provider.searchIssues({ connectionId: CONNECTION.id, query: '  ' })

  assert.ok(requests[0].query.includes('issues('), 'blank query browses via issues(), not issueSearch')
  assert.deepEqual(requests[0].variables, { first: 50, after: null })
  assert.equal(page.issues.length, 1)
}

async function testFetchIssueIncludesComments(): Promise<void> {
  const { fetchImpl, requests } = fakeFetch([
    jsonResponse(200, {
      data: {
        issue: issueNode({
          state: { name: 'Shipped', type: 'completed' },
          comments: {
            nodes: [
              { body: 'Deployed to prod.', createdAt: '2026-07-18T12:00:00.000Z', user: { displayName: 'Dana Ops' } },
              { body: 'Nice.', createdAt: null, user: null },
            ],
          },
        }),
      },
    }),
  ])
  const provider = makeProvider(fetchImpl)
  const issue = await provider.fetchIssue({ connectionId: CONNECTION.id, externalId: 'issue-uuid-1' })

  assert.deepEqual(requests[0].variables, { id: 'issue-uuid-1' })
  // Renamed "Shipped" with completed type still maps to closed.
  assert.deepEqual(issue.state, { category: 'closed', nativeName: 'Shipped' })
  assert.equal(issue.comments.length, 2)
  assert.deepEqual(issue.comments[0], {
    body: 'Deployed to prod.',
    author: 'Dana Ops',
    createdAt: '2026-07-18T12:00:00.000Z',
  })
  // Missing author/timestamp omit the optional keys rather than emitting nulls.
  assert.deepEqual(issue.comments[1], { body: 'Nice.' })
}

async function testFetchMissingIssueThrowsNotFound(): Promise<void> {
  const { fetchImpl } = fakeFetch([jsonResponse(200, { data: { issue: null } })])
  const provider = makeProvider(fetchImpl)
  await assert.rejects(
    () => provider.fetchIssue({ connectionId: CONNECTION.id, externalId: 'missing' }),
    (err: unknown) => err instanceof TrackerProviderError && err.kind === 'not_found'
  )
}

async function testAssignedToMePaginatesAndFiltersOpen(): Promise<void> {
  const { fetchImpl, requests } = fakeFetch([
    jsonResponse(200, {
      data: {
        viewer: {
          assignedIssues: {
            pageInfo: { hasNextPage: true, endCursor: 'a-2' },
            nodes: [issueNode({ id: 'a1', identifier: 'ENG-1' })],
          },
        },
      },
    }),
    jsonResponse(200, {
      data: {
        viewer: {
          assignedIssues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [issueNode({ id: 'a2', identifier: 'ENG-2' })],
          },
        },
      },
    }),
  ])
  const provider = makeProvider(fetchImpl)
  const issues = await provider.listAssignedToMe({ connectionId: CONNECTION.id })

  assert.equal(requests.length, 2, 'walked both cursor pages')
  assert.deepEqual(requests[0].variables, { first: 50, after: null })
  assert.deepEqual(requests[1].variables, { first: 50, after: 'a-2' })
  assert.ok(requests[0].query.includes('assignedIssues'), 'uses viewer.assignedIssues')
  assert.ok(requests[0].query.includes('nin: ["completed", "canceled"]'), 'filters open state types structurally')
  assert.deepEqual(
    issues.map((i) => i.nativeKey),
    ['ENG-1', 'ENG-2']
  )
}

async function testInvalidKeyHttp401IsTypedAuthError(): Promise<void> {
  const { fetchImpl } = fakeFetch([
    jsonResponse(401, { errors: [{ message: 'Authentication required — the API key is invalid.' }] }),
  ])
  const provider = makeProvider(fetchImpl)
  await assert.rejects(
    () => provider.searchIssues({ connectionId: CONNECTION.id, query: 'x' }),
    (err: unknown) =>
      err instanceof TrackerProviderError &&
      err.kind === 'auth' &&
      err.provider === 'linear' &&
      err.connectionId === CONNECTION.id &&
      err.message === 'Authentication required — the API key is invalid.'
  )
}

async function testGraphQLErrorEnvelopeMapsByExtensionType(): Promise<void> {
  const { fetchImpl } = fakeFetch([
    jsonResponse(200, {
      errors: [{ message: 'Rate limit exceeded, retry soon.', extensions: { type: 'ratelimited' } }],
    }),
  ])
  const provider = makeProvider(fetchImpl)
  await assert.rejects(
    () => provider.searchIssues({ connectionId: CONNECTION.id, query: 'x' }),
    (err: unknown) =>
      err instanceof TrackerProviderError &&
      err.kind === 'rate_limit' &&
      err.message === 'Rate limit exceeded, retry soon.'
  )
}

async function testRateLimitStatusParsesRetryAfter(): Promise<void> {
  const { fetchImpl } = fakeFetch([
    jsonResponse(429, { errors: [{ message: 'Too many requests.' }] }, { 'retry-after': '30' }),
  ])
  const provider = makeProvider(fetchImpl)
  await assert.rejects(
    () => provider.searchIssues({ connectionId: CONNECTION.id, query: 'x' }),
    (err: unknown) =>
      err instanceof TrackerProviderError && err.kind === 'rate_limit' && err.retryAfterSeconds === 30
  )
}

async function testTestConnectionSuccessAndFailure(): Promise<void> {
  const okProvider = makeProvider(
    fakeFetch([
      jsonResponse(200, {
        data: { viewer: { id: 'u1', displayName: 'Dana Ops' }, organization: { name: 'Acme' } },
      }),
    ]).fetchImpl
  )
  assert.deepEqual(await okProvider.testConnection({ connectionId: CONNECTION.id }), {
    ok: true,
    summary: 'Connected as Dana Ops in Acme.',
  })

  const badProvider = makeProvider(
    fakeFetch([jsonResponse(401, { errors: [{ message: 'Invalid API key.' }] })]).fetchImpl
  )
  const probe = await badProvider.testConnection({ connectionId: CONNECTION.id })
  assert.equal(probe.ok, false)
  assert.equal(probe.reason, 'Invalid API key.')
}

async function testMissingSecretIsNotConfigured(): Promise<void> {
  const provider = makeProvider(fakeFetch([]).fetchImpl, { ok: false, message: 'no secret' })
  await assert.rejects(
    () => provider.searchIssues({ connectionId: CONNECTION.id, query: 'x' }),
    (err: unknown) => err instanceof TrackerProviderError && err.kind === 'not_configured'
  )
}

async function testWriteBackIsCapabilityGated(): Promise<void> {
  const provider = makeProvider(fakeFetch([]).fetchImpl)
  assert.deepEqual(provider.capabilities, { canComment: false, canTransition: false, selfHostable: false })
  await assert.rejects(
    () => provider.postComment({ connectionId: CONNECTION.id, externalId: 'x', body: 'hi' }),
    (err: unknown) => err instanceof TrackerProviderError && err.kind === 'unsupported'
  )
  await assert.rejects(
    () => provider.transitionIssue({ connectionId: CONNECTION.id, externalId: 'x', transitionId: 't' }),
    (err: unknown) => err instanceof TrackerProviderError && err.kind === 'unsupported'
  )
}

async function main(): Promise<void> {
  await testSearchWithTermNormalizesAndPages()
  await testSearchForwardsCursorAndStopsAtLastPage()
  await testEmptyQueryBrowsesRecentIssues()
  await testFetchIssueIncludesComments()
  await testFetchMissingIssueThrowsNotFound()
  await testAssignedToMePaginatesAndFiltersOpen()
  await testInvalidKeyHttp401IsTypedAuthError()
  await testGraphQLErrorEnvelopeMapsByExtensionType()
  await testRateLimitStatusParsesRetryAfter()
  await testTestConnectionSuccessAndFailure()
  await testMissingSecretIsNotConfigured()
  await testWriteBackIsCapabilityGated()
  console.log('linear-provider.test.ts: all assertions passed')
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
