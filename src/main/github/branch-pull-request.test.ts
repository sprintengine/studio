import assert from 'node:assert/strict'

import { listBranchPullRequests, readPullRequestState } from './branch-pull-request'
import type { GhResult, GhRunner } from './gh'

// A fake `gh` throughout: no subprocess, no network, no repository. What is
// under test is what the app CONCLUDES from an answer — including the answers
// that mean "I could not ask".

const NOW = Date.parse('2026-09-09T12:00:00.000Z')

type Call = { args: string[]; cwd?: string }

function ghStub(reply: (call: Call) => GhResult): { gh: GhRunner; calls: Call[] } {
  const calls: Call[] = []
  const gh: GhRunner = {
    available: async () => true,
    run: async (args, options) => {
      const call: Call = { args, ...(options?.cwd ? { cwd: options.cwd } : {}) }
      calls.push(call)
      return reply(call)
    },
  }
  return { gh, calls }
}

function ok(stdout: string): GhResult {
  return { found: true, code: 0, stdout, stderr: '' }
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    url: 'https://github.com/acme/app/pull/12',
    title: 'Teach the sidebar to say where the work went',
    state: 'OPEN',
    isDraft: false,
    createdAt: '2026-09-08T10:00:00.000Z',
    mergedAt: null,
    closedAt: null,
    ...overrides,
  }
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // The query, and the three states. A draft is an OPEN pull request wearing
  // `isDraft` — never a fourth state (decision 1).
  // -------------------------------------------------------------------------
  {
    const { gh, calls } = ghStub(() =>
      ok(
        JSON.stringify([
          row(),
          row({ number: 11, url: 'https://github.com/acme/app/pull/11', state: 'OPEN', isDraft: true, createdAt: '2026-09-07T10:00:00.000Z' }),
          row({ number: 10, url: 'https://github.com/acme/app/pull/10', state: 'MERGED', createdAt: '2026-09-06T10:00:00.000Z', mergedAt: '2026-09-06T18:00:00.000Z' }),
          row({ number: 9, url: 'https://github.com/acme/app/pull/9', state: 'CLOSED', createdAt: '2026-09-05T10:00:00.000Z', closedAt: '2026-09-05T18:00:00.000Z' }),
        ]),
      ),
    )
    const read = await listBranchPullRequests({ gitRoot: '/repo/worktree', branch: 'feature/marks' }, { gh, now: () => NOW })

    assert.deepEqual(calls[0].args, [
      'pr',
      'list',
      '--head',
      'feature/marks',
      '--state',
      'all',
      '--json',
      'number,url,title,state,isDraft,createdAt,mergedAt,closedAt',
    ])
    assert.equal(calls[0].cwd, '/repo/worktree', 'the read runs in the session\'s own checkout')
    assert.equal(read.settled, true)
    if (!read.settled) return
    assert.equal(read.pullRequests.length, 4, 'a branch may carry several pull requests, and every one is kept')
    assert.deepEqual(
      read.pullRequests.map((pr) => [pr.number, pr.state, pr.isDraft]),
      [
        [12, 'open', false],
        [11, 'open', true],
        [10, 'merged', false],
        [9, 'closed', false],
      ],
      'newest first, with MERGED/CLOSED/OPEN mapped and draft carried as a flag',
    )
    assert.equal(read.pullRequests[0].title, 'Teach the sidebar to say where the work went')
    assert.equal(read.pullRequests[0].openedAt, Date.parse('2026-09-08T10:00:00.000Z'))
    assert.equal(read.pullRequests[0].stateAt, NOW, 'stateAt is when GitHub was asked')
    assert.equal(read.pullRequests[0].openedBySessionId, undefined, 'a lookup names no session')
  }

  // A pull request whose payload says CLOSED but carries a mergedAt is merged.
  {
    const { gh } = ghStub(() => ok(JSON.stringify([row({ state: 'CLOSED', mergedAt: '2026-09-08T20:00:00.000Z' })])))
    const read = await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh, now: () => NOW })
    assert.equal(read.settled && read.pullRequests[0].state, 'merged')
  }

  // A draft flag on a merged pull request is dropped: only an open one can be a draft.
  {
    const { gh } = ghStub(() => ok(JSON.stringify([row({ state: 'MERGED', isDraft: true, mergedAt: '2026-09-08T20:00:00.000Z' })])))
    const read = await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh, now: () => NOW })
    assert.equal(read.settled && read.pullRequests[0].isDraft, false)
  }

  // -------------------------------------------------------------------------
  // Empty is an ANSWER: this branch has no pull request, and the caller may
  // write that down.
  // -------------------------------------------------------------------------
  {
    const { gh } = ghStub(() => ok('[]'))
    const read = await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh, now: () => NOW })
    assert.deepEqual(read, { settled: true, pullRequests: [] })
  }

  // -------------------------------------------------------------------------
  // "Could not ask" is NOT an empty list. Each of these must leave the caller's
  // record untouched.
  // -------------------------------------------------------------------------
  {
    const missing = ghStub(() => ({ found: false, code: -1, stdout: '', stderr: '' }))
    assert.deepEqual(
      await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh: missing.gh, now: () => NOW }),
      { settled: false, reason: 'gh-missing' },
      'gh not installed is unsettled, never "no pull request"',
    )

    const failed = ghStub(() => ({ found: true, code: 1, stdout: '', stderr: 'could not determine base repository' }))
    assert.deepEqual(
      await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh: failed.gh, now: () => NOW }),
      { settled: false, reason: 'gh-failed' },
    )

    const garbage = ghStub(() => ok('not json at all'))
    assert.deepEqual(
      await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh: garbage.gh, now: () => NOW }),
      { settled: false, reason: 'bad-output' },
    )

    const threw = ghStub(() => {
      throw new Error('spawn exploded')
    })
    assert.deepEqual(
      await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh: threw.gh, now: () => NOW }),
      { settled: false, reason: 'gh-failed' },
    )

    const hangs: GhRunner = { available: async () => true, run: () => new Promise<GhResult>(() => {}) }
    assert.deepEqual(
      await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh: hangs, now: () => NOW, timeoutMs: 1 }),
      { settled: false, reason: 'timeout' },
      'a hover never waits behind an offline laptop',
    )
  }

  // A question we cannot ask never reaches `gh` at all.
  {
    const { gh, calls } = ghStub(() => ok('[]'))
    assert.deepEqual(await listBranchPullRequests({ gitRoot: '/repo', branch: '' }, { gh }), {
      settled: false,
      reason: 'bad-request',
    })
    assert.deepEqual(await listBranchPullRequests({ gitRoot: '/repo', branch: '--state' }, { gh }), {
      settled: false,
      reason: 'bad-request',
    })
    assert.deepEqual(await listBranchPullRequests({ gitRoot: '', branch: 'feature' }, { gh }), {
      settled: false,
      reason: 'bad-request',
    })
    assert.equal(calls.length, 0, 'a flag-shaped branch is never handed to gh')
  }

  // -------------------------------------------------------------------------
  // GitHub Enterprise Server: the host the checkout's remote uses is the host
  // the record keys on. Nothing is rewritten to github.com.
  // -------------------------------------------------------------------------
  {
    const { gh } = ghStub(() =>
      ok(JSON.stringify([row({ url: 'https://ghe.corp.example.com/acme/app/pull/12/files?w=1' })])),
    )
    const read = await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh, now: () => NOW })
    assert.equal(
      read.settled && read.pullRequests[0].url,
      'https://ghe.corp.example.com/acme/app/pull/12',
      'the enterprise host passes through, canonicalised by the one URL parser',
    )
  }

  // A row we cannot key or cannot state is skipped; the rest of the answer stands.
  {
    const { gh } = ghStub(() =>
      ok(JSON.stringify([{ ...row(), url: 'not a url' }, { ...row({ number: 8, url: 'https://github.com/acme/app/pull/8' }), state: 'ELSEWHERE' }, row()])),
    )
    const read = await listBranchPullRequests({ gitRoot: '/repo', branch: 'feature' }, { gh, now: () => NOW })
    assert.equal(read.settled, true)
    assert.deepEqual(read.settled && read.pullRequests.map((pr) => pr.number), [12])
  }

  // -------------------------------------------------------------------------
  // The state re-read, by URL — the watch's probe and hover's refresh.
  // -------------------------------------------------------------------------
  {
    const { gh, calls } = ghStub(() => ok(JSON.stringify({ state: 'OPEN', isDraft: true, mergedAt: null, closedAt: null })))
    const read = await readPullRequestState('https://github.com/acme/app/pull/12/files', { gh, now: () => NOW })
    assert.deepEqual(calls[0].args, [
      'pr',
      'view',
      'https://github.com/acme/app/pull/12',
      '--json',
      'state,isDraft,mergedAt,closedAt',
    ])
    assert.equal(calls[0].cwd, undefined, 'a URL read needs no checkout')
    assert.deepEqual(read, { settled: true, state: 'open', isDraft: true, stateAt: NOW })
  }
  {
    const { gh } = ghStub(() => ok(JSON.stringify({ state: 'MERGED', isDraft: false, mergedAt: '2026-09-09T09:00:00.000Z', closedAt: '2026-09-09T09:00:00.000Z' })))
    assert.deepEqual(await readPullRequestState('https://github.com/acme/app/pull/12', { gh, now: () => NOW }), {
      settled: true,
      state: 'merged',
      isDraft: false,
      stateAt: NOW,
    })
  }
  {
    const { gh } = ghStub(() => ok(JSON.stringify({ state: 'CLOSED', isDraft: false, mergedAt: null, closedAt: '2026-09-09T09:00:00.000Z' })))
    assert.deepEqual(await readPullRequestState('https://github.com/acme/app/pull/12', { gh, now: () => NOW }), {
      settled: true,
      state: 'closed',
      isDraft: false,
      stateAt: NOW,
    })
  }
  {
    const missing = ghStub(() => ({ found: false, code: -1, stdout: '', stderr: '' }))
    assert.deepEqual(await readPullRequestState('https://github.com/acme/app/pull/12', { gh: missing.gh }), {
      settled: false,
      reason: 'gh-missing',
    })
    const { gh, calls } = ghStub(() => ok('{}'))
    assert.deepEqual(await readPullRequestState('https://bitbucket.org/acme/app/pull-requests/12', { gh }), {
      settled: false,
      reason: 'bad-request',
    })
    assert.deepEqual(await readPullRequestState('nonsense', { gh }), { settled: false, reason: 'bad-request' })
    assert.equal(calls.length, 0)
  }
  {
    // gh answered, but with no state we recognise: unsettled, so the record
    // keeps the state it last read (decision 3).
    const { gh } = ghStub(() => ok(JSON.stringify({ isDraft: false })))
    assert.deepEqual(await readPullRequestState('https://github.com/acme/app/pull/12', { gh }), {
      settled: false,
      reason: 'bad-output',
    })
  }
}

main().then(
  () => console.log('github/branch-pull-request: all assertions passed'),
  (error) => {
    console.error(error)
    process.exitCode = 1
  },
)
