import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationEvent, ConversationSessionFrame } from '../shared/conversation-runtime'
import type { ConversationBackend } from '../server/core/conversation-backend'
import { ConversationSessionApi } from './conversation-session-api'

// A subscription to a chat on another server catches up when the router says
// that server's wire came back: by its cursor while the log vouches for it,
// with a reset snapshot when the log was rewritten meanwhile, and only for
// chats that server holds.

function routerStandIn() {
  const log: ConversationEvent[] = []
  let generation = 'g1'
  const listeners = new Set<(event: ConversationEvent) => void>()
  const resumed = new Set<(key: string) => void>()
  const syncs: Array<{ afterSeq?: number; generation?: string }> = []
  const event = (seq: number): ConversationEvent =>
    ({
      seq,
      type: 'content_delta',
      sessionId: 's',
      workspaceId: 'w-ssh',
      agentId: 'a',
      createdAt: seq,
    }) as ConversationEvent
  const backend = {
    onEvent: (listener: (event: ConversationEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    recoverTranscript: async () => undefined,
    readConversationSync: async (_key: unknown, input: { afterSeq?: number; generation?: string }) => {
      syncs.push(input)
      const head = log.at(-1)?.seq ?? 0
      if (input.afterSeq !== undefined && input.generation === generation)
        return {
          ok: true,
          kind: 'events',
          events: log.filter((entry) => (entry.seq ?? 0) > input.afterSeq!),
          head,
          generation,
        }
      return {
        ok: true,
        kind: 'snapshot',
        page: { events: [...log], hasMore: false, beforeCursor: null },
        head,
        generation,
      }
    },
    routeOf: (workspaceId: string) => (workspaceId === 'w-ssh' ? 'ssh:e1' : null),
    onRouteResumed: (listener: (key: string) => void) => {
      resumed.add(listener)
      return () => resumed.delete(listener)
    },
  }
  return {
    backend: backend as unknown as ConversationBackend,
    syncs,
    append: (seq: number, publish: boolean) => {
      log.push(event(seq))
      if (publish) for (const listener of listeners) listener(event(seq))
    },
    rewrite: () => (generation = 'g2'),
    resume: (key: string) => resumed.forEach((listener) => listener(key)),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const seqs = (frames: ConversationSessionFrame[]) =>
  frames.flatMap((frame) => (frame.type === 'event' ? [frame.event.seq] : []))

test('events missed while the wire was down are handed over by the cursor, once, in order', async () => {
  const router = routerStandIn()
  router.append(1, false)
  const frames: ConversationSessionFrame[] = []
  const api = new ConversationSessionApi(router.backend)
  const subscription = api.subscribe(
    { key: { workspaceId: 'w-ssh', agentId: 'a', workspaceRoot: '/home/dev/repo' } },
    (frame) => frames.push(frame),
  )
  await subscription.ready
  router.append(2, true)
  // Down: these reach nobody.
  router.append(3, false)
  router.append(4, false)
  // Another server's resume is not this chat's.
  router.resume('wsl:Ubuntu')
  await settle()
  assert.equal(router.syncs.length, 1)
  router.resume('ssh:e1')
  await settle()
  router.append(5, true)
  await settle()
  assert.deepEqual(router.syncs.at(-1), { afterSeq: 2, generation: 'g1', turnLimit: undefined })
  assert.deepEqual(seqs(frames), [2, 3, 4, 5])
  assert.equal(frames.filter((frame) => frame.type === 'synchronized').length, 2)
  subscription.dispose()
})

test('a log rewritten while the wire was down is replaced by a reset snapshot', async () => {
  const router = routerStandIn()
  router.append(1, false)
  const frames: ConversationSessionFrame[] = []
  const subscription = new ConversationSessionApi(router.backend).subscribe(
    { key: { workspaceId: 'w-ssh', agentId: 'a', workspaceRoot: '/home/dev/repo' } },
    (frame) => frames.push(frame),
  )
  await subscription.ready
  router.rewrite()
  router.append(2, false)
  router.resume('ssh:e1')
  await settle()
  const snapshots = frames.filter((frame) => frame.type === 'snapshot')
  assert.equal(snapshots.length, 2)
  assert.equal((snapshots[1] as { reset?: boolean }).reset, true)
  subscription.dispose()
  router.resume('ssh:e1')
  await settle()
  assert.equal(frames.filter((frame) => frame.type === 'snapshot').length, 2, 'a disposed subscription stays quiet')
})
