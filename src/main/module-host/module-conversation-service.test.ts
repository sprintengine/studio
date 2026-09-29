import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { AgentState } from '../../shared/agent-state'
import type {
  ConversationEvent,
  ConversationEventType,
  ConversationSendTurnInput,
  ConversationSessionSummary,
  ConversationStartSessionInput,
} from '../../shared/conversation-runtime'
import type { ModuleConversationEvent, ModuleConversationSummary } from '../../shared/modules/conversation-service'
import { emptyAgentLaunchSettings } from '../../shared/launch-settings'
import { createConversationLaunchService } from '../conversation-launch-service'
import {
  createConversationModuleRegistry,
  type ModuleConversationRuntime,
  type ModuleConversationWorkspace,
} from './module-conversation-service'

// The real launch service over an in-memory workspace registry and a fake
// runtime, so ownership is stamped exactly as the app stamps it.
function harness(permissions: Record<string, string[]>) {
  const workspaces: ModuleConversationWorkspace[] = [
    { id: 'ws-1', folderPath: '/repo/a', agents: {} },
    { id: 'ws-2', folderPath: '/repo/b', agents: {} },
  ]
  const sessions: ConversationSessionSummary[] = []
  const listeners = new Set<(event: ConversationEvent) => void>()
  const workspaceListeners = new Set<() => void>()
  const calls = {
    starts: [] as ConversationStartSessionInput[],
    sends: [] as ConversationSendTurnInput[],
    interrupts: [] as string[],
    stops: [] as string[],
    responses: [] as unknown[],
  }
  let suffix = 0
  let sessionSeq = 0

  const runtime: ModuleConversationRuntime = {
    startSession: async (input) => {
      calls.starts.push(input)
      sessionSeq += 1
      const summary: ConversationSessionSummary = {
        sessionId: `conv_${sessionSeq}`,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        providerId: input.providerId,
        modelId: input.modelId,
        status: 'ready',
        createdAt: sessionSeq,
        updatedAt: sessionSeq,
      }
      sessions.push(summary)
      return { ok: true, session: summary }
    },
    sendTurn: async (input) => {
      calls.sends.push(input)
      return { ok: true, session: sessions.find((entry) => entry.sessionId === input.sessionId)! }
    },
    interrupt: async (input) => {
      calls.interrupts.push(input.sessionId)
      return { ok: true, session: sessions.find((entry) => entry.sessionId === input.sessionId)! }
    },
    respondToRequest: async (input) => {
      calls.responses.push(input)
      return { ok: true, session: sessions.find((entry) => entry.sessionId === input.sessionId)! }
    },
    stopSession: async (input) => {
      calls.stops.push(input.sessionId)
      const found = sessions.find((entry) => entry.sessionId === input.sessionId)!
      found.status = 'stopped'
      return { ok: true, session: found }
    },
    listSessions: (input = {}) => ({
      ok: true,
      sessions: sessions.filter(
        (entry) =>
          (!input.workspaceId || entry.workspaceId === input.workspaceId) &&
          (!input.agentId || entry.agentId === input.agentId),
      ),
    }),
    readTranscript: async (input) => ({
      ok: true,
      events: [event('content_delta', { workspaceId: input.workspaceId, agentId: input.agentId }, { text: 'hi' })],
    }),
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  const launch = createConversationLaunchService({
    getWorkspace: (id) => workspaces.find((workspace) => workspace.id === id) ?? null,
    getLaunchSettings: () => emptyAgentLaunchSettings(),
    writeAgent: (workspaceId, agentId, agent) => {
      const workspace = workspaces.find((candidate) => candidate.id === workspaceId)!
      if (agent) workspace.agents[agentId] = agent
      else delete workspace.agents[agentId]
      for (const listener of workspaceListeners) listener()
      return { ok: true }
    },
    startSession: (input) => runtime.startSession(input),
    send: async () => ({ ok: true }) as never,
    newAgentSuffix: () => `s${++suffix}`,
  })

  const registry = createConversationModuleRegistry({
    launch: (request) => launch.launch(request),
    runtime,
    getWorkspaceAgents: () => workspaces,
    getModulePermissions: (moduleId) => permissions[moduleId],
    onWorkspacesChanged: (listener) => {
      workspaceListeners.add(listener)
      return () => workspaceListeners.delete(listener)
    },
    newCommandId: () => 'cmd',
  })

  function emit(type: ConversationEventType, ref: { workspaceId: string; agentId: string }, payload = {}): void {
    for (const listener of listeners) listener(event(type, ref, payload))
  }

  return { registry, workspaces, sessions, calls, emit, listenerCount: () => listeners.size }
}

let eventSeq = 0
function event(
  type: ConversationEventType,
  ref: { workspaceId: string; agentId: string },
  payload: Record<string, unknown> = {},
): ConversationEvent {
  eventSeq += 1
  return {
    id: `evt-${eventSeq}`,
    seq: eventSeq,
    sessionId: 'conv_x',
    workspaceId: ref.workspaceId,
    agentId: ref.agentId,
    providerId: 'claude-agent',
    modelId: 'default',
    type,
    createdAt: eventSeq,
    payload,
  }
}

const OPERATE = ['conversation:operate']

test('create needs conversation:operate, and the chat it starts is the module’s own', async () => {
  const { registry, workspaces } = harness({ reviews: OPERATE, reader: ['conversation:read'], none: [] })

  for (const moduleId of ['reader', 'none']) {
    const refused = await registry.forModule(moduleId).create({ workspaceId: 'ws-1', cli: 'claude-code' })
    assert.equal(!refused.ok && refused.code, 'permission_missing', `${moduleId} cannot start a chat`)
  }

  const created = await registry.forModule('reviews').create({ workspaceId: 'ws-1', cli: 'claude-code', name: 'Rev' })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const agent = workspaces[0]!.agents[created.conversation.agentId] as AgentState
  assert.equal(agent.ownerModuleId, 'reviews')
  assert.equal(agent.runtimeKind, 'conversation')
  assert.deepEqual(
    { ...created.conversation, agentId: 'x' },
    {
      workspaceId: 'ws-1',
      agentId: 'x',
      sessionId: 'conv_1',
      name: 'Rev',
      cli: 'claude-code',
      providerId: created.conversation.providerId,
      modelId: 'default',
      status: 'ready',
    },
  )
})

test('create refuses input it cannot use, and passes the launch’s own refusals through', async () => {
  const { registry } = harness({ reviews: OPERATE })
  const service = registry.forModule('reviews')
  const bad = await service.create({ workspaceId: 'ws-1', permissionPreset: 'root' as never })
  assert.equal(!bad.ok && bad.code, 'invalid_input')
  const unknown = await service.create({ workspaceId: 'ws-9', cli: 'claude-code' })
  assert.equal(!unknown.ok && unknown.code, 'unknown_workspace')
  const notChat = await service.create({ workspaceId: 'ws-1', cli: 'not-a-chat-cli' })
  assert.equal(!notChat.ok && notChat.code, 'cli_not_conversational')
})

test('a module reaches only its own chats: another module’s and the person’s are not_owned', async () => {
  const { registry, workspaces, calls } = harness({ reviews: OPERATE, calendar: OPERATE })
  const created = await registry.forModule('reviews').create({ workspaceId: 'ws-1', cli: 'claude-code' })
  assert.ok(created.ok)
  const reviewsChat = { workspaceId: 'ws-1', agentId: created.conversation.agentId }
  // The person's own chat, started from a window: no owner.
  workspaces[0]!.agents['agent-own'] = {
    id: 'agent-own',
    name: 'Mine',
    runtimeKind: 'conversation',
    conversation: { providerId: 'claude-agent', modelId: 'default' },
  } as AgentState
  const ownChat = { workspaceId: 'ws-1', agentId: 'agent-own' }

  const calendar = registry.forModule('calendar')
  for (const ref of [reviewsChat, ownChat, { workspaceId: 'ws-1', agentId: 'nothing' }]) {
    assert.equal(((await calendar.send(ref, { message: 'hi' })) as { code?: string }).code, 'not_owned')
    assert.equal(((await calendar.stop(ref)) as { code?: string }).code, 'not_owned')
    assert.equal(((await calendar.interrupt(ref)) as { code?: string }).code, 'not_owned')
    assert.equal(((await calendar.transcript(ref)) as { code?: string }).code, 'not_owned')
    assert.equal(
      ((await calendar.respondToApproval(ref, { requestId: 'r', approved: true })) as { code?: string }).code,
      'not_owned',
    )
    assert.throws(
      () => calendar.subscribe(ref, () => undefined),
      /not started by this module|was started by this module/,
    )
  }
  assert.deepEqual(calendar.list(), [], 'another module lists none of them')
  assert.deepEqual(
    registry
      .forModule('reviews')
      .list()
      .map((entry) => entry.agentId),
    [reviewsChat.agentId],
    'the owner lists only its own, never the person’s',
  )
  assert.deepEqual(calls.sends, [])
  assert.deepEqual(calls.stops, [])
})

test('the owner drives its chat through the runtime, never with a remembered rule', async () => {
  const { registry, calls, sessions } = harness({ reviews: OPERATE })
  const service = registry.forModule('reviews')
  const created = await service.create({ workspaceId: 'ws-1', cli: 'claude-code' })
  assert.ok(created.ok)
  const ref = { workspaceId: 'ws-1', agentId: created.conversation.agentId }

  assert.deepEqual(await service.send(ref, { message: 'go', skills: ['review'], steer: true }), { ok: true })
  assert.deepEqual(calls.sends.at(-1), {
    sessionId: 'conv_1',
    commandId: 'cmd',
    message: 'go',
    skills: [{ id: 'review' }],
    steer: true,
  })
  assert.deepEqual(await service.respondToApproval(ref, { requestId: 'req-1', approved: true, answers: { q: 'a' } }), {
    ok: true,
  })
  assert.deepEqual(calls.responses, [{ sessionId: 'conv_1', requestId: 'req-1', approved: true, answers: { q: 'a' } }])
  assert.deepEqual(await service.interrupt(ref), { ok: true })
  assert.deepEqual(calls.interrupts, ['conv_1'])
  assert.deepEqual(await service.stop(ref), { ok: true })
  assert.deepEqual(calls.stops, ['conv_1'])
  assert.equal(service.list()[0]!.status, 'absent', 'a stopped chat has no live session')

  // A send to a chat whose session ended starts it again on its own engine.
  assert.deepEqual(await service.send(ref, { message: 'again' }), { ok: true })
  assert.equal(calls.starts.length, 2)
  assert.equal(calls.starts[1]!.agentId, ref.agentId)
  assert.equal(calls.sends.at(-1)!.sessionId, sessions.at(-1)!.sessionId)
})

test('read-only modules read their chats but cannot drive them; no permission reads nothing', async () => {
  const permissions: Record<string, string[]> = { reviews: OPERATE }
  const { registry } = harness(permissions)
  const created = await registry.forModule('reviews').create({ workspaceId: 'ws-1', cli: 'claude-code' })
  assert.ok(created.ok)
  const ref = { workspaceId: 'ws-1', agentId: created.conversation.agentId }

  // Narrowed to read: read calls still answer, operate calls refuse.
  permissions.reviews = ['conversation:read']
  const service = registry.forModule('reviews')
  assert.equal(service.list().length, 1)
  const transcript = await service.transcript(ref)
  assert.equal(transcript.ok && transcript.events.length, 1)
  assert.equal(((await service.send(ref, { message: 'x' })) as { code?: string }).code, 'permission_missing')
  assert.equal(((await service.stop(ref)) as { code?: string }).code, 'permission_missing')

  // Nothing declared: the read calls refuse as well.
  permissions.reviews = []
  assert.throws(() => service.list(), /conversation:read/)
  assert.throws(() => service.subscribe(ref, () => undefined), /conversation:read/)
  assert.throws(() => service.watch(undefined, () => undefined), /conversation:read/)
  assert.equal(((await service.transcript(ref)) as { code?: string }).code, 'permission_missing')
})

test('events reach only the module whose chat they belong to, redacted', async () => {
  const { registry, emit, listenerCount } = harness({ reviews: OPERATE, calendar: OPERATE })
  const reviews = registry.forModule('reviews')
  const calendar = registry.forModule('calendar')
  const a = await reviews.create({ workspaceId: 'ws-1', cli: 'claude-code' })
  const b = await calendar.create({ workspaceId: 'ws-2', cli: 'claude-code' })
  assert.ok(a.ok && b.ok)
  const refA = { workspaceId: 'ws-1', agentId: a.conversation.agentId }
  const refB = { workspaceId: 'ws-2', agentId: b.conversation.agentId }

  const seenA: ModuleConversationEvent[] = []
  const seenB: ModuleConversationEvent[] = []
  const stopA = reviews.subscribe(refA, (e) => seenA.push(e))
  const stopB = calendar.subscribe(refB, (e) => seenB.push(e))
  assert.equal(listenerCount(), 1, 'one runtime subscription serves every module')

  emit('content_delta', refA, { text: 'for reviews', apiKey: 'sk-live-123' })
  emit('content_delta', refB, { text: 'for calendar' })
  emit('content_delta', { workspaceId: 'ws-1', agentId: 'agent-own' }, { text: 'the person’s' })

  assert.deepEqual(
    seenA.map((e) => e.payload?.text),
    ['for reviews'],
  )
  assert.equal(seenA[0]!.payload?.apiKey, '[redacted]', 'secret-shaped keys are redacted')
  assert.deepEqual(
    seenB.map((e) => e.payload?.text),
    ['for calendar'],
  )

  stopA()
  emit('content_delta', refA, { text: 'after unsubscribe' })
  assert.equal(seenA.length, 1)
  stopB()
  assert.equal(listenerCount(), 0, 'the runtime subscription is released with the last subscriber')
})

test('watch answers at once, then on every change to the module’s own chats', async () => {
  const { registry, emit, sessions } = harness({ reviews: OPERATE, calendar: OPERATE })
  const lists: ModuleConversationSummary[][] = []
  const stop = registry.forModule('reviews').watch({ workspaceId: 'ws-1' }, (list) => lists.push(list))
  assert.equal(lists.length, 1, 'the current list, straight away')
  assert.equal(lists[0]!.length, 0)

  const created = await registry.forModule('reviews').create({ workspaceId: 'ws-1', cli: 'claude-code' })
  assert.ok(created.ok)
  const ref = { workspaceId: 'ws-1', agentId: created.conversation.agentId }
  // Its session coming up is a conversation event of its own chat.
  emit('session_ready', ref)
  const settled = lists.length
  assert.ok(settled >= 2, 'a new chat of its own moves the list')
  assert.equal(lists.at(-1)![0]!.agentId, ref.agentId)
  assert.equal(lists.at(-1)![0]!.status, 'ready')

  // Another module's chat, in the same workspace, does not.
  const other = await registry.forModule('calendar').create({ workspaceId: 'ws-1', cli: 'claude-code' })
  assert.ok(other.ok)
  emit('session_ready', { workspaceId: 'ws-1', agentId: other.conversation.agentId })
  assert.equal(lists.length, settled)

  sessions[0]!.status = 'active'
  emit('turn_started', ref)
  assert.equal(lists.length, settled + 1)
  assert.equal(lists.at(-1)![0]!.status, 'active')

  stop()
  sessions[0]!.status = 'ready'
  emit('turn_completed', ref)
  assert.equal(lists.length, settled + 1, 'nothing after the watch is stopped')
})
