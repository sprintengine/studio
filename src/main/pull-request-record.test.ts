import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createPullRequestRecord,
  pullRequestRecordKey,
  pullRequestSessionKey,
  pullRequestStorePath,
  type PullRequestRecordSession,
} from './pull-request-record'
import type {
  BranchPullRequestsRead,
  PullRequestStateRead,
} from './github/branch-pull-request'
import type { BranchPullRequest } from '../shared/git/pull-request'

// No `gh`, no network, no pty: the two GitHub reads are injected and the store
// writes into a temp directory. What is under test is what the record DECIDES.

const NOW = Date.parse('2026-09-09T12:00:00.000Z')

function pr(overrides: Partial<BranchPullRequest> & { number: number }): BranchPullRequest {
  return {
    url: `https://github.com/acme/app/pull/${overrides.number}`,
    title: `#${overrides.number}`,
    state: 'open',
    isDraft: false,
    openedAt: Date.parse('2026-09-01T00:00:00.000Z') + overrides.number * 60_000,
    stateAt: NOW,
    ...overrides,
  }
}

function session(input: { sessionId: string; gitRoot?: string | null; branch?: string | null; resolved?: boolean }): PullRequestRecordSession {
  return {
    sessionId: input.sessionId,
    observedCheckout: {
      resolved: input.resolved ?? true,
      gitRoot: input.gitRoot ?? null,
      branch: input.branch ?? null,
    },
  }
}

// A hand-driven clock for the watch's timers.
function makeClock() {
  let seq = 1
  const pending = new Map<number, { handler: () => void; dueAt: number }>()
  let nowMs = NOW
  return {
    setTimeout: (handler: () => void, ms: number): unknown => {
      const id = seq++
      pending.set(id, { handler, dueAt: nowMs + ms })
      return id
    },
    clearTimeout: (handle: unknown): void => {
      pending.delete(handle as number)
    },
    tick(): number | null {
      let nextId: number | null = null
      let nextDue = Infinity
      for (const [id, entry] of pending) {
        if (entry.dueAt < nextDue) {
          nextDue = entry.dueAt
          nextId = id
        }
      }
      if (nextId === null) return null
      const entry = pending.get(nextId)!
      pending.delete(nextId)
      nowMs = entry.dueAt
      entry.handler()
      return nextDue
    },
    pendingCount: () => pending.size,
    nowMs: () => nowMs,
  }
}

// Let the queued microtasks (a probe's promise chain) settle between ticks.
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

async function main(): Promise<void> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'multicode-pr-record-'))

  // -------------------------------------------------------------------------
  // The key is the observed gitRoot + branch — NEVER repoRoot, so an agent in a
  // linked worktree files its pull requests under the worktree it is on.
  // -------------------------------------------------------------------------
  {
    assert.deepEqual(
      pullRequestSessionKey(session({ sessionId: 's', gitRoot: '/repo/worktrees/feature', branch: 'feature' })),
      { gitRoot: '/repo/worktrees/feature', branch: 'feature' },
    )
    assert.equal(
      pullRequestSessionKey(session({ sessionId: 's', gitRoot: '/repo', branch: 'main', resolved: false })),
      null,
      'an unresolved checkout has no key: the answer is "not known", never the launch folder',
    )
    assert.equal(pullRequestSessionKey(session({ sessionId: 's', gitRoot: '/repo', branch: null })), null, 'a detached HEAD has no branch to look up')
    assert.equal(pullRequestSessionKey(null), null)
    assert.equal(pullRequestSessionKey({}), null, 'a plain terminal has no observed checkout')
    assert.notEqual(
      pullRequestRecordKey('/repo/worktrees/feature', 'feature'),
      pullRequestRecordKey('/repo', 'feature'),
      'two checkouts on the same branch name are two keys',
    )
    assert.equal(
      pullRequestRecordKey('/repo/', 'feature'),
      pullRequestRecordKey('/repo', 'feature'),
      'the path half is normalised the way every other checkout key is',
    )
    assert.notEqual(
      pullRequestRecordKey('/repo', 'Feature'),
      pullRequestRecordKey('/repo', 'feature'),
      "and the branch half is verbatim, because git's refs are case-sensitive",
    )
  }

  // -------------------------------------------------------------------------
  // Capture inserts an OPEN pull request against the session that made it, and
  // schedules a state read. The lookup that follows must not clobber the
  // session id — it is the one field a branch lookup can never supply.
  // -------------------------------------------------------------------------
  {
    const clock = makeClock()
    const changed: string[] = []
    let stateReads = 0
    const record = createPullRequestRecord({
      userDataDir,
      now: () => NOW,
      timers: clock,
      random: () => 0.5,
      onRecordChanged: ({ key }) => changed.push(key),
      reads: {
        listBranchPullRequests: async (): Promise<BranchPullRequestsRead> => ({
          settled: true,
          pullRequests: [pr({ number: 12, title: 'Marks', openedAt: Date.parse('2026-09-08T10:00:00.000Z') })],
        }),
        readPullRequestState: async (): Promise<PullRequestStateRead> => {
          stateReads += 1
          return { settled: true, state: 'open', isDraft: false, stateAt: NOW }
        },
      },
    })

    record.noteCaptured({ gitRoot: '/repo', branch: 'feature', url: 'https://github.com/acme/app/pull/12', sessionId: 'session-a' })
    await record.flush()

    const captured = record.listFor({ gitRoot: '/repo', branch: 'feature' })
    assert.equal(captured.length, 1)
    assert.equal(captured[0].state, 'open', 'a pull request the app watched being created is open the moment it exists')
    assert.equal(captured[0].number, 12, 'the number comes off the URL until GitHub says otherwise')
    assert.equal(captured[0].openedBySessionId, 'session-a')
    assert.equal(stateReads, 1, 'capture schedules a state read')
    assert.deepEqual(record.watchedUrls(), ['https://github.com/acme/app/pull/12'], 'an open one is watched')
    assert.deepEqual(changed, [pullRequestRecordKey('/repo', 'feature')], 'the sessions on that key are re-emitted')

    // Now the branch lookup runs over the same URL.
    await record.ensureLookedUp({ gitRoot: '/repo', branch: 'feature' })
    await record.flush()
    const merged = record.listFor({ gitRoot: '/repo', branch: 'feature' })
    assert.equal(merged.length, 1, 'merged by URL, not appended twice')
    assert.equal(merged[0].title, 'Marks', "GitHub's truth wins for everything it knows")
    assert.equal(merged[0].openedBySessionId, 'session-a', 'except the session that opened it, which is never clobbered')

    // It is on disk, and a fresh record reads it back.
    const stored = JSON.parse(await readFile(pullRequestStorePath(userDataDir, '/repo'), 'utf-8'))
    assert.equal(stored.branches.feature[0].openedBySessionId, 'session-a')

    const reopened = createPullRequestRecord({ userDataDir, now: () => NOW, timers: clock, reads: { listBranchPullRequests: async () => ({ settled: false, reason: 'gh-missing' }) } })
    assert.deepEqual(reopened.listFor({ gitRoot: '/repo', branch: 'feature' }), [], 'the first read of a checkout answers "not known yet"')
    await reopened.flush()
    assert.equal(reopened.listFor({ gitRoot: '/repo', branch: 'feature' })[0]?.openedBySessionId, 'session-a', 'and then the stored record stands')
    reopened.dispose()
    record.dispose()
  }

  // -------------------------------------------------------------------------
  // An UNSETTLED read leaves the record exactly as it was. "Could not ask" is
  // never "there are none".
  // -------------------------------------------------------------------------
  {
    const clock = makeClock()
    let now = NOW
    const changed: string[] = []
    let settled: BranchPullRequestsRead = { settled: true, pullRequests: [pr({ number: 4 })] }
    const record = createPullRequestRecord({
      userDataDir,
      now: () => now,
      timers: clock,
      onRecordChanged: ({ key }) => changed.push(key),
      reads: { listBranchPullRequests: async () => settled },
    })

    await record.ensureLookedUp({ gitRoot: '/repo-b', branch: 'feature' })
    await record.flush()
    assert.equal(record.listFor({ gitRoot: '/repo-b', branch: 'feature' }).length, 1)
    const changesAfterFirst = changed.length

    settled = { settled: false, reason: 'gh-failed' }
    now += 60_001 // past the hold, so the lookup really runs
    await record.ensureLookedUp({ gitRoot: '/repo-b', branch: 'feature' })
    await record.flush()
    assert.equal(record.listFor({ gitRoot: '/repo-b', branch: 'feature' }).length, 1, 'the pull request the app knew about is still there')
    assert.equal(changed.length, changesAfterFirst, 'and nothing was re-emitted, because nothing changed')

    // An unsettled read does not buy the full hold: the next ask really asks.
    let asks = 0
    const holdRecord = createPullRequestRecord({
      userDataDir,
      now: () => now,
      timers: clock,
      reads: {
        listBranchPullRequests: async () => {
          asks += 1
          return { settled: false, reason: 'gh-failed' }
        },
      },
    })
    await holdRecord.ensureLookedUp({ gitRoot: '/repo-c', branch: 'feature' })
    await holdRecord.ensureLookedUp({ gitRoot: '/repo-c', branch: 'feature' })
    assert.equal(asks, 1, 'a failure is still held briefly, so a hover storm is one call')
    now += 10_001
    await holdRecord.ensureLookedUp({ gitRoot: '/repo-c', branch: 'feature' })
    assert.equal(asks, 2, 'and lapses in ten seconds rather than the settled minute')

    // A settled read holds for the full minute.
    let settledAsks = 0
    const settledRecord = createPullRequestRecord({
      userDataDir,
      now: () => now,
      timers: clock,
      reads: {
        listBranchPullRequests: async () => {
          settledAsks += 1
          return { settled: true, pullRequests: [] }
        },
      },
    })
    await settledRecord.ensureLookedUp({ gitRoot: '/repo-d', branch: 'feature' })
    now += 10_001
    await settledRecord.ensureLookedUp({ gitRoot: '/repo-d', branch: 'feature' })
    assert.equal(settledAsks, 1, 'a settled answer is held')
    assert.deepEqual(record.listFor({ gitRoot: '/repo-d', branch: 'feature' }), [], 'a branch with no pull request draws nothing')
    holdRecord.dispose()
    settledRecord.dispose()
    record.dispose()
  }

  // -------------------------------------------------------------------------
  // The watch: every OPEN pull request is watched, each stopping on its own
  // when it lands. Merged and closed are terminal, for good.
  // -------------------------------------------------------------------------
  {
    const clock = makeClock()
    const states = new Map<string, PullRequestStateRead>([
      ['https://github.com/acme/app/pull/1', { settled: true, state: 'open', isDraft: false, stateAt: NOW }],
      ['https://github.com/acme/app/pull/2', { settled: true, state: 'open', isDraft: false, stateAt: NOW }],
    ])
    const probes: string[] = []
    const record = createPullRequestRecord({
      userDataDir,
      now: () => clock.nowMs(),
      timers: clock,
      random: () => 0.5, // no jitter: the schedule under assertion is the pure one
      reads: {
        listBranchPullRequests: async () => ({
          settled: true,
          pullRequests: [pr({ number: 1 }), pr({ number: 2 }), pr({ number: 3, state: 'merged' }), pr({ number: 4, state: 'closed' })],
        }),
        readPullRequestState: async (url) => {
          probes.push(url)
          return states.get(url) ?? { settled: false, reason: 'gh-failed' }
        },
      },
    })

    await record.ensureLookedUp({ gitRoot: '/repo-watch', branch: 'feature' })
    await record.flush()
    assert.deepEqual(
      record.watchedUrls().sort(),
      ['https://github.com/acme/app/pull/1', 'https://github.com/acme/app/pull/2'],
      'every open pull request is watched; merged and closed are not',
    )

    // The first one lands. Its own timer stops; the other keeps going. Both are
    // due on the same tick, so both probes are driven.
    states.set('https://github.com/acme/app/pull/1', { settled: true, state: 'merged', isDraft: false, stateAt: clock.nowMs() })
    clock.tick()
    await record.flush()
    await settle()
    clock.tick()
    await record.flush()
    await settle()
    assert.deepEqual(probes.sort(), ['https://github.com/acme/app/pull/1', 'https://github.com/acme/app/pull/2'], 'each open pull request is probed on its own timer')
    assert.deepEqual(record.watchedUrls(), ['https://github.com/acme/app/pull/2'], 'a merged pull request stops watching for good')
    assert.equal(record.listFor({ gitRoot: '/repo-watch', branch: 'feature' }).find((entry) => entry.number === 1)?.state, 'merged')

    // An unsettled probe leaves the state — and the watch — exactly as they were.
    states.delete('https://github.com/acme/app/pull/2')
    clock.tick()
    await record.flush()
    await settle()
    assert.deepEqual(record.watchedUrls(), ['https://github.com/acme/app/pull/2'], 'a probe that could not ask never closes a pull request')
    assert.equal(record.listFor({ gitRoot: '/repo-watch', branch: 'feature' }).find((entry) => entry.number === 2)?.state, 'open')

    record.dispose()
    assert.equal(clock.pendingCount(), 0, 'dispose tears every timer down')
  }

  // -------------------------------------------------------------------------
  // Hover: look the session's branch up, and re-read a state older than ~60s.
  // A fresh reading buys no `gh` call at all.
  // -------------------------------------------------------------------------
  {
    const clock = makeClock()
    let now = NOW
    const sessions = [session({ sessionId: 'live', gitRoot: '/repo-hover', branch: 'feature' }), session({ sessionId: 'unresolved', resolved: false })]
    let lookups = 0
    let listed: BranchPullRequest[] = [pr({ number: 5, stateAt: NOW })]
    const probes: string[] = []
    const record = createPullRequestRecord({
      userDataDir,
      now: () => now,
      timers: clock,
      sessions: {
        get: (sessionId) => sessions.find((entry) => entry.sessionId === sessionId) ?? null,
        list: () => sessions,
      },
      reads: {
        listBranchPullRequests: async () => {
          lookups += 1
          return { settled: true, pullRequests: listed }
        },
        readPullRequestState: async (url) => {
          probes.push(url)
          // GitHub itself moved on, so the next branch lookup says so too.
          listed = [pr({ number: 5, state: 'merged', stateAt: now })]
          return { settled: true, state: 'merged', isDraft: false, stateAt: now }
        },
      },
    })

    record.refreshForSession('live')
    await record.flush()
    assert.equal(lookups, 1)
    assert.deepEqual(probes, [], 'a reading taken a moment ago is not re-read')

    // A pointer sweeping down the sidebar inside the hold buys nothing at all.
    record.refreshForSession('live')
    record.refreshForSession('live')
    await record.flush()
    assert.equal(lookups, 1, 'the branch lookup is held')
    assert.deepEqual(probes, [], 'and so is the state reading')

    now += 60_001
    record.refreshForSession('live')
    await record.flush()
    assert.equal(lookups, 2, 'past the hold, a hover really asks again')
    assert.deepEqual(probes, ['https://github.com/acme/app/pull/5'], 'and a state reading older than a minute is re-read')
    assert.equal(record.listFor({ gitRoot: '/repo-hover', branch: 'feature' })[0].state, 'merged')

    // A session main does not know, and one whose checkout has not resolved,
    // ask GitHub nothing.
    record.refreshForSession('nobody')
    record.refreshForSession('unresolved')
    await record.flush()
    assert.equal(lookups, 2)

    // Window focus walks the live sessions the same way.
    now += 60_001
    record.refreshOnFocus()
    await record.flush()
    assert.equal(lookups, 3, 'coming back to the app re-asks for the sessions that have a branch')
    assert.deepEqual(probes, ['https://github.com/acme/app/pull/5'], 'a merged one is terminal: focus never probes it again')
    record.dispose()
  }

  // -------------------------------------------------------------------------
  // Earlier pull requests are never dropped, and a hand-mangled store file
  // cannot smuggle a mark in.
  // -------------------------------------------------------------------------
  {
    const clock = makeClock()
    const record = createPullRequestRecord({
      userDataDir,
      now: () => NOW,
      timers: clock,
      reads: {
        listBranchPullRequests: async () => ({ settled: true, pullRequests: [pr({ number: 20 })] }),
      },
    })
    record.noteCaptured({ gitRoot: '/repo-keep', branch: 'feature', url: 'https://github.com/acme/app/pull/9', sessionId: 'old' })
    await record.flush()
    await record.ensureLookedUp({ gitRoot: '/repo-keep', branch: 'feature' })
    await record.flush()
    assert.deepEqual(
      record.listFor({ gitRoot: '/repo-keep', branch: 'feature' }).map((entry) => entry.number),
      // #9 was captured just now and wears this moment as its `openedAt` until
      // GitHub corrects it, so it sorts above the one the lookup found.
      [9, 20],
      'a pull request GitHub no longer lists is never dropped from the record',
    )
    record.dispose()
  }
  {
    await mkdir(join(userDataDir, 'pull-requests'), { recursive: true })
    await writeFile(
      pullRequestStorePath(userDataDir, '/repo-junk'),
      JSON.stringify({
        version: 1,
        gitRoot: '/repo-junk',
        branches: {
          feature: [
            { url: 'https://github.com/acme/app/pull/1', state: 'sideways', number: 1 },
            { state: 'open', number: 2 },
            { url: 'https://github.com/acme/app/pull/3', state: 'merged', isDraft: true, number: 3, title: 'ok', openedAt: 1, stateAt: 2 },
          ],
        },
      }),
      'utf-8',
    )
    const record = createPullRequestRecord({ userDataDir, now: () => NOW, timers: makeClock() })
    record.listFor({ gitRoot: '/repo-junk', branch: 'feature' })
    await record.flush()
    const entries = record.listFor({ gitRoot: '/repo-junk', branch: 'feature' })
    assert.deepEqual(entries.map((entry) => entry.number), [3], 'only well-formed rows survive the read')
    assert.equal(entries[0].isDraft, false, 'and a draft flag on a merged one is dropped')
    record.dispose()
  }
}

main().then(
  () => console.log('pull-request-record: all assertions passed'),
  (error) => {
    console.error(error)
    process.exitCode = 1
  },
)
