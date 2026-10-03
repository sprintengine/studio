import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import { createPullRequestRecord, HOVER_REFRESH_STALE_MS, type PullRequestRecordChange } from './pull-request-record'
import type { PullRequestStateRead } from './github/branch-pull-request'

// A conversation's pull requests once its agents are gone (owner, 2026-10-02):
// "I should be able to scan my thread and see exactly what is outstanding."
// These are the rows with no live session, so nothing a session does may be
// what keeps them fresh.

const NOW = Date.parse('2026-10-02T22:00:00.000Z')
const URL = 'https://github.com/acme/app/pull/137'

const noTimers = { setTimeout: () => 0, clearTimeout: () => undefined }

function stateRead(state: 'open' | 'merged', stateAt: number): PullRequestStateRead {
  return { settled: true, state, isDraft: false, stateAt, headRefName: 'feat/chat-replay' }
}

async function capturedOpenPullRequest(userDataDir: string): Promise<void> {
  const record = createPullRequestRecord({
    userDataDir,
    now: () => NOW,
    timers: noTimers,
    reads: {
      listBranchPullRequests: async () => ({ settled: true, pullRequests: [] }),
      readPullRequestState: async () => stateRead('open', NOW),
    },
  })
  record.noteCaptured({ url: URL, workspaceId: 'chat-1' })
  await record.flush()
  assert.equal(record.forWorkspace('chat-1')[0]?.state, 'open')
  record.dispose()
}

test('a stored conversation pull request is there after a restart, with no session to ask for it', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'sprintengine-pr-conversations-'))
  await capturedOpenPullRequest(userDataDir)

  const changes: PullRequestRecordChange[] = []
  const record = createPullRequestRecord({
    userDataDir,
    now: () => NOW,
    timers: noTimers,
    loadStoredOnStart: true,
    onRecordChanged: (change) => changes.push(change),
    reads: {
      listBranchPullRequests: async () => ({ settled: true, pullRequests: [] }),
      readPullRequestState: async () => stateRead('open', NOW),
    },
  })
  await record.flush()

  assert.deepEqual(
    record.forWorkspace('chat-1').map((entry) => entry.url),
    [URL],
    'the conversation holds its pull request without any session asking about the repository',
  )
  assert.ok(
    changes.some((change) => change.workspaceIds.includes('chat-1')),
    'and the windows are told, so a sidebar that asked before the load asks again',
  )
  assert.deepEqual(record.watchedUrls(), [URL], 'an open one is watched for its merge')
  record.dispose()
})

test('without loadStoredOnStart a repository still loads only when asked', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'sprintengine-pr-conversations-'))
  await capturedOpenPullRequest(userDataDir)

  const record = createPullRequestRecord({ userDataDir, now: () => NOW, timers: noTimers })
  await record.flush()
  assert.deepEqual(record.forWorkspace('chat-1'), [])
  record.dispose()
})

test('a window focus re-reads a stale open pull request that no live session holds', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'sprintengine-pr-conversations-'))
  await capturedOpenPullRequest(userDataDir)

  let now = NOW
  const reads: string[] = []
  const record = createPullRequestRecord({
    userDataDir,
    now: () => now,
    timers: noTimers,
    loadStoredOnStart: true,
    // No live sessions at all: the only thing that can reach the pull request
    // is the record's own sweep of what it holds.
    sessions: { get: () => null, list: () => [] },
    reads: {
      listBranchPullRequests: async () => ({ settled: true, pullRequests: [] }),
      readPullRequestState: async (url) => {
        reads.push(url)
        return stateRead('merged', now)
      },
    },
  })
  await record.flush()

  record.refreshOnFocus()
  await record.flush()
  assert.deepEqual(reads, [], 'a reading taken inside the hover window is not asked again')

  now += HOVER_REFRESH_STALE_MS + 1
  record.refreshOnFocus()
  await record.flush()
  assert.deepEqual(reads, [URL], 'a stale one is')
  assert.equal(record.forWorkspace('chat-1')[0]?.state, 'merged', 'and the row learns it merged')
  assert.deepEqual(record.watchedUrls(), [], 'a merged one holds no timer')

  now += HOVER_REFRESH_STALE_MS + 1
  record.refreshOnFocus()
  await record.flush()
  assert.deepEqual(reads, [URL], 'merged is terminal: never asked about again')
  record.dispose()
})

test('a branch lookup that finds a captured pull request keeps the conversation it belongs to', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'sprintengine-pr-conversations-'))
  const record = createPullRequestRecord({
    userDataDir,
    now: () => NOW,
    timers: noTimers,
    resolveRepoKey: async () => 'github.com/acme/app',
    reads: {
      listBranchPullRequests: async () => ({
        settled: true,
        pullRequests: [
          {
            url: URL,
            repoKey: 'github.com/acme/app',
            repoName: 'app',
            number: 137,
            title: 'feat(chat): replay a conversation',
            state: 'open',
            isDraft: false,
            openedAt: NOW,
            stateAt: NOW,
          },
        ],
      }),
      readPullRequestState: async () => stateRead('open', NOW),
    },
  })
  record.noteCaptured({ url: URL, workspaceId: 'chat-1' })
  await record.flush()
  await record.ensureLookedUp({ gitRoot: '/repo', branch: 'feat/chat-replay' })
  await record.flush()
  assert.deepEqual(
    record.forWorkspace('chat-1').map((entry) => entry.title),
    ['feat(chat): replay a conversation'],
    "the lookup's reading lands, and the conversation still holds it",
  )
  record.dispose()
})
