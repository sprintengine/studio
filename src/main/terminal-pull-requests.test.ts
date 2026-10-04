import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import { socketTransport } from '../../packages/agent-sdk/src/node'
import type { StudioTransportFactory } from '../../packages/agent-sdk/src/transport'
import type { StudioPullRequest, StudioPullRequestsMethodMap } from '../../packages/studio-protocol/src/public'
import type { PullRequestsChanged, StudioPullRequests } from '../server/pull-requests/pull-request-domain'
import { OWNER_TOKEN, startTestServer } from '../server/rpc/studio-rpc.test-helper'
import { createTerminalPullRequests, type PullRequestTerminalSession } from './terminal-pull-requests'

// The shell's half of a terminal agent's pull request marks, against a real
// Studio RPC server whose record is a stub: what the shell tells the server,
// and what it keeps of the answers for the terminal snapshot.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const AGENT: PullRequestTerminalSession = {
  sessionId: 'terminal-1',
  kind: 'agent',
  workspaceId: 'ws-1',
  agentId: 'term-1',
  observedCheckout: { resolved: true, gitRoot: '/Users/dev/app', branch: 'agent/x' },
}
const PLAIN: PullRequestTerminalSession = { sessionId: 'shell-1', kind: 'terminal' }

const MARK: StudioPullRequest = {
  url: 'https://github.com/acme/app/pull/4',
  repoKey: 'github.com/acme/app',
  repoName: 'app',
  number: 4,
  title: 'Marks',
  state: 'open',
  isDraft: false,
  openedAt: 1,
  stateAt: 2,
  onConversationBranch: true,
}

async function bridgeOver(sessions: PullRequestTerminalSession[]) {
  const noted: Array<StudioPullRequestsMethodMap['pullRequests.noteWork']['params']> = []
  const calls: Array<StudioPullRequestsMethodMap['pullRequests.noteToolCall']['params']> = []
  const refreshed: unknown[] = []
  let listed = 0
  const listeners = new Set<(change: PullRequestsChanged) => void>()
  let answer: StudioPullRequest[] = []
  const stub: StudioPullRequests = {
    list: async (target) => {
      listed += 1
      return {
        workspaces: {},
        conversations: (target.conversations ?? [])
          .filter((key) => key.agentId === 'term-1' && answer.length > 0)
          .map((key) => ({ ...key, pullRequests: answer })),
      }
    },
    refresh: async (target) => {
      refreshed.push(target)
      return { asked: true }
    },
    noteWork: async (input) => {
      noted.push(input)
    },
    noteToolCall: async (input) => {
      calls.push(input)
    },
    onChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const started = await startTestServer({ pullRequests: stub })
  cleanups.push(() => started.dispose())
  const socket = socketTransport({ socketPath: started.path })
  const transport: StudioTransportFactory = async () => ({ ...(await socket()), credential: { token: OWNER_TOKEN } })
  const reemitted: string[][] = []
  const bridge = createTerminalPullRequests({
    transport,
    sessions: {
      list: () => sessions,
      get: (sessionId) => sessions.find((session) => session.sessionId === sessionId) ?? null,
    },
    onListsChanged: (affects) => reemitted.push(sessions.filter(affects).map((session) => session.sessionId)),
  })
  cleanups.push(() => bridge.stop())
  await bridge.start()
  return {
    bridge,
    noted,
    calls,
    refreshed,
    reemitted,
    listed: () => listed,
    setAnswer: (next: StudioPullRequest[]) => {
      answer = next
    },
    emit: (change: PullRequestsChanged) => listeners.forEach((listener) => listener(change)),
  }
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > 5_000) throw new Error(`timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('where an agent is, and the calls it made, reach the server; a plain terminal says nothing', async () => {
  const fixture = await bridgeOver([AGENT, PLAIN])
  const call = { name: 'Bash', command: 'gh pr create --fill', output: 'https://github.com/acme/app/pull/4\n' }
  fixture.bridge.noteToolCall(PLAIN, call)
  fixture.bridge.noteToolCall(AGENT, call)
  fixture.bridge.noteCheckoutResolved(PLAIN, { fresh: true })
  fixture.bridge.noteCheckoutResolved(AGENT, { fresh: true })
  await until(() => fixture.noted.length >= 1 && fixture.calls.length >= 1, 'a note and a call')
  assert.deepEqual(fixture.calls, [{ conversation: { workspaceId: 'ws-1', agentId: 'term-1' }, toolCall: call }])
  assert.deepEqual(fixture.noted, [
    {
      conversation: { workspaceId: 'ws-1', agentId: 'term-1' },
      sessionId: 'terminal-1',
      checkout: { gitRoot: '/Users/dev/app', branch: 'agent/x' },
      turnEnded: true,
    },
  ])
  fixture.bridge.noteCheckoutResolved(AGENT, { fresh: false })
  await until(() => fixture.noted.length >= 2, 'a second note')
  assert.equal(fixture.noted[1].turnEnded, false)
})

test('a change the server names is fetched onto the session, and only its snapshot is re-sent', async () => {
  const fixture = await bridgeOver([AGENT, PLAIN])
  assert.deepEqual(fixture.bridge.listForSession(AGENT), [])
  fixture.setAnswer([MARK])
  fixture.emit({ workspaceIds: ['ws-1'], conversations: [{ workspaceId: 'ws-1', agentId: 'term-1' }] })
  await until(() => fixture.bridge.listForSession(AGENT).length === 1, 'the list')
  const [mark] = fixture.bridge.listForSession(AGENT)
  assert.equal(mark.onSessionBranch, true, "the server's own-branch reading is the snapshot's")
  assert.equal('onConversationBranch' in mark, false)
  assert.deepEqual(fixture.reemitted, [['terminal-1']])
  assert.deepEqual(fixture.bridge.listForSession(PLAIN), [])
  // The same answer again moves nothing and re-sends nothing: a later answer
  // that does move is the only other re-send.
  const asked = fixture.listed()
  fixture.emit({ workspaceIds: ['ws-1'], conversations: [] })
  await until(() => fixture.listed() > asked, 'the same list asked for again')
  fixture.setAnswer([{ ...MARK, state: 'merged' }])
  fixture.emit({ workspaceIds: ['ws-1'], conversations: [] })
  await until(() => fixture.bridge.listForSession(AGENT)[0]?.state === 'merged', 'the merge')
  assert.deepEqual(fixture.reemitted, [['terminal-1'], ['terminal-1']])
})

test('a hover asks the server again only for an agent there is something to ask about', async () => {
  const fixture = await bridgeOver([
    AGENT,
    PLAIN,
    { ...AGENT, sessionId: 'unresolved', agentId: 'term-2', observedCheckout: null },
  ])
  assert.equal(fixture.bridge.refreshForSession('no-such-session'), false)
  assert.equal(fixture.bridge.refreshForSession('shell-1'), false)
  assert.equal(fixture.bridge.refreshForSession('unresolved'), false, 'a checkout not resolved yet has nothing to ask')
  assert.equal(fixture.bridge.refreshForSession('terminal-1'), true)
  await until(() => fixture.refreshed.length >= 1, 'a refresh')
  assert.deepEqual(fixture.refreshed, [{ conversations: [{ workspaceId: 'ws-1', agentId: 'term-1' }] }])
})
