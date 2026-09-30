import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { ConversationRuntime } from './conversation-runtime'
import type {
  ConversationProviderAdapter,
  ConversationProviderCursor,
  MockAdapterSessionInput,
} from './providers/conversation-provider-adapter'
import type { ConversationCapabilities, ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'

const runtimes = new Set<ConversationRuntime>()
const roots = new Set<string>()

afterEach(async () => {
  await Promise.all(Array.from(runtimes, (runtime) => runtime.shutdown().catch(() => undefined)))
  runtimes.clear()
  await Promise.all(Array.from(roots, (root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

const CAPABILITIES: ConversationCapabilities = {
  tools: false,
  approvals: false,
  questions: false,
  planMode: false,
  images: false,
  skills: 'none',
  reasoningEfforts: null,
  interrupt: true,
  resume: true,
  subagents: false,
  cost: false,
  contextMeter: false,
  liveModelSwitch: false,
  rewind: true,
}

type Calls = {
  starts: Array<{ resumeSessionId?: string; resumeSessionAt?: string }>
  rewinds: Array<ConversationProviderCursor | null>
}

function event(input: MockAdapterSessionInput, type: ConversationEventType, payload?: object): ConversationEvent {
  return {
    id: '',
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    providerId: input.providerId,
    modelId: input.modelId,
    type,
    createdAt: 0,
    payload: payload as ConversationEvent['payload'],
  }
}

// A stateful provider whose every turn ends where a real one would say its
// session stood: the next entry of one provider session.
function rewindingProvider(record: Calls, options: { rewind?: boolean; cursors?: boolean } = {}) {
  let entries = 0
  const adapter: ConversationProviderAdapter = {
    id: 'rewinding',
    sessions: 'stateful',
    capabilities: { ...CAPABILITIES, rewind: options.rewind !== false },
    listModels: () => ['model'],
    startSession: (input) => {
      record.starts.push({ resumeSessionId: input.resumeSessionId, resumeSessionAt: input.resumeSessionAt })
      return [event(input, 'session_started', { providerSessionId: input.resumeSessionId ?? null })]
    },
    async *sendTurn(input) {
      yield event(input, 'turn_started', { turnId: input.turnId })
      // As Claude's and Codex's do: the provider says which session it is.
      yield event(input, 'session_updated', { providerSessionId: 'provider-1' })
      yield event(input, 'content_delta', { turnId: input.turnId, text: `reply to ${input.message}` })
      yield event(input, 'turn_completed', {
        turnId: input.turnId,
        ...(options.cursors === false ? {} : { providerCursor: { sessionId: 'provider-1', at: `entry-${++entries}` } }),
      })
    },
    resolveApproval: () => [],
    interrupt: () => [],
    stopSession: () => [],
  }
  if (options.rewind !== false)
    adapter.rewind = async (input) => {
      record.rewinds.push(input.cursor)
      return { ok: true }
    }
  return adapter
}

async function setup(options: { rewind?: boolean; cursors?: boolean } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-handoff-'))
  roots.add(workspaceRoot)
  const record: Calls = { starts: [], rewinds: [] }
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const open = async () => {
    const runtime = new ConversationRuntime({
      adapters: [rewindingProvider(record, options)],
      getProviderById: () => undefined,
      secretStore: { getStatus: async () => ({ ok: false, message: 'unused' }) },
    })
    runtimes.add(runtime)
    const started = await runtime.startSession({ ...key, providerId: 'rewinding', modelId: 'model' })
    assert.ok(started.ok)
    return { runtime, sessionId: started.session.sessionId }
  }
  const { runtime, sessionId } = await open()
  const send = async (message: string) => assert.ok((await runtime.sendTurn({ sessionId, message })).ok)
  const events = async () => {
    const transcript = await runtime.readTranscript(key)
    assert.ok(transcript.ok)
    return transcript.events
  }
  const seqOf = async (text: string) =>
    (await events()).filter((entry) => entry.type === 'user_message' && entry.payload?.text === text).at(-1)?.seq ?? 0
  return { runtime, key, record, send, events, seqOf, open }
}

function sessionOf(runtime: ConversationRuntime): string {
  const listed = runtime.listSessions()
  assert.ok(listed.ok)
  return listed.sessions[0]!.sessionId
}

test('a chat with no turn yet has no CLI session for a terminal to resume', async () => {
  const chat = await setup()
  const listed = chat.runtime.listSessions()
  const sessionId = listed.ok ? listed.sessions[0]!.sessionId : ''
  assert.deepEqual(await chat.runtime.terminalHandoffTarget({ sessionId }), {
    ok: false,
    message: 'This chat has no CLI session yet. Send it a message first.',
  })
})

test('a chat hands a terminal its CLI session, its folder and its mode', async () => {
  const chat = await setup()
  await chat.send('one')
  const sessionId = sessionOf(chat.runtime)
  const found = await chat.runtime.terminalHandoffTarget({ sessionId })
  assert.deepEqual(found, {
    ok: true,
    target: {
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'rewinding',
      modelId: 'model',
      workspaceRoot: chat.key.workspaceRoot,
      providerSessionId: 'provider-1',
    },
  })
})

test('after Edit from here a terminal waits for the chat to take a turn from where it now stands', async () => {
  const chat = await setup()
  await chat.send('one')
  await chat.send('two')
  assert.deepEqual(await chat.runtime.rewindToTurn({ key: chat.key, turnSeq: await chat.seqOf('two') }), { ok: true })
  const sessionId = sessionOf(chat.runtime)
  const refused = await chat.runtime.terminalHandoffTarget({ sessionId })
  assert.equal(refused.ok, false)
  assert.match(!refused.ok ? refused.message : '', /taken back to an earlier message/)

  await chat.send('two again')
  assert.equal((await chat.runtime.terminalHandoffTarget({ sessionId })).ok, true)
})

test('the handoff notice lands in the chat without moving its resume point', async () => {
  const chat = await setup()
  await chat.send('one')
  const sessionId = sessionOf(chat.runtime)
  await chat.runtime.noteTerminalHandoff({ sessionId, notice: 'Continues in a terminal.' })
  const last = (await chat.events()).at(-1)
  assert.equal(last?.type, 'session_updated')
  assert.deepEqual(last?.payload, { notice: 'Continues in a terminal.' })
  const found = await chat.runtime.terminalHandoffTarget({ sessionId })
  assert.equal(found.ok && found.target.providerSessionId, 'provider-1')
})
