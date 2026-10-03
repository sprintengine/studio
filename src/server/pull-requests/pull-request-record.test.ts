import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { test } from 'vitest'

import type { BranchPullRequestsRead, PullRequestStateRead } from '../../main/github/branch-pull-request'
import type { BranchPullRequest } from '../../shared/git/pull-request'
import {
  createPullRequestRecord,
  FORCED_LOOKUP_MIN_INTERVAL_MS,
  GH_MISSING_HOLD_MS,
  pullRequestConversationsPath,
  pullRequestStorePath,
  WATCH_MAX_AGE_MS,
  type PullRequestRecordChange,
  type PullRequestRecordOptions,
} from './pull-request-record'

// No `gh`, no network, no git remote: the two GitHub reads and the
// checkout→repository resolution are injected. What is under test is what the
// record DECIDES.

const NOW = Date.parse('2026-09-09T12:00:00.000Z')
const APP = 'github.com/acme/app'
const WEBSITE = 'github.com/acme/website'
const CHAT = { workspaceId: 'ws-1', agentId: 'agent-1' }
const OTHER_AGENT = { workspaceId: 'ws-1', agentId: 'agent-2' }

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

function sitePr(number: number): BranchPullRequest {
  return pr({ number, url: `https://github.com/acme/website/pull/${number}`, repoKey: WEBSITE, repoName: 'website' })
}

/** `/repo` and its worktrees are clones of acme/app, `/site` of acme/website. */
async function resolveRepo(gitRoot: string): Promise<string | null> {
  if (gitRoot.startsWith('/repo')) return APP
  if (gitRoot.startsWith('/site')) return WEBSITE
  return null
}

// A hand-driven clock for the watch's and the deferred lookups' timers.
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
    advance(ms: number): void {
      nowMs += ms
    },
    pendingCount: () => pending.size,
    nowMs: () => nowMs,
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

function freshUserDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sprintengine-pr-record-'))
}

/** A record over a branch → answer table, counting the lookups each checkout costs. */
function recordOver(
  userDataDir: string,
  answers: Record<string, BranchPullRequest[]>,
  extra: Partial<PullRequestRecordOptions> = {},
) {
  const lookups: string[] = []
  const record = createPullRequestRecord({
    userDataDir,
    now: () => NOW,
    timers: makeClock(),
    resolveRepoKey: resolveRepo,
    ...extra,
    reads: {
      listBranchPullRequests: async ({ gitRoot, branch }): Promise<BranchPullRequestsRead> => {
        lookups.push(`${gitRoot}@${branch}`)
        return { settled: true, pullRequests: answers[`${gitRoot}@${branch}`] ?? [] }
      },
      ...extra.reads,
    },
  })
  return { record, lookups }
}

test('a conversation wears the pull requests on every branch it worked on, its own one stamped', async () => {
  const { record } = recordOver(await freshUserDataDir(), {
    '/repo@feature': [pr({ number: 4 })],
    '/site@banner': [sitePr(9)],
  })
  await record.noteCheckout(CHAT, { gitRoot: '/repo', branch: 'feature' }, { home: true, force: true })
  await record.noteCheckout(CHAT, { gitRoot: '/site', branch: 'banner' }, { force: true })
  const listed = record.forConversation(CHAT)
  assert.deepEqual(
    listed.map((entry) => [entry.repoName, entry.number, entry.onSessionBranch === true]),
    [
      ['website', 9, false],
      ['app', 4, true],
    ],
    'both repositories, newest first; only the one on its own checkout speaks for its branch',
  )
  assert.equal(new Set(listed.map((entry) => entry.url)).size, listed.length, 'de-duplicated by URL')
  assert.deepEqual(record.forConversation(OTHER_AGENT), [], 'another agent did not work there')
  record.dispose()
})

test('a workspace row wears every agent it had, and no entry on it speaks for a branch', async () => {
  const { record } = recordOver(await freshUserDataDir(), {
    '/repo@feature': [pr({ number: 4 })],
    '/repo@other': [pr({ number: 5 })],
  })
  await record.noteCheckout(CHAT, { gitRoot: '/repo', branch: 'feature' }, { home: true })
  await record.noteCheckout(OTHER_AGENT, { gitRoot: '/repo', branch: 'other' }, { home: true })
  const row = record.forWorkspace('ws-1')
  assert.deepEqual(
    row.map((entry) => entry.number),
    [5, 4],
  )
  assert.ok(row.every((entry) => entry.onSessionBranch === undefined))
  assert.deepEqual(record.forWorkspace('ws-elsewhere'), [])
  record.dispose()
})

test('two agents on one branch are one lookup and one row', async () => {
  const { record, lookups } = recordOver(await freshUserDataDir(), { '/repo@feature': [pr({ number: 4 })] })
  await record.noteCheckout(CHAT, { gitRoot: '/repo', branch: 'feature' }, { home: true })
  await record.noteCheckout(OTHER_AGENT, { gitRoot: '/repo', branch: 'feature' }, { home: true })
  assert.deepEqual(lookups, ['/repo@feature'], 'a held answer serves the second agent')
  assert.deepEqual(
    record.forWorkspace('ws-1').map((entry) => entry.number),
    [4],
  )
  record.dispose()
})

test('a turn end asks for a lookup made after it, folded into one per interval', async () => {
  const clock = makeClock()
  let answer: BranchPullRequest[] = []
  const lookups: number[] = []
  const record = createPullRequestRecord({
    userDataDir: await freshUserDataDir(),
    now: () => clock.nowMs(),
    timers: clock,
    resolveRepoKey: resolveRepo,
    reads: {
      listBranchPullRequests: async () => {
        lookups.push(clock.nowMs())
        return { settled: true, pullRequests: answer }
      },
    },
  })
  await record.noteCheckout(CHAT, { gitRoot: '/repo', branch: 'feature' }, { home: true, force: true })
  assert.equal(lookups.length, 1)
  // The agent opens a pull request and its turn ends a moment later: the
  // earlier answer predates it, so a new lookup is due, but not before the
  // interval has passed since the last one started.
  answer = [pr({ number: 7 })]
  clock.advance(1_000)
  const turnEnd = record.noteCheckout(CHAT, { gitRoot: '/repo', branch: 'feature' }, { home: true, force: true })
  const secondTurnEnd = record.ensureLookedUp({ gitRoot: '/repo', branch: 'feature' }, { force: true })
  await settle()
  assert.equal(lookups.length, 1, 'held until the interval is up')
  clock.tick()
  await Promise.all([turnEnd, secondTurnEnd])
  assert.deepEqual(lookups, [NOW, NOW + FORCED_LOOKUP_MIN_INTERVAL_MS], 'two turn ends, one deferred lookup')
  assert.deepEqual(
    record.forConversation(CHAT).map((entry) => entry.number),
    [7],
  )
  // A hover inside the hold asks nothing.
  await record.ensureLookedUp({ gitRoot: '/repo', branch: 'feature' })
  assert.equal(lookups.length, 2)
  record.dispose()
})

test('a lookup waits for the one in flight on its checkout, so an older answer never lands last', async () => {
  let now = NOW
  const releases: Array<() => void> = []
  const answers = [[pr({ number: 1 })], [pr({ number: 1, state: 'merged' })]]
  let calls = 0
  const record = createPullRequestRecord({
    userDataDir: await freshUserDataDir(),
    now: () => now,
    timers: makeClock(),
    reads: {
      listBranchPullRequests: async () => {
        const answer = answers[calls++]
        await new Promise<void>((resolve) => releases.push(resolve))
        return { settled: true, pullRequests: answer }
      },
    },
  })
  const first = record.ensureLookedUp({ gitRoot: '/repo', branch: 'feature' })
  await settle()
  now += FORCED_LOOKUP_MIN_INTERVAL_MS + 1
  const second = record.ensureLookedUp({ gitRoot: '/repo', branch: 'feature' }, { force: true })
  await settle()
  assert.equal(calls, 1, 'the second does not start while the first is out')
  releases.shift()!()
  await first
  await settle()
  assert.equal(calls, 2, 'and starts once it has landed')
  releases.shift()!()
  await second
  assert.equal(record.forBranch(APP, 'feature')[0].state, 'merged', 'the newer answer is the one kept')
  record.dispose()
})

test('an unsettled read leaves the record exactly as it was, and is held only briefly', async () => {
  let now = NOW
  const changes: PullRequestRecordChange[] = []
  let answer: BranchPullRequestsRead = { settled: true, pullRequests: [pr({ number: 4 })] }
  let asks = 0
  const record = createPullRequestRecord({
    userDataDir: await freshUserDataDir(),
    now: () => now,
    timers: makeClock(),
    resolveRepoKey: resolveRepo,
    onRecordChanged: (change) => changes.push(change),
    reads: {
      listBranchPullRequests: async () => {
        asks += 1
        return answer
      },
    },
  })
  await record.noteCheckout(CHAT, { gitRoot: '/repo', branch: 'feature' }, { home: true })
  const changesAfterFirst = changes.length
  answer = { settled: false, reason: 'gh-failed' }
  now += 60_001
  await record.ensureLookedUp({ gitRoot: '/repo', branch: 'feature' })
  await record.flush()
  assert.equal(record.forConversation(CHAT).length, 1, 'could not ask is never "there are none"')
  assert.equal(changes.length, changesAfterFirst, 'and nothing was re-emitted')
  await record.ensureLookedUp({ gitRoot: '/repo', branch: 'feature' })
  assert.equal(asks, 2, 'a failure is held, so a hover storm is one call')
  now += 10_001
  await record.ensureLookedUp({ gitRoot: '/repo', branch: 'feature' })
  assert.equal(asks, 3, 'and lapses in ten seconds rather than the settled minute')
  record.dispose()
})

test('a machine with no gh asks nothing for five minutes, and says nothing about it', async () => {
  let now = NOW
  let asks = 0
  const warnings: string[] = []
  const record = createPullRequestRecord({
    userDataDir: await freshUserDataDir(),
    now: () => now,
    timers: makeClock(),
    resolveRepoKey: resolveRepo,
    logWarning: (message) => warnings.push(message),
    reads: {
      listBranchPullRequests: async () => {
        asks += 1
        return { settled: false, reason: 'gh-missing' }
      },
      readPullRequestState: async () => {
        asks += 1
        return { settled: false, reason: 'gh-missing' }
      },
    },
  })
  await record.noteCheckout(CHAT, { gitRoot: '/repo', branch: 'feature' }, { home: true, force: true })
  assert.equal(asks, 1)
  now += 60_000
  await record.noteCheckout(CHAT, { gitRoot: '/repo', branch: 'other' }, { home: true, force: true })
  await record.refresh('https://github.com/acme/app/pull/3')
  assert.equal(asks, 1, 'neither a turn end nor a refresh spawns a doomed gh')
  now += GH_MISSING_HOLD_MS
  await record.noteCheckout(CHAT, { gitRoot: '/repo', branch: 'third' }, { home: true, force: true })
  assert.equal(asks, 2, 'and asks again once the hold is up')
  assert.deepEqual(record.forConversation(CHAT), [])
  assert.deepEqual(warnings, [], 'no marks is not an error')
  record.dispose()
})

test('a change names the conversations that worked on its branch, and the new reader hears it', async () => {
  const changes: PullRequestRecordChange[] = []
  const { record } = recordOver(
    await freshUserDataDir(),
    { '/repo@feature': [pr({ number: 4 })] },
    { onRecordChanged: (change) => changes.push(change) },
  )
  await record.noteCheckout(CHAT, { gitRoot: '/repo', branch: 'feature' }, { home: true })
  assert.ok(
    changes.some(
      (change) =>
        change.workspaceIds.includes('ws-1') &&
        change.conversations.some((key) => key.agentId === CHAT.agentId && key.workspaceId === CHAT.workspaceId),
    ),
    `the conversation that asked is told: ${JSON.stringify(changes)}`,
  )
  // A second agent arrives on a branch whose list did not change: it is told it now reads one.
  changes.length = 0
  await record.noteCheckout(OTHER_AGENT, { gitRoot: '/repo', branch: 'feature' }, { home: true })
  assert.deepEqual(changes, [{ repoKey: null, branch: null, workspaceIds: ['ws-1'], conversations: [OTHER_AGENT] }])
  record.dispose()
})

test('where a conversation worked survives a restart, worn before any lookup runs again', async () => {
  const userDataDir = await freshUserDataDir()
  const first = recordOver(userDataDir, { '/repo@feature': [pr({ number: 4 })], '/site@banner': [sitePr(9)] })
  await first.record.noteCheckout(CHAT, { gitRoot: '/repo', branch: 'feature' }, { home: true })
  await first.record.noteCheckout(CHAT, { gitRoot: '/site', branch: 'banner' })
  await first.record.flush()
  first.record.dispose()
  const stored = JSON.parse(await readFile(pullRequestConversationsPath(userDataDir), 'utf-8')) as {
    conversations: Array<{ touches: Array<{ repoKeys: string[] }> }>
  }
  assert.equal(stored.conversations.length, 1)

  const second = recordOver(userDataDir, {}, { loadStoredOnStart: true })
  await second.record.whenLoaded()
  assert.deepEqual(
    second.record.forConversation(CHAT).map((entry) => [entry.number, entry.onSessionBranch === true]),
    [
      [9, false],
      [4, true],
    ],
  )
  assert.deepEqual(second.lookups, [], 'read from disk, not from GitHub')
  assert.deepEqual(second.record.homeOf(CHAT), { gitRoot: '/repo', branch: 'feature' })
  second.record.dispose()
})

test('a conversation remembers a bounded number of checkouts, never dropping its own', async () => {
  const { record } = recordOver(await freshUserDataDir(), {})
  await record.noteCheckout(CHAT, { gitRoot: '/repo', branch: 'home' }, { home: true })
  for (let index = 0; index < 20; index += 1) {
    await record.noteCheckout(CHAT, { gitRoot: `/elsewhere/${index}`, branch: 'work' })
  }
  await record.flush()
  assert.deepEqual(record.homeOf(CHAT), { gitRoot: '/repo', branch: 'home' })
  record.dispose()
})

test('a lookup answered under another key is read back by the checkout that asked', async () => {
  const { record } = recordOver(
    await freshUserDataDir(),
    { '/work/app@feature': [pr({ number: 12 })] },
    // What `git remote get-url origin` says through an ~/.ssh/config alias.
    { resolveRepoKey: async () => 'github-work/acme/app' },
  )
  await record.noteCheckout(CHAT, { gitRoot: '/work/app', branch: 'feature' }, { home: true })
  const listed = record.forConversation(CHAT)
  assert.deepEqual(
    listed.map((entry) => entry.number),
    [12],
  )
  assert.equal(listed[0].repoKey, APP, 'and the row still says which repository it is really in')
  assert.deepEqual(record.watchedUrls(), ['https://github.com/acme/app/pull/12'])
  record.dispose()
})

test('the watch probes every open pull request on its own timer, and stops when it lands', async () => {
  const clock = makeClock()
  const states = new Map<string, PullRequestStateRead>([
    [
      'https://github.com/acme/app/pull/1',
      { settled: true, state: 'merged', isDraft: false, stateAt: NOW, headRefName: 'feature' },
    ],
  ])
  const record = createPullRequestRecord({
    userDataDir: await freshUserDataDir(),
    now: () => clock.nowMs(),
    timers: clock,
    random: () => 0.5,
    reads: {
      listBranchPullRequests: async () => ({
        settled: true,
        pullRequests: [pr({ number: 1 }), pr({ number: 2 }), pr({ number: 3, state: 'closed' })],
      }),
      readPullRequestState: async (url) => states.get(url) ?? { settled: false, reason: 'gh-failed' },
    },
  })
  await record.ensureLookedUp({ gitRoot: '/repo', branch: 'feature' })
  await record.flush()
  assert.deepEqual(record.watchedUrls().sort(), [
    'https://github.com/acme/app/pull/1',
    'https://github.com/acme/app/pull/2',
  ])
  for (let step = 0; step < 2; step += 1) {
    clock.tick()
    await record.flush()
    await settle()
  }
  assert.deepEqual(record.watchedUrls(), ['https://github.com/acme/app/pull/2'], 'merged stops for good')
  assert.equal(record.forBranch(APP, 'feature').find((entry) => entry.number === 2)?.state, 'open')
  record.dispose()
  assert.equal(clock.pendingCount(), 0, 'dispose tears every timer down')
})

test('only a pull request opened in the last 30 days holds a watch timer', async () => {
  const ancient = { ...pr({ number: 40 }), openedAt: NOW - WATCH_MAX_AGE_MS - 1 }
  const recent = { ...pr({ number: 41 }), openedAt: NOW - 1_000 }
  const { record } = recordOver(await freshUserDataDir(), { '/repo@feature': [ancient, recent] })
  await record.ensureLookedUp({ gitRoot: '/repo', branch: 'feature' })
  await record.flush()
  assert.equal(record.forBranch(APP, 'feature').length, 2)
  assert.deepEqual(record.watchedUrls(), ['https://github.com/acme/app/pull/41'])
  record.dispose()
})

test('an unsettled state read is held, a settled one never stands in the way', async () => {
  let now = NOW
  let reads = 0
  let settled = false
  const url = 'https://github.com/acme/app/pull/31'
  const record = createPullRequestRecord({
    userDataDir: await freshUserDataDir(),
    now: () => now,
    timers: makeClock(),
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
  assert.equal(reads, 1)
  now += 10_001
  await record.refresh(url)
  assert.equal(reads, 2)
  settled = true
  now += 10_001
  await record.refresh(url)
  await record.refresh(url)
  assert.equal(reads, 4)
  record.dispose()
})

test('a probe that learned nothing repaints nothing, but its reading is dated and kept', async () => {
  let now = NOW
  const changes: PullRequestRecordChange[] = []
  const userDataDir = await freshUserDataDir()
  const record = createPullRequestRecord({
    userDataDir,
    now: () => now,
    timers: makeClock(),
    resolveRepoKey: resolveRepo,
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
  await record.noteCheckout(CHAT, { gitRoot: '/repo', branch: 'feature' }, { home: true })
  const afterLookup = changes.length
  now += 120_000
  await record.refresh('https://github.com/acme/app/pull/50')
  await record.flush()
  assert.equal(changes.length, afterLookup)
  const persisted = JSON.parse(await readFile(pullRequestStorePath(userDataDir, APP), 'utf-8')) as {
    branches: Record<string, { stateAt: number }[]>
  }
  assert.equal(persisted.branches.feature[0].stateAt, now)
  record.dispose()
})

test('at most three gh reads are in flight at once', async () => {
  let inFlight = 0
  let peak = 0
  const release: (() => void)[] = []
  const record = createPullRequestRecord({
    userDataDir: await freshUserDataDir(),
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
  assert.equal(peak, 3)
  while (release.length > 0) {
    release.shift()?.()
    await settle()
  }
  await Promise.all(reads)
  assert.equal(peak, 3)
  record.dispose()
})

test('a store this build cannot read is kept aside, and a dead write`s temp file is swept', async () => {
  const userDataDir = await freshUserDataDir()
  const dir = join(userDataDir, 'pull-requests')
  await mkdir(dir, { recursive: true })
  const path = pullRequestStorePath(userDataDir, APP)
  await writeFile(path, '{"version":1,"repoKey":"github.com/acme/app","branches":{"feature":[', 'utf-8')
  const stale = `${path}.11111111-2222-3333-4444-555555555555.tmp`
  await writeFile(stale, '{}', 'utf-8')
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await utimes(stale, old, old)
  const warnings: string[] = []
  const { record } = recordOver(
    userDataDir,
    { '/repo@feature': [pr({ number: 60 })] },
    { logWarning: (message) => warnings.push(message) },
  )
  record.forBranch(APP, 'feature')
  await record.ensureLookedUp({ gitRoot: '/repo', branch: 'feature' })
  await record.flush()
  assert.ok(warnings.some((message) => message.includes('aside')))
  const names = await readdir(dir)
  assert.ok(names.some((name) => name.endsWith('.corrupt')))
  assert.ok(!names.includes(basename(stale)))
  assert.deepEqual(
    record.forBranch(APP, 'feature').map((entry) => entry.number),
    [60],
  )
  record.dispose()
})

test('a hand-mangled store cannot smuggle a mark in', async () => {
  const userDataDir = await freshUserDataDir()
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
          {
            url: 'https://github.com/acme/junk/pull/3',
            repoKey: 'github.com/attacker/elsewhere',
            state: 'merged',
            isDraft: true,
            number: 3,
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
    entries.map((entry) => [entry.number, entry.repoKey, entry.isDraft]),
    [[3, junkRepo, false]],
  )
  record.dispose()
})

test('a pull request a hook captured before this build is still worn, placed, and kept through a lookup', async () => {
  // What a terminal agent's hook filed under an unknown branch, with the
  // session and the conversation that opened it.
  const userDataDir = await freshUserDataDir()
  await mkdir(join(userDataDir, 'pull-requests'), { recursive: true })
  await writeFile(
    pullRequestStorePath(userDataDir, WEBSITE),
    JSON.stringify({
      version: 1,
      repoKey: WEBSITE,
      branches: {
        '': [
          {
            ...sitePr(9),
            title: '',
            openedBySessionId: 'terminal-session-1',
            openedByWorkspaceId: 'ws-1',
          },
        ],
      },
    }),
    'utf-8',
  )
  const { record } = recordOver(
    userDataDir,
    { '/site@banner': [{ ...sitePr(9), title: 'Banner' }] },
    {
      loadStoredOnStart: true,
      reads: {
        readPullRequestState: async () => ({
          settled: true,
          state: 'open',
          isDraft: false,
          stateAt: NOW,
          headRefName: 'banner',
          title: 'Banner',
        }),
      },
    },
  )
  await record.whenLoaded()
  assert.deepEqual(
    record.forWorkspace('ws-1').map((entry) => entry.number),
    [9],
    'its conversation still wears it after the restart',
  )
  assert.deepEqual(record.watchedUrls(), ['https://github.com/acme/website/pull/9'], 'and it is watched')
  // The terminal session names itself when it notes where it is.
  await record.noteCheckout(
    CHAT,
    { gitRoot: '/repo', branch: 'feature' },
    { home: true, sessionId: 'terminal-session-1' },
  )
  assert.deepEqual(
    record.forConversation(CHAT).map((entry) => entry.number),
    [9],
    'the agent that captured it wears it too',
  )
  await record.refresh('https://github.com/acme/website/pull/9')
  await record.flush()
  assert.deepEqual(record.forBranch(WEBSITE, ''), [], 'its first state read placed it under its branch')
  await record.ensureLookedUp({ gitRoot: '/site', branch: 'banner' })
  await record.flush()
  const placed = record.forBranch(WEBSITE, 'banner')
  assert.equal(placed.length, 1, 'a lookup finding it again merges by URL')
  assert.equal(placed[0].openedByWorkspaceId, 'ws-1', 'and keeps whose it was')
  assert.equal(placed[0].title, 'Banner')
  record.dispose()
})
