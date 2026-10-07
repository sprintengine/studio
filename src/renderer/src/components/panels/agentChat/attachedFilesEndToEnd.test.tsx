// @vitest-environment jsdom
// Files attached by path, from the send to the bubble: what the agent is told,
// what the transcript keeps, and what a replayed bubble draws from it. The
// runtime here is the real one, over a provider that records what it is handed.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { ConversationRuntime } from '../../../../../main/conversation-runtime'
import type {
  ConversationMessage,
  ConversationProviderAdapter,
  MockAdapterSessionInput,
} from '../../../../../main/providers/conversation-provider-adapter'
import type {
  ConversationCapabilities,
  ConversationEvent,
  ConversationEventType,
} from '../../../../../shared/conversation-runtime'
import { projectConversation, type TranscriptEntry } from './conversationProjection'
import { resetAttachedFilePreviewsForTests } from './ComposerFileChip'
import { UserTimelineRow } from './timelineRows'

const CAPABILITIES: ConversationCapabilities = {
  tools: true,
  approvals: true,
  questions: false,
  planMode: false,
  images: false,
  skills: 'none',
  reasoningEfforts: null,
  interrupt: true,
  resume: true,
  subagents: false,
  cost: true,
  contextMeter: false,
  liveModelSwitch: false,
  steer: false,
  rewind: false,
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

// A provider that answers every turn at once and keeps what it was handed.
function recordingProvider(sessions: 'stateful' | 'stateless') {
  const handed: { message: string; messages: ConversationMessage[] | undefined }[] = []
  const adapter: ConversationProviderAdapter = {
    id: 'recording',
    ...(sessions === 'stateful' ? { sessions: 'stateful' as const } : {}),
    capabilities: CAPABILITIES,
    listModels: () => ['model'],
    startSession: (input) => [event(input, 'session_started'), event(input, 'session_ready')],
    async *sendTurn(input) {
      handed.push({ message: input.message, messages: input.messages })
      yield event(input, 'turn_started', { turnId: input.turnId })
      yield event(input, 'content_delta', { turnId: input.turnId, text: 'Read them.' })
      yield event(input, 'turn_completed', { turnId: input.turnId })
    },
    resolveApproval: () => [],
    interrupt: () => [],
    stopSession: () => [],
  }
  return { adapter, handed }
}

const runtimes: ConversationRuntime[] = []
const folders: string[] = []
let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  resetAttachedFilePreviewsForTests()
  ;(window as unknown as { api: unknown }).api = {
    platform: 'darwin',
    previewAttachedFile: async () => ({ kind: 'file', thumbnailDataUrl: null, openable: true }),
    openAttachedFile: async () => undefined,
    showItemInFolder: async () => undefined,
  }
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown().catch(() => undefined)))
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

async function chat(sessions: 'stateful' | 'stateless', workspaceRoot?: string) {
  const folder = workspaceRoot ?? (await mkdtemp(join(tmpdir(), 'sprintengine-attached-files-e2e-')))
  if (!workspaceRoot) folders.push(folder)
  const provider = recordingProvider(sessions)
  const runtime = new ConversationRuntime({
    adapters: [provider.adapter],
    getProviderById: () => undefined,
    secretStore: { getStatus: async () => ({ ok: false, message: 'unused' }) },
  })
  runtimes.push(runtime)
  const key = { workspaceRoot: folder, workspaceId: 'workspace', agentId: 'agent' }
  const started = await runtime.startSession({ ...key, providerId: 'recording', modelId: 'model' })
  if (!started.ok) throw new Error(started.message)
  return { runtime, provider, key, folder, sessionId: started.session.sessionId }
}

async function replayedBubbles(
  runtime: ConversationRuntime,
  key: { workspaceRoot: string; workspaceId: string; agentId: string },
) {
  const transcript = await runtime.readTranscript(key)
  if (!transcript.ok) throw new Error(transcript.message)
  const events = transcript.events
  const users = projectConversation(events).entries.filter(
    (entry): entry is Extract<TranscriptEntry, { kind: 'user' }> => entry.kind === 'user',
  )
  return { events, users }
}

async function draw(entry: Extract<TranscriptEntry, { kind: 'user' }>) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(<UserTimelineRow entry={entry} />))
  return host
}

test('a send’s files reach the agent after the words, are stored beside the text, and come back as the bubble’s cards', async () => {
  const { runtime, provider, key, sessionId } = await chat('stateful')
  const sent = await runtime.sendTurn({
    sessionId,
    message: 'Summarise these',
    localTurnId: 'local-1',
    files: [{ path: '/Users/me/Desktop/Q3 budget.xlsx' }, { path: '/Users/me/notes.pdf' }],
  })
  expect(sent.ok).toBe(true)
  expect(provider.handed[0].message, 'the agent is told what each file is and where').toBe(
    [
      'Summarise these',
      'Attached file "Q3 budget.xlsx": /Users/me/Desktop/Q3 budget.xlsx\nAttached file "notes.pdf": /Users/me/notes.pdf',
    ].join('\n\n'),
  )

  const { events, users } = await replayedBubbles(runtime, key)
  const stored = events.find((next) => next.type === 'user_message')
  expect(stored?.payload, 'the transcript keeps the words and the files apart').toMatchObject({
    text: 'Summarise these',
    files: [{ path: '/Users/me/Desktop/Q3 budget.xlsx' }, { path: '/Users/me/notes.pdf' }],
  })
  expect(users).toHaveLength(1)
  expect(users[0].text).toBe('Summarise these')

  const bubble = await draw(users[0])
  const cards = Array.from(bubble.querySelectorAll('button[aria-label^="Open "]')).map((card) =>
    card.getAttribute('aria-label'),
  )
  expect(cards).toEqual(['Open Q3 budget.xlsx', 'Open notes.pdf'])
  expect(bubble.textContent).toContain('Summarise these')
  expect(bubble.textContent, 'no path is spelled into the words').not.toContain('/Users/me')
})

test('a path typed into the words stays words: no card, whatever paragraph it is in', async () => {
  const { runtime, provider, key, sessionId } = await chat('stateful')
  const typed = 'Read this:\n\n/Users/me/notes.pdf'
  expect((await runtime.sendTurn({ sessionId, message: typed })).ok).toBe(true)
  expect(provider.handed[0].message, 'nothing is added to a message that attached nothing').toBe(typed)
  const { users } = await replayedBubbles(runtime, key)
  expect(users[0].files ?? []).toEqual([])
  const bubble = await draw(users[0])
  // The path is still the person's words — linked where the text names it, as
  // any path in a message is — and there is no card for it beside them.
  expect(bubble.querySelector('button[aria-label="Open notes.pdf"]')).toBeNull()
  expect(bubble.textContent).not.toContain('PDF')
  expect(bubble.querySelector('button[aria-label="Open /Users/me/notes.pdf"]')?.textContent).toBe('/Users/me/notes.pdf')
})

test('a provider that is handed the history reads an earlier message’s files in it, as it first read them', async () => {
  const first = await chat('stateless')
  expect(
    (
      await first.runtime.sendTurn({
        sessionId: first.sessionId,
        message: 'Keep this in mind',
        files: [{ path: '/Users/me/spec.pdf' }],
      })
    ).ok,
  ).toBe(true)
  await first.runtime.shutdown()
  // A new run reads the history back off the transcript.
  const next = await chat('stateless', first.folder)
  expect((await next.runtime.sendTurn({ sessionId: next.sessionId, message: 'What did it say?' })).ok).toBe(true)
  const history = next.provider.handed[0].messages ?? []
  expect(history.find((message) => message.role === 'user')?.content).toBe(
    'Keep this in mind\n\nAttached file "spec.pdf": /Users/me/spec.pdf',
  )
})

test('a send whose files are not absolute paths is refused, not half-sent', async () => {
  const { runtime, provider, sessionId } = await chat('stateful')
  const refused = await runtime.sendTurn({ sessionId, message: 'Look', files: [{ path: 'notes.pdf' }] })
  expect(refused).toMatchObject({ ok: false, message: 'Attached files must be absolute paths, at most 50.' })
  expect(provider.handed).toHaveLength(0)
})
