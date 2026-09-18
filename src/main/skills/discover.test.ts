import assert from 'node:assert/strict'

import { createSkillDiscoveryClient } from './discover'

type Call = { url: string; headers: Record<string, string> }

type Reply = {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

function stubGitHub(replies: (call: Call) => Reply): { calls: Call[]; fetcher: typeof fetch } {
  const calls: Call[] = []
  const fetcher = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    const call = { url, headers }
    calls.push(call)
    const reply = replies(call)
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers },
    })
  }) as unknown as typeof fetch
  return { calls, fetcher }
}

function codeSearchBody(items: unknown[]): unknown {
  return { total_count: items.length, incomplete_results: false, items }
}

const PDF_HIT = {
  path: 'skills/pdf-processing/SKILL.md',
  html_url: 'https://github.com/anthropics/skills/blob/main/skills/pdf-processing/SKILL.md',
  repository: { full_name: 'anthropics/skills', description: 'Skills for Claude' },
  text_matches: [
    {
      property: 'content',
      fragment: 'name: pdf-processing\ndescription: Extract text from PDFs, fill forms, and merge documents.\n',
    },
  ],
}

async function findsSkillsNotRepositories(): Promise<void> {
  const github = stubGitHub(() => ({ body: codeSearchBody([PDF_HIT]) }))
  const client = createSkillDiscoveryClient({ fetcher: github.fetcher })

  const found = await client.searchSkills('extract text from PDFs', 'ghp_token')

  assert.equal(github.calls.length, 1, 'a row is rendered from the search response alone, with no second fetch')
  const url = new URL(github.calls[0].url)
  assert.equal(url.pathname, '/search/code')
  assert.equal(url.searchParams.get('q'), 'extract text from PDFs filename:SKILL.md')
  assert.match(github.calls[0].headers.accept, /text-match\+json/)
  assert.equal(github.calls[0].headers.authorization, 'Bearer ghp_token')

  assert.equal(found.degraded, null)
  assert.deepEqual(found.results, [
    {
      repo: 'anthropics/skills',
      path: 'skills/pdf-processing/SKILL.md',
      skillId: 'skills/pdf-processing',
      name: 'pdf-processing',
      description: 'Extract text from PDFs, fill forms, and merge documents.',
      htmlUrl: 'https://github.com/anthropics/skills/blob/main/skills/pdf-processing/SKILL.md',
    },
  ])
  assert.ok(!('skillCount' in found.results[0]), 'a hit carries no skill count — the repo has not been scanned')
  console.log('ok - code search returns skills with name and description from the matched fragment')
}

async function readsAFoldedDescription(): Promise<void> {
  const github = stubGitHub(() => ({
    body: codeSearchBody([
      {
        ...PDF_HIT,
        text_matches: [
          {
            fragment:
              'name: robust-pdf-read\ndescription: >-\n  Read a PDF that other readers\n  give up on.\nallowed-tools: Read\n',
          },
        ],
      },
    ]),
  }))
  const client = createSkillDiscoveryClient({ fetcher: github.fetcher })

  const found = await client.searchSkills('pdf', 'ghp_token')
  assert.equal(found.results[0].name, 'robust-pdf-read')
  assert.equal(found.results[0].description, 'Read a PDF that other readers give up on.')
  console.log('ok - a folded frontmatter description still reads')
}

async function saysItNeedsATokenInsteadOfSearchingEmpty(): Promise<void> {
  const github = stubGitHub(() => ({ body: codeSearchBody([]) }))
  const client = createSkillDiscoveryClient({ fetcher: github.fetcher })

  const found = await client.searchSkills('extract text from PDFs', '')

  assert.equal(
    github.calls.length,
    0,
    'code search needs authentication, so an anonymous request is not worth spending',
  )
  assert.deepEqual(found.results, [])
  assert.equal(found.degraded?.reason, 'needs_token')
  assert.match(found.degraded?.message ?? '', /Settings/, 'the condition points at where the token is entered')
  console.log('ok - searching without a token states the missing credential')
}

async function browsesUnauthenticatedAndStillFlagsTheMissingToken(): Promise<void> {
  const github = stubGitHub((call) => ({
    body: {
      items: [
        {
          full_name: 'browser-act/skills',
          description: 'Browser skills',
          stargazers_count: 4900,
          html_url: 'https://github.com/browser-act/skills',
        },
        {
          full_name: 'pbakaus/impeccable',
          description: 'One skill',
          stargazers_count: 52000,
          html_url: 'https://github.com/pbakaus/impeccable',
        },
      ].filter(() => new URL(call.url).searchParams.get('q') === 'topic:claude-skills'),
    },
  }))
  const client = createSkillDiscoveryClient({ fetcher: github.fetcher })

  const browsed = await client.listPopularSkillRepos('')

  assert.equal(github.calls.length, 2, 'both topic searches run unauthenticated; the code search does not')
  assert.ok(github.calls.every((call) => call.headers.authorization === undefined))
  assert.deepEqual(
    browsed.results.map((hit) => hit.repo),
    ['pbakaus/impeccable', 'browser-act/skills'],
    'most starred first',
  )
  assert.equal(browsed.degraded?.reason, 'needs_token', 'the curated list is the part a token unlocks')
  assert.ok(browsed.results.every((hit) => hit.curated === false))
  console.log('ok - repo search works unauthenticated while the curated list states it needs a token')
}

async function putsCuratedRepositoriesFirstWithoutInventingStars(): Promise<void> {
  const github = stubGitHub((call) => {
    const url = new URL(call.url)
    if (url.pathname === '/search/code') {
      return {
        body: {
          items: [
            {
              path: '.claude-plugin/marketplace.json',
              repository: { full_name: 'obra/superpowers', description: 'A curated marketplace' },
            },
          ],
        },
      }
    }
    return {
      body: {
        items:
          url.searchParams.get('q') === 'topic:claude-skills'
            ? [
                {
                  full_name: 'claude-mem/claude-mem',
                  description: 'Not a skill collection',
                  stargazers_count: 88000,
                  html_url: 'https://github.com/claude-mem/claude-mem',
                },
              ]
            : [],
      },
    }
  })
  const client = createSkillDiscoveryClient({ fetcher: github.fetcher })

  const browsed = await client.listPopularSkillRepos('ghp_token')

  assert.deepEqual(
    browsed.results.map((hit) => hit.repo),
    ['obra/superpowers', 'claude-mem/claude-mem'],
  )
  assert.equal(browsed.results[0].curated, true)
  assert.equal(
    browsed.results[0].stars,
    null,
    'code search does not report stars, and an unknown count must not render as zero',
  )
  assert.equal(browsed.results[1].stars, 88000)
  assert.equal(browsed.degraded, null)
  console.log('ok - a curated repository leads the list and carries no invented star count')
}

async function statesRateLimitExhaustion(): Promise<void> {
  const resetAt = Math.floor(Date.now() / 1000) + 120
  const github = stubGitHub(() => ({
    status: 403,
    body: { message: 'API rate limit exceeded' },
    headers: {
      'x-ratelimit-limit': '10',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(resetAt),
    },
  }))
  const client = createSkillDiscoveryClient({ fetcher: github.fetcher })

  const found = await client.searchSkills('extract text from PDFs', 'ghp_token')

  assert.deepEqual(found.results, [])
  assert.equal(
    found.degraded?.reason,
    'rate_limited',
    'an exhausted budget is never an empty list that reads as no matches',
  )
  assert.ok((found.degraded?.retryAfterSeconds ?? 0) > 0)
  assert.deepEqual(found.rateLimit, { limit: 10, remaining: 0, resetAt: new Date(resetAt * 1000).toISOString() })

  // The window reopens in under a minute, so the refusal must not be cached.
  const again = await client.searchSkills('extract text from PDFs', 'ghp_token')
  assert.equal(github.calls.length, 2)
  assert.equal(again.degraded?.reason, 'rate_limited')
  console.log('ok - rate-limit exhaustion is stated, and not cached past its window')
}

async function statesAnAbandonedSearch(): Promise<void> {
  const github = stubGitHub(() => ({ body: { total_count: 0, incomplete_results: true, items: [] } }))
  const client = createSkillDiscoveryClient({ fetcher: github.fetcher })

  const found = await client.searchSkills('extract text from PDFs', 'ghp_token')
  assert.deepEqual(found.results, [])
  assert.equal(
    found.degraded?.reason,
    'unavailable',
    'GitHub gives up on a slow search with HTTP 200 and a short list — unstated, that reads as no matches',
  )

  // A partial answer is not the answer, so it is not what the next query gets.
  await client.searchSkills('extract text from PDFs', 'ghp_token')
  assert.equal(github.calls.length, 2)
  console.log('ok - a search GitHub abandoned says so instead of reading as no matches')
}

async function keepsARejectedCredentialApartFromAnExhaustedBudget(): Promise<void> {
  const github = stubGitHub(() => ({
    status: 403,
    body: { message: 'Bad credentials' },
    // The budget is only half-reported, so it must not be read as 0 remaining.
    headers: { 'x-ratelimit-limit': '10' },
  }))
  const client = createSkillDiscoveryClient({ fetcher: github.fetcher })

  const found = await client.searchSkills('extract text from PDFs', 'ghp_expired')
  assert.equal(found.rateLimit, null)
  assert.equal(found.degraded?.reason, 'needs_token', 'a rejected token is a credential problem, not a spent budget')
  console.log('ok - a rejected credential is not reported as a used-up limit')
}

async function repeatsWithinTheCacheWindowMakeNoRequest(): Promise<void> {
  let clock = 1_000_000
  const github = stubGitHub(() => ({ body: codeSearchBody([PDF_HIT]) }))
  const client = createSkillDiscoveryClient({
    fetcher: github.fetcher,
    cacheTtlMs: 60_000,
    now: () => clock,
  })

  const first = await client.searchSkills('extract text from PDFs', 'ghp_token')
  const second = await client.searchSkills('  Extract text from   PDFs ', 'ghp_token')
  assert.equal(github.calls.length, 1, 'the same query inside the window is answered from cache')
  assert.deepEqual(second.results, first.results)

  clock += 60_001
  await client.searchSkills('extract text from PDFs', 'ghp_token')
  assert.equal(github.calls.length, 2, 'past the window the query is asked again')

  // A token added in Settings changes what the same query can return, so the
  // anonymous refusal must not be served back to an authenticated caller.
  const anonymous = await client.searchSkills('extract text from PDFs', '')
  assert.equal(anonymous.degraded?.reason, 'needs_token')
  assert.equal(github.calls.length, 2)
  console.log('ok - a repeated query inside the cache window makes no second request')
}

async function refusesAQueryTooShortToSearch(): Promise<void> {
  const github = stubGitHub(() => ({ body: codeSearchBody([]) }))
  const client = createSkillDiscoveryClient({ fetcher: github.fetcher })

  const found = await client.searchSkills('pd', 'ghp_token')
  assert.equal(github.calls.length, 0)
  assert.equal(found.degraded?.reason, 'query_too_short')
  console.log('ok - too short a query says so rather than spending a search')
}

async function reportsAnUnreachableGitHub(): Promise<void> {
  const client = createSkillDiscoveryClient({
    fetcher: (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com')
    }) as unknown as typeof fetch,
  })

  const found = await client.searchSkills('extract text from PDFs', 'ghp_token')
  assert.deepEqual(found.results, [])
  assert.equal(found.degraded?.reason, 'unavailable')
  assert.match(found.degraded?.message ?? '', /ENOTFOUND/)
  console.log('ok - an unreachable GitHub is a stated condition')
}

async function main(): Promise<void> {
  await findsSkillsNotRepositories()
  await readsAFoldedDescription()
  await saysItNeedsATokenInsteadOfSearchingEmpty()
  await browsesUnauthenticatedAndStillFlagsTheMissingToken()
  await putsCuratedRepositoriesFirstWithoutInventingStars()
  await statesRateLimitExhaustion()
  await statesAnAbandonedSearch()
  await keepsARejectedCredentialApartFromAnExhaustedBudget()
  await repeatsWithinTheCacheWindowMakeNoRequest()
  await refusesAQueryTooShortToSearch()
  await reportsAnUnreachableGitHub()
  console.log('skills discover tests passed')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
