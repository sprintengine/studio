import assert from 'node:assert/strict'
import { test } from 'vitest'

import { EDITOR_REVEAL_REQUEST_CHANNEL, type EditorRevealRequest } from '../../shared/editor-reveal'
import { createEditorRevealBroker, type EditorRevealTarget } from './editor-reveal-broker'

type Sent = { target: string; channel: string; payload: unknown }

function harness(windowIds: string[], waitMs = 30) {
  const sent: Sent[] = []
  const pendingBroadcasts: string[][] = []
  let counter = 0
  let respond: ((target: string, payload: Record<string, unknown>) => void) | null = null
  const targets: EditorRevealTarget[] = windowIds.map((id) => ({
    id,
    isDestroyed: () => false,
    send: (channel, payload) => {
      sent.push({ target: id, channel, payload })
      respond?.(id, payload as Record<string, unknown>)
    },
  }))
  const broker = createEditorRevealBroker({
    targets: () => targets,
    broadcastPending: (ids) => pendingBroadcasts.push(ids),
    newRequestId: () => `req-${++counter}`,
    waitMs,
  })
  return {
    broker,
    sent,
    pendingBroadcasts,
    /** How each window answers a request, synchronously as it is sent. */
    answer(fn: (target: string, payload: Record<string, unknown>) => void) {
      respond = fn
    },
  }
}

const request = (workspaceId: string, note: string | null = null): Omit<EditorRevealRequest, 'requestId'> => ({
  workspaceId,
  agentName: 'Claude',
  note,
  files: [{ path: '/Users/dev/repo/a.ts', displayPath: 'a.ts', name: 'a.ts', range: { startLine: 3 } }],
  awaiting: [],
  diff: null,
})

test('the window showing the workspace opens it and says what the person could see', async () => {
  const h = harness(['win-a', 'win-b'])
  h.answer((target, payload) => {
    const requestId = payload.requestId as string
    if (target === 'win-b') h.broker.handleAck(target, { requestId, outcome: 'opened', shown: 'background' })
    else h.broker.handleAck(target, { requestId, outcome: 'declined' })
  })
  const result = await h.broker.reveal(request('ws-1'))
  assert.deepEqual(result, { shown: 'background' })
  assert.equal(h.sent.filter((entry) => entry.channel === EDITOR_REVEAL_REQUEST_CHANNEL).length, 2)
  assert.equal(h.broker.hasPending('ws-1'), false)
})

test('no window showing it: nothing is opened now, the request waits, and the sidebar is told', async () => {
  const h = harness(['win-a'])
  h.answer((target, payload) => h.broker.handleAck(target, { requestId: payload.requestId, outcome: 'declined' }))
  const result = await h.broker.reveal(request('ws-1', 'first'))
  assert.deepEqual(result, { shown: 'not_visible' })
  assert.deepEqual(h.broker.pendingWorkspaceIds(), ['ws-1'])
  assert.deepEqual(h.pendingBroadcasts.at(-1), ['ws-1'])

  // Latest wins: the newest thing the agent wanted to show is the one kept.
  await h.broker.reveal(request('ws-1', 'second'))
  const claimed = h.broker.claimPending('ws-1')
  assert.equal(claimed?.note, 'second')
  // Claimed once: a second window switching to it gets nothing.
  assert.equal(h.broker.claimPending('ws-1'), null)
  assert.deepEqual(h.pendingBroadcasts.at(-1), [])
})

test('with no windows at all the request waits without anything being sent', async () => {
  const h = harness([])
  assert.deepEqual(await h.broker.reveal(request('ws-2')), { shown: 'not_visible' })
  assert.equal(h.sent.length, 0)
  assert.equal(h.broker.hasPending('ws-2'), true)
})

test('silence is read as not showing it; a late "opened" withdraws the queued copy', async () => {
  const h = harness(['win-a'], 10)
  const result = await h.broker.reveal(request('ws-3'))
  assert.deepEqual(result, { shown: 'not_visible' })
  assert.equal(h.broker.hasPending('ws-3'), true)
  const requestId = (h.sent[0].payload as { requestId: string }).requestId
  h.broker.handleAck('win-a', { requestId, outcome: 'opened', shown: 'foreground' })
  assert.equal(h.broker.hasPending('ws-3'), false, 'the window did open it, so it must not open twice')
})

test('an answer from a window the question did not go to is ignored', async () => {
  const h = harness(['win-a'], 20)
  h.answer((_target, payload) =>
    h.broker.handleAck('intruder', { requestId: payload.requestId, outcome: 'opened', shown: 'foreground' }),
  )
  assert.deepEqual(await h.broker.reveal(request('ws-4')), { shown: 'not_visible' })
})

test('editor state comes from the window that shows the workspace, and is null when none does', async () => {
  const h = harness(['win-a', 'win-b'])
  h.answer((target, payload) => {
    if (payload.workspaceId !== 'ws-5') return
    if (target === 'win-a') {
      h.broker.handleStateReply(target, { requestId: payload.requestId, outcome: 'declined' })
      return
    }
    h.broker.handleStateReply(target, {
      requestId: payload.requestId,
      outcome: 'answered',
      state: { windowVisible: true, active: null, openFiles: ['/Users/dev/repo/a.ts'], awaitingOwner: 1 },
    })
  })
  const state = await h.broker.queryState('ws-5')
  assert.deepEqual(state, {
    windowVisible: true,
    active: null,
    openFiles: ['/Users/dev/repo/a.ts'],
    awaitingOwner: 1,
  })
  h.answer((target, payload) =>
    h.broker.handleStateReply(target, { requestId: payload.requestId, outcome: 'declined' }),
  )
  assert.equal(await h.broker.queryState('ws-6'), null)
})
