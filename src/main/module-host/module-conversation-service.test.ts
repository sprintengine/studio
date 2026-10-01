import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { AgentState } from '../../shared/agent-state'
import type {
  ConversationEvent,
  ConversationEventType,
  ConversationSendTurnInput,
  ConversationSessionFrame,
  ConversationSessionSummary,
  ConversationStartSessionInput,
  ConversationSubscribeInput,
} from '../../shared/conversation-runtime'
import type {
  ModuleConversationEvent,
  ModuleConversationStreamFrame,
  ModuleConversationSummary,
} from '../../shared/modules/conversation-service'
import { ConversationRuntime } from '../conversation-runtime'
import { createMockConversationProvider } from '../providers/mock-conversation-provider'
import { emptyAgentLaunchSettings } from '../../shared/launch-settings'
import { createConversationLaunchService } from '../conversation-launch-service'
import type { CliPermissionPreset } from '../../shared/cli-permission-preset'
import {
  createConversationModuleRegistry,
  moduleConversationCeiling,
  type ModuleConversationDeps,
  type ModuleConversationRuntime,
  type ModuleConversationWorkspace,
} from './module-conversation-service'

// The real launch service over an in-memory workspace registry and a fake
// runtime, so ownership is stamped exactly as the app stamps it.
function harness(
  permissions: Record<string, string[]>,
  options: {
    modelCatalog?: ModuleConversationDeps['modelCatalog']
    callerCeiling?: () => CliPermissionPreset | null
    /** Whether the fake provider takes a new model mid-conversation. */
    liveModelSwitch?: boolean
  } = {},
) {
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
    presets: [] as unknown[],
    models: [] as unknown[],
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
        ...(input.permissionPreset ? { permissionPreset: input.permissionPreset } : {}),
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
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
    setPermission: async (input) => {
      calls.presets.push(input)
      const found = sessions.find((entry) => entry.sessionId === input.sessionId)!
      found.permissionPreset = input.permissionPreset
      if (input.permissionMode) found.permissionMode = input.permissionMode
      else delete found.permissionMode
      return input.permissionPreset === 'bypass'
        ? { ok: true, session: found, notice: 'Applies once the reply finishes.' }
        : { ok: true, session: found }
    },
    setModel: async (input) => {
      calls.models.push(input)
      if (options.liveModelSwitch === false) {
        return { ok: false, message: 'This conversation provider cannot change models mid-conversation.' }
      }
      const found = sessions.find((entry) => entry.sessionId === input.sessionId)!
      found.modelId = input.modelId
      return { ok: true, session: found }
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
    // A module's chat always joins the workspace it names; none is a `newChat`.
    listWorkspaces: () => workspaces,
    createWorkspace: () => ({ ok: false, message: 'a module never starts a newChat' }),
    removeWorkspace: () => undefined,
    startSession: (input) => runtime.startSession(input),
    send: async () => ({ ok: true }) as never,
    newAgentSuffix: () => `s${++suffix}`,
  })

  // Each follow the service opened: what it asked the session API for, the
  // listener a test drives the session API's frames through, and whether it
  // was let go.
  const follows: Array<{
    input: ConversationSubscribeInput
    listener: (frame: ConversationSessionFrame) => void
    disposed: boolean
  }> = []
  const registry = createConversationModuleRegistry({
    launch: (request) => launch.launch(request),
    runtime,
    follow: (input, listener) => {
      const entry = { input, listener, disposed: false }
      follows.push(entry)
      return { dispose: () => void (entry.disposed = true), ready: Promise.resolve() }
    },
    writeAgent: (workspaceId, agentId, patch) => {
      const workspace = workspaces.find((candidate) => candidate.id === workspaceId)!
      workspace.agents[agentId] = { ...workspace.agents[agentId]!, ...patch }
      return { ok: true }
    },
    ...(options.modelCatalog ? { modelCatalog: options.modelCatalog } : {}),
    ...(options.callerCeiling ? { getCallerPermissionCeiling: options.callerCeiling } : {}),
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

  return { registry, workspaces, sessions, calls, emit, follows, listenerCount: () => listeners.size }
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
      permissionPreset: agent.cliPermissionPreset,
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
    assert.equal(((await calendar.setPermissionPreset(ref, 'manual')) as { code?: string }).code, 'not_owned')
    assert.equal(((await calendar.setModel(ref, 'default')) as { code?: string }).code, 'not_owned')
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
  assert.deepEqual(calls.presets, [])
  assert.deepEqual(calls.models, [])
  assert.equal(workspaces[0]!.agents['agent-own']!.cliPermissionPreset, undefined, 'the person’s chat is untouched')
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
  assert.equal(((await service.setPermissionPreset(ref, 'manual')) as { code?: string }).code, 'permission_missing')
  assert.equal(((await service.setModel(ref, 'default')) as { code?: string }).code, 'permission_missing')

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

test('a module’s ceiling is auto, or bypass with conversation:bypass declared', () => {
  assert.equal(moduleConversationCeiling(['conversation:operate']), 'auto')
  assert.equal(moduleConversationCeiling(['conversation:operate', 'conversation:bypass']), 'bypass')
})

test('create takes all four presets, lowered to the module’s ceiling', async () => {
  const { registry, workspaces, calls } = harness({
    capped: OPERATE,
    trusted: [...OPERATE, 'conversation:bypass'],
  })
  const presetOf = (agentId: string) => workspaces[0]!.agents[agentId]!.cliPermissionPreset

  for (const preset of ['none', 'manual', 'auto'] as const) {
    const created = await registry
      .forModule('capped')
      .create({ workspaceId: 'ws-1', cli: 'claude-code', permissionPreset: preset })
    assert.ok(created.ok)
    assert.equal(presetOf(created.conversation.agentId), preset, `${preset} is within the default ceiling`)
    assert.equal(created.conversation.permissionPreset, preset, 'the summary names the preset in force')
  }
  const lowered = await registry
    .forModule('capped')
    .create({ workspaceId: 'ws-1', cli: 'claude-code', permissionPreset: 'bypass' })
  assert.ok(lowered.ok)
  assert.equal(presetOf(lowered.conversation.agentId), 'auto', 'bypass without the grant is lowered, not refused')
  assert.equal(lowered.conversation.permissionPreset, 'auto')
  assert.equal(calls.starts.at(-1)!.permissionPreset, 'auto', 'the session starts on the lowered preset')

  const granted = await registry
    .forModule('trusted')
    .create({ workspaceId: 'ws-1', cli: 'claude-code', permissionPreset: 'bypass' })
  assert.ok(granted.ok)
  assert.equal(presetOf(granted.conversation.agentId), 'bypass', 'the grant lifts the ceiling')
})

test('the calling agent’s ceiling still caps a module with conversation:bypass', async () => {
  const { registry, workspaces } = harness(
    { trusted: [...OPERATE, 'conversation:bypass'] },
    { callerCeiling: () => 'manual' },
  )
  const service = registry.forModule('trusted')
  const created = await service.create({ workspaceId: 'ws-1', cli: 'claude-code', permissionPreset: 'bypass' })
  assert.ok(created.ok)
  assert.equal(workspaces[0]!.agents[created.conversation.agentId]!.cliPermissionPreset, 'manual')
  const ref = { workspaceId: 'ws-1', agentId: created.conversation.agentId }
  const switched = await service.setPermissionPreset(ref, 'auto')
  assert.deepEqual(switched, { ok: true, permissionPreset: 'manual' })
})

test('setPermissionPreset switches the live session and its record, lowered to the ceiling', async () => {
  const { registry, workspaces, calls, sessions } = harness({
    capped: OPERATE,
    trusted: [...OPERATE, 'conversation:bypass'],
  })
  const capped = registry.forModule('capped')
  const created = await capped.create({ workspaceId: 'ws-1', cli: 'claude-code', permissionPreset: 'manual' })
  assert.ok(created.ok)
  const ref = { workspaceId: 'ws-1', agentId: created.conversation.agentId }
  const record = () => workspaces[0]!.agents[ref.agentId]!

  assert.deepEqual(await capped.setPermissionPreset(ref, 'auto'), { ok: true, permissionPreset: 'auto' })
  assert.deepEqual(calls.presets.at(-1), { sessionId: 'conv_1', commandId: 'cmd', permissionPreset: 'auto' })
  assert.equal(record().cliPermissionPreset, 'auto', 'the record moves with the session')
  assert.equal(capped.list()[0]!.permissionPreset, 'auto')

  assert.deepEqual(await capped.setPermissionPreset(ref, 'bypass'), { ok: true, permissionPreset: 'auto' })
  assert.equal(sessions[0]!.permissionPreset, 'auto', 'bypass without the grant never reaches the session')

  const bad = await capped.setPermissionPreset(ref, 'root' as never)
  assert.equal(!bad.ok && bad.code, 'invalid_input')

  // With the grant, bypass goes through and the runtime's notice comes back.
  const trusted = registry.forModule('trusted')
  const own = await trusted.create({ workspaceId: 'ws-2', cli: 'claude-code' })
  assert.ok(own.ok)
  const ownRef = { workspaceId: 'ws-2', agentId: own.conversation.agentId }
  assert.deepEqual(await trusted.setPermissionPreset(ownRef, 'bypass'), {
    ok: true,
    permissionPreset: 'bypass',
    notice: 'Applies once the reply finishes.',
  })

  // No live session: the record alone moves, and no session is started for it.
  await capped.stop(ref)
  const starts = calls.starts.length
  const presets = calls.presets.length
  assert.deepEqual(await capped.setPermissionPreset(ref, 'none'), { ok: true, permissionPreset: 'none' })
  assert.equal(calls.starts.length, starts)
  assert.equal(calls.presets.length, presets)
  assert.equal(record().cliPermissionPreset, 'none')
  await capped.send(ref, { message: 'again' })
  assert.equal(calls.starts.at(-1)!.permissionPreset, 'none', 'the next session starts on it')
})

test('setModel switches within the CLI’s catalog and moves the record', async () => {
  const { registry, workspaces, calls } = harness(
    { reviews: OPERATE },
    {
      modelCatalog: async () => ({ cliLabel: 'Claude Code', options: [{ id: 'opus' }, { id: 'sonnet' }] }),
    },
  )
  const service = registry.forModule('reviews')
  const created = await service.create({ workspaceId: 'ws-1', cli: 'claude-code' })
  assert.ok(created.ok)
  const ref = { workspaceId: 'ws-1', agentId: created.conversation.agentId }

  assert.deepEqual(await service.setModel(ref, 'sonnet'), { ok: true, modelId: 'sonnet' })
  assert.deepEqual(calls.models.at(-1), { sessionId: 'conv_1', commandId: 'cmd', modelId: 'sonnet' })
  assert.equal(workspaces[0]!.agents[ref.agentId]!.conversation!.modelId, 'sonnet')
  assert.equal(service.list()[0]!.modelId, 'sonnet')

  const unknown = await service.setModel(ref, 'not-a-model')
  assert.equal(!unknown.ok && unknown.code, 'invalid_input')
  assert.match(!unknown.ok ? unknown.message : '', /Claude Code does not offer/)
  assert.deepEqual(
    await service.setModel(ref, 'default'),
    { ok: true, modelId: 'default' },
    'the CLI default is always offered',
  )
  const empty = await service.setModel(ref, '  ')
  assert.equal(!empty.ok && empty.code, 'invalid_input')

  // A chat with no live session is started again to take the switch.
  await service.stop(ref)
  const starts = calls.starts.length
  assert.deepEqual(await service.setModel(ref, 'opus'), { ok: true, modelId: 'opus' })
  assert.equal(calls.starts.length, starts + 1)
})

test('setModel passes the runtime’s refusal through and leaves the record alone', async () => {
  const { registry, workspaces } = harness({ reviews: OPERATE }, { liveModelSwitch: false })
  const service = registry.forModule('reviews')
  const created = await service.create({ workspaceId: 'ws-1', cli: 'claude-code' })
  assert.ok(created.ok)
  const ref = { workspaceId: 'ws-1', agentId: created.conversation.agentId }
  const refused = await service.setModel(ref, 'sonnet')
  assert.equal(!refused.ok && refused.code, 'runtime_refused')
  assert.equal(workspaces[0]!.agents[ref.agentId]!.conversation!.modelId, 'default')
})

test('an approval answer is once, for the conversation, or deny, and never a permanent rule', async () => {
  const { registry, calls } = harness({ reviews: OPERATE })
  const service = registry.forModule('reviews')
  const created = await service.create({ workspaceId: 'ws-1', cli: 'claude-code' })
  assert.ok(created.ok)
  const ref = { workspaceId: 'ws-1', agentId: created.conversation.agentId }

  assert.deepEqual(await service.respondToApproval(ref, { requestId: 'r1', decision: 'once' }), { ok: true })
  assert.deepEqual(await service.respondToApproval(ref, { requestId: 'r2', decision: 'conversation' }), { ok: true })
  assert.deepEqual(await service.respondToApproval(ref, { requestId: 'r3', decision: 'deny' }), { ok: true })
  assert.deepEqual(await service.respondToApproval(ref, { requestId: 'r4', approved: false }), { ok: true })
  assert.deepEqual(
    await service.respondToApproval(ref, { requestId: 'r5', approved: true, decision: 'conversation' }),
    {
      ok: true,
    },
  )
  assert.deepEqual(calls.responses, [
    { sessionId: 'conv_1', requestId: 'r1', approved: true },
    { sessionId: 'conv_1', requestId: 'r2', approved: true, decision: 'conversation' },
    { sessionId: 'conv_1', requestId: 'r3', approved: false },
    { sessionId: 'conv_1', requestId: 'r4', approved: false },
    { sessionId: 'conv_1', requestId: 'r5', approved: true, decision: 'conversation' },
  ])

  for (const input of [
    { requestId: 'x', decision: 'always' },
    { requestId: 'x' },
    { requestId: 'x', approved: false, decision: 'once' },
    { requestId: 'x', approved: 'yes' },
  ]) {
    const refused = await service.respondToApproval(ref, input as never)
    assert.equal(!refused.ok && refused.code, 'invalid_input', JSON.stringify(input))
  }
  assert.equal(calls.responses.length, 5, 'nothing refused reached the runtime')
})

const BYPASS = ['conversation:operate', 'conversation:bypass']

test('a commandId reaches the runtime namespaced by the module, and a retried create makes one chat', async () => {
  const { registry, workspaces, calls } = harness({ reviews: OPERATE, calendar: OPERATE })
  const service = registry.forModule('reviews')
  // Two attempts in flight at once, and one after: one chat.
  const [first, second] = await Promise.all([
    service.create({ workspaceId: 'ws-1', cli: 'claude-code', commandId: 'create-1' }),
    service.create({ workspaceId: 'ws-1', cli: 'claude-code', commandId: 'create-1' }),
  ])
  const third = await service.create({ workspaceId: 'ws-1', cli: 'claude-code', commandId: 'create-1' })
  assert.ok(first.ok && second.ok && third.ok)
  assert.equal(second.conversation.agentId, first.conversation.agentId)
  assert.equal(third.conversation.agentId, first.conversation.agentId)
  assert.equal(calls.starts.length, 1)
  assert.equal(workspaces[0]!.agents[first.conversation.agentId]!.launchCommandId, 'module:reviews:create-1')
  // Another module's command with the same id is its own.
  const other = await registry
    .forModule('calendar')
    .create({ workspaceId: 'ws-1', cli: 'claude-code', commandId: 'create-1' })
  assert.ok(other.ok)
  assert.notEqual(other.conversation.agentId, first.conversation.agentId)
  // Without an id, each create is its own, as before.
  await service.create({ workspaceId: 'ws-1', cli: 'claude-code' })
  assert.equal(calls.starts.length, 3)

  const ref = { workspaceId: 'ws-1', agentId: first.conversation.agentId }
  await service.send(ref, { message: 'hi', commandId: 'send-1' })
  await service.send(ref, { message: 'again' })
  await service.setPermissionPreset(ref, 'manual', { commandId: 'preset-1' })
  await service.setModel(ref, 'default', { commandId: 'model-1' })
  await service.interrupt(ref, { commandId: 'stop-turn-1' })
  await service.respondToApproval(ref, { requestId: 'r1', decision: 'once', commandId: 'answer-1' })
  assert.deepEqual(
    calls.sends.map((send) => send.commandId),
    ['module:reviews:send-1', 'cmd'],
  )
  assert.equal((calls.presets[0] as { commandId?: string }).commandId, 'module:reviews:preset-1')
  assert.equal((calls.models[0] as { commandId?: string }).commandId, 'module:reviews:model-1')
  assert.equal((calls.responses[0] as { commandId?: string }).commandId, 'module:reviews:answer-1')

  for (const commandId of ['', 'x'.repeat(201), 7]) {
    const refused = await service.send(ref, { message: 'hi', commandId: commandId as never })
    assert.equal(!refused.ok && refused.code, 'invalid_input', String(commandId))
    const notCreated = await service.create({ workspaceId: 'ws-1', commandId: commandId as never })
    assert.equal(!notCreated.ok && notCreated.code, 'invalid_input', String(commandId))
  }
})

test('a retried send through the real runtime is carried out once and answered with the first result', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'module-conversation-receipts-'))
  const runtime = new ConversationRuntime({
    adapters: [createMockConversationProvider()],
    getProviderById: () => undefined,
  })
  try {
    const workspaces: ModuleConversationWorkspace[] = [
      {
        id: 'ws-1',
        folderPath: folder,
        agents: {
          chat: {
            id: 'chat',
            name: 'Notes',
            runtimeKind: 'conversation',
            conversation: { providerId: 'mock-provider', modelId: 'mock-model' },
            ownerModuleId: 'reviews',
          } as AgentState,
        },
      },
    ]
    const registry = createConversationModuleRegistry({
      launch: async () => ({ ok: false, code: 'unused', message: 'unused' }),
      runtime,
      follow: () => ({ dispose: () => undefined, ready: Promise.resolve() }),
      writeAgent: () => ({ ok: true }),
      getWorkspaceAgents: () => workspaces,
      getModulePermissions: () => OPERATE,
    })
    const turns: ConversationEvent[] = []
    runtime.onEvent((next) => {
      if (next.type === 'user_message') turns.push(next)
    })
    const service = registry.forModule('reviews')
    const ref = { workspaceId: 'ws-1', agentId: 'chat' }
    const [first, retry] = await Promise.all([
      service.send(ref, { message: '/tools', commandId: 'send-1' }),
      service.send(ref, { message: '/tools', commandId: 'send-1' }),
    ])
    const late = await service.send(ref, { message: '/tools', commandId: 'send-1' })
    assert.deepEqual([first, retry, late], [{ ok: true }, { ok: true }, { ok: true }])
    assert.equal(turns.length, 1, 'one turn for one command, however often it is sent')
    await service.send(ref, { message: '/tools', commandId: 'send-2' })
    assert.equal(turns.length, 2)
  } finally {
    await runtime.shutdown()
    await rm(folder, { recursive: true, force: true })
  }
})

test('answerQuestion and resolvePlan each answer only their own kind of request', async () => {
  const { registry, calls } = harness({ reviews: OPERATE, reader: ['conversation:read'] })
  const service = registry.forModule('reviews')
  const created = await service.create({ workspaceId: 'ws-1', cli: 'claude-code' })
  assert.ok(created.ok)
  const ref = { workspaceId: 'ws-1', agentId: created.conversation.agentId }

  assert.deepEqual(await service.answerQuestion(ref, { requestId: 'q1', answers: { 'Which file?': 'a.ts' } }), {
    ok: true,
  })
  assert.deepEqual(await service.resolvePlan(ref, { requestId: 'p1', decision: 'approve', commandId: 'plan-1' }), {
    ok: true,
  })
  assert.deepEqual(await service.resolvePlan(ref, { requestId: 'p2', decision: 'reject' }), { ok: true })
  // The runtime is told which kind each answer is for, and refuses one that does not match.
  assert.deepEqual(calls.responses, [
    {
      sessionId: 'conv_1',
      requestId: 'q1',
      approved: true,
      requestKind: 'question',
      answers: { 'Which file?': 'a.ts' },
    },
    { sessionId: 'conv_1', requestId: 'p1', approved: true, requestKind: 'plan', commandId: 'module:reviews:plan-1' },
    { sessionId: 'conv_1', requestId: 'p2', approved: false, requestKind: 'plan' },
  ])

  const refusals = [
    await service.resolvePlan(ref, { requestId: 'p3', decision: 'once' as never }),
    await service.resolvePlan(ref, { requestId: 7 as never, decision: 'approve' }),
    await service.answerQuestion(ref, { requestId: 'q2', answers: { q: 3 } as never }),
    await service.answerQuestion(ref, { requestId: 'q2', answers: ['a'] as never }),
  ]
  for (const refused of refusals) assert.equal(!refused.ok && refused.code, 'invalid_input')
  const reader = registry.forModule('reader')
  const readOnly = await reader.resolvePlan(ref, { requestId: 'p1', decision: 'approve' })
  assert.equal(!readOnly.ok && readOnly.code, 'permission_missing')
  const stranger = await registry.forModule('reviews').answerQuestion(
    { workspaceId: 'ws-1', agentId: 'nothing' },
    {
      requestId: 'q1',
      answers: {},
    },
  )
  assert.equal(!stranger.ok && stranger.code, 'not_owned')
  assert.equal(calls.responses.length, 3, 'nothing refused reached the runtime')
})

test('a CLI mode rides beside the preset it belongs to, and goes when the preset is lowered or changed', async () => {
  const { registry, workspaces, calls } = harness({ reviews: OPERATE })
  const service = registry.forModule('reviews')
  const created = await service.create({
    workspaceId: 'ws-1',
    cli: 'claude-code',
    permissionPreset: 'auto',
    permissionMode: 'acceptEdits',
  })
  assert.ok(created.ok)
  assert.equal(calls.starts[0]!.permissionMode, 'acceptEdits')
  assert.equal(created.conversation.permissionMode, 'acceptEdits')
  // Asked above the module's ceiling: the preset is lowered and the mode,
  // which belonged to the preset asked for, is dropped.
  const lowered = await service.create({
    workspaceId: 'ws-1',
    cli: 'claude-code',
    permissionPreset: 'bypass',
    permissionMode: 'dontAsk',
  })
  assert.ok(lowered.ok)
  assert.equal(calls.starts[1]!.permissionPreset, 'auto')
  assert.equal(calls.starts[1]!.permissionMode, undefined)

  const ref = { workspaceId: 'ws-1', agentId: created.conversation.agentId }
  const record = () => workspaces[0]!.agents[ref.agentId]!
  assert.deepEqual(await service.setPermissionPreset(ref, 'manual'), { ok: true, permissionPreset: 'manual' })
  assert.equal(record().cliPermissionMode, undefined, 'a mode left from another preset is cleared')
  assert.deepEqual(await service.setPermissionPreset(ref, 'auto', { permissionMode: 'acceptEdits' }), {
    ok: true,
    permissionPreset: 'auto',
    permissionMode: 'acceptEdits',
  })
  assert.equal((calls.presets.at(-1) as { permissionMode?: string }).permissionMode, 'acceptEdits')
  assert.equal(record().cliPermissionMode, 'acceptEdits')
  assert.equal(service.list()[0]!.permissionMode, 'acceptEdits')
  const capped = await service.setPermissionPreset(ref, 'bypass', { permissionMode: 'dontAsk' })
  assert.deepEqual(capped, { ok: true, permissionPreset: 'auto' })

  for (const permissionMode of ['workspace', '../x', 'manual']) {
    const refused = await service.setPermissionPreset(ref, 'auto', { permissionMode })
    assert.equal(!refused.ok && refused.code, 'invalid_input', permissionMode)
  }
  const badCreate = await service.create({ workspaceId: 'ws-1', permissionPreset: 'auto', permissionMode: 'a b' })
  assert.equal(!badCreate.ok && badCreate.code, 'invalid_input')
})

test('allowed tools need conversation:bypass, and never ride a tool call capped below it', async () => {
  let callerCeiling: CliPermissionPreset | null = null
  const { registry, calls } = harness({ reviews: OPERATE, trusted: BYPASS }, { callerCeiling: () => callerCeiling })
  const refused = await registry
    .forModule('reviews')
    .create({ workspaceId: 'ws-1', cli: 'claude-code', allowedTools: ['Write'] })
  assert.equal(!refused.ok && refused.code, 'permission_missing')
  assert.match(!refused.ok ? refused.message : '', /conversation:bypass/)
  // An empty list asks for nothing.
  assert.ok(
    (await registry.forModule('reviews').create({ workspaceId: 'ws-1', cli: 'claude-code', allowedTools: [] })).ok,
  )

  const trusted = registry.forModule('trusted')
  const allowed = await trusted.create({ workspaceId: 'ws-1', cli: 'claude-code', allowedTools: ['Write', 'Edit'] })
  assert.ok(allowed.ok)
  assert.deepEqual(calls.starts.at(-1)!.allowedTools, ['Write', 'Edit'])
  callerCeiling = 'auto'
  const throughAgent = await trusted.create({ workspaceId: 'ws-1', cli: 'claude-code', allowedTools: ['Write'] })
  assert.equal(!throughAgent.ok && throughAgent.code, 'permission_missing')
  callerCeiling = null
  for (const allowedTools of ['Write', ['Write\nBash'], Array.from({ length: 65 }, (_, i) => `T${i}`)]) {
    const bad = await trusted.create({ workspaceId: 'ws-1', allowedTools: allowedTools as never })
    assert.equal(!bad.ok && bad.code, 'invalid_input')
  }
})

test('follow hands the session API the module’s cursor, redacts what comes back, and ends when reading is no longer allowed', async () => {
  const permissions: Record<string, string[]> = { reviews: OPERATE, reader: ['conversation:read'] }
  const { registry, follows } = harness(permissions)
  const created = await registry.forModule('reviews').create({ workspaceId: 'ws-1', cli: 'claude-code' })
  assert.ok(created.ok)
  const ref = { workspaceId: 'ws-1', agentId: created.conversation.agentId }
  const frames: ModuleConversationStreamFrame[] = []
  const stop = registry.forModule('reviews').follow(ref, { afterSeq: 4, generation: 'log-1' }, (frame) => {
    frames.push(frame)
    throw new Error('a module callback that throws does not end the stream')
  })
  assert.deepEqual(follows[0]!.input, {
    key: { workspaceRoot: '/repo/a', workspaceId: 'ws-1', agentId: ref.agentId },
    afterSeq: 4,
    generation: 'log-1',
  })
  const secret = event('tool_output', ref, { output: 'ok', apiKey: 'sk-live' })
  follows[0]!.listener({
    type: 'snapshot',
    page: { events: [secret], hasMore: false, beforeCursor: secret.seq! },
    reset: true,
    generation: 'log-2',
  })
  follows[0]!.listener({ type: 'synchronized', seq: secret.seq!, generation: 'log-2' })
  follows[0]!.listener({ type: 'event', event: event('content_delta', ref, { text: 'hi', token: 'x' }) })
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ['snapshot', 'synchronized', 'event'],
  )
  const snapshot = frames[0] as Extract<ModuleConversationStreamFrame, { type: 'snapshot' }>
  assert.equal(snapshot.reset, true)
  assert.equal(snapshot.page.events[0]!.payload?.apiKey, '[redacted]')
  assert.equal((frames[2] as { event: ModuleConversationEvent }).event.payload?.token, '[redacted]')

  // A module whose read is withdrawn is told once, and the follow is let go.
  delete permissions.reviews
  follows[0]!.listener({ type: 'event', event: event('content_delta', ref, { text: 'more' }) })
  assert.deepEqual(frames.at(-1), { type: 'error', message: 'This conversation is no longer readable by this module.' })
  assert.equal(follows[0]!.disposed, true)
  follows[0]!.listener({ type: 'event', event: event('content_delta', ref, { text: 'after' }) })
  assert.equal(frames.length, 4)
  stop()

  // A follow refuses a cursor that is not one, a chat that is not the
  // module's, and a module that may not read.
  permissions.reviews = OPERATE
  const service = registry.forModule('reviews')
  for (const options of [{ afterSeq: -1 }, { generation: '' }, { turnLimit: 0 }, { turnLimit: 101 }])
    assert.throws(() => service.follow(ref, options, () => undefined), /afterSeq|generation|turnLimit/)
  assert.throws(() => service.follow({ workspaceId: 'ws-1', agentId: 'nothing' }, undefined, () => undefined))
  assert.throws(() => registry.forModule('none').follow(ref, undefined, () => undefined), /conversation:read/)
  const second = service.follow(ref, undefined, () => undefined)
  assert.deepEqual(follows[1]!.input, { key: { workspaceRoot: '/repo/a', workspaceId: 'ws-1', agentId: ref.agentId } })
  second()
  assert.equal(follows[1]!.disposed, true)
  // Teardown lets every open follow go.
  service.follow(ref, undefined, () => undefined)
  registry.dispose()
  assert.equal(follows[2]!.disposed, true)
})
