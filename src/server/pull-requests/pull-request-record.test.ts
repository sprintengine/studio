import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import type { PullRequestStateRead } from '../../main/github/branch-pull-request'
import {
  createPullRequestRecord,
  GH_MISSING_HOLD_MS,
  pullRequestStorePath,
  type PullRequestRecordChange,
  type PullRequestRecordOptions,
} from './pull-request-record'

// No `gh` and no network: the one GitHub read is injected. What is under test
// is what the record DECIDES — whose a pull request is, and what it shows.

const NOW = Date.parse('2026-10-04T12:00:00.000Z')
const CHAT = { workspaceId: 'ws-1', agentId: 'agent-1' }
const OTHER_AGENT = { workspaceId: 'ws-1', agentId: 'agent-2' }
const OTHER_CHAT = { workspaceId: 'ws-2', agentId: 'agent-9' }
const PR_12 = 'https://github.com/acme/app/pull/12'

/** A hand-driven clock for the watch's timers. */
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
    advance(ms: number): void {
      nowMs += ms
    },
    pendingCount: () => pending.size,
    nowMs: () => nowMs,
  }
}

function freshUserDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sprintengine-pr-record-'))
}

function opened(overrides: Partial<Extract<PullRequestStateRead, { settled: true }>> = {}): PullRequestStateRead {
  return {
    settled: true,
    state: 'open',
    isDraft: false,
    stateAt: NOW,
    headRefName: 'feature/marks',
    title: 'Teach the sidebar to say where the work went',
    openedAt: NOW - 60_000,
    number: 12,
    ...overrides,
  }
}

/** A record whose GitHub read answers from `answers` by URL, counting the reads. */
function recordOver(
  userDataDir: string,
  answers: Record<string, PullRequestStateRead>,
  extra: Partial<PullRequestRecordOptions> = {},
) {
  const reads: string[] = []
  const changes: PullRequestRecordChange[] = []
  const clock = makeClock()
  const record = createPullRequestRecord({
    userDataDir,
    reads: {
      readPullRequestState: async (url) => {
        reads.push(url)
        return answers[url] ?? { settled: false, reason: 'gh-failed' }
      },
    },
    onRecordChanged: (change) => changes.push(change),
    now: clock.nowMs,
    timers: clock,
    random: () => 0.5,
    logWarning: () => undefined,
    ...extra,
  })
  return { record, reads, changes, clock }
}

test('a pull request a conversation opened is that conversation’s, and nobody else’s', async () => {
  const { record, reads, changes } = recordOver(await freshUserDataDir(), { [PR_12]: opened() })
  const outcome = await record.noteOpened(CHAT, { url: `${PR_12}/files` })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.ok && outcome.recorded, true)
  await record.flush()

  const mine = record.forConversation(CHAT)
  assert.deepEqual(
    mine.map((entry) => entry.url),
    [PR_12],
    'filed under its canonical URL',
  )
  assert.equal(mine[0].title, 'Teach the sidebar to say where the work went', 'its state was read at once')
  assert.equal(mine[0].headRefName, 'feature/marks')
  assert.deepEqual(reads, [PR_12])
  assert.deepEqual(record.forConversation(OTHER_AGENT), [], 'another agent in the same workspace does not wear it')
  assert.deepEqual(record.forConversation(OTHER_CHAT), [])
  assert.deepEqual(
    record.forWorkspace('ws-1').map((entry) => entry.url),
    [PR_12],
    'the workspace row wears what any conversation in it opened',
  )
  assert.deepEqual(record.forWorkspace('ws-2'), [])
  assert.ok(
    changes.some((change) => change.conversations.some((key) => key.agentId === CHAT.agentId)),
    'the owner hears it',
  )
  record.dispose()
})

test('the first conversation to claim a pull request keeps it', async () => {
  const { record } = recordOver(await freshUserDataDir(), { [PR_12]: opened() })
  await record.noteOpened(CHAT, { url: PR_12 })
  const again = await record.noteOpened(CHAT, { url: PR_12 })
  assert.equal(again.ok && again.recorded, false, 'claiming it twice is harmless')
  const theirs = await record.noteOpened(OTHER_CHAT, { url: PR_12 })
  assert.equal(theirs.ok, false)
  assert.equal(!theirs.ok && theirs.code, 'opened_by_another_conversation')
  await record.flush()
  assert.deepEqual(record.forConversation(OTHER_CHAT), [])
  assert.equal(record.forConversation(CHAT).length, 1)
  record.dispose()
})

test('only a pull request URL is recorded', async () => {
  const { record } = recordOver(await freshUserDataDir(), {})
  for (const url of [
    'https://github.com/acme/app/pull/new/feature',
    'https://github.com/acme/app/issues/12',
    'https://api.github.com/repos/acme/app/pulls/12',
    'not a url',
  ]) {
    const outcome = await record.noteOpened(CHAT, { url })
    assert.equal(outcome.ok, false, url)
    assert.equal(!outcome.ok && outcome.code, 'not_a_pull_request', url)
  }
  assert.deepEqual(record.forConversation(CHAT), [])
  record.dispose()
})

test('a pull request on another forge is shown as opened, and never read', async () => {
  const { record, reads, clock } = recordOver(await freshUserDataDir(), {})
  const url = 'https://gitlab.example.com/acme/platform/app/-/merge_requests/7'
  const outcome = await record.noteOpened(CHAT, { url, title: 'Add the thing' })
  assert.equal(outcome.ok, true)
  await record.flush()
  const [entry] = record.forConversation(CHAT)
  assert.equal(entry.forge, 'gitlab')
  assert.equal(entry.repoKey, 'gitlab.example.com/acme/platform/app')
  assert.equal(entry.number, 7)
  assert.equal(entry.title, 'Add the thing', 'the title the agent gave stands in for the forge’s')
  assert.equal(entry.state, 'open')
  assert.deepEqual(reads, [], '`gh` is never asked about it')
  assert.equal(clock.pendingCount(), 0, 'and it holds no watch')
  record.refreshConversation(CHAT)
  await record.flush()
  assert.deepEqual(reads, [])
  record.dispose()
})

test('the branch the conversation is on decides which of its pull requests may say it landed', async () => {
  const { record } = recordOver(await freshUserDataDir(), { [PR_12]: opened() })
  await record.noteOpened(CHAT, { url: PR_12 })
  await record.flush()
  assert.equal(record.forConversation(CHAT)[0].onSessionBranch, undefined, 'no checkout noted yet')
  record.noteCheckout(CHAT, { gitRoot: '/repo', branch: 'feature/marks' })
  assert.equal(record.forConversation(CHAT)[0].onSessionBranch, true)
  assert.deepEqual(record.homeOf(CHAT), { gitRoot: '/repo', branch: 'feature/marks' })
  record.noteCheckout(CHAT, { gitRoot: '/repo', branch: 'main' })
  assert.equal(record.forConversation(CHAT)[0].onSessionBranch, undefined)
  assert.equal(record.forWorkspace('ws-1')[0].onSessionBranch, undefined, 'a row speaks for no branch')
  // A checkout never adds a pull request: another conversation on the same
  // branch wears nothing.
  record.noteCheckout(OTHER_AGENT, { gitRoot: '/repo', branch: 'feature/marks' })
  assert.deepEqual(record.forConversation(OTHER_AGENT), [])
  record.dispose()
})

test('a read that could not be made changes nothing, and a missing gh holds every read', async () => {
  const dir = await freshUserDataDir()
  let answer: PullRequestStateRead = { settled: false, reason: 'gh-missing' }
  const reads: string[] = []
  const clock = makeClock()
  const record = createPullRequestRecord({
    userDataDir: dir,
    reads: {
      readPullRequestState: async (url) => {
        reads.push(url)
        return answer
      },
    },
    now: clock.nowMs,
    timers: clock,
    logWarning: () => undefined,
  })
  await record.noteOpened(CHAT, { url: PR_12 })
  await record.flush()
  const [entry] = record.forConversation(CHAT)
  assert.equal(entry.state, 'open')
  assert.equal(entry.stateAt, 0, 'never read')
  assert.equal(reads.length, 1)
  record.refreshConversation(CHAT)
  await record.flush()
  assert.equal(reads.length, 1, 'held while gh is missing')
  clock.advance(GH_MISSING_HOLD_MS + 1)
  answer = opened({ state: 'merged', stateAt: clock.nowMs() })
  record.refreshConversation(CHAT)
  await record.flush()
  assert.equal(reads.length, 2)
  assert.equal(record.forConversation(CHAT)[0].state, 'merged')
  record.dispose()
})

test('an open GitHub pull request is watched until it lands', async () => {
  const answers: Record<string, PullRequestStateRead> = { [PR_12]: opened() }
  const { record } = recordOver(await freshUserDataDir(), answers)
  await record.noteOpened(CHAT, { url: PR_12 })
  await record.flush()
  assert.deepEqual(record.watchedUrls(), [PR_12])
  answers[PR_12] = opened({ state: 'merged' })
  await record.refresh(PR_12)
  await record.flush()
  assert.deepEqual(record.watchedUrls(), [], 'a merged one is never probed again')
  record.dispose()
})

test('the record survives a restart', async () => {
  const dir = await freshUserDataDir()
  const first = recordOver(dir, { [PR_12]: opened() })
  await first.record.noteOpened(CHAT, { url: PR_12 })
  await first.record.flush()
  first.record.dispose()

  const stored = JSON.parse(await readFile(pullRequestStorePath(dir), 'utf-8')) as { version: number }
  assert.equal(stored.version, 2)

  const second = recordOver(dir, {})
  await second.record.whenLoaded()
  const [entry] = second.record.forConversation(CHAT)
  assert.equal(entry.url, PR_12)
  assert.equal(entry.title, 'Teach the sidebar to say where the work went')
  assert.equal(entry.openedByAgentId, 'agent-1')
  second.record.dispose()
})

test('the branch-lookup files migrate: what a conversation opened stays, what a lookup found goes', async () => {
  const dir = await freshUserDataDir()
  const store = join(dir, 'pull-requests')
  await mkdir(store, { recursive: true })
  const row = (number: number, extra: Record<string, unknown> = {}) => ({
    url: `https://github.com/acme/app/pull/${number}`,
    repoKey: 'github.com/acme/app',
    repoName: 'app',
    number,
    title: `#${number}`,
    state: 'merged',
    isDraft: false,
    openedAt: NOW - number,
    stateAt: NOW - number,
    ...extra,
  })
  await writeFile(
    join(store, 'app-0123456789abcdef.json'),
    JSON.stringify({
      version: 1,
      repoKey: 'github.com/acme/app',
      branches: {
        // Found on a branch someone's conversation happened to be on.
        'someone-else': [row(1)],
        // Opened by a chat, captured before the agent was known.
        'feature/marks': [row(2, { openedByWorkspaceId: 'ws-1', openedBySessionId: 'term-1' })],
        // Captured under a terminal session alone: no conversation can be named.
        '': [row(3, { openedBySessionId: 'term-2', state: 'open' })],
      },
    }),
  )
  await writeFile(join(store, 'conversations.json'), JSON.stringify({ version: 1, conversations: [] }))

  const { record, reads } = recordOver(dir, {})
  await record.whenLoaded()
  await record.flush()
  assert.deepEqual(
    record.forWorkspace('ws-1').map((entry) => entry.number),
    [2],
  )
  const [kept] = record.forConversation(CHAT)
  assert.equal(kept.number, 2, 'every conversation in the workspace wears an unclaimed capture')
  assert.equal(kept.headRefName, 'feature/marks', 'its branch comes from the bucket it sat in')
  assert.equal(record.forConversation(OTHER_AGENT).length, 1)
  assert.deepEqual(reads, [], 'a merged one is not read again')
  assert.deepEqual((await readdir(store)).sort(), ['opened.json'], 'the old files are gone')

  // The agent that opened it says so, and it is that conversation's alone.
  const claimed = await record.noteOpened(CHAT, { url: kept.url })
  assert.equal(claimed.ok && claimed.recorded, false)
  assert.equal(record.forConversation(OTHER_AGENT).length, 0)
  assert.equal(record.forConversation(CHAT)[0].openedByAgentId, 'agent-1')
  record.dispose()
})

// A file mode locks nothing on Windows, or for root.
test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'a record that is there but cannot be read is not written over',
  async () => {
    const dir = await freshUserDataDir()
    await mkdir(join(dir, 'pull-requests'), { recursive: true })
    const stored = '{"version": 2, "pullRequests": []}'
    await writeFile(pullRequestStorePath(dir), stored)
    await chmod(pullRequestStorePath(dir), 0o000)
    const { record } = recordOver(dir, { [PR_12]: opened() })
    await record.whenLoaded()
    await record.noteOpened(CHAT, { url: PR_12 })
    await record.flush()
    await chmod(pullRequestStorePath(dir), 0o600)
    assert.equal(await readFile(pullRequestStorePath(dir), 'utf8'), stored)
    assert.equal(record.forConversation(CHAT).length, 1)
    record.dispose()
  },
)

test('an unreadable record is kept aside, not overwritten', async () => {
  const dir = await freshUserDataDir()
  await mkdir(join(dir, 'pull-requests'), { recursive: true })
  await writeFile(pullRequestStorePath(dir), '{"version": 99')
  const { record } = recordOver(dir, { [PR_12]: opened() })
  await record.whenLoaded()
  await record.noteOpened(CHAT, { url: PR_12 })
  await record.flush()
  const names = await readdir(join(dir, 'pull-requests'))
  assert.ok(names.includes('opened.json.corrupt'))
  assert.equal(record.forConversation(CHAT).length, 1)
  record.dispose()
})
