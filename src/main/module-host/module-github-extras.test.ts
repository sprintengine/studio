import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { BrokerFetch } from './broker-http'
import {
  createModuleGitHubRegistry,
  graphqlTopLevelKeywords,
  isGitHubStorageUrl,
  pickGitHubResponseHeaders,
} from './module-github'

// The GitHub broker beyond plain REST calls: the response headers a module may
// read, conditional requests and media types, the read-only GraphQL call, and
// the download that follows GitHub's own storage redirect without the token.
// Every request is answered by a fake fetch; nothing here reaches GitHub.

const TOKEN = 'ghp_s3cretT0kenValue'

type Call = { url: string; init: RequestInit }

function harness(respond: (call: Call) => Response | Promise<Response>, permissions: string[] = ['github']) {
  const calls: Call[] = []
  const fetchImpl: BrokerFetch = async (url, init) => {
    calls.push({ url, init })
    return respond({ url, init })
  }
  const github = createModuleGitHubRegistry({
    tokenStore: { resolveToken: async () => TOKEN },
    getModulePermissions: () => permissions,
    fetch: fetchImpl,
  })
  return { calls, radar: github.forModule('pr-radar'), registry: github.registry }
}

const headersOf = (call: Call | undefined): Record<string, string> =>
  (call?.init.headers ?? {}) as Record<string, string>

const json = (value: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  })

test('only the allow-listed response headers reach the module', () => {
  assert.deepEqual(
    pickGitHubResponseHeaders({
      'x-ratelimit-remaining': '4999',
      'X-RateLimit-Reset': '1700000000',
      link: '<https://api.github.com/x?page=2>; rel="next"',
      etag: 'W/"abc"',
      'retry-after': '30',
      'set-cookie': 'session=1',
      'x-github-request-id': 'A:B',
      server: 'GitHub.com',
    }),
    {
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-reset': '1700000000',
      link: '<https://api.github.com/x?page=2>; rel="next"',
      etag: 'W/"abc"',
      'retry-after': '30',
    },
  )
})

test('an answer carries its rate-limit, pagination and etag headers', async () => {
  const { radar } = harness(() =>
    json([{ number: 1 }], {
      headers: { 'x-ratelimit-remaining': '42', link: '<https://api.github.com/x?page=2>; rel="next"', etag: '"e1"' },
    }),
  )
  const result = await radar.request({ route: '/repos/acme/app/pulls' })
  assert.ok(result.ok)
  assert.deepEqual(result.headers, {
    'x-ratelimit-remaining': '42',
    link: '<https://api.github.com/x?page=2>; rel="next"',
    etag: '"e1"',
  })
})

test('ifNoneMatch is sent, and a 304 is an answer with no data', async () => {
  const { calls, radar } = harness(() => new Response(null, { status: 304, headers: { etag: '"e1"' } }))
  const result = await radar.request({ route: '/repos/acme/app/pulls', ifNoneMatch: '"e1"' })
  assert.deepEqual(result, { ok: true, status: 304, data: null, headers: { etag: '"e1"' } })
  assert.equal(headersOf(calls[0])['If-None-Match'], '"e1"')
})

test('an etag that could split a header is refused before anything is sent', async () => {
  const { calls, radar } = harness(() => json({}))
  const result = await radar.request({ route: '/user', ifNoneMatch: '"x"\r\nX-Evil: 1' })
  assert.equal(result.ok === false && result.code, 'invalid_route')
  assert.equal(calls.length, 0)
})

test("accept takes one of GitHub's media types and nothing else", async () => {
  const { calls, radar } = harness(
    () => new Response('diff --git a/x b/x', { headers: { 'content-type': 'text/plain' } }),
  )
  const diff = await radar.request({ route: '/repos/acme/app/pulls/7', accept: 'application/vnd.github.diff' })
  assert.ok(diff.ok)
  assert.equal(diff.data, 'diff --git a/x b/x')
  assert.equal(headersOf(calls[0]).Accept, 'application/vnd.github.diff')

  const refused = await radar.request({ route: '/user', accept: 'text/html' as never })
  assert.equal(refused.ok === false && refused.code, 'invalid_route')
  assert.equal(calls.length, 1)
})

test('an http_error keeps the headers a client needs to back off', async () => {
  const { radar } = harness(() =>
    json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'retry-after': '60' } }),
  )
  const result = await radar.request({ route: '/user' })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.equal(result.code, 'http_error')
  assert.deepEqual(result.headers, { 'retry-after': '60' })
})

test('the GraphQL lexer sees top-level keywords only', () => {
  assert.deepEqual(graphqlTopLevelKeywords('query Q { viewer { login } }'), ['query', 'Q'])
  assert.deepEqual(graphqlTopLevelKeywords('{ viewer { mutation: login } }'), [])
  assert.deepEqual(graphqlTopLevelKeywords('# mutation\n{ search(query: "mutation {}") { issueCount } }'), [])
  assert.deepEqual(graphqlTopLevelKeywords('query { a(x: """ mutation { } """) }'), ['query'])
  assert.deepEqual(graphqlTopLevelKeywords('mutation M { addStar(input: {}) { clientMutationId } }'), ['mutation', 'M'])
  assert.equal(graphqlTopLevelKeywords('query'), null)
})

test('graphql sends a read to /graphql with the token', async () => {
  const { calls, radar } = harness(() =>
    json({ data: { viewer: { login: 'octo' } } }, { headers: { 'x-ratelimit-used': '1' } }),
  )
  const result = await radar.graphql('query($n: Int!) { viewer { repositories(first: $n) { totalCount } } }', {
    n: 5,
  })
  assert.deepEqual(result, {
    ok: true,
    status: 200,
    data: { data: { viewer: { login: 'octo' } } },
    headers: { 'x-ratelimit-used': '1' },
  })
  assert.equal(calls[0]?.url, 'https://api.github.com/graphql')
  assert.equal(calls[0]?.init.method, 'POST')
  assert.equal(headersOf(calls[0]).Authorization, `Bearer ${TOKEN}`)
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    query: 'query($n: Int!) { viewer { repositories(first: $n) { totalCount } } }',
    variables: { n: 5 },
  })
})

test('graphql refuses a mutation or a subscription before anything is sent', async () => {
  const { calls, radar } = harness(() => json({}))
  for (const query of [
    'mutation { addStar(input: { starrableId: "x" }) { clientMutationId } }',
    'query A { viewer { login } } mutation B { removeStar(input: {}) { clientMutationId } }',
    'subscription { x }',
    '   ',
  ]) {
    const result = await radar.graphql(query)
    assert.equal(result.ok === false && result.code, 'invalid_query', query)
  }
  assert.equal(calls.length, 0)
})

test('graphql and download need the github permission', async () => {
  const { calls, radar } = harness(() => json({}), [])
  assert.equal((await radar.graphql('{ viewer { login } }')).ok, false)
  const download = await radar.download({ route: '/repos/acme/app/actions/jobs/1/logs' })
  assert.equal(download.ok === false && download.code, 'permission_missing')
  assert.equal(calls.length, 0)
})

test('storage hosts are GitHub-owned, https, and carry no credentials', () => {
  assert.equal(isGitHubStorageUrl('https://pipelines.actions.githubusercontent.com/logs/1?sig=x'), true)
  assert.equal(isGitHubStorageUrl('https://productionresultssa1.blob.core.windows.net/x'), true)
  assert.equal(isGitHubStorageUrl('https://codeload.github.com/acme/app/zip/main'), true)
  assert.equal(isGitHubStorageUrl('http://pipelines.actions.githubusercontent.com/x'), false)
  assert.equal(isGitHubStorageUrl('https://githubusercontent.com.evil.example.net/x'), false)
  assert.equal(isGitHubStorageUrl('https://user:pass@objects.githubusercontent.com/x'), false)
  assert.equal(isGitHubStorageUrl('https://objects.githubusercontent.com:8443/x'), false)
  assert.equal(isGitHubStorageUrl('not a url'), false)
})

test('download follows the storage redirect with the token stripped', async () => {
  const storage = 'https://pipelines.actions.githubusercontent.com/logs/job-1?sig=abc'
  const { calls, radar } = harness(({ url }) =>
    url.startsWith('https://api.github.com/')
      ? new Response(null, { status: 302, headers: { location: storage, 'x-ratelimit-remaining': '7' } })
      : new Response('2026-10-09T10:00:00Z step 1\nerror: tests failed\n', {
          headers: { 'content-type': 'text/plain' },
        }),
  )
  const result = await radar.download({
    route: '/repos/{owner}/{repo}/actions/jobs/{job}/logs',
    params: { owner: 'acme', repo: 'app', job: 1 },
  })
  assert.deepEqual(result, {
    ok: true,
    status: 200,
    data: '2026-10-09T10:00:00Z step 1\nerror: tests failed\n',
    encoding: 'utf8',
    contentType: 'text/plain',
    headers: { 'x-ratelimit-remaining': '7' },
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.url, 'https://api.github.com/repos/acme/app/actions/jobs/1/logs')
  assert.equal(calls[0]?.init.redirect, 'manual')
  assert.equal(headersOf(calls[0]).Authorization, `Bearer ${TOKEN}`)
  assert.equal(calls[1]?.url, storage)
  assert.equal(calls[1]?.init.redirect, 'error', 'the storage hop follows nothing further')
  assert.equal(headersOf(calls[1]).Authorization, undefined, 'the token never goes to the storage host')
  assert.equal(JSON.stringify(calls[1]?.init.headers).includes(TOKEN), false)
})

test('download refuses a redirect off GitHub storage', async () => {
  const { calls, radar } = harness(
    () => new Response(null, { status: 302, headers: { location: 'https://evil.example.net/steal' } }),
  )
  const result = await radar.download({ route: '/repos/acme/app/actions/jobs/1/logs' })
  assert.equal(result.ok === false && result.code, 'redirect_not_allowed')
  assert.equal(calls.length, 1)
})

test('download hands bytes back as base64 when asked', async () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00])
  const { radar } = harness(({ url }) =>
    url.startsWith('https://api.github.com/')
      ? new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/acme/app/zip/main' } })
      : new Response(bytes, { headers: { 'content-type': 'application/zip' } }),
  )
  const result = await radar.download({ route: '/repos/acme/app/zipball/main', encoding: 'base64' })
  assert.ok(result.ok)
  assert.equal(result.encoding, 'base64')
  assert.deepEqual(new Uint8Array(Buffer.from(result.data, 'base64')), bytes)
})

test('download of a route that answers directly returns the body as is', async () => {
  const { calls, radar } = harness(() => new Response('# README\n', { headers: { 'content-type': 'text/plain' } }))
  const result = await radar.download({ route: '/repos/acme/app/readme', accept: 'application/vnd.github.raw' })
  assert.ok(result.ok)
  assert.equal(result.data, '# README\n')
  assert.equal(calls.length, 1)
})

test('the moduleId-first registry reaches the new methods', async () => {
  const { registry } = harness(() => json({ data: {} }))
  const result = await registry.graphql('pr-radar', '{ viewer { login } }')
  assert.equal(result.ok, true)
})
