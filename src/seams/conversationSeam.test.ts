import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  ConversationEvent,
  ConversationEventType,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationSessionSummary,
} from '../shared/conversation-runtime'
import type {
  ConversationProviderAdapter,
  ConversationSessionEventSink,
  MockAdapterSessionInput,
  MockAdapterTurnInput,
} from '../main/providers/mock-conversation-provider'

// ── Seam: the conversation composer and its runtime (T4 → T5, items 1798/1809/1810)
//
// T4 fixed the runtime: one busy predicate covering a continuation turn, and a
// turn takeover that ends the queue it replaces. T5 fixed the composer: the
// permission pill reads the live session, and the attachment limits became one
// shared declaration. Both tasks' suites are thorough on their own side — the
// runtime's against a fake adapter, the composer's against fake session data.
//
// What neither can see is whether the two halves agree, and that is where the
// original defect lived: the composer decided "busy" from a projection of the
// runtime's own broadcast, the runtime decided it from session fields, and a
// continuation turn was busy by one definition and idle by the other. So this
// suite runs the REAL runtime behind the REAL send-turn IPC boundary, and asks
// the REAL composer predicates about the events that runtime actually emitted:
//
//   composer predicates (renderer)  ←  broadcast events  ←  ConversationRuntime
//   composer commit                 →  conversation:sessions:*  →  same runtime
//
// Nothing here re-derives what a turn looks like; the fixtures are the runtime's
// output.

async function main(): Promise<void> {
  await testContinuationTurnIsBusyOnBothSidesOfTheBoundary()
  await testPermissionPillReportsTheLiveSession()
  await testComposerAndBoundaryAcceptTheSameAttachments()
  console.log('all conversation seam tests passed')
}

// --- Fixtures ----------------------------------------------------------------

function runtimeEvent(
  base: { sessionId: string; workspaceId: string; agentId: string },
  type: ConversationEventType,
  payload: Record<string, unknown> = {},
): ConversationEvent {
  return {
    id: '',
    sessionId: base.sessionId,
    workspaceId: base.workspaceId,
    agentId: base.agentId,
    type,
    createdAt: 0,
    payload,
  } as ConversationEvent
}

/**
 * A stateful adapter that hands back its continuation sink, so the suite can
 * open a continuation turn the way a background subagent completing does — the
 * shape item 1798 is about. `setPermissionPreset` accepts but reports that a
 * turn already streaming keeps the old preset, which is the 1808 notice path.
 */
function createSinkAdapter(capture: {
  base: MockAdapterSessionInput | null
  sink: ConversationSessionEventSink | null
  permissionCalls: string[]
}): ConversationProviderAdapter {
  return {
    id: 'seam-provider',
    sessions: 'stateful',
    listModels: () => ['seam-model'],
    startSession(input) {
      capture.base = input
      capture.sink = input.onSessionEvent ?? null
      return [runtimeEvent(input, 'session_started'), runtimeEvent(input, 'session_ready')]
    },
    async *sendTurn(input: MockAdapterTurnInput) {
      yield runtimeEvent(input, 'turn_started', { turnId: input.turnId })
      yield runtimeEvent(input, 'content_delta', { turnId: input.turnId, text: `re: ${input.message}` })
      yield runtimeEvent(input, 'turn_completed', { turnId: input.turnId })
    },
    async setPermissionPreset(input) {
      capture.permissionCalls.push(input.permissionPreset)
      return {
        ok: true,
        notice: 'Bypass permissions applies from your next message; this turn keeps the current setting.',
      }
    },
    resolveApproval: () => [],
    interrupt: (input) => [runtimeEvent(input, 'turn_failed', { reason: 'interrupted' })],
    stopSession: (input) => [runtimeEvent(input, 'session_closed')],
  }
}

/** Only the members this seam crosses answer; the rest refuse rather than fake. */
function refusingHandlerStubs(): Record<string, unknown> {
  const refuse = async (): Promise<{ ok: false; message: string }> => ({
    ok: false,
    message: 'This channel is not part of the conversation seam.',
  })
  return {
    listProviders: refuse,
    listProviderModels: refuse,
    testProvider: refuse,
    getSecretStatus: refuse,
    setSecret: refuse,
    clearSecret: refuse,
    readTranscript: refuse,
  }
}

async function withWorkspaceRoot<T>(prefix: string, fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// --- 1798: one definition of busy, on both sides of the boundary -------------

async function testContinuationTurnIsBusyOnBothSidesOfTheBoundary(): Promise<void> {
  await withWorkspaceRoot('multicode-seam-conversation-busy-', async (workspaceRoot) => {
    const { ipcMain } = await import('electron')
    const { ConversationRuntime } = await import('../main/conversation-runtime')
    const { registerConversationIpc } = await import('../main/ipc/conversation-ipc')
    const { conversationApi } = await import('../preload/api/conversation')
    const { projectConversation, isConversationBusy } = await import(
      '../renderer/src/components/panels/AgentChatView'
    )

    const capture: {
      base: MockAdapterSessionInput | null
      sink: ConversationSessionEventSink | null
      permissionCalls: string[]
    } = { base: null, sink: null, permissionCalls: [] }
    const runtime = new ConversationRuntime({
      adapters: [createSinkAdapter(capture)],
      getProviderById: () => undefined,
      secretStore: { getStatus: async () => ({ ok: false, message: 'unused' }) } as never,
    })

    // Everything the renderer sees, in broadcast order — the composer's own
    // projection input, not a hand-written approximation of one.
    const broadcast: ConversationEvent[] = []
    runtime.onEvent((event) => broadcast.push(event))

    registerConversationIpc(ipcMain, {
      ...refusingHandlerStubs(),
      startSession: (input) => runtime.startSession(input),
      sendTurn: (input) => runtime.sendTurn(input),
      interrupt: (input) => runtime.interrupt(input),
      respondToRequest: (input) => runtime.respondToRequest(input),
      setPermission: (input) => runtime.setPermission(input),
      stopSession: (input) => runtime.stopSession(input),
      listSessions: (input) => runtime.listSessions(input),
      onEvent: (listener) => runtime.onEvent(listener),
    } as unknown as Parameters<typeof registerConversationIpc>[1])

    const started = await conversationApi.conversationSessionStart({
      workspaceRoot,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'seam-provider',
      modelId: 'seam-model',
    })
    assert.equal(started.ok, true, 'the session starts through the real channel')
    if (!started.ok) return
    const sessionId = started.session.sessionId

    const firstTurn = await conversationApi.conversationSessionSendTurn({ sessionId, message: 'investigate' })
    assert.equal(firstTurn.ok, true)

    // The composer's own view of an idle session: not busy, so a commit sends.
    const idle = projectConversation(broadcast)
    assert.equal(idle.activeTurn, false)
    assert.equal(isConversationBusy(idle.activeTurn, idle.awaitingApproval, null), false, 'an idle session sends')

    // A background subagent reports and the adapter opens a continuation turn.
    // This is the window the old guard could not see: `pendingRequestId` is null
    // throughout one.
    const base = capture.base
    const sink = capture.sink
    assert.ok(base && sink, 'the adapter received a session-scoped continuation sink')
    if (!base || !sink) return
    sink(runtimeEvent(base, 'turn_started', { turnId: 'cont_turn_1' }))
    sink(runtimeEvent(base, 'content_delta', { turnId: 'cont_turn_1', text: 'subagent reported' }))
    await waitForEvents('the continuation turn to open', broadcast, (events) =>
      events.some((event) => event.type === 'content_delta' && event.payload?.turnId === 'cont_turn_1'),
    )

    // The composer, reading the same events, agrees the session is busy — so a
    // commit QUEUES rather than firing an IPC that would error. This is the
    // agreement the two tasks had to reach; either side alone cannot show it.
    const duringContinuation = projectConversation(broadcast)
    assert.equal(duringContinuation.activeTurn, true, 'the composer sees the continuation turn as an open turn')
    assert.equal(
      isConversationBusy(duringContinuation.activeTurn, duringContinuation.awaitingApproval, null),
      true,
      'so the composer queues the typed-ahead message instead of sending it',
    )

    // The race the guard closes: a flush that beats the projection update (the
    // event channel is serialized off the send path, so this ordering is real).
    const raced = await conversationApi.conversationSessionSendTurn({ sessionId, message: 'and this too' })
    assert.deepEqual(
      raced,
      { ok: false, message: 'Conversation turn is already in progress.' },
      'the runtime refuses the racing send rather than taking the continuation turn over',
    )

    // Nothing was suppressed: the continuation streams on, and its events still
    // reach the renderer under their own turn id.
    sink(runtimeEvent(base, 'content_delta', { turnId: 'cont_turn_1', text: 'and finished' }))
    sink(runtimeEvent(base, 'turn_completed', { turnId: 'cont_turn_1' }))
    await waitForEvents('the continuation turn to close', broadcast, (events) =>
      events.some((event) => event.type === 'turn_completed' && event.payload?.turnId === 'cont_turn_1'),
    )

    const continuationDeltas = broadcast
      .filter((event) => event.type === 'content_delta' && event.payload?.turnId === 'cont_turn_1')
      .map((event) => event.payload?.text)
    assert.deepEqual(
      continuationDeltas,
      ['subagent reported', 'and finished'],
      'every event of the continuation turn survives the racing send',
    )
    assert.equal(
      broadcast.filter((event) => event.type === 'user_message').length,
      1,
      'and the refused send left no user bubble behind',
    )

    // Once the continuation closes, both sides agree the session is free again
    // and the queued message goes out as an ordinary follow-up turn.
    const afterContinuation = projectConversation(broadcast)
    assert.equal(
      isConversationBusy(afterContinuation.activeTurn, afterContinuation.awaitingApproval, null),
      false,
      'the composer’s auto-send gate opens when the continuation closes',
    )
    const flushed = await conversationApi.conversationSessionSendTurn({ sessionId, message: 'and this too' })
    assert.equal(flushed.ok, true, 'and the same message is accepted')
    assert.equal(broadcast.filter((event) => event.type === 'user_message').length, 2)

    await conversationApi.conversationSessionStop({ sessionId })
    console.log('ok - a continuation turn reads as busy in the composer and in the runtime alike')
  })
}

// --- 1809: the pill reports the session, not a stale record ------------------

async function testPermissionPillReportsTheLiveSession(): Promise<void> {
  await withWorkspaceRoot('multicode-seam-conversation-permission-', async (workspaceRoot) => {
    const { ConversationRuntime } = await import('../main/conversation-runtime')
    const { resolvePermissionPreset } = await import('../renderer/src/components/panels/AgentChatView')

    const capture: {
      base: MockAdapterSessionInput | null
      sink: ConversationSessionEventSink | null
      permissionCalls: string[]
    } = { base: null, sink: null, permissionCalls: [] }
    const runtime = new ConversationRuntime({
      adapters: [createSinkAdapter(capture)],
      getProviderById: () => undefined,
      secretStore: { getStatus: async () => ({ ok: false, message: 'unused' }) } as never,
    })

    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'seam-provider',
      modelId: 'seam-model',
      permissionPreset: 'manual',
    })
    assert.equal(started.ok, true)
    if (!started.ok) return

    // The disagreement the item describes: the durable agent record says one
    // thing (an optimistic write that lost a reload race), the running child is
    // on another. The pill must report the child.
    assert.equal(
      resolvePermissionPreset(started.session, 'bypass'),
      'manual',
      'the live session outranks a stale agent record',
    )

    const changed = await runtime.setPermission({
      sessionId: started.session.sessionId,
      permissionPreset: 'bypass',
    })
    assert.equal(changed.ok, true, 'the adapter accepted the change')
    if (!changed.ok) return
    assert.deepEqual(capture.permissionCalls, ['bypass'], 'and it reached the provider')
    assert.equal(
      changed.notice,
      'Bypass permissions applies from your next message; this turn keeps the current setting.',
      'an accepted-but-not-yet-applied change comes back as a notice, never a refusal',
    )
    assert.equal(
      resolvePermissionPreset(changed.session, 'manual'),
      'bypass',
      'the pill moves to what the session now reports, whatever the record still says',
    )

    // No session yet (the agent has never been started): the durable record is
    // what the next session will start on, so it is what the pill shows.
    assert.equal(resolvePermissionPreset(null, 'auto'), 'auto')
    // Neither: a record predating the field reads as the safe end of the scale.
    assert.equal(resolvePermissionPreset(null, undefined), 'manual')

    await runtime.stopSession({ sessionId: started.session.sessionId })
    console.log('ok - the permission pill reports the live session, then the record, then default')
  })
}

// --- 1810: one accepted attachment set, not two that agree today ------------

async function testComposerAndBoundaryAcceptTheSameAttachments(): Promise<void> {
  const { ipcMain } = await import('electron')
  const { registerConversationIpc } = await import('../main/ipc/conversation-ipc')
  const { conversationApi } = await import('../preload/api/conversation')
  const {
    ATTACHABLE_IMAGE_TYPES,
    MAX_ATTACHMENTS_PER_TURN,
    MAX_ATTACHMENT_BYTES,
    isAttachableImageType,
    attachmentRejection,
  } = await import('../renderer/src/components/panels/AgentChatView')

  const sent: ConversationSendTurnInput[] = []
  const accepted: ConversationSessionActionResult = {
    ok: true,
    session: {
      sessionId: 'conv_seam',
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'seam-provider',
      modelId: 'seam-model',
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
    } as ConversationSessionSummary,
  }
  registerConversationIpc(ipcMain, {
    ...refusingHandlerStubs(),
    startSession: async () => ({ ok: false, message: 'unused' }),
    sendTurn: async (input: ConversationSendTurnInput) => {
      sent.push(input)
      return accepted
    },
    interrupt: async () => accepted,
    respondToRequest: async () => accepted,
    setPermission: async () => accepted,
    stopSession: async () => accepted,
    listSessions: () => ({ ok: true, sessions: [] }),
    onEvent: () => () => {},
  } as unknown as Parameters<typeof registerConversationIpc>[1])

  const send = async (attachments: unknown): Promise<ConversationSessionActionResult> =>
    conversationApi.conversationSessionSendTurn({
      sessionId: 'conv_seam',
      message: 'look at this',
      attachments,
    } as unknown as ConversationSendTurnInput)
  const image = (id: string, mediaType: string, base64 = 'Zm9v'): Record<string, unknown> => ({
    id,
    mediaType,
    dataBase64: base64,
  })
  // Base64 for exactly `bytes` decoded bytes.
  const base64OfBytes = (bytes: number): string => Buffer.alloc(bytes, 1).toString('base64')

  // Every type the composer offers is accepted by the boundary. A composer that
  // staged a type the boundary refuses would buy the user a rejection mid-send,
  // which is the drift the shared declaration exists to prevent.
  for (const mediaType of ATTACHABLE_IMAGE_TYPES) {
    assert.equal(isAttachableImageType(mediaType), true, `the composer stages ${mediaType}`)
    assert.equal((await send([image('a', mediaType)])).ok, true, `and the boundary accepts ${mediaType}`)
  }
  // And the reverse: a type the boundary refuses is one the composer will not
  // stage, so the refusal is never a surprise mid-send.
  assert.equal(isAttachableImageType('image/svg+xml'), false, 'the composer refuses image/svg+xml')
  assert.equal((await send([image('a', 'image/svg+xml')])).ok, false, 'as does the boundary')

  // The per-turn cap is one number: the composer refuses the attachment the
  // boundary would have rejected, at exactly the same count.
  const atCap = Array.from({ length: MAX_ATTACHMENTS_PER_TURN }, (_, index) => image(`a${index}`, 'image/png'))
  assert.equal((await send(atCap)).ok, true, 'the boundary admits exactly the composer’s cap')
  assert.equal(
    attachmentRejection({ name: 'one-more.png', type: 'image/png' }, MAX_ATTACHMENTS_PER_TURN),
    `A message can carry at most ${MAX_ATTACHMENTS_PER_TURN} images.`,
    'and the composer refuses the one past it',
  )
  assert.equal((await send([...atCap, image('over', 'image/png')])).ok, false, 'as does the boundary')

  // Same for the per-image ceiling.
  assert.equal(
    (await send([image('a', 'image/png', base64OfBytes(MAX_ATTACHMENT_BYTES))])).ok,
    true,
    'the boundary admits an image of exactly the shared ceiling',
  )
  assert.equal(
    (await send([image('a', 'image/png', base64OfBytes(MAX_ATTACHMENT_BYTES + 1))])).ok,
    false,
    'and refuses one byte more',
  )

  assert.ok(sent.length > 0, 'the accepted sends really crossed the boundary')
  console.log('ok - the composer and the send-turn boundary accept exactly the same attachments')
}

// Waiting for a condition, never for a duration. The continuation channel
// persists each event to the transcript JSONL before broadcasting, so this
// crosses real disk I/O; a fixed delay long enough here is a flake elsewhere.
async function waitForEvents(
  label: string,
  broadcast: ConversationEvent[],
  predicate: (events: ConversationEvent[]) => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate(broadcast) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(predicate(broadcast), `timed out waiting for ${label}`)
}

main().catch((error) => {
  console.error('not ok - conversation seam')
  console.error(error)
  process.exit(1)
})
