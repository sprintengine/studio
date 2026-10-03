import { expect, test } from 'vitest'
import type { ConversationEvent, ConversationEventType } from '../../../../../shared/conversation-runtime'
import { projectConversation } from './conversationProjection'
import { deriveConversationTimelineRows } from './conversationTimeline'
import {
  buildReplayScript,
  initialReplayState,
  loadWholeConversation,
  ReplayClock,
  replayDelay,
  replayPromptIndex,
  replayReducer,
  splitIntoChunks,
  type ReplayAction,
  type ReplayScript,
  type ReplayState,
} from './conversationReplay'

let next = 0
function event(type: ConversationEventType, at: number, payload: Record<string, unknown> = {}): ConversationEvent {
  next += 1
  return {
    id: `event-${next}`,
    seq: next,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'claude-agent',
    modelId: 'model',
    type,
    createdAt: at,
    payload,
  }
}

// Two exchanges: the first thinks, runs a tool and replies in two paragraphs;
// the second replies at once.
function conversation(): ConversationEvent[] {
  return [
    event('session_started', 0),
    event('user_message', 1_000, { turnId: 't1', text: 'Why does the build fail?' }),
    event('turn_started', 1_100, { turnId: 't1' }),
    event('reasoning_delta', 1_200, { turnId: 't1', text: 'Start with the failing step and read its log.' }),
    event('tool_started', 2_000, { turnId: 't1', toolUseId: 'read', name: 'Read' }),
    event('tool_output', 3_000, { turnId: 't1', toolUseId: 'read', output: 'error: missing export' }),
    event('content_delta', 4_000, { turnId: 't1', text: 'The barrel stopped exporting `Pager`.' }),
    event('content_delta', 4_100, { turnId: 't1', text: '\n\nRestoring the export fixes it.' }),
    event('usage_updated', 4_200, { turnId: 't1', inputTokens: 10 }),
    event('turn_completed', 9_000, { turnId: 't1' }),
    event('user_message', 20_000, { turnId: 't2', text: 'Thanks' }),
    event('turn_started', 20_100, { turnId: 't2' }),
    event('content_delta', 20_200, { turnId: 't2', text: 'Any time.' }),
    event('turn_completed', 21_000, { turnId: 't2' }),
  ]
}

function play(script: ReplayScript, state: ReplayState, ...actions: ReplayAction[]): ReplayState {
  return actions.reduce((current, action) => replayReducer(script, current, action), state)
}

/** Tick until the player stops of its own accord. */
function runUntilStopped(script: ReplayScript, state: ReplayState): ReplayState {
  let current = state
  for (let guard = 0; current.playing && guard < 10_000; guard++)
    current = replayReducer(script, current, { type: 'tick' })
  return current
}

/** The rows a replay at `cursor` draws, as the kind and words of each. */
function shownText(script: ReplayScript, cursor: number): Array<{ kind: string; text: string }> {
  const projection = projectConversation(script.events.slice(0, cursor))
  return deriveConversationTimelineRows(projection.entries, projection.activeTurn).flatMap((row) =>
    row.kind === 'user' || row.kind === 'assistant' ? [{ kind: row.kind, text: row.entry.text }] : [],
  )
}

test('chunks of streamed text are a few words each and add up to the text exactly', () => {
  const text = '  The barrel stopped exporting `Pager`.\n\nRestoring it fixes the build.  '
  const chunks = splitIntoChunks(text, 3)
  expect(chunks.join('')).toBe(text)
  expect(chunks[0]).toBe('  The barrel stopped')
  expect(chunks.every((chunk) => (chunk.match(/\S+/gu) ?? []).length <= 3)).toBe(true)
  expect(splitIntoChunks('   ', 3)).toEqual(['   '])
  expect(splitIntoChunks('', 3)).toEqual([])
})

test('a reply is cut into chunks, each a step the player waits on at reading pace', () => {
  const script = buildReplayScript(conversation())
  const reply = script.events.filter((item) => item.type === 'content_delta' && item.payload?.turnId === 't1')
  // The two adjacent deltas merge first, as the log on disk keeps them.
  expect(reply.map((item) => item.payload?.text).join('')).toBe(
    'The barrel stopped exporting `Pager`.\n\nRestoring the export fixes it.',
  )
  expect(reply.length).toBeGreaterThan(2)
  expect(new Set(reply.map((item) => item.id)).size).toBe(reply.length)
  const firstChunk = script.events.indexOf(reply[0]!)
  expect(script.delays[firstChunk]).toBe(250)
  // Bookkeeping costs nothing: it rides along with the step before it.
  expect(script.delays[script.events.findIndex((item) => item.type === 'usage_updated')]).toBe(0)
})

test('the player stops just past each message, starting on the first', () => {
  const script = buildReplayScript(conversation())
  const messages = script.prompts.map((prompt) => script.events[prompt - 1]!.type)
  expect(messages).toEqual(['user_message', 'user_message'])
  const state = initialReplayState(script)
  expect(state.cursor).toBe(script.prompts[0])
  expect(shownText(script, state.cursor)).toEqual([{ kind: 'user', text: 'Why does the build fail?' }])
  expect(replayPromptIndex(script, state.cursor)).toBe(1)
})

test('play streams the reply and halts on the next message, showing it and none of its reply', () => {
  const script = buildReplayScript(conversation())
  const playing = play(script, initialReplayState(script), { type: 'toggle' })
  expect(playing.playing).toBe(true)
  const midway = play(script, playing, { type: 'tick' }, { type: 'tick' }, { type: 'tick' })
  expect(midway.playing).toBe(true)
  const stopped = runUntilStopped(script, playing)
  expect(stopped.cursor).toBe(script.prompts[1])
  expect(stopped.playing).toBe(false)
  expect(shownText(script, stopped.cursor)).toEqual([
    { kind: 'user', text: 'Why does the build fail?' },
    { kind: 'assistant', text: 'The barrel stopped exporting `Pager`.\n\nRestoring the export fixes it.' },
    { kind: 'user', text: 'Thanks' },
  ])
})

test('a continuous player goes past the messages and stops only at the end', () => {
  const script = buildReplayScript(conversation())
  const stopped = runUntilStopped(
    script,
    play(script, initialReplayState(script), { type: 'continuous', on: true }, { type: 'toggle' }),
  )
  expect(stopped.cursor).toBe(script.events.length)
  expect(play(script, stopped, { type: 'toggle' }).playing).toBe(false)
})

test('pause holds the player where it is', () => {
  const script = buildReplayScript(conversation())
  const midway = play(script, initialReplayState(script), { type: 'toggle' }, { type: 'tick' }, { type: 'tick' })
  const paused = play(script, midway, { type: 'toggle' })
  expect(paused).toMatchObject({ cursor: midway.cursor, playing: false })
  expect(play(script, paused, { type: 'tick' }).cursor).toBe(midway.cursor)
})

test('next finishes the reply at once; previous goes back to the message that asked for it, then the one before', () => {
  const script = buildReplayScript(conversation())
  const start = initialReplayState(script)
  const skipped = play(script, start, { type: 'next' })
  expect(skipped.cursor).toBe(script.prompts[1])
  const midway = play(script, skipped, { type: 'toggle' }, { type: 'tick' }, { type: 'tick' })
  expect(play(script, midway, { type: 'previous' }).cursor).toBe(script.prompts[1])
  expect(play(script, skipped, { type: 'previous' }).cursor).toBe(script.prompts[0])
  // The first message is as far back as a replay goes.
  expect(play(script, start, { type: 'previous' }).cursor).toBe(script.prompts[0])
  expect(play(script, skipped, { type: 'next' }).cursor).toBe(script.events.length)
  expect(play(script, midway, { type: 'restart' })).toMatchObject({ cursor: script.prompts[0], playing: false })
})

test('the delay before each step shortens with speed', () => {
  const script = buildReplayScript(conversation())
  const state = initialReplayState(script)
  const atOne = replayDelay(script, state)
  expect(atOne).toBeGreaterThan(0)
  expect(replayDelay(script, play(script, state, { type: 'speed', speed: 4 }))).toBe(Math.round(atOne / 4))
})

test('a replayed conversation folds into the same transcript as the conversation itself', () => {
  // Interleaved thinking, steps and prose, which the fold keeps in order; cut
  // into chunks, it must come out the same.
  const log = [
    event('user_message', 0, { turnId: 'x', text: 'Fix the test' }),
    event('turn_started', 1, { turnId: 'x' }),
    event('reasoning_delta', 10, { turnId: 'x', text: 'Look at the failing test first, then the fixture it reads.' }),
    event('tool_started', 40, { turnId: 'x', toolUseId: 'read', name: 'Read' }),
    event('tool_output', 50, { turnId: 'x', toolUseId: 'read', output: 'ok' }),
    event('reasoning_delta', 60, { turnId: 'x', text: 'The fixture is stale.' }),
    event('content_delta', 70, { turnId: 'x', text: 'Updating the fixture so it matches the new schema.' }),
    event('reasoning_delta', 80, { turnId: 'x', text: ' Then rerun.' }),
    event('tool_started', 100, { turnId: 'x', toolUseId: 'edit', name: 'Edit' }),
    event('tool_output', 110, { turnId: 'x', toolUseId: 'edit', output: 'ok' }),
    event('content_delta', 150, { turnId: 'x', text: 'Fixed, and the suite passes again.' }),
    event('turn_completed', 160, { turnId: 'x' }),
  ]
  const script = buildReplayScript(log)
  expect(script.events.length).toBeGreaterThan(log.length)
  expect(projectConversation(script.events).entries).toEqual(projectConversation(log).entries)
})

test("the replay's clock moves a turn to when it replays, keeping its spacing and the message's time", () => {
  const script = buildReplayScript(conversation())
  const clock = new ReplayClock()
  const now = 1_000_000
  const shown = clock.reveal(script, script.prompts[1]!, now)
  const message = shown.find((item) => item.type === 'user_message')!
  expect(message.createdAt).toBe(1_000)
  const started = shown.find((item) => item.type === 'turn_started')!
  const completed = shown.find((item) => item.type === 'turn_completed')!
  expect(started.createdAt).toBe(now)
  expect(completed.createdAt - started.createdAt).toBe(9_000 - 1_100)
  // Revealed again, an event is the same object, so the fold can append.
  const again = clock.reveal(script, script.prompts[1]! + 1, now + 50)
  expect(again[3]).toBe(shown[3])
  // Stepping back drops what was shown past the cursor.
  expect(clock.reveal(script, script.prompts[0]!, now + 60)).toHaveLength(script.prompts[0]!)
})

test('the whole log is read back page by page, oldest first, without repeating an event', async () => {
  const log = conversation()
  const pages = new Map<number, { events: ConversationEvent[]; hasMore: boolean; beforeCursor: number | null }>([
    [10, { events: log.slice(5, 10), hasMore: true, beforeCursor: 5 }],
    [5, { events: log.slice(0, 6), hasMore: false, beforeCursor: 0 }],
  ])
  const asked: number[] = []
  const all = await loadWholeConversation(
    async ({ beforeCursor }) => {
      asked.push(beforeCursor)
      return { ok: true, page: pages.get(beforeCursor)! }
    },
    { workspaceRoot: '/Users/dev/project', workspaceId: 'workspace', agentId: 'agent' },
    { events: log.slice(10), hasMore: true, beforeCursor: 10 },
  )
  expect(asked).toEqual([10, 5])
  expect(all).toEqual(log)
})

test('a page that does not move back ends the read rather than looping', async () => {
  const log = conversation()
  let calls = 0
  const all = await loadWholeConversation(
    async () => {
      calls += 1
      return { ok: true, page: { events: log.slice(0, 2), hasMore: true, beforeCursor: 4 } }
    },
    { workspaceRoot: '/Users/dev/project', workspaceId: 'workspace', agentId: 'agent' },
    { events: log.slice(2), hasMore: true, beforeCursor: 4 },
  )
  expect(calls).toBe(1)
  expect(all).toEqual(log)
})

test('a page that cannot be read fails the read with its reason', async () => {
  await expect(
    loadWholeConversation(
      async () => ({ ok: false, message: 'The transcript is locked.' }),
      { workspaceRoot: '/Users/dev/project', workspaceId: 'workspace', agentId: 'agent' },
      { events: [], hasMore: true, beforeCursor: 3 },
    ),
  ).rejects.toThrow('The transcript is locked.')
})
