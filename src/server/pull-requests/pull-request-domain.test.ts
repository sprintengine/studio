import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import type { BranchPullRequest } from '../../shared/git/pull-request'
import {
  changedPathsOf,
  createPullRequestDomain,
  MAX_OTHER_REPOSITORIES_PER_TURN,
  type PullRequestsChanged,
} from './pull-request-domain'
import { createPullRequestRecord, type PullRequestCheckout } from './pull-request-record'

// The domain decides WHEN the record asks GitHub and which checkouts a turn
// touched. Git and gh are injected: a folder map stands in for the disk.

const NOW = Date.parse('2026-10-03T12:00:00.000Z')
const APP = 'github.com/acme/app'

function pr(number: number, repo = 'app'): BranchPullRequest {
  return {
    url: `https://github.com/acme/${repo}/pull/${number}`,
    repoKey: `github.com/acme/${repo}`,
    repoName: repo,
    number,
    title: `#${number}`,
    state: 'open',
    isDraft: false,
    openedAt: NOW - number * 1_000,
    stateAt: NOW,
  }
}

type Fixture = {
  /** Folder → the checkout it is in, by longest prefix. */
  checkouts: Record<string, PullRequestCheckout>
  /** `gitRoot@branch` → what `gh pr list` answers. */
  answers: Record<string, BranchPullRequest[]>
  defaultBranches?: Record<string, string | null>
  sessions?: ConversationSessionSummary[]
  sessionRoots?: Record<string, string>
}

async function domainOver(fixture: Fixture) {
  const listeners: Array<(event: ConversationEvent) => void> = []
  const lookups: string[] = []
  const resolved: string[] = []
  const changes: PullRequestsChanged[] = []
  let now = NOW
  const record = createPullRequestRecord({
    userDataDir: await mkdtemp(join(tmpdir(), 'sprintengine-pr-domain-')),
    now: () => now,
    timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    resolveRepoKey: async (gitRoot) => (gitRoot.startsWith('/other') ? 'github.com/acme/other' : APP),
    onRecordChanged: (change) =>
      changes.push({ workspaceIds: change.workspaceIds, conversations: change.conversations }),
    reads: {
      listBranchPullRequests: async ({ gitRoot, branch }) => {
        lookups.push(`${gitRoot}@${branch}`)
        return { settled: true, pullRequests: fixture.answers[`${gitRoot}@${branch}`] ?? [] }
      },
    },
  })
  const domain = createPullRequestDomain({
    dataDir: '/unused',
    record,
    timers: null,
    now: () => now,
    conversations: {
      onEvent: (listener) => {
        listeners.push(listener)
        return () => undefined
      },
      listSessions: () => ({ ok: true, sessions: fixture.sessions ?? [] }),
      sessionWorkspaceRoot: (sessionId) => fixture.sessionRoots?.[sessionId] ?? null,
    },
    workspaceFolder: (workspaceId) => (workspaceId === 'ws-1' ? '/repo' : null),
    resolveCheckout: async (path) => {
      resolved.push(path)
      if (path.startsWith('/gone')) return 'missing'
      const match = Object.keys(fixture.checkouts)
        .filter((folder) => path === folder || path.startsWith(`${folder}/`))
        .sort((a, b) => b.length - a.length)[0]
      return match ? fixture.checkouts[match] : null
    },
    readDefaultBranch: async (gitRoot) =>
      fixture.defaultBranches && gitRoot in fixture.defaultBranches ? fixture.defaultBranches[gitRoot] : 'main',
    log: () => undefined,
  })
  const emit = (event: Partial<ConversationEvent> & Pick<ConversationEvent, 'type'>) => {
    for (const listener of listeners)
      listener({
        id: `e${Math.random()}`,
        sessionId: 'chat-session',
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        providerId: 'p',
        modelId: 'm',
        createdAt: now,
        ...event,
      })
  }
  const settled = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
    await record.flush()
  }
  return {
    domain,
    record,
    lookups,
    resolved,
    changes,
    emit,
    settled,
    advance: (ms: number) => {
      now += ms
    },
  }
}

const CHAT = { workspaceId: 'ws-1', agentId: 'agent-1' }

test('changedPathsOf reads fileChanges defensively: absolute paths only, anything else skipped', () => {
  assert.deepEqual(
    changedPathsOf({
      fileChanges: [
        { path: '/repo/src/a.ts', additions: 1, deletions: 0 },
        { path: 'relative/b.ts' },
        { path: 'C:\\work\\c.ts' },
        { path: 42 },
        null,
        { path: '/bad\0path' },
      ],
    }),
    ['/repo/src/a.ts', 'C:\\work\\c.ts'],
  )
  assert.deepEqual(changedPathsOf({ fileChanges: 'nope' }), [])
  assert.deepEqual(changedPathsOf({ output: 'https://github.com/acme/app/pull/1' }), [], 'a URL in output is nothing')
  assert.deepEqual(changedPathsOf(undefined), [])
})

test('a chat turn end looks up its own checkout and every other repository it changed files in', async () => {
  const fixture = await domainOver({
    checkouts: {
      '/repo': { gitRoot: '/repo', branch: 'feature' },
      '/other/site': { gitRoot: '/other/site', branch: 'banner' },
    },
    answers: { '/repo@feature': [pr(4)], '/other/site@banner': [pr(9, 'other')] },
    sessionRoots: { 'chat-session': '/repo' },
  })
  fixture.emit({
    type: 'tool_output',
    payload: { toolUseId: 't1', fileChanges: [{ path: '/repo/src/a.ts', additions: 1, deletions: 0 }] },
  })
  fixture.emit({
    type: 'tool_output',
    payload: { toolUseId: 't2', fileChanges: [{ path: '/other/site/index.html', additions: 2, deletions: 1 }] },
  })
  // A partial output is not a completed call.
  fixture.emit({
    type: 'tool_output',
    payload: { toolUseId: 't3', partial: true, fileChanges: [{ path: '/elsewhere/x.ts', additions: 1, deletions: 0 }] },
  })
  assert.deepEqual(fixture.lookups, [], 'nothing is asked mid-turn')
  fixture.emit({ type: 'turn_completed' })
  await fixture.settled()
  assert.deepEqual(fixture.lookups.sort(), ['/other/site@banner', '/repo@feature'])
  const listed = await fixture.domain.list({ conversations: [CHAT], workspaceIds: ['ws-1', 'ws-none'] })
  assert.deepEqual(
    listed.conversations[0].pullRequests.map((entry) => [entry.number, entry.onConversationBranch === true]),
    [
      [4, true],
      [9, false],
    ],
  )
  assert.deepEqual(Object.keys(listed.workspaces), ['ws-1'], 'a workspace with nothing is left out')
  assert.equal(
    'openedBySessionId' in listed.workspaces['ws-1'][0],
    false,
    'the wire carries no ids of who filed an entry',
  )
  assert.ok(
    fixture.changes.some((change) => change.workspaceIds.includes('ws-1')),
    'the change reaches the workspace',
  )
  fixture.domain.dispose()
})

test('a turn that ended in the default branch, or with no checkout, asks nothing', async () => {
  const fixture = await domainOver({
    checkouts: {
      '/repo': { gitRoot: '/repo', branch: 'main' },
      '/plain-repo': { gitRoot: '/plain-repo', branch: 'master' },
    },
    answers: { '/repo@main': [pr(1)] },
    defaultBranches: { '/plain-repo': null },
  })
  fixture.emit({
    type: 'tool_output',
    payload: { fileChanges: [{ path: '/plain-repo/a.ts' }, { path: '/not-a-repo/b.ts' }] },
  })
  fixture.emit({ type: 'turn_completed' })
  await fixture.settled()
  assert.deepEqual(
    fixture.lookups,
    [],
    "main is never asked about (every fork's main would answer), nor master when git names no default",
  )
  fixture.domain.dispose()
})

test('one turn looks up a bounded number of other repositories, and walks up past a removed folder', async () => {
  const checkouts: Record<string, PullRequestCheckout> = { '/repo': { gitRoot: '/repo', branch: 'feature' } }
  const paths: string[] = []
  for (let index = 0; index < 10; index += 1) {
    checkouts[`/other/r${index}`] = { gitRoot: `/other/r${index}`, branch: 'work' }
    paths.push(`/other/r${index}/file.ts`)
  }
  const fixture = await domainOver({ checkouts, answers: {} })
  await fixture.domain.noteWork({
    conversation: CHAT,
    checkout: { gitRoot: '/repo', branch: 'feature' },
    changedPaths: paths,
    turnEnded: true,
  })
  await fixture.settled()
  assert.equal(fixture.lookups.length, 1 + MAX_OTHER_REPOSITORIES_PER_TURN)
  fixture.resolved.length = 0
  await fixture.domain.noteWork({ conversation: CHAT, changedPaths: ['/gone/a/b/c.ts'], turnEnded: true })
  assert.deepEqual(fixture.resolved, ['/gone/a/b', '/gone/a', '/gone', '/'], 'a missing folder is walked up, bounded')
  fixture.domain.dispose()
})

test("a terminal agent's note is looked up like a chat's turn, and a relative path is never resolved", async () => {
  const fixture = await domainOver({
    checkouts: { '/repo/wt': { gitRoot: '/repo/wt', branch: 'agent/x' } },
    answers: { '/repo/wt@agent/x': [pr(12)] },
  })
  await fixture.domain.noteWork({
    conversation: { workspaceId: 'ws-2', agentId: 'term-1' },
    sessionId: 'terminal-1',
    checkout: { gitRoot: '/repo/wt', branch: 'agent/x' },
    changedPaths: ['relative.ts'],
    turnEnded: true,
  })
  await fixture.settled()
  assert.deepEqual(fixture.lookups, ['/repo/wt@agent/x'])
  assert.ok(!fixture.resolved.includes('.'), 'a relative path would resolve against the server`s own folder')
  const listed = await fixture.domain.list({ conversations: [{ workspaceId: 'ws-2', agentId: 'term-1' }] })
  assert.deepEqual(
    listed.conversations[0].pullRequests.map((entry) => entry.number),
    [12],
  )
  fixture.domain.dispose()
})

test("the poll notices a chat's branch moving between turns, and looks open conversations up again", async () => {
  const checkouts: Record<string, PullRequestCheckout> = { '/repo': { gitRoot: '/repo', branch: 'feature' } }
  const fixture = await domainOver({
    checkouts,
    answers: { '/repo@feature': [pr(4)], '/repo@second': [pr(5)] },
    sessions: [
      {
        sessionId: 'chat-session',
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        providerId: 'p',
        modelId: 'm',
        status: 'ready',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    sessionRoots: { 'chat-session': '/repo' },
  })
  await fixture.domain.pollOnce(false)
  await fixture.settled()
  assert.deepEqual(fixture.lookups, ['/repo@feature'], 'a chat the record had not seen is noted')
  await fixture.domain.pollOnce(false)
  await fixture.settled()
  assert.equal(fixture.lookups.length, 1, 'an unmoved branch is git only')
  checkouts['/repo'] = { gitRoot: '/repo', branch: 'second' }
  await fixture.domain.pollOnce(false)
  await fixture.settled()
  assert.deepEqual(fixture.lookups, ['/repo@feature', '/repo@second'], 'a moved branch is looked up')
  fixture.advance(61_000)
  await fixture.domain.pollOnce(true)
  await fixture.settled()
  assert.ok(fixture.lookups.length >= 4, `a lookup tick asks GitHub again once the hold is up: ${fixture.lookups}`)
  const listed = await fixture.domain.list({ workspaceIds: ['ws-1'] })
  assert.deepEqual(
    listed.workspaces['ws-1'].map((entry) => entry.number),
    [4, 5],
    'both branches stay on the chat: an earlier pull request is never dropped',
  )
  fixture.domain.dispose()
})

test('a refresh says whether there was anything to ask about', async () => {
  const fixture = await domainOver({ checkouts: {}, answers: {} })
  assert.deepEqual(await fixture.domain.refresh({ conversations: [CHAT] }), { asked: false })
  assert.deepEqual(await fixture.domain.refresh({ workspaceIds: ['ws-1'] }), { asked: false })
  assert.deepEqual(await fixture.domain.refresh({}), { asked: true }, 'with no ids, everything outstanding')
  fixture.domain.dispose()
})
