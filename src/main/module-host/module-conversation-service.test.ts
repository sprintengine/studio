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

  const registry = createConversationModuleRegistry({
    launch: (request) => launch.launch(request),
    runtime,
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
