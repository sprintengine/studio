import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { BrokerFetch } from './broker-http'
import { buildGitHubPath, createModuleGitHubRegistry } from './module-github'

const TOKEN = 'ghp_s3cretT0kenValue'

type Call = { url: string; init: RequestInit }

function harness(
  options: {
    token?: string
    permissions?: Record<string, string[]>
    respond?: (call: Call) => Response | Promise<Response>
    now?: () => number
  } = {},
) {
  const calls: Call[] = []
  const fetchImpl: BrokerFetch = async (url, init) => {
    calls.push({ url, init })
    return options.respond
      ? options.respond({ url, init })
      : new Response('{"login":"octo"}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const github = createModuleGitHubRegistry({
    tokenStore: { resolveToken: async () => options.token ?? TOKEN },
    getModulePermissions: (id) => (options.permissions ?? { reviews: ['github'] })[id],
    fetch: fetchImpl,
    ...(options.now ? { now: options.now } : {}),
  })
  return { calls, github, reviews: github.forModule('reviews') }
}

test('a request goes to api.github.com with the token attached and never returns it', async () => {
  const { calls, reviews } = harness({
    respond: () => new Response(JSON.stringify([{ number: 7 }]), { headers: { 'content-type': 'application/json' } }),
  })
  const result = await reviews.request({
    route: '/repos/{owner}/{repo}/pulls',
    params: { owner: 'acme', repo: 'studio', state: 'open', per_page: 50 },
  })
  assert.deepEqual(result, { ok: true, status: 200, data: [{ number: 7 }], headers: {} })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.github.com/repos/acme/studio/pulls?state=open&per_page=50')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`)
  assert.equal(JSON.stringify(result).includes(TOKEN), false)
})

test('params are URL-encoded into their placeholders', async () => {
  const { calls, reviews } = harness()
  await reviews.request({
    route: '/repos/{owner}/{repo}/contents/{path}',
    params: { owner: 'acme', repo: 'studio', path: 'docs/a b?#.md' },
  })
  assert.equal(calls[0].url, 'https://api.github.com/repos/acme/studio/contents/docs%2Fa%20b%3F%23.md')
})

test('a body is sent as JSON for writes', async () => {
  const { calls, reviews } = harness({ respond: () => new Response(null, { status: 204 }) })
  const result = await reviews.request({
    method: 'POST',
    route: '/repos/{owner}/{repo}/issues/{issue}/comments',
    params: { owner: 'acme', repo: 'studio', issue: 12 },
    body: { body: 'Looks good' },
  })
  assert.deepEqual(result, { ok: true, status: 204, data: null, headers: {} })
  assert.equal(calls[0].init.body, '{"body":"Looks good"}')
  assert.equal((calls[0].init.headers as Record<string, string>)['Content-Type'], 'application/json')
})

test('a route cannot leave api.github.com or climb out of its path', async () => {
  const { calls, reviews } = harness()
  const refused: Array<{ route: string; params?: Record<string, string> }> = [
    { route: 'https://evil.example.net/x' },
    { route: '//evil.example.net/x' },
    { route: '/repos/../user' },
    { route: '/repos/./user' },
    { route: '/repos//x' },
    { route: '/a\\b' },
    { route: '/repos/%2e%2e/user' },
    { route: '/search?q=x' },
    { route: '/x#frag' },
    { route: '/x@evil.example.net' },
    { route: '/x:y' },
    { route: '/repos/{owner}', params: { owner: '..' } },
    { route: '/repos/{owner}', params: { owner: '.' } },
    { route: '/repos/{owner}', params: {} },
    { route: '/repos/{owner-name}', params: { 'owner-name': 'x' } },
    { route: 'repos' },
  ]
  for (const request of refused) {
    const result = await reviews.request(request as never)
    assert.equal(result.ok === false && result.code, 'invalid_route', request.route)
  }
  assert.equal(calls.length, 0)

  // A value that would be a host or a path elsewhere stays one segment here.
  await reviews.request({ route: '/users/{user}', params: { user: '//evil.example.net/x' } })
  const url = new URL(calls[0].url)
  assert.equal(url.origin, 'https://api.github.com')
  assert.equal(url.pathname, '/users/%2F%2Fevil.example.net%2Fx')
})

test('buildGitHubPath leaves unused params for the query string', () => {
  assert.deepEqual(buildGitHubPath('/user/repos', { per_page: 10, archived: false }), {
    ok: true,
    path: '/user/repos',
    query: [
      ['per_page', '10'],
      ['archived', 'false'],
    ],
  })
})

test('no token means not_signed_in, before anything is sent', async () => {
  const { calls, reviews } = harness({ token: '' })
  const result = await reviews.request({ route: '/user' })
  assert.equal(result.ok === false && result.code, 'not_signed_in')
  assert.deepEqual(await reviews.status(), { signedIn: false })
  assert.equal(calls.length, 0)
})

test('the github permission gates both calls', async () => {
  const { calls, github } = harness({ permissions: { reviews: ['storage'] } })
  const service = github.forModule('reviews')
  const result = await service.request({ route: '/user' })
  assert.equal(result.ok === false && result.code, 'permission_missing')
  await assert.rejects(service.status(), /"github" permission/)
  const unknown = await github.registry.request('stranger', { route: '/user' })
  assert.equal(unknown.ok === false && unknown.code, 'permission_missing')
  assert.equal(calls.length, 0)
})

test("an error answer carries GitHub's message and status, never the token", async () => {
  const { reviews } = harness({
    respond: () =>
      new Response(JSON.stringify({ message: `Bad credentials for ${TOKEN}` }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
  })
  const result = await reviews.request({ route: '/user' })
  assert.equal(result.ok === false && result.code, 'http_error')
  assert.equal(result.ok === false && result.status, 401)
  assert.equal(JSON.stringify(result).includes(TOKEN), false)
})

test('a redirect is refused, a failure is not quoted, and an oversized answer is not read', async () => {
  const redirect = harness({
    respond: () => new Response(null, { status: 301, headers: { location: 'https://evil.example.net/' } }),
  })
  const redirected = await redirect.reviews.request({ route: '/user' })
  assert.equal(redirected.ok === false && redirected.code, 'network_error')

  const thrown = harness({
    respond: () => {
      throw new Error(`connect failed with Authorization: Bearer ${TOKEN}`)
    },
  })
  const failed = await thrown.reviews.request({ route: '/user' })
  assert.equal(failed.ok === false && failed.code, 'network_error')
  assert.equal(JSON.stringify(failed).includes(TOKEN), false)

  const huge = harness({
    respond: () => new Response('x', { headers: { 'content-length': String(9 * 1024 * 1024) } }),
  })
  const tooBig = await huge.reviews.request({ route: '/user' })
  assert.equal(tooBig.ok === false && tooBig.code, 'network_error')
  assert.match(tooBig.ok === false ? tooBig.message : '', /8 MiB/)
})

test('status reports the login and caches it per token', async () => {
  let clock = 0
  const { calls, reviews } = harness({ now: () => clock })
  assert.deepEqual(await reviews.status(), { signedIn: true, login: 'octo' })
  assert.deepEqual(await reviews.status(), { signedIn: true, login: 'octo' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.github.com/user')
  clock += 10 * 60_000
  await reviews.status()
  assert.equal(calls.length, 2)

  const revoked = harness({ respond: () => new Response('{}', { status: 401 }) })
  assert.deepEqual(await revoked.reviews.status(), { signedIn: false })
})
