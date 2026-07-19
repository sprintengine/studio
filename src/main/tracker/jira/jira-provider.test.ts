import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { JiraTrackerProvider, type JiraConnectionAccess } from './jira-provider'
import { TrackerProviderError, type TrackerConnection } from '../../../shared/tracker/types'

// Provider acceptance (MC-1635) against recorded fixtures + a fake fetch: the
// Cloud/Data-Center auth branch is the ONLY difference exercised, status maps by
// statusCategory, wiki/ADF bodies convert while rawBody is preserved, search and
// assigned-to-me paginate, and 401/403/429/404 degrade to typed errors carrying
// Jira's own message. Fixtures load relative to repo-root (the npm-run cwd).

const FIXTURE_DIR = 'src/main/tracker/jira/fixtures'

function loadFixture(name: string): any {
  return JSON.parse(readFileSync(join(process.cwd(), FIXTURE_DIR, `${name}.json`), 'utf8'))
}

const CLOUD: TrackerConnection = {
  id: 'trk-cloud',
  provider: 'jira',
  baseUrl: 'https://acme.atlassian.net',
  authMode: 'jira_basic',
  label: 'Acme Cloud',
}
const DC: TrackerConnection = {
  id: 'trk-dc',
  provider: 'jira',
  baseUrl: 'https://jira.internal.acme.example',
  authMode: 'jira_pat',
  label: 'Acme DC',
}

type RecordedRequest = { url: string; method: string; headers: Record<string, string>; body?: unknown }

// Builds a provider whose fetch is driven by `route`, recording every request so
// tests can assert the exact URL, auth header, and body sent.
function makeProvider(
  connection: TrackerConnection,
  secret: string | undefined,
  route: (url: URL, init: RequestInit) => Response
): { provider: JiraTrackerProvider; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const connections: JiraConnectionAccess = {
    getConnection: async (id) => (id === connection.id ? connection : undefined),
    resolveSecret: async (id) =>
      id === connection.id && secret !== undefined
        ? { ok: true, providerId: id, value: secret, source: 'settings' }
        : { ok: false, message: 'not configured' },
  }
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    requests.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return route(url, init ?? {})
  }) as unknown as typeof fetch
  return { provider: new JiraTrackerProvider({ connections, fetchImpl }), requests }
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers })
}

function basicHeader(secret: string): string {
  return `Basic ${Buffer.from(secret).toString('base64')}`
}

async function testFetchIssueCloudWiki(): Promise<void> {
  const fixture = loadFixture('cloud-issue')
  const secret = 'dana@acme.example:token-123'
  const { provider, requests } = makeProvider(CLOUD, secret, (url) => {
    assert.ok(url.pathname.endsWith('/rest/api/2/issue/10023'), `unexpected path ${url.pathname}`)
    return jsonResponse(fixture)
  })

  const issue = await provider.fetchIssue({ connectionId: CLOUD.id, externalId: '10023' })

  assert.equal(issue.externalId, '10023')
  assert.equal(issue.nativeKey, 'PROJ-17')
  assert.equal(issue.title, 'Checkout total ignores currency rounding')
  // statusCategory 'indeterminate' → open, DESPITE the display name 'Ship it'.
  assert.deepEqual(issue.state, { category: 'open', nativeName: 'Ship it' })
  assert.equal(issue.priority, 'High')
  assert.deepEqual(issue.labels, ['billing', 'regression'])
  assert.equal(issue.assignee?.displayName, 'Dana Rivera')
  assert.equal(issue.url, 'https://acme.atlassian.net/browse/PROJ-17')
  // Body converts best-effort AND the raw wiki is preserved verbatim.
  assert.equal(issue.rawBody, fixture.fields.description)
  assert.ok(issue.bodyMarkdown.includes('## Summary'))
  assert.ok(issue.bodyMarkdown.includes('**total**'))
  assert.ok(issue.bodyMarkdown.includes('```java'))
  assert.equal(issue.comments.length, 2)
  assert.ok(issue.comments[0].body.includes('`PriceFormatter.round`'))
  assert.equal(issue.comments[0].author, 'Sam Okoro')
  // Cloud → Basic auth from the colon-joined email:token secret.
  assert.equal(requests[0].headers.Authorization, basicHeader(secret))
  assert.ok(requests[0].url.includes('fields=summary'))
}

async function testAuthBranchIsTheOnlyDataCenterDifference(): Promise<void> {
  const fixture = loadFixture('datacenter-issue')
  const { provider, requests } = makeProvider(DC, 'pat-xyz', (url) => {
    assert.ok(url.pathname.endsWith('/rest/api/2/issue/44120'))
    return jsonResponse(fixture)
  })

  const issue = await provider.fetchIssue({ connectionId: DC.id, externalId: '44120' })

  // Same normalization path as Cloud; only the header changed.
  assert.equal(requests[0].headers.Authorization, 'Bearer pat-xyz')
  assert.equal(issue.nativeKey, 'OPS-902')
  assert.deepEqual(issue.state, { category: 'open', nativeName: 'Backlog' })
  assert.equal(issue.assignee?.id, 'jkraft')
  assert.equal(issue.assignee?.displayName, 'Jordan Kraft')
  assert.equal(issue.url, 'https://jira.internal.acme.example/browse/OPS-902')
}

async function testFetchIssueAdf(): Promise<void> {
  const fixture = loadFixture('adf-issue')
  const { provider } = makeProvider(CLOUD, 'e:t', () => jsonResponse(fixture))

  const issue = await provider.fetchIssue({ connectionId: CLOUD.id, externalId: '10099' })

  // statusCategory 'done' → closed, DESPITE display name 'In Review'.
  assert.deepEqual(issue.state, { category: 'closed', nativeName: 'In Review' })
  assert.equal(issue.assignee, undefined) // null assignee normalizes away
  assert.equal(issue.rawBody, JSON.stringify(fixture.fields.description))
  assert.ok(issue.bodyMarkdown.includes('## What happens'))
  assert.ok(issue.bodyMarkdown.includes('**escaped tags**'))
  assert.ok(issue.bodyMarkdown.includes('[template](https://example.com/tpl)'))
  assert.ok(issue.bodyMarkdown.includes('- Affects new signups only'))
  assert.ok(issue.bodyMarkdown.includes('```html'))
}

async function testSearchPaginatesWithStartAt(): Promise<void> {
  const page1 = loadFixture('search-page1')
  const page2 = loadFixture('search-page2')
  const { provider, requests } = makeProvider(CLOUD, 'e:t', (url) => {
    assert.ok(url.pathname.endsWith('/rest/api/2/search'))
    return jsonResponse(url.searchParams.get('startAt') === '0' ? page1 : page2)
  })

  const first = await provider.searchIssues({ connectionId: CLOUD.id, query: 'rounding' })
  assert.equal(first.issues.length, 2)
  assert.equal(first.nextCursor, '2')
  assert.equal(requests[0].url.match(/[?&]startAt=0(&|$)/) !== null, true)
  assert.equal(new URL(requests[0].url).searchParams.get('jql'), 'text ~ "rounding" ORDER BY updated DESC')

  const second = await provider.searchIssues({ connectionId: CLOUD.id, query: 'rounding', cursor: '2' })
  assert.equal(second.issues.length, 1)
  assert.equal(second.nextCursor, undefined) // startAt(2) + 1 === total(3)
  assert.equal(new URL(requests[1].url).searchParams.get('startAt'), '2')
}

async function testListAssignedToMeWalksAllPages(): Promise<void> {
  const page1 = loadFixture('search-page1')
  const page2 = loadFixture('search-page2')
  const { provider, requests } = makeProvider(CLOUD, 'e:t', (url) =>
    jsonResponse(url.searchParams.get('startAt') === '0' ? page1 : page2)
  )

  const issues = await provider.listAssignedToMe({ connectionId: CLOUD.id })
  assert.equal(issues.length, 3)
  assert.equal(
    new URL(requests[0].url).searchParams.get('jql'),
    'assignee = currentUser() AND resolution = EMPTY ORDER BY updated DESC'
  )
}

async function assertProviderError(
  fn: () => Promise<unknown>,
  expected: { kind: string; messageIncludes?: string; retryAfterSeconds?: number }
): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof TrackerProviderError, 'expected a TrackerProviderError')
    assert.equal(err.kind, expected.kind)
    assert.equal(err.provider, 'jira')
    assert.ok(err.connectionId, 'connectionId is carried')
    if (expected.messageIncludes) assert.ok(err.message.includes(expected.messageIncludes), err.message)
    if (expected.retryAfterSeconds !== undefined) assert.equal(err.retryAfterSeconds, expected.retryAfterSeconds)
    return true
  })
}

async function testErrorsDegradeToTypedProviderErrors(): Promise<void> {
  const error401 = loadFixture('error-401')
  const auth = makeProvider(CLOUD, 'e:t', () => jsonResponse(error401, 401))
  await assertProviderError(() => auth.provider.fetchIssue({ connectionId: CLOUD.id, externalId: '10023' }), {
    kind: 'auth',
    messageIncludes: 'credentials are invalid',
  })

  const rate = makeProvider(CLOUD, 'e:t', () => jsonResponse({ errorMessages: ['Too many'] }, 429, { 'Retry-After': '42' }))
  await assertProviderError(() => rate.provider.searchIssues({ connectionId: CLOUD.id, query: 'x' }), {
    kind: 'rate_limit',
    messageIncludes: 'Too many',
    retryAfterSeconds: 42,
  })

  const error404 = loadFixture('error-404')
  const missing = makeProvider(CLOUD, 'e:t', () => jsonResponse(error404, 404))
  await assertProviderError(() => missing.provider.fetchIssue({ connectionId: CLOUD.id, externalId: 'PROJ-999' }), {
    kind: 'not_found',
    messageIncludes: 'does not exist',
  })
}

async function testTestConnectionProbe(): Promise<void> {
  const me = loadFixture('myself')
  const ok = makeProvider(CLOUD, 'e:t', (url) => {
    assert.ok(url.pathname.endsWith('/rest/api/2/myself'))
    return jsonResponse(me)
  })
  const probe = await ok.provider.testConnection({ connectionId: CLOUD.id })
  assert.equal(probe.ok, true)
  assert.ok(probe.summary?.includes('Dana Rivera'))

  const bad = makeProvider(CLOUD, 'e:t', () => jsonResponse(loadFixture('error-401'), 403))
  const failProbe = await bad.provider.testConnection({ connectionId: CLOUD.id })
  assert.equal(failProbe.ok, false)
  assert.ok(failProbe.reason?.includes('credentials are invalid'))
}

async function testWriteBackCallsShapeRequests(): Promise<void> {
  const comment = makeProvider(CLOUD, 'e:t', () => jsonResponse({ id: '99' }, 201))
  await comment.provider.postComment({ connectionId: CLOUD.id, externalId: '10023', body: 'On it.' })
  assert.equal(comment.requests[0].method, 'POST')
  assert.ok(comment.requests[0].url.endsWith('/rest/api/2/issue/10023/comment'))
  assert.deepEqual(comment.requests[0].body, { body: 'On it.' })

  const transition = makeProvider(CLOUD, 'e:t', () => jsonResponse(null, 204))
  await transition.provider.transitionIssue({ connectionId: CLOUD.id, externalId: '10023', transitionId: '31' })
  assert.equal(transition.requests[0].method, 'POST')
  assert.ok(transition.requests[0].url.endsWith('/rest/api/2/issue/10023/transitions'))
  assert.deepEqual(transition.requests[0].body, { transition: { id: '31' } })

  const list = makeProvider(CLOUD, 'e:t', () => jsonResponse(loadFixture('transitions')))
  const transitions = await list.provider.listTransitions({ connectionId: CLOUD.id, externalId: '10023' })
  assert.deepEqual(transitions, [
    { id: '11', name: 'To Do' },
    { id: '21', name: 'In Progress' },
    { id: '31', name: 'Done' },
  ])
}

async function testMissingConnectionAndSecret(): Promise<void> {
  const noConnection = makeProvider(CLOUD, 'e:t', () => jsonResponse({}))
  await assertProviderError(() => noConnection.provider.fetchIssue({ connectionId: 'nope', externalId: '1' }), {
    kind: 'not_configured',
  })

  const noSecret = makeProvider(CLOUD, undefined, () => jsonResponse({}))
  await assertProviderError(() => noSecret.provider.fetchIssue({ connectionId: CLOUD.id, externalId: '1' }), {
    kind: 'auth',
  })
}

function testCapabilities(): void {
  const { provider } = makeProvider(CLOUD, 'e:t', () => jsonResponse({}))
  assert.equal(provider.provider, 'jira')
  assert.deepEqual(provider.capabilities, { canComment: true, canTransition: true, selfHostable: true })
}

async function main(): Promise<void> {
  await testFetchIssueCloudWiki()
  await testAuthBranchIsTheOnlyDataCenterDifference()
  await testFetchIssueAdf()
  await testSearchPaginatesWithStartAt()
  await testListAssignedToMeWalksAllPages()
  await testErrorsDegradeToTypedProviderErrors()
  await testTestConnectionProbe()
  await testWriteBackCallsShapeRequests()
  await testMissingConnectionAndSecret()
  testCapabilities()
  console.log('tracker-jira-provider tests passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
