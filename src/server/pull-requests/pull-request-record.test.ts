import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import {
  createPullRequestRecord,
  pullRequestSessionCheckout,
  pullRequestStorePath,
  WATCH_MAX_AGE_MS,
  type PullRequestRecordChange,
  type PullRequestRecordSession,
} from './pull-request-record'
import type { BranchPullRequestsRead, PullRequestStateRead } from './github/branch-pull-request'
import type { BranchPullRequest } from '../shared/git/pull-request'
import { test } from 'vitest'

test('pull-request-record', async () => {
  // No `gh`, no network, no git remote, no pty: the two GitHub reads and the
  // checkout→repository resolution are injected. What is under test is what the
  // record DECIDES.

  const NOW = Date.parse('2026-09-09T12:00:00.000Z')
  const APP = 'github.com/acme/app'
  const WEBSITE = 'github.com/acme/website'

  function pr(overrides: Partial<BranchPullRequest> & { number: number }): BranchPullRequest {
    return {
      url: `https://github.com/acme/app/pull/${overrides.number}`,
      repoKey: APP,
      repoName: 'app',
      title: `#${overrides.number}`,
      state: 'open',
      isDraft: false,
      openedAt: Date.parse('2026-09-01T00:00:00.000Z') + overrides.number * 60_000,
      stateAt: NOW,
      ...overrides,
    }
  }

  function session(input: {
    sessionId: string
    gitRoot?: string | null
    branch?: string | null
    resolved?: boolean
  }): PullRequestRecordSession {
    return {
      sessionId: input.sessionId,
      observedCheckout: {
        resolved: input.resolved ?? true,
        gitRoot: input.gitRoot ?? null,
        branch: input.branch ?? null,
      },
    }
  }

  /** The app checkout is a clone of `github.com/acme/app`; nothing else resolves. */
  async function resolveAppRepo(gitRoot: string): Promise<string | null> {
    return gitRoot === '/repo' || gitRoot === '/repo/worktrees/feature' ? APP : null
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

  /** A store of its own per case: the file is keyed by repository, and two cases
   *  using one directory would inherit each other's pull requests. */
  function freshUserDataDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'sprintengine-pr-record-'))
  }

  async function main(): Promise<void> {
    let userDataDir = await freshUserDataDir()

    // -------------------------------------------------------------------------
    // A session's own checkout is the OBSERVED one — never launch intent, never
    // `repoRoot`, so an agent in a linked worktree looks up the worktree's branch.
    // -------------------------------------------------------------------------
    {
      userDataDir = await freshUserDataDir()
      assert.deepEqual(
        pullRequestSessionCheckout(session({ sessionId: 's', gitRoot: '/repo/worktrees/feature', branch: 'feature' })),
        { gitRoot: '/repo/worktrees/feature', branch: 'feature' },
      )
      assert.equal(
        pullRequestSessionCheckout(session({ sessionId: 's', gitRoot: '/repo', branch: 'main', resolved: false })),
        null,
        'an unresolved checkout has no branch to ask about yet',
      )
      assert.equal(
        pullRequestSessionCheckout(session({ sessionId: 's', gitRoot: '/repo', branch: null })),
        null,
        'a detached HEAD has no branch to look up',
      )
      assert.equal(pullRequestSessionCheckout(null), null)
      assert.equal(pullRequestSessionCheckout({}), null, 'a plain terminal has no observed checkout')
    }

    // -------------------------------------------------------------------------
    // THE CROSS-REPOSITORY CASE (decision 10). An agent whose session sits in
    // `/repo` runs `cd ../website && gh pr create`. The capture knows a URL and a
    // session and nothing else: it must be filed under the WEBSITE, not under the
    // repository the session is on, and the first state read learns its branch.
    // -------------------------------------------------------------------------
    {
      userDataDir = await freshUserDataDir()
      const clock = makeClock()
      const changes: { repoKey: string; branch: string | null; sessionIds: string[] }[] = []
      const record = createPullRequestRecord({
        userDataDir,
        now: () => NOW,
        timers: clock,
        resolveRepoKey: resolveAppRepo,
        onRecordChanged: (change) => changes.push(change),
        reads: {
          listBranchPullRequests: async () => ({ settled: true, pullRequests: [pr({ number: 4 })] }),
          readPullRequestState: async () => ({
            settled: true,
            state: 'open',
            isDraft: false,
            stateAt: NOW,
            headRefName: 'site/banner',
          }),
        },
      })

      const live = session({ sessionId: 'session-a', gitRoot: '/repo', branch: 'feature' })
      record.noteCaptured({ url: 'https://github.com/acme/website/pull/9/files?w=1', sessionId: 'session-a' })
      await record.flush()

      const captured = record.forSession('session-a')
      assert.equal(captured.length, 1)
      assert.equal(captured[0].repoKey, WEBSITE, "filed under the repository the URL names, not the session's")
      assert.equal(captured[0].repoName, 'website', 'and it can say which repo, for a row that spans two')
      assert.equal(captured[0].url, 'https://github.com/acme/website/pull/9', 'the URL is canonicalised on the way in')
      assert.equal(captured[0].number, 9)
      assert.equal(captured[0].state, 'open', 'a captured pull request is open the moment it exists')
      assert.deepEqual(
        record.forBranch(WEBSITE, 'site/banner'),
        captured,
        'the state read learned its head branch and moved it out of the unknown bucket',
      )
      assert.deepEqual(record.forBranch(WEBSITE, ''), [], 'nothing is left behind in the unknown bucket')
      assert.ok(
        changes.some((change) => change.repoKey === WEBSITE && change.sessionIds.includes('session-a')),
        'the change names the session that opened it, so its conversation is re-emitted',
      )

      // The snapshot's union: the session's own branch in its own repository, plus
      // the pull request it opened in the other one.
      await record.ensureLookedUp({ gitRoot: '/repo', branch: 'feature' })
      record.listForSession(live) // kicks off the checkout → repository read
      await record.flush()
      const union = record.listForSession(live)
      assert.deepEqual(
        union.map((entry) => entry.repoName),
        ['website', 'app'],
        'both repositories, newest first',
      )
      assert.equal(new Set(union.map((entry) => entry.url)).size, union.length, 'de-duplicated by URL')
      assert.deepEqual(
        union.map((entry) => [entry.repoName, entry.onSessionBranch === true]),
        [
          ['website', false],
          ['app', true],
        ],
        "only the entry on the session's own repository and branch is stamped on-branch",
      )

      // A different session on the same checkout sees the branch's pull request
      // but NOT the one another conversation opened elsewhere.
      const other = session({ sessionId: 'session-b', gitRoot: '/repo', branch: 'feature' })
      assert.deepEqual(
        record.listForSession(other).map((entry) => entry.number),
        [4],
        'a capture belongs to the conversation that made it',
      )
      record.dispose()
    }

    // -------------------------------------------------------------------------
    // Capture then lookup: the branch lookup finds the same pull request and must
    // NOT clobber the session that opened it, wherever the capture had filed it.
    // -------------------------------------------------------------------------
    {
      userDataDir = await freshUserDataDir()
      const clock = makeClock()
      const record = createPullRequestRecord({
        userDataDir,
        now: () => NOW,
        timers: clock,
        resolveRepoKey: resolveAppRepo,
        reads: {
          listBranchPullRequests: async () => ({
            settled: true,
            pullRequests: [pr({ number: 12, title: 'Marks', openedAt: Date.parse('2026-09-08T10:00:00.000Z') })],
          }),
          // GitHub has not been asked about the capture yet: unsettled, so it
          // stays in the unknown-branch bucket until the lookup places it.
          readPullRequestState: async () => ({ settled: false, reason: 'gh-failed' }),
        },
      })

      record.noteCaptured({ url: 'https://github.com/acme/app/pull/12', sessionId: 'session-a' })
      await record.flush()
      assert.deepEqual(
        record.forBranch(APP, '').map((entry) => entry.number),
        [12],
        'no branch known yet',
      )

      await record.ensureLookedUp({ gitRoot: '/repo', branch: 'feature' })
      await record.flush()
      const merged = record.forBranch(APP, 'feature')
      assert.equal(merged.length, 1, 'merged by URL, not filed twice')
      assert.equal(merged[0].title, 'Marks', "GitHub's truth wins for everything it knows")
      assert.equal(
        merged[0].openedBySessionId,
        'session-a',
        'except the session that opened it, which is never clobbered',
      )
      assert.deepEqual(record.forBranch(APP, ''), [], 'and it left the unknown bucket')
      assert.deepEqual(
        record.forSession('session-a').map((entry) => entry.number),
        [12],
        "still the session's own",
      )

      // On disk, and read back by a fresh record.
      const stored = JSON.parse(await readFile(pullRequestStorePath(userDataDir, APP), 'utf-8'))
      assert.equal(stored.repoKey, APP)
      assert.equal(stored.branches.feature[0].openedBySessionId, 'session-a')

      const reopened = createPullRequestRecord({
        userDataDir,
        now: () => NOW,
        timers: makeClock(),
        resolveRepoKey: resolveAppRepo,
      })
      assert.deepEqual(reopened.forBranch(APP, 'feature'), [], 'the first read of a repository answers "not known yet"')
      await reopened.flush()
      assert.equal(
        reopened.forBranch(APP, 'feature')[0]?.openedBySessionId,
        'session-a',
        'and then the stored record stands, session and all',
      )
      assert.deepEqual(
        reopened.forSession('session-a').map((entry) => entry.number),
        [12],
        'the by-session index is rebuilt from the file',
      )
      reopened.dispose()
      record.dispose()
    }

    // -------------------------------------------------------------------------
    // An UNSETTLED read leaves the record exactly as it was. "Could not ask" is
    // never "there are none".
    // -------------------------------------------------------------------------
    {
      userDataDir = await freshUserDataDir()
      const clock = makeClock()
      let now = NOW
      const changes: unknown[] = []
      let answer: BranchPullRequestsRead = { settled: true, pullRequests: [pr({ number: 4 })] }
      const record = createPullRequestRecord({
        userDataDir,
        now: () => now,
        timers: clock,
        resolveRepoKey: async () => 'github.com/acme/b',
        onRecordChanged: (change) => changes.push(change),
        reads: { listBranchPullRequests: async () => answer },
      })

      await record.ensureLookedUp({ gitRoot: '/repo-b', branch: 'feature' })
      await record.flush()
      assert.equal(record.forBranch(APP, 'feature').length, 1)
      const changesAfterFirst = changes.length

      answer = { settled: false, reason: 'gh-failed' }
      now += 60_001 // past the hold, so the lookup really runs
      await record.ensureLookedUp({ gitRoot: '/repo-b', branch: 'feature' })
      await record.flush()
      assert.equal(record.forBranch(APP, 'feature').length, 1, 'the pull request the app knew about is still there')
      assert.equal(changes.length, changesAfterFirst, 'and nothing was re-emitted, because nothing changed')

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
      assert.deepEqual(settledRecord.forBranch(APP, 'nothing-here'), [], 'a branch with no pull request draws nothing')
      holdRecord.dispose()
      settledRecord.dispose()
      record.dispose()
    }

    // -------------------------------------------------------------------------
    // The watch: every OPEN pull request is watched, each stopping on its own
    // when it lands. Merged and closed are terminal, for good.
    // -------------------------------------------------------------------------
    {
      userDataDir = await freshUserDataDir()
      const clock = makeClock()
      const states = new Map<string, PullRequestStateRead>([
        [
          'https://github.com/acme/app/pull/1',
          { settled: true, state: 'open', isDraft: false, stateAt: NOW, headRefName: 'feature' },
        ],
        [
          'https://github.com/acme/app/pull/2',
          { settled: true, state: 'open', isDraft: false, stateAt: NOW, headRefName: 'feature' },
        ],
      ])
      const probes: string[] = []
      const record = createPullRequestRecord({
        userDataDir,
        now: () => clock.nowMs(),
        timers: clock,
        random: () => 0.5, // no jitter: the schedule under assertion is the pure one
        resolveRepoKey: resolveAppRepo,
        reads: {
          listBranchPullRequests: async () => ({
            settled: true,
            pullRequests: [
              pr({ number: 1 }),
              pr({ number: 2 }),
              pr({ number: 3, state: 'merged' }),
              pr({ number: 4, state: 'closed' }),
            ],
          }),
          readPullRequestState: async (url) => {
            probes.push(url)
            return states.get(url) ?? { settled: false, reason: 'gh-failed' }
          },
        },
      })

      await record.ensureLookedUp({ gitRoot: '/repo', branch: 'feature' })
      await record.flush()
      assert.deepEqual(
        record.watchedUrls().sort(),
        ['https://github.com/acme/app/pull/1', 'https://github.com/acme/app/pull/2'],
        'every open pull request is watched; merged and closed are not',
      )

      // Both are due on the same tick; the first one lands.
      states.set('https://github.com/acme/app/pull/1', {
        settled: true,
        state: 'merged',
        isDraft: false,
        stateAt: clock.nowMs(),
        headRefName: 'feature',
      })
      clock.tick()
      await record.flush()
      await settle()
      clock.tick()
      await record.flush()
      await settle()
      assert.deepEqual(
        probes.sort(),
        ['https://github.com/acme/app/pull/1', 'https://github.com/acme/app/pull/2'],
        'each open pull request is probed on its own timer',
      )
      assert.deepEqual(
        record.watchedUrls(),
        ['https://github.com/acme/app/pull/2'],
        'a merged pull request stops watching for good',
      )
      assert.equal(record.forBranch(APP, 'feature').find((entry) => entry.number === 1)?.state, 'merged')

      // An unsettled probe leaves the state — and the watch — exactly as they were.
      states.delete('https://github.com/acme/app/pull/2')
      clock.tick()
      await record.flush()
      await settle()
      assert.deepEqual(
        record.watchedUrls(),
        ['https://github.com/acme/app/pull/2'],
        'a probe that could not ask never closes a pull request',
      )
      assert.equal(record.forBranch(APP, 'feature').find((entry) => entry.number === 2)?.state, 'open')

      record.dispose()
      assert.equal(clock.pendingCount(), 0, 'dispose tears every timer down')
    }

    // -------------------------------------------------------------------------
    // Hover: look the session's branch up, and re-read a state older than ~60s.
    // A fresh reading buys no `gh` call at all.
    // -------------------------------------------------------------------------
    {
      userDataDir = await freshUserDataDir()
      const clock = makeClock()
      let now = NOW
      const sessions = [
        session({ sessionId: 'live', gitRoot: '/repo', branch: 'feature' }),
        session({ sessionId: 'unresolved', resolved: false }),
      ]
      let lookups = 0
      let listed: BranchPullRequest[] = [pr({ number: 5, stateAt: NOW })]
      const probes: string[] = []
      const record = createPullRequestRecord({
        userDataDir,
        now: () => now,
        timers: clock,
        resolveRepoKey: resolveAppRepo,
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
            return { settled: true, state: 'merged', isDraft: false, stateAt: now, headRefName: 'feature' }
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
      assert.deepEqual(
        probes,
        ['https://github.com/acme/app/pull/5'],
        'and a state reading older than a minute is re-read',
      )
      assert.equal(record.forBranch(APP, 'feature')[0].state, 'merged')

      // A session main does not know asks GitHub nothing.
      record.refreshForSession('nobody')
      await record.flush()
      assert.equal(lookups, 2)

      // Window focus walks the live sessions the same way.
      now += 60_001
      record.refreshOnFocus()
      await record.flush()
      assert.equal(lookups, 3, 'coming back to the app re-asks for the sessions that have a branch')
      assert.deepEqual(
        probes,
        ['https://github.com/acme/app/pull/5'],
        'a merged one is terminal: focus never probes it again',
      )
      record.dispose()
    }

    // -------------------------------------------------------------------------
    // Which sessions a change reaches — the re-emit's filter (decision 10).
    // -------------------------------------------------------------------------
    {
      userDataDir = await freshUserDataDir()
      const record = createPullRequestRecord({
        userDataDir,
        now: () => NOW,
        timers: makeClock(),
        resolveRepoKey: resolveAppRepo,
      })
      const onFeature = session({ sessionId: 'live', gitRoot: '/repo', branch: 'feature' })
      const elsewhere = session({ sessionId: 'elsewhere', gitRoot: '/other', branch: 'feature' })

      // Before the checkout has been resolved to a repository, only the session
      // that opened the pull request is reached.
      assert.equal(
        record.changeAffectsSession({ repoKey: APP, branch: 'feature', sessionIds: [], workspaceIds: [] }, onFeature),
        false,
        'an unresolved checkout matches nothing yet',
      )
      record.listForSession(onFeature) // kicks off the resolution
      await record.flush()

      assert.equal(
        record.changeAffectsSession({ repoKey: APP, branch: 'feature', sessionIds: [], workspaceIds: [] }, onFeature),
        true,
      )
      assert.equal(
        record.changeAffectsSession({ repoKey: APP, branch: 'other', sessionIds: [], workspaceIds: [] }, onFeature),
        false,
        'another branch of the same repository is another conversation',
      )
      assert.equal(
        record.changeAffectsSession(
          { repoKey: WEBSITE, branch: 'feature', sessionIds: [], workspaceIds: [] },
          onFeature,
        ),
        false,
        'another repository is another conversation',
      )
      assert.equal(
        record.changeAffectsSession({ repoKey: APP, branch: null, sessionIds: [], workspaceIds: [] }, onFeature),
        true,
        'a repository-wide change (a checkout just resolved) reaches everything on it',
      )
      assert.equal(
        record.changeAffectsSession(
          { repoKey: WEBSITE, branch: 'site/banner', sessionIds: ['live'], workspaceIds: [] },
          onFeature,
        ),
        true,
        'and the conversation that opened one hears about it in any repository',
      )
      assert.equal(
        record.changeAffectsSession({ repoKey: APP, branch: 'feature', sessionIds: [], workspaceIds: [] }, elsewhere),
        false,
      )
      assert.equal(
        record.changeAffectsSession({ repoKey: APP, branch: 'feature', sessionIds: [], workspaceIds: [] }, {}),
        false,
      )
      record.dispose()
    }

    // -------------------------------------------------------------------------
    // Earlier pull requests are never dropped, and a hand-mangled store file
    // cannot smuggle a mark in.
    // -------------------------------------------------------------------------
    {
      userDataDir = await freshUserDataDir()
      const record = createPullRequestRecord({
        userDataDir,
        now: () => NOW,
        timers: makeClock(),
        resolveRepoKey: resolveAppRepo,
        reads: {
          listBranchPullRequests: async () => ({ settled: true, pullRequests: [pr({ number: 20 })] }),
          readPullRequestState: async () => ({
            settled: true,
            state: 'open',
            isDraft: false,
            stateAt: NOW,
            headRefName: 'feature',
          }),
        },
      })
      record.noteCaptured({ url: 'https://github.com/acme/app/pull/9', sessionId: 'old' })
      await record.flush()
      await record.ensureLookedUp({ gitRoot: '/repo', branch: 'feature' })
      await record.flush()
      assert.deepEqual(
        record.forBranch(APP, 'feature').map((entry) => entry.number),
        // #9 was captured just now and wears this moment as its `openedAt` until
        // GitHub corrects it, so it sorts above the one the lookup found.
        [9, 20],
        'a pull request GitHub no longer lists is never dropped from the record',
      )
      record.dispose()
    }
    {
      userDataDir = await freshUserDataDir()
      const junkRepo = 'github.com/acme/junk'
      await mkdir(join(userDataDir, 'pull-requests'), { recursive: true })
      await writeFile(
        pullRequestStorePath(userDataDir, junkRepo),
        JSON.stringify({
          version: 1,
          repoKey: junkRepo,
          branches: {
            feature: [
              { url: 'https://github.com/acme/junk/pull/1', state: 'sideways', number: 1 },
              { state: 'open', number: 2 },
              {
                url: 'https://github.com/acme/junk/pull/3',
                repoKey: 'github.com/attacker/elsewhere',
                repoName: 'elsewhere',
                state: 'merged',
                isDraft: true,
                number: 3,
                title: 'ok',
                openedAt: 1,
                stateAt: 2,
              },
            ],
          },
        }),
        'utf-8',
      )
      const record = createPullRequestRecord({ userDataDir, now: () => NOW, timers: makeClock() })
      record.forBranch(junkRepo, 'feature')
      await record.flush()
      const entries = record.forBranch(junkRepo, 'feature')
      assert.deepEqual(
        entries.map((entry) => entry.number),
        [3],
        'only well-formed rows survive the read',
      )
      assert.equal(entries[0].isDraft, false, 'a draft flag on a merged one is dropped')
      assert.equal(
        entries[0].repoKey,
        junkRepo,
        'and the repository is re-derived from the URL, never taken from the file',
      )
      record.dispose()
    }

    // -------------------------------------------------------------------------
    // REVIEW FIX (finding 1). A lookup files each row under the repository ITS
    // URL names, which is not always the key the asking checkout resolves to. An
    // SSH host alias (`git@github-work:acme/app`) keys as `github-work/acme/app`,
    // and before this the marks were filed correctly and were invisible for ever
    // — `listForSession` read one key, the rows sat under another, and a watch
    // was armed on an entry nothing could show.
    // -------------------------------------------------------------------------
    {
      userDataDir = await freshUserDataDir()
      const clock = makeClock()
      const changes: PullRequestRecordChange[] = []
      const alias = session({ sessionId: 'alias', gitRoot: '/work/app', branch: 'feature' })
      const record = createPullRequestRecord({
        userDataDir,
        now: () => NOW,
        timers: clock,
        // What `git remote get-url origin` says through an ~/.ssh/config alias.
        resolveRepoKey: async () => 'github-work/acme/app',
        onRecordChanged: (change) => changes.push(change),
        reads: { listBranchPullRequests: async () => ({ settled: true, pullRequests: [pr({ number: 12 })] }) },
      })

      record.listForSession(alias)
      await record.flush()
      await record.ensureLookedUp({ gitRoot: '/work/app', branch: 'feature' })
      await record.flush()

      const listed = record.listForSession(alias)
      assert.deepEqual(
        listed.map((entry) => entry.number),
        [12],
        'the checkout that asked can read the answer back',
      )
      assert.equal(listed[0].repoKey, APP, 'and the row still says which repository it is really in')
      assert.deepEqual(
        record.watchedUrls(),
        ['https://github.com/acme/app/pull/12'],
        'the watch is armed on something a session can see',
      )
      const change = changes.find((entry) => entry.repoKey === APP && entry.branch === 'feature')
      assert.ok(change, 'the change was emitted under the URL`s own repository')
      assert.equal(record.changeAffectsSession(change, alias), true, 'and it reaches the session that asked')
      record.dispose()
    }

    // -------------------------------------------------------------------------
    // REVIEW FIX (finding 1), the fork. `gh pr list` in a fork clone answers for
    // the PARENT, so the rows key to `acme/app` while the checkout is `me/app`.
    // The capture of that same pull request and the lookup's row must still be
    // ONE row and ONE watch.
    // -------------------------------------------------------------------------
    {
      userDataDir = await freshUserDataDir()
      const clock = makeClock()
      const fork = session({ sessionId: 'fork', gitRoot: '/fork/app', branch: 'feature' })
      const record = createPullRequestRecord({
        userDataDir,
        now: () => NOW,
        timers: clock,
        resolveRepoKey: async () => 'github.com/me/app',
        reads: {
          listBranchPullRequests: async () => ({ settled: true, pullRequests: [pr({ number: 21 })] }),
          readPullRequestState: async () => ({
            settled: true,
            state: 'open',
            isDraft: false,
            stateAt: NOW,
            headRefName: 'feature',
          }),
        },
      })

      record.noteCaptured({ url: 'https://github.com/acme/app/pull/21', sessionId: 'fork' })
      await record.flush()
      await record.ensureLookedUp({ gitRoot: '/fork/app', branch: 'feature' })
      await record.flush()

      const listed = record.listForSession(fork)
      assert.equal(listed.length, 1, 'the capture and the lookup row are one pull request')
      assert.equal(listed[0].number, 21)
      assert.equal(listed[0].openedBySessionId, 'fork', 'and the conversation that opened it still owns it')
      assert.equal(record.watchedUrls().length, 1, 'one watch, not two')
      record.dispose()
    }

    // -------------------------------------------------------------------------
    // REVIEW FIX (finding 2). A CAPTURED pull request is filed from a URL alone:
    // no title, and the moment of capture standing in for the moment it opened.
    // In another repository no branch lookup ever heals that, so the state read
    // has to — otherwise every menu row and the peek's title line read empty.
    // -------------------------------------------------------------------------
    {
      userDataDir = await freshUserDataDir()
      const clock = makeClock()
      const openedAt = Date.parse('2026-09-05T09:00:00.000Z')
      const record = createPullRequestRecord({
        userDataDir,
        now: () => NOW,
        timers: clock,
        resolveRepoKey: async () => null,
        reads: {
          readPullRequestState: async () => ({
            settled: true,
            state: 'open',
            isDraft: false,
            stateAt: NOW,
            headRefName: 'site/banner',
            title: 'Refresh the banner',
            openedAt,
            number: 9,
          }),
        },
      })
      record.noteCaptured({ url: 'https://github.com/acme/website/pull/9', sessionId: 'writer' })
      await record.flush()
      const [captured] = record.forSession('writer')
      assert.equal(captured.title, 'Refresh the banner', 'the capture learned its title')
      assert.equal(captured.openedAt, openedAt, 'and when it was really opened, not when we noticed it')

      // A later read that says nothing about the title never blanks it.
      record.dispose()
    }

    // -------------------------------------------------------------------------
    // The hover hook says whether there was anything to ask about, so a caller
    // with one shot per session does not spend it on a session whose checkout has
    // not resolved yet.
    // -------------------------------------------------------------------------
    {
      userDataDir = await freshUserDataDir()
      const known = session({ sessionId: 'known', gitRoot: '/repo', branch: 'feature' })
      const unresolved = session({ sessionId: 'pending', resolved: false })
      const record = createPullRequestRecord({
        userDataDir,
        now: () => NOW,
        timers: makeClock(),
        resolveRepoKey: resolveAppRepo,
        sessions: {
          get: (sessionId) => (sessionId === 'known' ? known : sessionId === 'pending' ? unresolved : null),
          list: () => [known, unresolved],
        },
        reads: { listBranchPullRequests: async () => ({ settled: true, pullRequests: [] }) },
      })
      assert.equal(record.refreshForSession('known'), true, 'a resolved checkout was asked about')
      assert.equal(record.refreshForSession('pending'), false, 'a checkout that has not resolved was not')
      assert.equal(record.refreshForSession('no-such-session'), false, 'and an id main cannot name was not')
      await record.flush()
      record.dispose()
    }

    // -------------------------------------------------------------------------
    // REVIEW FIX (finding 4). An unsettled state read is HELD. With `gh` missing,
    // unauthenticated or rate limited every read fails instantly, so without a
    // hold each window focus re-spawned `gh` — and on macOS a whole `$SHELL -ilc`
    // login shell — once per open pull request, for ever, learning nothing.
    // -------------------------------------------------------------------------
    {
      userDataDir = await freshUserDataDir()
      const clock = makeClock()
      let now = NOW
      let reads = 0
      let settled = false
      const url = 'https://github.com/acme/app/pull/31'
      const record = createPullRequestRecord({
        userDataDir,
        now: () => now,
        timers: clock,
        reads: {
          readPullRequestState: async () => {
            reads += 1
            return settled
              ? { settled: true, state: 'open', isDraft: false, stateAt: now, headRefName: 'feature' }
              : { settled: false, reason: 'gh-failed' }
          },
        },
      })

      for (let focus = 0; focus < 6; focus += 1) await record.refresh(url)
      assert.equal(reads, 1, 'six focuses behind a broken `gh` buy one spawn, not six')
      now += 10_001
      await record.refresh(url)
      assert.equal(reads, 2, 'and the hold lapses in ten seconds, exactly as a branch lookup`s does')

      // A settled read is NOT held: the watch's own probe must always really ask.
      settled = true
      now += 10_001
      await record.refresh(url)
      const settledReads = reads
      await record.refresh(url)
      assert.equal(reads, settledReads + 1, 'a settled reading leaves nothing standing in the way of the next probe')
      record.dispose()
    }

    // -------------------------------------------------------------------------
    // REVIEW FIX (finding 9). The watch is bounded by a 30-day window. Without it
    // every open pull request the app ever saw holds a <=32-minute timer for the
    // life of the process — including ones in repositories nobody has open.
    // -------------------------------------------------------------------------
    {
      userDataDir = await freshUserDataDir()
      const clock = makeClock()
      const ancient = { ...pr({ number: 40 }), openedAt: NOW - WATCH_MAX_AGE_MS - 1 }
      const recent = { ...pr({ number: 41 }), openedAt: NOW - 1_000 }
      const record = createPullRequestRecord({
        userDataDir,
        now: () => NOW,
        timers: clock,
        reads: { listBranchPullRequests: async () => ({ settled: true, pullRequests: [ancient, recent] }) },
      })
      await record.ensureLookedUp({ gitRoot: '/repo', branch: 'feature' })
      await record.flush()
      assert.deepEqual(
        record
          .forBranch(APP, 'feature')
          .map((entry) => entry.number)
          .sort((a, b) => a - b),
        [40, 41],
        'both are still on the record and still drawn',
      )
      assert.deepEqual(
        record.watchedUrls(),
        ['https://github.com/acme/app/pull/41'],
        'but only the one somebody might still merge holds a timer',
      )
      record.dispose()
    }

    // -------------------------------------------------------------------------
    // REVIEW FIX (finding 10). A probe that learned nothing must not repaint. The
    // reading's timestamp moves (and is written, so a restart does not re-ask
    // everything), but `stateAt` is not something a person sees.
    // -------------------------------------------------------------------------
    {
      userDataDir = await freshUserDataDir()
      const clock = makeClock()
      let now = NOW
      const changes: PullRequestRecordChange[] = []
      const record = createPullRequestRecord({
        userDataDir,
        now: () => now,
        timers: clock,
        onRecordChanged: (change) => changes.push(change),
        reads: {
          listBranchPullRequests: async () => ({ settled: true, pullRequests: [pr({ number: 50 })] }),
          readPullRequestState: async () => ({
            settled: true,
            state: 'open',
            isDraft: false,
            stateAt: now,
            headRefName: 'feature',
          }),
        },
      })
      await record.ensureLookedUp({ gitRoot: '/repo', branch: 'feature' })
      await record.flush()
      const afterLookup = changes.length
      assert.ok(afterLookup > 0, 'finding the pull request is a change')

      now += 120_000
      await record.refresh('https://github.com/acme/app/pull/50')
      await record.flush()
      assert.equal(changes.length, afterLookup, 'a probe that learned nothing repaints nothing')
      assert.equal(
        record.forBranch(APP, 'feature')[0].stateAt,
        now,
        'the reading is still dated, so the next hover does not ask again',
      )

      const persisted = JSON.parse(await readFile(pullRequestStorePath(userDataDir, APP), 'utf-8')) as {
        branches: Record<string, { stateAt: number }[]>
      }
      assert.equal(persisted.branches.feature[0].stateAt, now, 'and it survives a restart')
      record.dispose()
    }

    // -------------------------------------------------------------------------
    // REVIEW FIX (finding 11). Persistence hygiene: the version is READ, a file
    // this build cannot understand is kept aside rather than silently overwritten
    // by the next commit, and a `.tmp` from a write that died is swept.
    // -------------------------------------------------------------------------
    {
      userDataDir = await freshUserDataDir()
      const dir = join(userDataDir, 'pull-requests')
      await mkdir(dir, { recursive: true })
      const path = pullRequestStorePath(userDataDir, APP)
      await writeFile(path, '{"version":1,"repoKey":"github.com/acme/app","branches":{"feature":[', 'utf-8')
      const stale = `${path}.11111111-2222-3333-4444-555555555555.tmp`
      await writeFile(stale, '{}', 'utf-8')
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
      await utimes(stale, old, old)
      const fresh = `${path}.99999999-2222-3333-4444-555555555555.tmp`
      await writeFile(fresh, '{}', 'utf-8')

      const warnings: string[] = []
      const record = createPullRequestRecord({
        userDataDir,
        now: () => NOW,
        timers: makeClock(),
        logWarning: (message) => warnings.push(message),
        reads: { listBranchPullRequests: async () => ({ settled: true, pullRequests: [pr({ number: 60 })] }) },
      })
      record.forBranch(APP, 'feature')
      await record.ensureLookedUp({ gitRoot: '/repo', branch: 'feature' })
      await record.flush()

      assert.ok(
        warnings.some((message) => message.includes('kept aside') || message.includes('keeping it aside')),
        `a truncated store is reported, not swallowed: ${JSON.stringify(warnings)}`,
      )
      const names = await readdir(dir)
      assert.ok(
        names.some((name) => name.endsWith('.corrupt')),
        'the unreadable file is kept, not overwritten',
      )
      assert.ok(!names.includes(basename(stale)), 'a stale temp file is swept')
      assert.ok(names.includes(basename(fresh)), 'a temp file young enough to be in flight is left alone')
      assert.deepEqual(
        record.forBranch(APP, 'feature').map((entry) => entry.number),
        [60],
        'and the record refills',
      )
      record.dispose()
    }

    // -------------------------------------------------------------------------
    // REVIEW FIX (finding 11, the version). A store written by a build this one
    // does not know is not read AND not overwritten.
    // -------------------------------------------------------------------------
    {
      userDataDir = await freshUserDataDir()
      await mkdir(join(userDataDir, 'pull-requests'), { recursive: true })
      await writeFile(
        pullRequestStorePath(userDataDir, APP),
        JSON.stringify({
          version: 99,
          repoKey: APP,
          branches: {
            feature: [
              { url: 'https://github.com/acme/app/pull/70', state: 'open', number: 70, openedAt: 1, stateAt: 1 },
            ],
          },
        }),
        'utf-8',
      )
      const record = createPullRequestRecord({ userDataDir, now: () => NOW, timers: makeClock(), logWarning: () => {} })
      record.forBranch(APP, 'feature')
      await record.flush()
      assert.deepEqual(record.forBranch(APP, 'feature'), [], 'a version this build does not know reads as nothing')
      const names = await readdir(join(userDataDir, 'pull-requests'))
      assert.ok(
        names.some((name) => name.endsWith('.corrupt')),
        'and the file is kept aside',
      )
      record.dispose()
    }

    // -------------------------------------------------------------------------
    // REVIEW FIX (finding 5). Every `gh` read goes through one slot queue: a
    // focus with twenty live sessions is not twenty subprocesses (and on a
    // GUI-launched macOS app, not twenty login shells).
    // -------------------------------------------------------------------------
    {
      userDataDir = await freshUserDataDir()
      let inFlight = 0
      let peak = 0
      const release: (() => void)[] = []
      const record = createPullRequestRecord({
        userDataDir,
        now: () => NOW,
        timers: makeClock(),
        reads: {
          readPullRequestState: async () => {
            inFlight += 1
            peak = Math.max(peak, inFlight)
            await new Promise<void>((resolve) => release.push(resolve))
            inFlight -= 1
            return { settled: false, reason: 'gh-failed' }
          },
        },
      })
      const reads = Array.from({ length: 10 }, (_, index) =>
        record.refresh(`https://github.com/acme/app/pull/${100 + index}`),
      )
      await settle()
      assert.equal(peak, 3, 'at most three `gh` reads are ever in flight at once')
      while (release.length > 0) {
        release.shift()?.()
        await settle()
      }
      await Promise.all(reads)
      assert.equal(peak, 3, 'and the queue drains rather than deadlocking')
      record.dispose()
    }

    // -------------------------------------------------------------------------
    // A conversation's pull requests outlive its agents (owner, 2026-09-10).
    //
    // The complaint this answers: an agent finished, its session went away, and
    // its pull request went with it — "if I'm scanning through the old chats I
    // don't know is there a pull request open that I'm missing." The session id
    // could never answer once the session was gone; the conversation id can.
    // -------------------------------------------------------------------------
    {
      userDataDir = await freshUserDataDir()
      const clock = makeClock()
      const changes: PullRequestRecordChange[] = []
      const record = createPullRequestRecord({
        userDataDir,
        now: () => NOW,
        timers: clock,
        resolveRepoKey: resolveAppRepo,
        onRecordChanged: (change) => changes.push(change),
        reads: {
          listBranchPullRequests: async () => ({ settled: true, pullRequests: [] }),
          readPullRequestState: async () => ({
            settled: true,
            state: 'merged',
            isDraft: false,
            stateAt: NOW,
            headRefName: 'skills-everywhere',
          }),
        },
      })

      record.noteCaptured({
        url: 'https://github.com/acme/app/pull/93',
        sessionId: 'session-gone',
        workspaceId: 'chat-1',
      })
      await record.flush()

      const mine = record.forWorkspace('chat-1')
      assert.equal(mine.length, 1, 'the conversation holds the pull request its agent opened')
      assert.equal(mine[0].number, 93)
      assert.equal(mine[0].openedByWorkspaceId, 'chat-1')
      assert.equal(
        mine[0].state,
        'merged',
        'and it keeps holding it once merged — the mark is the record, not a to-do list',
      )
      assert.deepEqual(record.forWorkspace('chat-2'), [], 'another conversation gets nothing')
      assert.deepEqual(record.forWorkspace(''), [], 'and an unnamed one asks for nothing')

      // The change signal has to name conversations too: `sessionIds` can only
      // ever reach a live session, and the rows this feature exists for have none.
      assert.ok(
        changes.some((change) => change.workspaceIds.includes('chat-1')),
        'a change names the conversations whose rows must re-read',
      )

      // A second agent in the SAME conversation, on its own branch: the row is the
      // conversation, not one of its terminals, so it wears both.
      record.noteCaptured({
        url: 'https://github.com/acme/app/pull/94',
        sessionId: 'session-two',
        workspaceId: 'chat-1',
      })
      await record.flush()
      assert.deepEqual(
        record
          .forWorkspace('chat-1')
          .map((entry) => entry.number)
          .sort((a, b) => a - b),
        [93, 94],
        "both agents' pull requests hang off the one conversation",
      )
      record.dispose()
    }

    // A pull request found by a branch lookup first, and captured afterwards,
    // still learns which conversation it came from: whichever id arrives second
    // is filled in, and neither is ever overwritten.
    {
      userDataDir = await freshUserDataDir()
      const clock = makeClock()
      const record = createPullRequestRecord({
        userDataDir,
        now: () => NOW,
        timers: clock,
        resolveRepoKey: resolveAppRepo,
        reads: {
          listBranchPullRequests: async () => ({ settled: true, pullRequests: [pr({ number: 4 })] }),
          readPullRequestState: async () => ({
            settled: true,
            state: 'open',
            isDraft: false,
            stateAt: NOW,
            headRefName: 'feature',
          }),
        },
      })

      await record.ensureLookedUp({ gitRoot: '/repo', branch: 'feature' })
      await record.flush()
      assert.equal(
        record.forBranch(APP, 'feature')[0]?.openedByWorkspaceId,
        undefined,
        'a branch lookup names no conversation — nobody here opened it',
      )

      record.noteCaptured({
        url: record.forBranch(APP, 'feature')[0].url,
        sessionId: 'session-a',
        workspaceId: 'chat-9',
      })
      await record.flush()
      assert.deepEqual(
        record.forWorkspace('chat-9').map((entry) => entry.number),
        [4],
        'and the capture attaches it to the conversation afterwards',
      )
      record.dispose()
    }
  }

  const suiteRun = main().then(
    () => console.log('pull-request-record: all assertions passed'),
    (error) => {
      console.error(error)
      process.exitCode = 1
    },
  )

  await suiteRun
})
