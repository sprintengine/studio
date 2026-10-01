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
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-rewind-'))
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

test('a rewind forks at the end of the turn before the message and resumes there after a restart', async () => {
  const chat = await setup()
  await chat.send('one')
  await chat.send('two')
  await chat.send('three')
  const two = await chat.seqOf('two')
  assert.deepEqual(await chat.runtime.rewindToTurn({ key: chat.key, turnSeq: two }), { ok: true })
  // The live session goes back to where the first turn left it.
  assert.deepEqual(chat.record.rewinds, [{ sessionId: 'provider-1', at: 'entry-1' }])
  const marker = (await chat.events()).at(-1)
  assert.equal(marker?.type, 'session_updated')
  assert.deepEqual(marker?.payload, {
    rewoundFromSeq: two,
    providerSessionId: 'provider-1',
    providerResumeAt: 'entry-1',
  })
  // A session opened before any new turn still forks at that point.
  await chat.runtime.shutdown()
  await chat.open()
  assert.deepEqual(chat.record.starts.at(-1), { resumeSessionId: 'provider-1', resumeSessionAt: 'entry-1' })
})

test('going back past the first message starts the provider afresh', async () => {
  const chat = await setup()
  await chat.send('one')
  await chat.send('two')
  assert.deepEqual(await chat.runtime.rewindToTurn({ key: chat.key, turnSeq: await chat.seqOf('one') }), { ok: true })
  assert.deepEqual(chat.record.rewinds, [null])
  await chat.runtime.shutdown()
  await chat.open()
  assert.deepEqual(chat.record.starts.at(-1), { resumeSessionId: undefined, resumeSessionAt: undefined })
})

test('turns an earlier rewind hid are skipped on the way back', async () => {
  const chat = await setup()
  await chat.send('one')
  await chat.send('two')
  await chat.send('three')
  assert.ok((await chat.runtime.rewindToTurn({ key: chat.key, turnSeq: await chat.seqOf('two') })).ok)
  await chat.send('two again')
  const again = await chat.seqOf('two again')
  assert.ok((await chat.runtime.rewindToTurn({ key: chat.key, turnSeq: again })).ok)
  // Not the hidden turns' ends (entry-2, entry-3): the first turn's.
  assert.deepEqual(chat.record.rewinds.at(-1), { sessionId: 'provider-1', at: 'entry-1' })
  // A message a rewind already took out of view cannot be gone back to again.
  const hidden = await chat.runtime.rewindToTurn({ key: chat.key, turnSeq: await chat.seqOf('three') })
  assert.deepEqual(hidden, { ok: false, message: 'That message is no longer in this conversation.' })
})

test('a rewind is refused without a record of where the provider stood, or without the capability', async () => {
  const uncharted = await setup({ cursors: false })
  await uncharted.send('one')
  await uncharted.send('two')
  const refused = await uncharted.runtime.rewindToTurn({ key: uncharted.key, turnSeq: await uncharted.seqOf('two') })
  assert.equal(refused.ok, false)
  assert.deepEqual(uncharted.record.rewinds, [])
  // The first message needs no record: before it there was nothing.
  assert.ok((await uncharted.runtime.rewindToTurn({ key: uncharted.key, turnSeq: await uncharted.seqOf('one') })).ok)

  const incapable = await setup({ rewind: false })
  await incapable.send('one')
  assert.deepEqual(
    await incapable.runtime.rewindToTurn({ key: incapable.key, turnSeq: await incapable.seqOf('one') }),
    {
      ok: false,
      message: 'This agent cannot go back to an earlier message.',
    },
  )
  assert.equal(
    (await incapable.events()).some((entry) => entry.payload?.rewoundFromSeq !== undefined),
    false,
    'a refused rewind writes nothing',
  )
})

test('a rewind names a user message', async () => {
  const chat = await setup()
  await chat.send('one')
  const reply = (await chat.events()).find((entry) => entry.type === 'turn_completed')?.seq ?? 0
  assert.equal((await chat.runtime.rewindToTurn({ key: chat.key, turnSeq: reply })).ok, false)
  assert.equal((await chat.runtime.rewindToTurn({ key: chat.key, turnSeq: 0 })).ok, false)
})
