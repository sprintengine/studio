import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { ConversationEvent, ConversationEventType } from '../../../../../shared/conversation-runtime'
import { projectConversation, type TranscriptToolEntry } from './conversationProjection'
import { applyEvent, createConversationProjectionState } from './incrementalConversationProjection'

let seq = 0
function ev(type: ConversationEventType, payload?: Record<string, unknown>): ConversationEvent {
  seq += 1
  return {
    id: `e-${seq}`,
    seq,
    sessionId: 'sess-1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: 'claude-agent',
    modelId: 'sonnet',
    type,
    createdAt: seq * 1000,
    payload,
  }
}

const tools = (events: ConversationEvent[]) =>
  projectConversation(events).entries.filter((entry): entry is TranscriptToolEntry => entry.kind === 'tool')

const ACK = 'Async agent launched successfully. (This tool result is internal metadata)'

function launch(turnId: string, toolUseId: string): ConversationEvent[] {
  return [
    ev('turn_started', { turnId }),
    ev('tool_started', { turnId, toolCallId: toolUseId, tool: 'Agent', subagentLane: true, subagentType: 'Explore' }),
    ev('subagent_status', { toolUseId, taskId: 't', status: 'running', background: true, description: 'Count files' }),
    ev('turn_completed', { turnId }),
  ]
}

test('a background agent works past its turn and closes on its own result', () => {
  const running = [
    ...launch('turn-1', 'lane-1'),
    ev('subagent_status', {
      toolUseId: 'lane-1',
      status: 'running',
      background: true,
      lastToolName: 'Bash',
      progressSummary: 'Listing files',
      usage: { totalTokens: 900, toolUses: 1, durationMs: 400 },
    }),
  ]
  const [lane] = tools(running)
  assert.equal(lane?.status, 'running', 'the turn ended; the agent did not')
  assert.equal(lane?.agent?.state, 'running')
  assert.equal(lane?.agent?.background, true)
  assert.equal(lane?.agent?.lastToolName, 'Bash')
  assert.equal(lane?.agent?.progressSummary, 'Listing files')
  assert.equal(lane?.agent?.description, 'Count files', 'a later report keeps what an earlier one said')

  const finished = tools([
    ...running,
    ev('tool_output', { toolCallId: 'lane-1', toolUseId: 'lane-1', output: '2 files', backgroundResult: true }),
    ev('subagent_status', {
      toolUseId: 'lane-1',
      status: 'completed',
      background: true,
      usage: { totalTokens: 1000, toolUses: 1, durationMs: 700 },
    }),
  ])[0]
  assert.equal(finished?.status, 'done')
  assert.equal(finished?.output, '2 files', 'the agent’s answer, with no turn to carry it')
  assert.equal(finished?.agent?.state, 'completed')
  assert.equal(finished?.agent?.usage?.totalTokens, 1000)
  assert.equal(finished?.outputStatus, 'ok')
})

test('a launch notice never reaches the lane', () => {
  // Reported by the provider: the lane stays open with no output.
  const [live] = tools([
    ...launch('turn-1', 'lane-1'),
    ev('tool_output', { turnId: 'turn-1', toolCallId: 'lane-1', output: ACK }),
  ])
  assert.equal(live?.status, 'running')
  assert.equal(live?.output, undefined)

  // Recorded before agents reported their end: all that is known is that it
  // ran in the background.
  const [legacy] = tools([
    ev('turn_started', { turnId: 'turn-2' }),
    ev('tool_started', { turnId: 'turn-2', toolCallId: 'lane-2', tool: 'Agent', subagentLane: true }),
    ev('tool_output', { turnId: 'turn-2', toolCallId: 'lane-2', output: ACK }),
  ])
  assert.equal(legacy?.status, 'done')
  assert.equal(legacy?.output, undefined)
  assert.deepEqual(legacy?.agent, { state: 'unknown', background: true })
})

test('a failed or stopped agent says so, and a late report never reopens its lane', () => {
  const [failed] = tools([
    ...launch('turn-1', 'lane-1'),
    ev('subagent_status', { toolUseId: 'lane-1', status: 'failed', error: 'Permission denied', endedAt: 4500 }),
    ev('subagent_status', { toolUseId: 'lane-1', status: 'running', lastToolName: 'Read' }),
  ])
  assert.equal(failed?.status, 'done')
  assert.equal(failed?.agent?.state, 'failed')
  assert.equal(failed?.agent?.error, 'Permission denied')
  assert.equal(failed?.outputStatus, 'error')
  assert.equal(failed?.completedAt, 4500, 'it ended when the agent ended, not when the report arrived')

  const [stopped] = tools([
    ...launch('turn-1', 'lane-2'),
    ev('subagent_status', { toolUseId: 'lane-2', status: 'stopped' }),
  ])
  assert.equal(stopped?.agent?.state, 'stopped')
  assert.equal(stopped?.outputStatus, 'stopped')
})

test('an interrupted turn leaves its background agent running', () => {
  const [lane] = tools([
    ev('turn_started', { turnId: 'turn-1' }),
    ev('tool_started', { turnId: 'turn-1', toolCallId: 'lane-1', tool: 'Agent', subagentLane: true }),
    ev('subagent_status', { toolUseId: 'lane-1', status: 'running', background: true }),
    ev('tool_started', { turnId: 'turn-1', toolCallId: 'bash-1', tool: 'Bash' }),
    ev('turn_failed', { turnId: 'turn-1', reason: 'interrupted' }),
  ])
  assert.equal(lane?.status, 'running')
})

test('a status reported before its lane is loaded applies when the lane arrives', () => {
  const [lane] = tools([
    ev('subagent_status', { toolUseId: 'lane-1', status: 'completed', background: true }),
    ev('turn_started', { turnId: 'turn-1' }),
    ev('tool_started', { turnId: 'turn-1', toolCallId: 'lane-1', tool: 'Agent', subagentLane: true }),
  ])
  assert.equal(lane?.status, 'done')
  assert.equal(lane?.agent?.state, 'completed')
})

test('a result for a call that is not loaded never lands on another call', () => {
  const entries = tools([
    ev('turn_started', { turnId: 'turn-1' }),
    ev('tool_started', { turnId: 'turn-1', toolCallId: 'bash-1', tool: 'Bash' }),
    ev('tool_output', { turnId: 'turn-1', toolCallId: 'lane-on-earlier-page', output: 'agent result' }),
  ])
  assert.equal(entries[0]?.status, 'running')
  assert.equal(entries[0]?.output, undefined)
})

test('the live projection keeps a lane open through its launch notice and closes it on the result', () => {
  let state = createConversationProjectionState(launch('turn-1', 'lane-1'))
  state = applyEvent(state, ev('tool_output', { turnId: 'turn-1', toolCallId: 'lane-1', output: ACK }))
  const lane = () => state.projection.entries.find((entry): entry is TranscriptToolEntry => entry.kind === 'tool')
  assert.equal(lane()?.status, 'running')
  assert.equal(lane()?.output, undefined)
  state = applyEvent(state, ev('tool_output', { toolCallId: 'lane-1', output: '2 files', backgroundResult: true }))
  assert.equal(lane()?.status, 'done')
  assert.equal(lane()?.output, '2 files')
  state = applyEvent(state, ev('subagent_status', { toolUseId: 'lane-1', status: 'completed' }))
  assert.equal(lane()?.agent?.state, 'completed')
})

test('the session says what each kind of agent it can spawn is for', () => {
  const { agentTypes } = projectConversation([
    ev('session_updated', {
      providerSessionId: 'native',
      agents: [
        { name: 'Explore', description: 'Fast agent specialized for exploring codebases.' },
        { name: 'code-reviewer', description: 'Reviews a diff for bugs.' },
        { name: 'nameless' },
        'junk',
      ],
    }),
  ])
  assert.deepEqual(agentTypes, {
    Explore: 'Fast agent specialized for exploring codebases.',
    'code-reviewer': 'Reviews a diff for bugs.',
  })
})

test('what an agent says is kept on its lane, never in the reply of the chat that spawned it', () => {
  const projection = projectConversation([
    ev('turn_started', { turnId: 'turn-1' }),
    ev('content_delta', { turnId: 'turn-1', text: 'Sending an agent.' }),
    ev('tool_started', { turnId: 'turn-1', toolCallId: 'lane-1', tool: 'Agent', subagentLane: true }),
    ev('subagent_message', { parentToolUseId: 'lane-1', text: 'Looking for the router first.' }),
    ev('subagent_message', { parentToolUseId: 'lane-1', text: 'Found it.', truncated: true }),
    ev('subagent_message', { parentToolUseId: 'lane-on-an-earlier-page', text: 'Lost?' }),
  ])
  const reply = projection.entries.find((entry) => entry.kind === 'assistant')
  assert.equal(
    reply?.kind === 'assistant' ? `${reply.intermediateText?.[0]?.text ?? ''}${reply.text}` : '',
    'Sending an agent.',
  )
  const lane = projection.entries.find((entry): entry is TranscriptToolEntry => entry.kind === 'tool')
  assert.deepEqual(
    lane?.messages?.map((message) => [message.text, message.truncated ?? false]),
    [
      ['Looking for the router first.', false],
      ['Found it.', true],
    ],
  )

  // Words that arrive before their lane is loaded join it once it is.
  const [late] = tools([
    ev('subagent_message', { parentToolUseId: 'lane-2', text: 'Early words.' }),
    ev('turn_started', { turnId: 'turn-2' }),
    ev('tool_started', { turnId: 'turn-2', toolCallId: 'lane-2', tool: 'Agent', subagentLane: true }),
  ])
  assert.deepEqual(
    late?.messages?.map((message) => message.text),
    ['Early words.'],
  )
})

test("a background agent's steps after its turn ended nest in its lane and leave the conversation idle", () => {
  const launched = launch('turn-1', 'lane-1')
  const steps = [
    ev('tool_started', { toolCallId: 'edit-1', tool: 'Edit', name: 'Edit', parentToolUseId: 'lane-1' }),
    ev('tool_output', { toolCallId: 'edit-1', toolUseId: 'edit-1', output: 'edited', parentToolUseId: 'lane-1' }),
  ]
  const events = [...launched, ...steps]
  const projection = projectConversation(events)
  assert.equal(projection.activeTurn, false, 'no turn is running while the agent works')
  const [lane, ...rest] = tools(events)
  assert.equal(rest.length, 0, 'the step is no row of its own')
  assert.equal(lane?.children?.[0]?.id, 'edit-1', 'the step sits in the lane that launched the agent')
  assert.equal(lane?.children?.[0]?.status, 'done')

  let state = createConversationProjectionState(launched)
  for (const step of steps) state = applyEvent(state, step)
  assert.deepEqual(state.projection.entries, projection.entries, 'the live projection folds it the same way')
})
