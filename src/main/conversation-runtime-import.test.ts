import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { ConversationRuntime } from './conversation-runtime'
import type { ConversationProviderAdapter, MockAdapterSessionInput } from './providers/conversation-provider-adapter'
import type {
  ConversationCapabilities,
  ConversationEvent,
  ConversationEventType,
  ConversationImportTranscriptInput,
} from '../shared/conversation-runtime'

const runtimes = new Set<ConversationRuntime>()
const roots = new Set<string>()

afterEach(async () => {
  await Promise.all(Array.from(runtimes, (runtime) => runtime.shutdown().catch(() => undefined)))
  runtimes.clear()
  await Promise.all(Array.from(roots, (root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

const CAPABILITIES: ConversationCapabilities = {
  tools: true,
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
  rewind: false,
  fork: false,
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

async function setup() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-import-'))
  roots.add(workspaceRoot)
  const starts: Array<string | undefined> = []
  const adapter: ConversationProviderAdapter = {
    id: 'stateful',
    sessions: 'stateful',
    capabilities: CAPABILITIES,
    listModels: () => ['default'],
    startSession: (input) => {
      starts.push(input.resumeSessionId)
      return [event(input, 'session_started')]
    },
    async *sendTurn(input) {
      yield event(input, 'turn_started', { turnId: input.turnId })
      yield event(input, 'turn_completed', { turnId: input.turnId })
    },
    resolveApproval: () => [],
    interrupt: () => [],
    stopSession: () => [],
  }
  const runtime = new ConversationRuntime({
    adapters: [adapter],
    getProviderById: () => undefined,
    secretStore: { getStatus: async () => ({ ok: false, message: 'unused' }) },
  })
  runtimes.add(runtime)
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  return { runtime, key, starts }
}

function history(key: ConversationImportTranscriptInput['key'], output: string): ConversationImportTranscriptInput {
  return {
    key,
    providerId: 'stateful',
    modelId: 'default',
    providerSessionId: 'native-1',
    title: 'Fix the flaky test',
    importedFrom: { source: 'claude-code', sessionId: 'native-1' },
    events: [
      { type: 'user_message', createdAt: 1_000, payload: { turnId: 'turn_import_1', text: 'Fix the flaky test' } },
      { type: 'turn_started', createdAt: 1_000, payload: { turnId: 'turn_import_1' } },
      { type: 'content_delta', createdAt: 1_100, payload: { turnId: 'turn_import_1', text: 'Running it.' } },
      {
        type: 'tool_started',
        createdAt: 1_200,
        payload: { turnId: 'turn_import_1', toolUseId: 'tool-1', tool: 'Bash', input: { command: 'npm test' } },
      },
      {
        type: 'tool_output',
        createdAt: 1_300,
        payload: { turnId: 'turn_import_1', toolUseId: 'tool-1', output, status: 'ok', isError: false },
      },
      { type: 'turn_completed', createdAt: 1_400, payload: { turnId: 'turn_import_1' } },
    ],
  }
}

test('an imported history is the chat’s transcript, ending in the CLI session it resumes', async () => {
  const t = await setup()
  const imported = await t.runtime.importTranscript(history(t.key, 'all green'))
  assert.deepEqual(imported, { ok: true })

  const transcript = await t.runtime.readTranscript(t.key)
  assert.ok(transcript.ok)
  assert.deepEqual(
    transcript.events.map((entry) => entry.type),
    [
      'user_message',
      'turn_started',
      'content_delta',
      'tool_started',
      'tool_output',
      'turn_completed',
      'session_updated',
    ],
  )
  assert.deepEqual(
    transcript.events.map((entry) => entry.seq),
    transcript.events.map((_, index) => index + 1),
  )
  assert.ok(transcript.events.every((entry) => entry.agentId === 'agent' && entry.providerId === 'stateful'))
  assert.deepEqual(transcript.events.at(-1)?.payload, {
    providerSessionId: 'native-1',
    importedFrom: { source: 'claude-code', sessionId: 'native-1' },
    conversationTitle: 'Fix the flaky test',
    titleSource: 'user',
  })
  assert.equal(transcript.events[0]?.createdAt, 1_000, 'the history keeps the times it happened at')

  const started = await t.runtime.startSession({ ...t.key, providerId: 'stateful', modelId: 'default' })
  assert.ok(started.ok)
  assert.deepEqual(t.starts, ['native-1'], 'the chat resumes the session it was imported from')
})

test('an imported step keeps a preview in the transcript and its whole output in its detail', async () => {
  const t = await setup()
  const output = 'x'.repeat(10_000)
  assert.deepEqual(await t.runtime.importTranscript(history(t.key, output)), { ok: true })
  const transcript = await t.runtime.readTranscript(t.key)
  assert.ok(transcript.ok)
  const step = transcript.events.find((entry) => entry.type === 'tool_output')
  assert.equal(String(step?.payload?.output).length, 4000)
  assert.equal(step?.payload?.truncated, true)
  assert.equal(step?.payload?.totalBytes, 10_000)
  const started = transcript.events.find((entry) => entry.type === 'tool_started')
  assert.equal(started?.payload?.kind, 'command')

  const detail = await t.runtime.getToolDetail({ ...t.key, toolUseId: 'tool-1' })
  assert.ok(detail.ok)
  assert.equal(detail.detail.output, output)
  assert.deepEqual(detail.detail.input, { command: 'npm test' })
})

test('a chat that already has a conversation is not imported into', async () => {
  const t = await setup()
  assert.deepEqual(await t.runtime.importTranscript(history(t.key, 'first')), { ok: true })
  const again = await t.runtime.importTranscript(history(t.key, 'second'))
  assert.equal(again.ok, false)
  const transcript = await t.runtime.readTranscript(t.key)
  assert.ok(transcript.ok)
  assert.equal(transcript.events.filter((entry) => entry.type === 'user_message').length, 1)
})
