import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

import type { StudioPullRequest } from '../../../../../packages/studio-protocol/src/public'
import type { BranchPullRequest } from '../../../../shared/git/pull-request'
import type { PullRequestsChanged, StudioPullRequests } from '../../../../server/pull-requests/pull-request-domain'
import { installStudioLoopback, type StudioLoopback } from '../../../../../tests/studio-chat-loopback'

// The open chat reads the pull requests its own conversation opened, by
// conversation, from the record the sidebar reads: asked on mount and again
// when the server names what moved.

function mark(number: number, state: StudioPullRequest['state'] = 'open'): StudioPullRequest {
  return {
    url: `https://github.com/acme/app/pull/${number}`,
    repoKey: 'github.com/acme/app',
    repoName: 'app',
    number,
    title: `#${number}`,
    state,
    isDraft: false,
    openedAt: number,
    stateAt: number,
  }
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > 5_000) throw new Error(`timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('usePullRequestsOfConversation', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  // Conversation → what the record answers for it.
  const answers: Record<string, StudioPullRequest[]> = { 'ws-1\0agent-1': [mark(4)], 'ws-1\0agent-2': [mark(5)] }
  const asked: unknown[] = []
  // An answer for agent-1 waits on this while a test holds it.
  let held: Promise<void> = Promise.resolve()
  const listeners = new Set<(change: PullRequestsChanged) => void>()
  const pullRequests: StudioPullRequests = {
    list: async (target) => {
      asked.push(target)
      if (target.conversations?.[0]?.agentId === 'agent-1') await held
      return {
        workspaces: {},
        conversations: (target.conversations ?? [])
          .filter((key) => answers[`${key.workspaceId}\0${key.agentId}`])
          .map((key) => ({ ...key, pullRequests: answers[`${key.workspaceId}\0${key.agentId}`] })),
      }
    },
    refresh: async () => ({ asked: true }),
    noteWork: async () => undefined,
    noteToolCall: async () => undefined,
    link: async () => ({ ok: false, code: 'not_a_pull_request', message: 'not here' }),
    onChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const win = dom.window as unknown as { api: Record<string, unknown> }
  win.api = {}
  const loopback = installStudioLoopback(win, { pullRequests }) as StudioLoopback

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { usePullRequestsOfConversation } = await import('./useConversationPullRequests')

  let seen: readonly BranchPullRequest[] = []
  function Probe({ conversation }: { conversation: { workspaceId: string; agentId: string } | null }) {
    seen = usePullRequestsOfConversation(conversation)
    return null
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(React.createElement(Probe, { conversation: { workspaceId: 'ws-1', agentId: 'agent-1' } })),
  )
  try {
    await until(() => seen.length === 1, 'the first list')
    assert.equal(seen[0].number, 4, 'its own conversation’s, not another agent’s in the workspace')
    assert.deepEqual(asked[0], { conversations: [{ workspaceId: 'ws-1', agentId: 'agent-1' }] })

    await until(() => listeners.size === 1, 'the subscription')
    answers['ws-1\0agent-1'] = [mark(4, 'merged')]
    await act(async () =>
      listeners.forEach((listener) =>
        listener({ workspaceIds: ['ws-1'], conversations: [{ workspaceId: 'ws-1', agentId: 'agent-1' }] }),
      ),
    )
    await until(() => seen[0]?.state === 'merged', 'the merge')

    // The view moves to another conversation while an ask for the first is
    // still out: the late answer is not drawn on the second.
    let release = () => {}
    held = new Promise<void>((resolve) => (release = resolve))
    await act(async () =>
      listeners.forEach((listener) =>
        listener({ workspaceIds: ['ws-1'], conversations: [{ workspaceId: 'ws-1', agentId: 'agent-1' }] }),
      ),
    )
    const before = asked.length
    await until(() => asked.length > before, 'the held ask')
    await act(async () =>
      root.render(React.createElement(Probe, { conversation: { workspaceId: 'ws-1', agentId: 'agent-2' } })),
    )
    await until(() => seen[0]?.number === 5, 'the second conversation’s list')
    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    assert.equal(seen[0]?.number, 5, 'the first conversation’s late answer is dropped')

    // No conversation to ask about (a chat on a paired machine): nothing.
    await act(async () => root.render(React.createElement(Probe, { conversation: null })))
    await until(() => seen.length === 0, 'nothing for no conversation')
  } finally {
    await act(async () => root.unmount())
    loopback.drop()
  }
})
