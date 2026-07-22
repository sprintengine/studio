import assert from 'node:assert/strict'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import {
  buildUserMessageContent,
  CLAUDE_AGENT_PROVIDER_ID,
  CLAUDE_AGENT_SESSION_ENV_KEY,
  createClaudeAgentProvider,
  mapSdkMessage,
  stripAnthropicAuthEnv,
  STRIPPED_ANTHROPIC_AUTH_ENV_KEYS,
  summarizeToolInput,
  type ClaudeAgentProviderAdapter,
} from './claude-agent-provider'
import type { MockAdapterTurnInput } from './mock-conversation-provider'

async function main(): Promise<void> {
  testSummarizeToolInput()
  testStripAnthropicAuthEnv()
  testBuildUserMessageContent()
  testMapSdkMessageCoversCanonicalShapes()
  await testTurnStreamsDeltasToolsUsageAndCompletion()
  await testImageAttachmentsBecomeMultimodalContent()
  await testResumeCursorIsPassedToTheSdkAndSessionUpdatesEmit()
  await testCanUseToolApprovalFlowApproveAndDeny()
  await testAskUserQuestionBecomesQuestionCardAndAnswersFlowBack()
  await testExitPlanModeBecomesPlanCard()
  await testPermissionPresetMapsToSdkPermissionMode()
  await testAbortSignalEndsTheTurnStream()
  await testSpawnFailureSurfacesAsTurnFailed()
  await testDisposeChildKeepsSessionAndCursorForRespawn()
  await testToolAfterResultOpensContinuationInsteadOfDenying()

  console.log('claude-agent-provider tests passed')
}

// ── Fake SDK plumbing ────────────────────────────────────────────────────────

type FakeSdkMessage = Record<string, unknown>

class FakeMessageQueue {
  private readonly queue: FakeSdkMessage[] = []
  private readonly resolvers: Array<(result: IteratorResult<FakeSdkMessage>) => void> = []
  private ended = false

  push(message: FakeSdkMessage): void {
    if (this.ended) return
    const resolve = this.resolvers.shift()
    if (resolve) resolve({ value: message, done: false })
    else this.queue.push(message)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const resolve of this.resolvers.splice(0)) resolve({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<FakeSdkMessage> {
    return {
      next: (): Promise<IteratorResult<FakeSdkMessage>> => {
        const value = this.queue.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.resolvers.push(resolve))
      },
    }
  }
}

type FakeQueryContext = {
  options: Record<string, unknown>
  emit: (message: FakeSdkMessage) => void
  end: () => void
  interrupted: () => boolean
}

type FakeQueryHandler = (userMessage: Record<string, unknown>, context: FakeQueryContext) => void | Promise<void>

function createFakeSdk(handler: FakeQueryHandler): {
  loadQuery: () => Promise<never>
  capturedOptions: Record<string, unknown>[]
} {
  const capturedOptions: Record<string, unknown>[] = []
  const queryFn = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
    capturedOptions.push(params.options)
    const output = new FakeMessageQueue()
    let interrupted = false
    const context: FakeQueryContext = {
      options: params.options,
      emit: (message) => output.push(message),
      end: () => output.end(),
      interrupted: () => interrupted,
    }
    void (async () => {
      for await (const userMessage of params.prompt) {
        await handler(userMessage, context)
      }
    })()
    return {
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
      interrupt: async () => {
        interrupted = true
        output.end()
      },
    }
  }
  return {
    loadQuery: (() => Promise.resolve(queryFn)) as () => Promise<never>,
    capturedOptions,
  }
}

function createAdapter(handler: FakeQueryHandler): {
  adapter: ClaudeAgentProviderAdapter
  capturedOptions: Record<string, unknown>[]
} {
  const sdk = createFakeSdk(handler)
  const adapter = createClaudeAgentProvider({
    loadQuery: sdk.loadQuery as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: (input) => ({ [CLAUDE_AGENT_SESSION_ENV_KEY]: input.sessionId, PATH: '/usr/bin' }),
    now: () => 1000,
  })
  return { adapter, capturedOptions: sdk.capturedOptions }
}

const SESSION_INPUT = {
  sessionId: 'conv_1',
  workspaceId: 'workspace',
  agentId: 'agent',
  providerId: CLAUDE_AGENT_PROVIDER_ID,
  modelId: 'sonnet',
  workspaceRoot: '/tmp/workspace',
}

function turnInput(overrides: Partial<MockAdapterTurnInput> = {}): MockAdapterTurnInput {
  return {
    ...SESSION_INPUT,
    turnId: 'turn_1',
    requestId: 'approval_1',
    message: 'hello',
    ...overrides,
  }
}

async function collect(
  stream: AsyncIterable<ConversationEvent> | ConversationEvent[],
  onEvent?: (event: ConversationEvent) => void | Promise<void>
): Promise<ConversationEvent[]> {
  const events: ConversationEvent[] = []
  if (Array.isArray(stream)) return stream
  for await (const event of stream) {
    events.push(event)
    if (onEvent) await onEvent(event)
  }
  return events
}

// ── Tests ────────────────────────────────────────────────────────────────────

function testSummarizeToolInput(): void {
  assert.equal(summarizeToolInput('Bash', { command: 'ls -la' }), 'Bash: ls -la')
  assert.equal(summarizeToolInput('Read', { file_path: '/tmp/a.txt' }), 'Read: /tmp/a.txt')
  assert.equal(summarizeToolInput('Weird', {}), 'Weird')
  assert.ok(summarizeToolInput('Edit', { other: 1 }).startsWith('Edit: {'))
}

// The subscription-auth guarantee: the child env this provider builds must
// never carry an inherited API key or an endpoint redirect (the CLI would
// prefer them over the stored `claude login` credentials and bill silently).
function testStripAnthropicAuthEnv(): void {
  const stripped = stripAnthropicAuthEnv({
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-ant-inherited',
    ANTHROPIC_AUTH_TOKEN: 'third-party-token',
    ANTHROPIC_BASE_URL: 'https://api.z.ai',
    MULTICODE_WORKSPACE_ID: 'workspace',
  })
  for (const key of STRIPPED_ANTHROPIC_AUTH_ENV_KEYS) assert.equal(key in stripped, false)
  assert.equal(stripped.PATH, '/usr/bin')
  assert.equal(stripped.MULTICODE_WORKSPACE_ID, 'workspace')
}

// Text-only turns keep the plain-string content shape (unchanged path);
// attaching images turns it into a multimodal block array — text first, then a
// base64 image block per attachment.
function testBuildUserMessageContent(): void {
  assert.equal(buildUserMessageContent('hello', undefined), 'hello')
  assert.equal(buildUserMessageContent('hello', []), 'hello')

  const withImage = buildUserMessageContent('look', [
    { id: 'a1', mediaType: 'image/png', dataBase64: 'AAAA', byteLength: 3 },
  ])
  assert.deepEqual(withImage, [
    { type: 'text', text: 'look' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ])

  // An image-only send (no text) drops the text block entirely.
  const imageOnly = buildUserMessageContent('', [
    { id: 'a1', mediaType: 'image/jpeg', dataBase64: 'BBBB', byteLength: 3 },
  ])
  assert.deepEqual(imageOnly, [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
  ])
}

function testMapSdkMessageCoversCanonicalShapes(): void {
  const state = {
    ...SESSION_INPUT,
    providerSessionId: null as string | null,
    turn: { turnId: 'turn_9' },
  }
  const init = mapSdkMessage(state, {
    type: 'system',
    subtype: 'init',
    session_id: 'sdk-session-1',
    model: 'sonnet',
    apiKeySource: 'none',
  })
  assert.deepEqual(init.map((event) => event.type), ['session_updated'])
  assert.equal(init[0]?.payload?.providerSessionId, 'sdk-session-1')
  assert.equal(init[0]?.payload?.apiKeySource, 'none')
  assert.equal(state.providerSessionId, 'sdk-session-1')

  // An init that binds an API key must surface the source even when the
  // session cursor did not change (e.g. a respawn resuming the same session).
  const keyedInit = mapSdkMessage(state, {
    type: 'system',
    subtype: 'init',
    session_id: 'sdk-session-1',
    model: 'sonnet',
    apiKeySource: 'ANTHROPIC_API_KEY',
  })
  assert.deepEqual(keyedInit.map((event) => event.type), ['session_updated'])
  assert.equal(keyedInit[0]?.payload?.apiKeySource, 'ANTHROPIC_API_KEY')

  const text = mapSdkMessage(state, {
    type: 'stream_event',
    session_id: 'sdk-session-1',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
  })
  assert.deepEqual(text.map((event) => event.type), ['content_delta'])
  assert.equal(text[0]?.payload?.text, 'Hi')
  assert.equal(text[0]?.payload?.turnId, 'turn_9')

  const thinking = mapSdkMessage(state, {
    type: 'stream_event',
    session_id: 'sdk-session-1',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
  })
  assert.deepEqual(thinking.map((event) => event.type), ['reasoning_delta'])

  // Subagent traffic must not leak into the top-level transcript.
  const subagent = mapSdkMessage(state, {
    type: 'stream_event',
    session_id: 'sdk-session-1',
    parent_tool_use_id: 'tool-1',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'nested' } },
  })
  assert.deepEqual(subagent, [])

  const toolUse = mapSdkMessage(state, {
    type: 'assistant',
    session_id: 'sdk-session-1',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] },
  })
  assert.deepEqual(toolUse.map((event) => event.type), ['tool_started'])
  assert.equal(toolUse[0]?.payload?.tool, 'Bash')
  assert.equal(toolUse[0]?.payload?.toolCallId, 'tu_1')
  assert.equal('addedLines' in (toolUse[0]?.payload ?? {}), false, 'non-edit tools ship no diff counts')

  // Edit-shaped tools ship added/removed line counts for the work timeline.
  const editUse = mapSdkMessage(state, {
    type: 'assistant',
    session_id: 'sdk-session-1',
    parent_tool_use_id: null,
    message: {
      content: [
        { type: 'tool_use', id: 'tu_2', name: 'Edit', input: { file_path: 'a.ts', old_string: 'x\ny', new_string: 'x\ny\nz' } },
        { type: 'tool_use', id: 'tu_3', name: 'Write', input: { file_path: 'b.ts', content: 'one\ntwo\nthree' } },
      ],
    },
  })
  assert.equal(editUse[0]?.payload?.addedLines, 3)
  assert.equal(editUse[0]?.payload?.removedLines, 2)
  assert.equal(editUse[1]?.payload?.addedLines, 3)
  assert.equal('removedLines' in (editUse[1]?.payload ?? {}), false, 'Write has no removable baseline')

  const toolResult = mapSdkMessage(state, {
    type: 'user',
    session_id: 'sdk-session-1',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'file-a' }] }] },
  })
  assert.deepEqual(toolResult.map((event) => event.type), ['tool_output'])
  assert.equal(toolResult[0]?.payload?.output, 'file-a')

  const success = mapSdkMessage(state, {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'sdk-session-1',
    usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 },
  })
  assert.deepEqual(success.map((event) => event.type), ['usage_updated', 'turn_completed'])
  assert.equal(success[0]?.payload?.inputTokens, 15)
  assert.equal(success[0]?.payload?.outputTokens, 3)

  const failure = mapSdkMessage(state, {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    session_id: 'sdk-session-1',
    usage: { input_tokens: 1, output_tokens: 1 },
    errors: ['boom'],
  })
  assert.deepEqual(failure.map((event) => event.type), ['usage_updated', 'turn_failed'])
  assert.equal(failure[1]?.payload?.reason, 'error_during_execution')
  assert.equal(failure[1]?.payload?.message, 'boom')

  // Unknown message shapes are dropped, not crashed on.
  assert.deepEqual(mapSdkMessage(state, { type: 'rate_limit_event', session_id: 'sdk-session-1' }), [])
}

async function testTurnStreamsDeltasToolsUsageAndCompletion(): Promise<void> {
  const { adapter, capturedOptions } = createAdapter((userMessage, context) => {
    assert.deepEqual(userMessage.message, { role: 'user', content: 'hello' })
    context.emit({ type: 'system', subtype: 'init', session_id: 's1', model: 'sonnet' })
    context.emit({
      type: 'stream_event',
      session_id: 's1',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
    })
    context.emit({
      type: 'assistant',
      session_id: 's1',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'a.txt' } }] },
    })
    context.emit({
      type: 'user',
      session_id: 's1',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'contents' }] },
    })
    context.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 's1',
      usage: { input_tokens: 7, output_tokens: 2 },
    })
  })

  const startEvents = await collect(adapter.startSession(SESSION_INPUT) as ConversationEvent[])
  assert.deepEqual(startEvents.map((event) => event.type), ['session_started', 'session_ready'])
  assert.equal(startEvents[0]?.payload?.resumed, false)

  const events = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
  assert.deepEqual(
    events.map((event) => event.type),
    ['turn_started', 'session_updated', 'content_delta', 'tool_started', 'tool_output', 'usage_updated', 'turn_completed']
  )
  const options = capturedOptions[0]
  assert.equal(options?.cwd, '/tmp/workspace')
  assert.equal(options?.pathToClaudeCodeExecutable, '/fake/bin/claude')
  assert.equal(options?.model, 'sonnet')
  assert.equal(options?.includePartialMessages, true)
  assert.equal(options?.permissionMode, 'default')
  assert.equal(options?.resume, undefined)
  assert.equal((options?.env as Record<string, string>)[CLAUDE_AGENT_SESSION_ENV_KEY], 'conv_1')

  const live = adapter.listLiveSessions()
  assert.equal(live.length, 1)
  assert.equal(live[0]?.hasChildProcess, true)
  assert.equal(live[0]?.providerSessionId, 's1')
  assert.equal(live[0]?.turnActive, false)
}

// A turn carrying attachments must reach the SDK as a multimodal user message:
// the text block plus one base64 image block per attachment.
async function testImageAttachmentsBecomeMultimodalContent(): Promise<void> {
  let capturedContent: unknown
  const { adapter } = createAdapter((userMessage, context) => {
    capturedContent = (userMessage.message as { content: unknown }).content
    context.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 's-img',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  })

  await collect(adapter.startSession(SESSION_INPUT) as ConversationEvent[])
  const events = await collect(
    adapter.sendTurn(
      turnInput({
        message: 'describe this',
        attachments: [{ id: 'img-1', mediaType: 'image/png', dataBase64: 'Zm9v', byteLength: 3 }],
      })
    ) as AsyncIterable<ConversationEvent>
  )
  assert.deepEqual(events.map((event) => event.type), ['turn_started', 'session_updated', 'usage_updated', 'turn_completed'])
  assert.deepEqual(capturedContent, [
    { type: 'text', text: 'describe this' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'Zm9v' } },
  ])
}

async function testResumeCursorIsPassedToTheSdkAndSessionUpdatesEmit(): Promise<void> {
  const { adapter, capturedOptions } = createAdapter((_userMessage, context) => {
    // Resume produces a fresh CLI session id; the adapter must surface it.
    context.emit({ type: 'system', subtype: 'init', session_id: 'resumed-2', model: 'sonnet' })
    context.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'resumed-2',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  })

  const startEvents = await collect(
    adapter.startSession({ ...SESSION_INPUT, resumeSessionId: 'previous-1' }) as ConversationEvent[]
  )
  assert.equal(startEvents[0]?.payload?.providerSessionId, 'previous-1')
  assert.equal(startEvents[0]?.payload?.resumed, true)

  const events = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
  assert.equal(capturedOptions[0]?.resume, 'previous-1')
  const updated = events.find((event) => event.type === 'session_updated')
  assert.equal(updated?.payload?.providerSessionId, 'resumed-2')
}

async function testCanUseToolApprovalFlowApproveAndDeny(): Promise<void> {
  const decisions: Array<Record<string, unknown>> = []
  const { adapter } = createAdapter(async (userMessage, context) => {
    const canUseTool = context.options.canUseTool as (
      toolName: string,
      input: Record<string, unknown>,
      options: { signal?: AbortSignal }
    ) => Promise<Record<string, unknown>>
    const text = (userMessage.message as { content: string }).content
    const decision = await canUseTool('Bash', { command: `run ${text}` }, {})
    decisions.push(decision)
    context.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 's1',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  })

  await collect(adapter.startSession(SESSION_INPUT) as ConversationEvent[])

  // Approve.
  const approvedEvents = await collect(
    adapter.sendTurn(turnInput({ message: 'first' })) as AsyncIterable<ConversationEvent>,
    (event) => {
      if (event.type === 'approval_requested') {
        assert.equal(event.payload?.requestId, 'approval_1')
        assert.equal(event.payload?.action, 'Bash')
        assert.equal(event.payload?.summary, 'Bash: run first')
        void collect(
          adapter.resolveApproval({ ...SESSION_INPUT, turnId: 'turn_1', requestId: 'approval_1', approved: true }) as ConversationEvent[]
        )
      }
    }
  )
  assert.deepEqual(
    approvedEvents.map((event) => event.type),
    ['turn_started', 'approval_requested', 'approval_resolved', 'session_updated', 'usage_updated', 'turn_completed']
  )
  assert.equal(approvedEvents[2]?.payload?.approved, true)
  assert.equal(decisions[0]?.behavior, 'allow')

  // Deny (second turn on the same live session).
  const deniedEvents = await collect(
    adapter.sendTurn(turnInput({ turnId: 'turn_2', requestId: 'approval_2', message: 'second' })) as AsyncIterable<ConversationEvent>,
    (event) => {
      if (event.type === 'approval_requested') {
        void collect(
          adapter.resolveApproval({ ...SESSION_INPUT, turnId: 'turn_2', requestId: 'approval_2', approved: false }) as ConversationEvent[]
        )
      }
    }
  )
  assert.equal(deniedEvents.find((event) => event.type === 'approval_resolved')?.payload?.approved, false)
  assert.equal(decisions[1]?.behavior, 'deny')
}

async function testAskUserQuestionBecomesQuestionCardAndAnswersFlowBack(): Promise<void> {
  const decisions: Array<Record<string, unknown>> = []
  const questionInput = {
    questions: [
      {
        question: 'Which auth method?',
        header: 'Auth',
        multiSelect: false,
        options: [
          { label: 'OAuth', description: 'Redirect flow' },
          { label: 'API key', description: 'Static secret' },
        ],
      },
    ],
  }
  const { adapter } = createAdapter(async (_userMessage, context) => {
    const canUseTool = context.options.canUseTool as (
      toolName: string,
      input: Record<string, unknown>,
      options: { signal?: AbortSignal }
    ) => Promise<Record<string, unknown>>
    decisions.push(await canUseTool('AskUserQuestion', questionInput, {}))
    context.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 's1',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  })

  await collect(adapter.startSession(SESSION_INPUT) as ConversationEvent[])
  const events = await collect(
    adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>,
    (event) => {
      if (event.type === 'approval_requested') {
        assert.equal(event.payload?.kind, 'question')
        assert.equal(event.payload?.summary, 'Which auth method?')
        const questions = event.payload?.questions as Array<Record<string, unknown>>
        assert.equal(questions.length, 1)
        assert.equal((questions[0]?.options as unknown[]).length, 2)
        assert.equal(questions[0]?.allowFreeText, true)
        void collect(
          adapter.resolveApproval({
            ...SESSION_INPUT,
            turnId: 'turn_1',
            requestId: 'approval_1',
            approved: true,
            answers: { 'Which auth method?': 'OAuth' },
          }) as ConversationEvent[]
        )
      }
    }
  )
  const resolved = events.find((event) => event.type === 'approval_resolved')
  assert.deepEqual(resolved?.payload?.answers, { 'Which auth method?': 'OAuth' })
  assert.equal(decisions[0]?.behavior, 'allow')
  assert.deepEqual((decisions[0]?.updatedInput as Record<string, unknown>).answers, { 'Which auth method?': 'OAuth' })

  // Dismissal denies the tool so the model can move on.
  const dismissed: Array<Record<string, unknown>> = []
  const { adapter: adapter2 } = createAdapter(async (_userMessage, context) => {
    const canUseTool = context.options.canUseTool as (
      toolName: string,
      input: Record<string, unknown>,
      options: { signal?: AbortSignal }
    ) => Promise<Record<string, unknown>>
    dismissed.push(await canUseTool('AskUserQuestion', questionInput, {}))
    context.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 's1',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  })
  await collect(adapter2.startSession(SESSION_INPUT) as ConversationEvent[])
  await collect(adapter2.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>, (event) => {
    if (event.type === 'approval_requested') {
      void collect(
        adapter2.resolveApproval({ ...SESSION_INPUT, turnId: 'turn_1', requestId: 'approval_1', approved: false }) as ConversationEvent[]
      )
    }
  })
  assert.equal(dismissed[0]?.behavior, 'deny')
}

async function testExitPlanModeBecomesPlanCard(): Promise<void> {
  const decisions: Array<Record<string, unknown>> = []
  const { adapter } = createAdapter(async (_userMessage, context) => {
    const canUseTool = context.options.canUseTool as (
      toolName: string,
      input: Record<string, unknown>,
      options: { signal?: AbortSignal }
    ) => Promise<Record<string, unknown>>
    decisions.push(await canUseTool('ExitPlanMode', { plan: '## Plan\n1. Do the thing' }, {}))
    context.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 's1',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  })
  await collect(adapter.startSession(SESSION_INPUT) as ConversationEvent[])
  const events = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>, (event) => {
    if (event.type === 'approval_requested') {
      assert.equal(event.payload?.kind, 'plan')
      assert.equal(event.payload?.plan, '## Plan\n1. Do the thing')
      void collect(
        adapter.resolveApproval({ ...SESSION_INPUT, turnId: 'turn_1', requestId: 'approval_1', approved: true }) as ConversationEvent[]
      )
    }
  })
  assert.equal(events.some((event) => event.type === 'approval_resolved' && event.payload?.approved === true), true)
  assert.equal(decisions[0]?.behavior, 'allow')
}

async function testPermissionPresetMapsToSdkPermissionMode(): Promise<void> {
  const emitResult = (context: FakeQueryContext): void => {
    context.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 's1',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }

  const bypass = createAdapter((_userMessage, context) => emitResult(context))
  await collect(bypass.adapter.startSession({ ...SESSION_INPUT, permissionPreset: 'bypass_all' }) as ConversationEvent[])
  await collect(bypass.adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
  assert.equal(bypass.capturedOptions[0]?.permissionMode, 'bypassPermissions')
  assert.equal(bypass.capturedOptions[0]?.allowDangerouslySkipPermissions, true)

  const auto = createAdapter((_userMessage, context) => emitResult(context))
  await collect(auto.adapter.startSession({ ...SESSION_INPUT, permissionPreset: 'auto_workspace' }) as ConversationEvent[])
  await collect(auto.adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
  assert.equal(auto.capturedOptions[0]?.permissionMode, 'auto')
  assert.equal(auto.capturedOptions[0]?.allowDangerouslySkipPermissions, undefined)
}

async function testAbortSignalEndsTheTurnStream(): Promise<void> {
  const { adapter } = createAdapter((_userMessage, context) => {
    context.emit({
      type: 'stream_event',
      session_id: 's1',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
    })
    // Never emits a result: the turn only ends via the abort signal.
  })

  await collect(adapter.startSession(SESSION_INPUT) as ConversationEvent[])
  const abort = new AbortController()
  const events = await collect(
    adapter.sendTurn(turnInput({ signal: abort.signal })) as AsyncIterable<ConversationEvent>,
    (event) => {
      if (event.type === 'content_delta') abort.abort()
    }
  )
  assert.deepEqual(events.map((event) => event.type), ['turn_started', 'session_updated', 'content_delta'])
}

async function testSpawnFailureSurfacesAsTurnFailed(): Promise<void> {
  const adapter = createClaudeAgentProvider({
    loadQuery: (() => Promise.reject(new Error('sdk unavailable'))) as never,
    resolveExecutable: async () => {
      throw new Error('Claude Code CLI is not installed.')
    },
    buildEnv: () => ({}),
    now: () => 1000,
  })
  await collect(adapter.startSession(SESSION_INPUT) as ConversationEvent[])
  const events = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
  assert.deepEqual(events.map((event) => event.type), ['turn_started', 'turn_failed'])
  assert.equal(events[1]?.payload?.reason, 'spawn')
  assert.equal(events[1]?.payload?.message, 'Claude Code CLI is not installed.')
}

async function testDisposeChildKeepsSessionAndCursorForRespawn(): Promise<void> {
  const { adapter, capturedOptions } = createAdapter((_userMessage, context) => {
    context.emit({ type: 'system', subtype: 'init', session_id: 'cursor-1', model: 'sonnet' })
    context.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'cursor-1',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  })

  await collect(adapter.startSession(SESSION_INPUT) as ConversationEvent[])
  await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
  assert.equal(adapter.listLiveSessions()[0]?.hasChildProcess, true)

  assert.equal(adapter.disposeChildProcess('conv_1'), true)
  assert.equal(adapter.disposeChildProcess('conv_1'), false)
  const live = adapter.listLiveSessions()[0]
  assert.equal(live?.hasChildProcess, false)
  assert.equal(live?.providerSessionId, 'cursor-1')

  // Next turn respawns with the kept cursor.
  const events = await collect(adapter.sendTurn(turnInput({ turnId: 'turn_2', requestId: 'approval_2' })) as AsyncIterable<ConversationEvent>)
  assert.equal(events.at(-1)?.type, 'turn_completed')
  assert.equal(capturedOptions.length, 2)
  assert.equal(capturedOptions[1]?.resume, 'cursor-1')

  const closed = await collect(adapter.stopSession(SESSION_INPUT) as ConversationEvent[])
  assert.deepEqual(closed.map((event) => event.type), ['session_closed'])
  assert.equal(adapter.listLiveSessions().length, 0)
}

// 1775: a tool the long-lived child invokes AFTER the turn `result` (the model
// resuming once a background subagent completes) must not be auto-denied. With
// a session-scoped continuation channel, handleCanUseTool opens a continuation
// turn and the approval card flows to the runtime; resolveApproval answers it.
async function testToolAfterResultOpensContinuationInsteadOfDenying(): Promise<void> {
  const gate = createDeferred<void>()
  const decisions: Array<Record<string, unknown>> = []
  const { adapter } = createAdapter(async (_userMessage, context) => {
    // The turn completes and its sendTurn stream ends.
    context.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 's1', usage: { input_tokens: 1, output_tokens: 1 } })
    // The child keeps working: only once the test has confirmed the turn
    // resolved does a post-`result` tool fire (a background subagent completed).
    await gate.promise
    const canUseTool = context.options.canUseTool as (
      toolName: string,
      input: Record<string, unknown>,
      options: { signal?: AbortSignal }
    ) => Promise<Record<string, unknown>>
    decisions.push(await canUseTool('Bash', { command: 'ls' }, {}))
    context.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 's1', usage: { input_tokens: 1, output_tokens: 1 } })
  })

  const continuation: ConversationEvent[] = []
  await collect(adapter.startSession({ ...SESSION_INPUT, onSessionEvent: (event) => continuation.push(event) }) as ConversationEvent[])

  const turnEvents = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
  assert.equal(turnEvents.at(-1)?.type, 'turn_completed', 'the turn resolves at `result`, freeing the composer')

  // Now let the post-`result` tool fire; its approval card must reach the
  // continuation channel rather than being denied.
  gate.resolve()
  const requestId = await waitForContinuationEvent(continuation, 'approval_requested')
  assert.deepEqual(
    continuation.slice(0, 2).map((event) => event.type),
    ['turn_started', 'approval_requested'],
    'the continuation announces its turn before the approval card'
  )
  const contTurnId = continuation[0]?.payload?.turnId
  assert.equal(typeof contTurnId === 'string' && contTurnId.includes('_cont_'), true)

  await collect(
    adapter.resolveApproval({ ...SESSION_INPUT, turnId: contTurnId as string, requestId, approved: true }) as ConversationEvent[]
  )
  await waitForContinuationEvent(continuation, 'turn_completed')

  assert.equal(decisions[0]?.behavior, 'allow', 'the post-`result` tool was approved, not auto-denied')
  assert.deepEqual(
    continuation.map((event) => event.type),
    ['turn_started', 'approval_requested', 'approval_resolved', 'usage_updated', 'turn_completed']
  )
  assert.equal(continuation.find((event) => event.type === 'approval_resolved')?.payload?.approved, true)

  await collect(adapter.stopSession(SESSION_INPUT) as ConversationEvent[])
}

function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function waitForContinuationEvent(events: ConversationEvent[], type: ConversationEvent['type']): Promise<string> {
  for (let i = 0; i < 200; i += 1) {
    const match = events.find((event) => event.type === type)
    if (match) return typeof match.payload?.requestId === 'string' ? match.payload.requestId : ''
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`Timed out waiting for continuation ${type}`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
