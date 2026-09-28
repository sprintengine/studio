import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  sweepStaleSkillPlugins,
  type ClaudeAgentProviderAdapter,
} from './claude-agent-provider'
import type { MockAdapterTurnInput } from './mock-conversation-provider'
import { ConversationRuntime } from '../conversation-runtime'
import {
  conversationCommandsFor,
  onConversationCommandsChanged,
  publishConversationCommands,
} from '../conversation-commands/registry'
import { test } from 'vitest'

test('claude-agent-provider', async () => {
  async function main(): Promise<void> {
    testSummarizeToolInput()
    testStripAnthropicAuthEnv()
    testBuildUserMessageContent()
    testMapSdkMessageCoversCanonicalShapes()
    await testTurnStreamsDeltasToolsUsageAndCompletion()
    await testImageAttachmentsBecomeMultimodalContent()
    await testNativeSkillSelectionReachesSdk()
    await testAskModeReadOnlyAndEffort()
    await testLiveModelSwitch()
    await testResumeCursorIsPassedToTheSdkAndSessionUpdatesEmit()
    await testCanUseToolApprovalFlowApproveAndDeny()
    await testBypassAnswersSubagentAsksButKeepsSafetyAndRuleAsks()
    await testDeniedToolResultReadsAsDeclined()
    await testAskUserQuestionBecomesQuestionCardAndAnswersFlowBack()
    await testExitPlanModeBecomesPlanCard()
    await testPermissionPresetMapsToSdkPermissionMode()
    await testLivePermissionPresetReachesTheChildAndSurvivesRespawn()
    await testAbortSignalEndsTheTurnStream()
    await testSpawnFailureSurfacesAsTurnFailed()
    await testDisposeChildKeepsSessionAndCursorForRespawn()
    await testToolAfterResultOpensContinuationInsteadOfDenying()
    await testSubagentEventsAfterResultRideTheContinuationChannel()
    await testAskUserQuestionAfterResultReachesTheUserAndAnswersFlowBack()
    await testTurnTakeoverEndsTheReplacedContinuationQueue()
    await testSwitchingToBypassMidSessionRespawnsInsteadOfBeingRefused()

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

  // Live control requests the fake child records. `onSetPermissionMode` may throw
  // to stand in for a CLI that refuses the mode.
  type FakeSdkHooks = {
    onSetPermissionMode?: (mode: string) => void
  }

  function createFakeSdk(
    handler: FakeQueryHandler,
    hooks: FakeSdkHooks = {},
  ): {
    loadQuery: () => Promise<never>
    capturedOptions: Record<string, unknown>[]
    permissionModes: string[]
    models: Array<string | undefined>
  } {
    const capturedOptions: Record<string, unknown>[] = []
    const permissionModes: string[] = []
    const models: Array<string | undefined> = []
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
        setPermissionMode: async (mode: string) => {
          hooks.onSetPermissionMode?.(mode)
          permissionModes.push(mode)
        },
        setModel: async (model?: string) => {
          models.push(model)
        },
      }
    }
    return {
      loadQuery: (() => Promise.resolve(queryFn)) as () => Promise<never>,
      capturedOptions,
      permissionModes,
      models,
    }
  }

  function createAdapter(
    handler: FakeQueryHandler,
    hooks: FakeSdkHooks = {},
  ): {
    adapter: ClaudeAgentProviderAdapter
    capturedOptions: Record<string, unknown>[]
    permissionModes: string[]
    models: Array<string | undefined>
  } {
    const sdk = createFakeSdk(handler, hooks)
    const adapter = createClaudeAgentProvider({
      loadQuery: sdk.loadQuery as never,
      resolveExecutable: async () => '/fake/bin/claude',
      buildEnv: (input) => ({ [CLAUDE_AGENT_SESSION_ENV_KEY]: input.sessionId, PATH: '/usr/bin' }),
      now: () => 1000,
    })
    return {
      adapter,
      capturedOptions: sdk.capturedOptions,
      permissionModes: sdk.permissionModes,
      models: sdk.models,
    }
  }

  async function testNativeSkillSelectionReachesSdk(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'claude-skills-'))
    try {
      await mkdir(join(workspaceRoot, '.claude', 'skills', 'example'), { recursive: true })
      await writeFile(
        join(workspaceRoot, '.claude', 'skills', 'example', 'SKILL.md'),
        '---\nname: example\n---\nDo it.',
      )
      await writeFile(join(workspaceRoot, 'CLAUDE.md'), 'Run the tests before committing.')
      const prompts: string[] = []
      const { adapter, capturedOptions } = createAdapter((message, context) => {
        prompts.push(JSON.stringify(message))
        context.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-skills' })
      })
      const input = turnInput({ workspaceRoot })
      await adapter.startSession(input)
      for await (const _event of await adapter.sendTurn({ ...input, skills: ['example'] })) {
        /* drain the turn */
      }
      // The repository's settings files can pre-approve tools and run hooks,
      // so they are never loaded, with or without skills attached.
      assert.deepEqual(capturedOptions[0]?.settingSources, ['user'])
      assert.deepEqual(capturedOptions[0]?.skills, ['attached-skills:example'])
      const plugins = capturedOptions[0]?.plugins as Array<{ type: string; path: string }>
      assert.equal(plugins.length, 1)
      assert.equal(
        await readFile(join(plugins[0].path, 'skills', 'example', 'SKILL.md'), 'utf8'),
        '---\nname: example\n---\nDo it.',
      )
      assert.match(await readFile(join(plugins[0].path, '.claude-plugin', 'plugin.json'), 'utf8'), /attached-skills/)
      assert.match(prompts.join('\n'), /attached-skills:example/)
      // The project's instructions still reach the model, as prompt text.
      const systemPrompt = capturedOptions[0]?.systemPrompt as { append?: string }
      assert.match(systemPrompt.append ?? '', /Run the tests before committing\./)
      adapter.disposeAll?.()
      await new Promise((resolve) => setTimeout(resolve, 20))
      await assert.rejects(stat(plugins[0].path), 'the staged plugin is removed with its child')

      const plain = createAdapter((_message, context) => {
        context.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'no-skills' })
      })
      await plain.adapter.startSession(turnInput())
      for await (const _event of await plain.adapter.sendTurn(turnInput())) {
        /* drain the turn */
      }
      assert.deepEqual(plain.capturedOptions[0]?.settingSources, ['user'])
      assert.equal(plain.capturedOptions[0]?.plugins, undefined)
      plain.adapter.disposeAll?.()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testAskModeReadOnlyAndEffort(): Promise<void> {
    const { adapter, capturedOptions } = createAdapter((_message, context) => {
      context.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'ask-mode' })
    })
    const input = turnInput()
    await adapter.startSession(input)
    for await (const _event of await adapter.sendTurn({ ...input, mode: 'ask', reasoningEffort: 'high' })) {
      /* drain */
    }
    assert.equal(capturedOptions[0]?.permissionMode, 'plan')
    assert.equal(capturedOptions[0]?.effort, 'high')
    const hooks = capturedOptions[0]?.hooks as {
      PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>
    }
    const hook = hooks.PreToolUse[0].hooks[0]
    const denied = (await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })) as {
      hookSpecificOutput?: { permissionDecision: string }
    }
    assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny')
    assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read' }), {})
    await adapter.setPermissionPreset({ ...input, permissionPreset: 'bypass' })
    for await (const _event of await adapter.sendTurn({ ...input, turnId: 'default', mode: 'default' })) {
      /* drain */
    }
    assert.equal(capturedOptions[1]?.permissionMode, 'bypassPermissions')
    adapter.disposeAll()
  }

  // A model switch reaches the live query through the SDK's setModel — no
  // respawn — and the CLI's own default row clears the model rather than
  // naming one. With no child yet, the next spawn simply starts on it.
  async function testLiveModelSwitch(): Promise<void> {
    const { adapter, capturedOptions, models } = createAdapter((_message, context) => {
      context.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'switch' })
    })
    assert.equal(adapter.capabilities?.liveModelSwitch, true)
    const input = turnInput()
    await adapter.startSession(input)
    assert.deepEqual(await adapter.setModel({ ...input, nextModelId: 'haiku' }), { ok: true })
    for await (const _event of await adapter.sendTurn({ ...input, modelId: 'haiku' })) {
      /* drain */
    }
    assert.equal(capturedOptions[0]?.model, 'haiku', 'a switch before the child exists starts it on the new model')
    assert.deepEqual(await adapter.setModel({ ...input, nextModelId: 'opus' }), { ok: true })
    assert.deepEqual(await adapter.setModel({ ...input, nextModelId: 'default' }), { ok: true })
    assert.deepEqual(models, ['opus', undefined], 'the live query is switched in place, default clearing it')
    assert.equal(capturedOptions.length, 1, 'no respawn')
    adapter.disposeAll()
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
    onEvent?: (event: ConversationEvent) => void | Promise<void>,
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
      CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '3',
      SPRINTENGINE_WORKSPACE_ID: 'workspace',
    })
    for (const key of STRIPPED_ANTHROPIC_AUTH_ENV_KEYS) assert.equal(key in stripped, false)
    assert.equal(stripped.PATH, '/usr/bin')
    assert.equal(stripped.SPRINTENGINE_WORKSPACE_ID, 'workspace')
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
    assert.deepEqual(imageOnly, [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } }])
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
    assert.deepEqual(
      init.map((event) => event.type),
      ['session_updated'],
    )
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
    assert.deepEqual(
      keyedInit.map((event) => event.type),
      ['session_updated'],
    )
    assert.equal(keyedInit[0]?.payload?.apiKeySource, 'ANTHROPIC_API_KEY')

    // The source is written to the transcript unredacted, so a value outside
    // the SDK's labels is dropped instead of carried.
    const oddInit = mapSdkMessage(state, {
      type: 'system',
      subtype: 'init',
      session_id: 'sdk-session-1',
      model: 'sonnet',
      apiKeySource: 'sk-ant-not-a-label',
    })
    assert.deepEqual(oddInit, [])

    const text = mapSdkMessage(state, {
      type: 'stream_event',
      session_id: 'sdk-session-1',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
    })
    assert.deepEqual(
      text.map((event) => event.type),
      ['content_delta'],
    )
    assert.equal(text[0]?.payload?.text, 'Hi')
    assert.equal(text[0]?.payload?.turnId, 'turn_9')

    const thinking = mapSdkMessage(state, {
      type: 'stream_event',
      session_id: 'sdk-session-1',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
    })
    assert.deepEqual(
      thinking.map((event) => event.type),
      ['reasoning_delta'],
    )
    // A new thinking block opens a new paragraph of the run.
    const blockStart = mapSdkMessage(state, {
      type: 'stream_event',
      session_id: 'sdk-session-1',
      parent_tool_use_id: null,
      event: { type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: '' } },
    })
    assert.deepEqual(
      blockStart.map((event) => [event.type, event.payload?.text]),
      [['reasoning_delta', '\n\n']],
    )

    // Subagent text must not leak into the parent's streaming bubble.
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
    assert.deepEqual(
      toolUse.map((event) => event.type),
      ['tool_started'],
    )
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
          {
            type: 'tool_use',
            id: 'tu_2',
            name: 'Edit',
            input: { file_path: 'a.ts', old_string: 'x\ny', new_string: 'x\ny\nz' },
          },
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
    assert.deepEqual(
      toolResult.map((event) => event.type),
      ['tool_output'],
    )
    assert.equal(toolResult[0]?.payload?.output, 'file-a')
    assert.equal('parentToolUseId' in (toolResult[0]?.payload ?? {}), false, 'top-level tools carry no parent link')
    assert.equal('subagentLane' in (toolUse[0]?.payload ?? {}), false, 'ordinary tools are not subagent lanes')

    // The Task call that spawns a subagent is the header of a lane.
    const laneHeader = mapSdkMessage(state, {
      type: 'assistant',
      session_id: 'sdk-session-1',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'task_1',
            name: 'Task',
            input: { subagent_type: 'Explore', description: 'map the router' },
          },
        ],
      },
    })
    assert.deepEqual(
      laneHeader.map((event) => event.type),
      ['tool_started'],
    )
    assert.equal(laneHeader[0]?.payload?.toolCallId, 'task_1')
    assert.equal(laneHeader[0]?.payload?.subagentLane, true)
    assert.equal(laneHeader[0]?.payload?.subagentType, 'Explore')
    assert.equal('parentToolUseId' in (laneHeader[0]?.payload ?? {}), false, 'a top-level lane header has no parent')

    // The subagent's own tool calls are emitted, linked to that lane, with both a
    // start and a completion so the lane shows live status and derivable elapsed
    // time. The lane header closes on its own top-level tool_result.
    const childStart = mapSdkMessage(state, {
      type: 'assistant',
      session_id: 'sdk-session-1',
      parent_tool_use_id: 'task_1',
      message: { content: [{ type: 'tool_use', id: 'child_1', name: 'Grep', input: { pattern: 'router' } }] },
    })
    assert.deepEqual(
      childStart.map((event) => event.type),
      ['tool_started'],
    )
    assert.equal(childStart[0]?.payload?.parentToolUseId, 'task_1')
    assert.equal(childStart[0]?.payload?.toolCallId, 'child_1')
    assert.equal(childStart[0]?.payload?.turnId, 'turn_9', 'child rows stay attached to the turn that owns the lane')

    const childOutput = mapSdkMessage(state, {
      type: 'user',
      session_id: 'sdk-session-1',
      parent_tool_use_id: 'task_1',
      message: { content: [{ type: 'tool_result', tool_use_id: 'child_1', content: '12 matches' }] },
    })
    assert.deepEqual(
      childOutput.map((event) => event.type),
      ['tool_output'],
    )
    assert.equal(childOutput[0]?.payload?.parentToolUseId, 'task_1')
    assert.equal(childOutput[0]?.payload?.output, '12 matches')

    // A nested spawn is both a child row and a lane of its own.
    const nestedLane = mapSdkMessage(state, {
      type: 'assistant',
      session_id: 'sdk-session-1',
      parent_tool_use_id: 'task_1',
      message: {
        content: [{ type: 'tool_use', id: 'task_2', name: 'Agent', input: { description: 'check the tests' } }],
      },
    })
    assert.equal(nestedLane[0]?.payload?.parentToolUseId, 'task_1')
    assert.equal(nestedLane[0]?.payload?.subagentLane, true)
    assert.equal('subagentType' in (nestedLane[0]?.payload ?? {}), false, 'no invented type when the call names none')

    const success = mapSdkMessage(state, {
      total_cost_usd: 0.025,
      duration_ms: 1234,
      num_turns: 2,
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'sdk-session-1',
      usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 },
    })
    assert.deepEqual(
      success.map((event) => event.type),
      ['usage_updated', 'turn_completed'],
    )
    assert.equal(success[0]?.payload?.inputTokens, 15)
    assert.equal(success[0]?.payload?.cachedInputTokens, 5, 'the share the prompt cache served')
    assert.equal(success[0]?.payload?.outputTokens, 3)
    assert.deepEqual(success[1]?.payload, { turnId: 'turn_9', costUsd: 0.025, durationMs: 1234, numTurns: 2 })

    const failure = mapSdkMessage(state, {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: 'sdk-session-1',
      usage: { input_tokens: 1, output_tokens: 1 },
      errors: ['boom'],
    })
    assert.deepEqual(
      failure.map((event) => event.type),
      ['usage_updated', 'turn_failed'],
    )
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
    assert.deepEqual(
      startEvents.map((event) => event.type),
      ['session_started', 'session_ready'],
    )
    assert.equal(startEvents[0]?.payload?.resumed, false)

    const events = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    assert.deepEqual(
      events.map((event) => event.type),
      [
        'turn_started',
        'session_updated',
        'content_delta',
        'tool_started',
        'tool_output',
        'usage_updated',
        'turn_completed',
      ],
    )
    const options = capturedOptions[0]
    assert.equal(options?.cwd, '/tmp/workspace')
    assert.equal(options?.pathToClaudeCodeExecutable, '/fake/bin/claude')
    assert.equal(options?.model, 'sonnet')
    assert.equal(options?.includePartialMessages, true)
    // No preset named: no permission mode is pinned, so the CLI's own default applies.
    assert.equal(options?.permissionMode, undefined)
    assert.equal(options?.allowDangerouslySkipPermissions, undefined)
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
      context.emit({ type: 'system', subtype: 'init', session_id: 's-img' })
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
        }),
      ) as AsyncIterable<ConversationEvent>,
    )
    assert.deepEqual(
      events.map((event) => event.type),
      ['turn_started', 'session_updated', 'usage_updated', 'turn_completed'],
    )
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
      adapter.startSession({ ...SESSION_INPUT, resumeSessionId: 'previous-1' }) as ConversationEvent[],
    )
    assert.equal(startEvents[0]?.payload?.providerSessionId, 'previous-1')
    assert.equal(startEvents[0]?.payload?.resumed, true)

    const events = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    assert.equal(capturedOptions[0]?.resume, 'previous-1')
    const updated = events.find((event) => event.type === 'session_updated')
    assert.equal(updated?.payload?.providerSessionId, 'resumed-2')
  }

  // A tool the person refused comes back from the CLI as an ordinary error
  // result; it must read as declined, not as a command that failed.
  async function testDeniedToolResultReadsAsDeclined(): Promise<void> {
    const { adapter } = createAdapter(async (_message, context) => {
      const canUseTool = context.options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal?: AbortSignal; toolUseID: string },
      ) => Promise<Record<string, unknown>>
      await canUseTool('Bash', { command: 'rm -rf build' }, { signal: undefined, toolUseID: 'toolu_denied' })
      context.emit({
        type: 'user',
        session_id: 'declined',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_denied', is_error: true, content: 'Denied.' }],
        },
      })
      context.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'declined' })
    })
    await collect(adapter.startSession(SESSION_INPUT) as ConversationEvent[])
    const events = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>, (event) => {
      if (event.type === 'approval_requested')
        void collect(
          adapter.resolveApproval({
            ...SESSION_INPUT,
            turnId: 'turn_1',
            requestId: String(event.payload?.requestId),
            approved: false,
          }) as ConversationEvent[],
        )
    })
    assert.equal(events.find((event) => event.type === 'tool_output')?.payload?.status, 'declined')
    adapter.disposeAll()
  }

  async function testCanUseToolApprovalFlowApproveAndDeny(): Promise<void> {
    const decisions: Array<Record<string, unknown>> = []
    const { adapter } = createAdapter(async (userMessage, context) => {
      const canUseTool = context.options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal?: AbortSignal },
      ) => Promise<Record<string, unknown>>
      const text = (userMessage.message as { content: string }).content
      const permissionContext = {
        signal: undefined,
        agentID: 'research-agent',
        defaultToNo: true,
        suppressAlwaysAllowRule: true,
      }
      const decision = await canUseTool('Bash', { command: `run ${text}` }, permissionContext)
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
          assert.equal(event.payload?.originAgentId, 'research-agent')
          assert.equal(event.payload?.defaultToNo, true)
          assert.equal(event.payload?.suppressAlwaysAllowRule, true)
          void collect(
            adapter.resolveApproval({
              ...SESSION_INPUT,
              turnId: 'turn_1',
              requestId: 'approval_1',
              approved: true,
            }) as ConversationEvent[],
          )
        }
      },
    )
    assert.deepEqual(
      approvedEvents.map((event) => event.type),
      ['turn_started', 'approval_requested', 'approval_resolved', 'usage_updated', 'turn_completed'],
    )
    assert.equal(approvedEvents[2]?.payload?.approved, true)
    assert.equal(decisions[0]?.behavior, 'allow')

    // Deny (second turn on the same live session).
    const deniedEvents = await collect(
      adapter.sendTurn(
        turnInput({ turnId: 'turn_2', requestId: 'approval_2', message: 'second' }),
      ) as AsyncIterable<ConversationEvent>,
      (event) => {
        if (event.type === 'approval_requested') {
          void collect(
            adapter.resolveApproval({
              ...SESSION_INPUT,
              turnId: 'turn_2',
              requestId: 'approval_2',
              approved: false,
            }) as ConversationEvent[],
          )
        }
      },
    )
    assert.equal(deniedEvents.find((event) => event.type === 'approval_resolved')?.payload?.approved, false)
    assert.equal(decisions[1]?.behavior, 'deny')
  }

  // Under bypass the CLI still asks for some subagent calls (an Explore
  // agent's compound Bash); those answer themselves. A safety check marked
  // defaultToNo and an ask forced by the user's own rule still show a card.
  async function testBypassAnswersSubagentAsksButKeepsSafetyAndRuleAsks(): Promise<void> {
    const decisions: Array<Record<string, unknown>> = []
    const { adapter } = createAdapter(async (_userMessage, context) => {
      const canUseTool = context.options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>
      decisions.push(await canUseTool('Bash', { command: 'cd src; grep -rn x . | head' }, { agentID: 'explore-1' }))
      decisions.push(await canUseTool('Bash', { command: 'rm -rf /' }, { agentID: 'explore-1', defaultToNo: true }))
      decisions.push(
        await canUseTool('Bash', { command: 'git push' }, { matchedAskRule: { source: 'user', toolName: 'Bash' } }),
      )
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })
    await collect(adapter.startSession({ ...SESSION_INPUT, permissionPreset: 'bypass' }) as ConversationEvent[])
    const events = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>, (event) => {
      if (event.type === 'approval_requested')
        void collect(
          adapter.resolveApproval({
            ...SESSION_INPUT,
            turnId: 'turn_1',
            requestId: String(event.payload?.requestId),
            approved: false,
          }) as ConversationEvent[],
        )
    })
    const asked = events.filter((event) => event.type === 'approval_requested')
    assert.deepEqual(
      asked.map((event) => (event.payload?.input as { command?: string })?.command),
      ['rm -rf /', 'git push'],
    )
    assert.deepEqual(
      decisions.map((decision) => decision.behavior),
      ['allow', 'deny', 'deny'],
    )
    adapter.disposeAll()
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
        options: { signal?: AbortSignal },
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
    const events = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>, (event) => {
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
          }) as ConversationEvent[],
        )
      }
    })
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
        options: { signal?: AbortSignal },
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
          adapter2.resolveApproval({
            ...SESSION_INPUT,
            turnId: 'turn_1',
            requestId: 'approval_1',
            approved: false,
          }) as ConversationEvent[],
        )
      }
    })
    assert.equal(dismissed[0]?.behavior, 'deny')
  }

  async function testExitPlanModeBecomesPlanCard(): Promise<void> {
    const decisions: Array<Record<string, unknown>> = []
    const { adapter, permissionModes, capturedOptions } = createAdapter(async (_userMessage, context) => {
      const canUseTool = context.options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal?: AbortSignal },
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
    await collect(adapter.startSession({ ...SESSION_INPUT, permissionPreset: 'bypass' }) as ConversationEvent[])
    const events = await collect(
      adapter.sendTurn(turnInput({ mode: 'plan' })) as AsyncIterable<ConversationEvent>,
      (event) => {
        if (event.type === 'approval_requested') {
          assert.equal(event.payload?.kind, 'plan')
          assert.equal(event.payload?.plan, '## Plan\n1. Do the thing')
          void collect(
            adapter.resolveApproval({
              ...SESSION_INPUT,
              turnId: 'turn_1',
              requestId: 'approval_1',
              approved: true,
            }) as ConversationEvent[],
          )
        }
      },
    )
    assert.equal(
      events.some((event) => event.type === 'approval_resolved' && event.payload?.approved === true),
      true,
    )
    assert.equal(decisions[0]?.behavior, 'allow')
    assert.equal(capturedOptions[0]?.permissionMode, 'plan')
    assert.equal(capturedOptions[0]?.allowDangerouslySkipPermissions, true, 'plan mode keeps the bypass opt-in')
    assert.deepEqual(
      permissionModes,
      ['bypassPermissions'],
      'accepting a plan restores the prior native permission mode',
    )
    await collect(
      adapter.sendTurn(
        turnInput({ turnId: 'turn_2', requestId: 'approval_2', mode: 'default' }),
      ) as AsyncIterable<ConversationEvent>,
      (event) => {
        if (event.type === 'approval_requested')
          void collect(
            adapter.resolveApproval({
              ...SESSION_INPUT,
              turnId: 'turn_2',
              requestId: 'approval_2',
              approved: false,
            }) as ConversationEvent[],
          )
      },
    )
    assert.equal(capturedOptions.length, 1, 'accepting the plan also exits the adapter mode without respawning')
    adapter.disposeAll()
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
    await collect(bypass.adapter.startSession({ ...SESSION_INPUT, permissionPreset: 'bypass' }) as ConversationEvent[])
    await collect(bypass.adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    assert.equal(bypass.capturedOptions[0]?.permissionMode, 'bypassPermissions')
    assert.equal(bypass.capturedOptions[0]?.allowDangerouslySkipPermissions, true)

    // `none` pins no mode at all: the SDK leaves the CLI on its own configured
    // default, rather than on 'default', which a user's settings can override.
    const none = createAdapter((_userMessage, context) => emitResult(context))
    await collect(none.adapter.startSession({ ...SESSION_INPUT, permissionPreset: 'none' }) as ConversationEvent[])
    await collect(none.adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    assert.equal(none.capturedOptions[0]?.permissionMode, undefined)
    assert.equal(none.capturedOptions[0]?.allowDangerouslySkipPermissions, undefined)

    // Plan mode is a separate toggle, not a preset: it spawns 'plan' under either.
    for (const permissionPreset of ['none', 'bypass'] as const) {
      const plan = createAdapter((_userMessage, context) => emitResult(context))
      await collect(plan.adapter.startSession({ ...SESSION_INPUT, permissionPreset }) as ConversationEvent[])
      await collect(plan.adapter.sendTurn(turnInput({ mode: 'plan' })) as AsyncIterable<ConversationEvent>)
      assert.equal(plan.capturedOptions[0]?.permissionMode, 'plan', permissionPreset)
      plan.adapter.disposeAll()
    }
  }

  // The preset is switchable while the session runs. Neither preset is a mode
  // the control channel can deliver — bypass comes only from the spawn flag, and
  // `none` is the absence of one — so a change is recorded and the child
  // replaced: the next turn respawns into the same provider session.
  async function testLivePermissionPresetReachesTheChildAndSurvivesRespawn(): Promise<void> {
    const emitResult = (context: FakeQueryContext): void => {
      context.emit({ type: 'system', subtype: 'init', session_id: 'cursor-1', model: 'sonnet' })
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'cursor-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }

    const live = createAdapter((_userMessage, context) => emitResult(context), {
      onSetPermissionMode: () => {
        throw new Error('a preset change must not ride the control channel')
      },
    })
    await collect(live.adapter.startSession(SESSION_INPUT) as ConversationEvent[])

    // Before the child exists the preset is only recorded — it lands at spawn,
    // including the bypass opt-in flag the SDK requires.
    assert.deepEqual(await live.adapter.setPermissionPreset({ ...SESSION_INPUT, permissionPreset: 'bypass' }), {
      ok: true,
    })
    await collect(live.adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    assert.equal(live.capturedOptions[0]?.permissionMode, 'bypassPermissions')
    assert.equal(live.capturedOptions[0]?.allowDangerouslySkipPermissions, true)

    // Choosing the preset already in force leaves the child alone.
    assert.deepEqual(await live.adapter.setPermissionPreset({ ...SESSION_INPUT, permissionPreset: 'bypass' }), {
      ok: true,
    })
    assert.equal(live.adapter.listLiveSessions()[0]?.hasChildProcess, true)

    // Leaving bypass on an idle child replaces it, so no bypass grant lingers.
    assert.deepEqual(await live.adapter.setPermissionPreset({ ...SESSION_INPUT, permissionPreset: 'none' }), {
      ok: true,
    })
    assert.deepEqual(live.permissionModes, [])
    assert.equal(live.adapter.listLiveSessions()[0]?.hasChildProcess, false)
    await collect(
      live.adapter.sendTurn(
        turnInput({ turnId: 'turn_2', requestId: 'approval_2' }),
      ) as AsyncIterable<ConversationEvent>,
    )
    assert.equal(live.capturedOptions[1]?.permissionMode, undefined)
    assert.equal(live.capturedOptions[1]?.allowDangerouslySkipPermissions, undefined)
    assert.equal(live.capturedOptions[1]?.resume, 'cursor-1')

    // The recorded preset carries into the respawn after idle disposal.
    assert.equal(live.adapter.disposeChildProcess('conv_1'), true)
    await collect(
      live.adapter.sendTurn(
        turnInput({ turnId: 'turn_3', requestId: 'approval_3' }),
      ) as AsyncIterable<ConversationEvent>,
    )
    assert.equal(live.capturedOptions[2]?.permissionMode, undefined)
    assert.equal(live.capturedOptions[2]?.allowDangerouslySkipPermissions, undefined)

    assert.deepEqual(
      await live.adapter.setPermissionPreset({
        ...SESSION_INPUT,
        sessionId: 'conv_missing',
        permissionPreset: 'bypass',
      }),
      {
        ok: false,
        message: 'Conversation session is not registered with the Claude provider.',
      },
    )
    await collect(live.adapter.stopSession(SESSION_INPUT) as ConversationEvent[])
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
      },
    )
    assert.deepEqual(
      events.map((event) => event.type),
      ['turn_started', 'content_delta'],
    )
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
    assert.deepEqual(
      events.map((event) => event.type),
      ['turn_started', 'turn_failed'],
    )
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
    const events = await collect(
      adapter.sendTurn(turnInput({ turnId: 'turn_2', requestId: 'approval_2' })) as AsyncIterable<ConversationEvent>,
    )
    assert.equal(events.at(-1)?.type, 'turn_completed')
    assert.equal(capturedOptions.length, 2)
    assert.equal(capturedOptions[1]?.resume, 'cursor-1')

    const closed = await collect(adapter.stopSession(SESSION_INPUT) as ConversationEvent[])
    assert.deepEqual(
      closed.map((event) => event.type),
      ['session_closed'],
    )
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
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      // The child keeps working: only once the test has confirmed the turn
      // resolved does a post-`result` tool fire (a background subagent completed).
      await gate.promise
      const canUseTool = context.options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal?: AbortSignal },
      ) => Promise<Record<string, unknown>>
      decisions.push(await canUseTool('Bash', { command: 'ls' }, {}))
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })

    const continuation: ConversationEvent[] = []
    await collect(
      adapter.startSession({
        ...SESSION_INPUT,
        onSessionEvent: (event) => continuation.push(event),
      }) as ConversationEvent[],
    )

    const turnEvents = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    assert.equal(turnEvents.at(-1)?.type, 'turn_completed', 'the turn resolves at `result`, freeing the composer')

    // Now let the post-`result` tool fire; its approval card must reach the
    // continuation channel rather than being denied.
    gate.resolve()
    const requestId = await waitForContinuationEvent(continuation, 'approval_requested')
    assert.deepEqual(
      continuation.slice(0, 2).map((event) => event.type),
      ['turn_started', 'approval_requested'],
      'the continuation announces its turn before the approval card',
    )
    const contTurnId = continuation[0]?.payload?.turnId
    assert.equal(typeof contTurnId === 'string' && contTurnId.includes('_cont_'), true)

    await collect(
      adapter.resolveApproval({
        ...SESSION_INPUT,
        turnId: contTurnId as string,
        requestId,
        approved: true,
      }) as ConversationEvent[],
    )
    await waitForContinuationEvent(continuation, 'turn_completed')

    assert.equal(decisions[0]?.behavior, 'allow', 'the post-`result` tool was approved, not auto-denied')
    assert.deepEqual(
      continuation.map((event) => event.type),
      ['turn_started', 'approval_requested', 'approval_resolved', 'usage_updated', 'turn_completed'],
    )
    assert.equal(continuation.find((event) => event.type === 'approval_resolved')?.payload?.approved, true)

    await collect(adapter.stopSession(SESSION_INPUT) as ConversationEvent[])
  }

  // A background subagent that finishes after the turn's `result` — the fan-out
  // case from 1777. Its tool calls must reach the runtime over the session
  // channel instead of being dropped with the closed turn.
  async function testSubagentEventsAfterResultRideTheContinuationChannel(): Promise<void> {
    const gate = createDeferred<void>()
    const { adapter } = createAdapter(async (_userMessage, context) => {
      context.emit({
        type: 'assistant',
        session_id: 's1',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: 'task_1', name: 'Task', input: { subagent_type: 'Explore' } }] },
      })
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      await gate.promise
      context.emit({
        type: 'assistant',
        session_id: 's1',
        parent_tool_use_id: 'task_1',
        message: { content: [{ type: 'tool_use', id: 'child_1', name: 'Read', input: { file_path: 'a.ts' } }] },
      })
      context.emit({
        type: 'user',
        session_id: 's1',
        parent_tool_use_id: 'task_1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'child_1', content: 'file body' }] },
      })
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })

    const continuation: ConversationEvent[] = []
    await collect(
      adapter.startSession({
        ...SESSION_INPUT,
        onSessionEvent: (event) => continuation.push(event),
      }) as ConversationEvent[],
    )

    const turnEvents = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    const lane = turnEvents.find((event) => event.type === 'tool_started')
    assert.equal(lane?.payload?.subagentLane, true, 'the lane header rides the turn that spawned it')

    gate.resolve()
    await waitForContinuationEvent(continuation, 'turn_completed')
    assert.deepEqual(
      continuation.map((event) => event.type),
      ['turn_started', 'tool_started', 'tool_output', 'usage_updated', 'turn_completed'],
    )
    const childStart = continuation[1]
    assert.equal(
      childStart?.payload?.parentToolUseId,
      'task_1',
      'the child stays linked to its lane after the turn closed',
    )
    assert.equal(childStart?.payload?.tool, 'Read')
    assert.equal(continuation[2]?.payload?.parentToolUseId, 'task_1')
    const contTurnId = continuation[0]?.payload?.turnId
    assert.equal(typeof contTurnId === 'string' && contTurnId.includes('_cont_'), true)
    assert.equal(
      childStart?.payload?.turnId,
      contTurnId,
      'child events carry the continuation turn the runtime mirrors',
    )

    await collect(adapter.stopSession(SESSION_INPUT) as ConversationEvent[])
  }

  // 1775, the exact acceptance case: an AskUserQuestion raised AFTER the turn's
  // `result` — the model resuming once its background subagents report — must
  // surface as a real question card and route the human's answer back into the
  // tool, not be auto-denied with "Conversation turn is not active."
  async function testAskUserQuestionAfterResultReachesTheUserAndAnswersFlowBack(): Promise<void> {
    const gate = createDeferred<void>()
    const decisions: Array<Record<string, unknown>> = []
    const { adapter } = createAdapter(async (_userMessage, context) => {
      // A fan-out turn: the Task lane opens, then the turn resolves at `result`.
      context.emit({
        type: 'assistant',
        session_id: 's1',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: 'task_1', name: 'Task', input: { subagent_type: 'Explore' } }] },
      })
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      await gate.promise
      // The subagent finished and the model came back with a question for the user.
      const canUseTool = context.options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal?: AbortSignal },
      ) => Promise<Record<string, unknown>>
      decisions.push(
        await canUseTool(
          'AskUserQuestion',
          {
            questions: [
              {
                question: 'Ship the fix or keep digging?',
                header: 'Next',
                multiSelect: false,
                options: [
                  { label: 'Ship it', description: 'The repro is covered' },
                  { label: 'Keep digging', description: 'Two lanes disagree' },
                ],
              },
            ],
          },
          {},
        ),
      )
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })

    const continuation: ConversationEvent[] = []
    await collect(
      adapter.startSession({
        ...SESSION_INPUT,
        onSessionEvent: (event) => continuation.push(event),
      }) as ConversationEvent[],
    )
    const turnEvents = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    assert.equal(turnEvents.at(-1)?.type, 'turn_completed', 'the fan-out turn resolves at `result`')

    gate.resolve()
    const requestId = await waitForContinuationEvent(continuation, 'approval_requested')
    const card = continuation.find((event) => event.type === 'approval_requested')
    assert.equal(card?.payload?.kind, 'question', 'it arrives as a question card, not a bare permission prompt')
    assert.equal(card?.payload?.summary, 'Ship the fix or keep digging?')
    assert.equal((card?.payload?.questions as unknown[]).length, 1)
    const contTurnId = continuation[0]?.payload?.turnId
    assert.equal(
      card?.payload?.turnId,
      contTurnId,
      'the card is stamped with the continuation turn the runtime mirrors',
    )

    await collect(
      adapter.resolveApproval({
        ...SESSION_INPUT,
        turnId: contTurnId as string,
        requestId,
        approved: true,
        answers: { 'Ship the fix or keep digging?': 'Ship it' },
      }) as ConversationEvent[],
    )
    await waitForContinuationEvent(continuation, 'turn_completed')

    assert.equal(decisions[0]?.behavior, 'allow', 'the post-`result` question was answered, not auto-denied')
    assert.deepEqual(
      (decisions[0]?.updatedInput as Record<string, unknown>).answers,
      { 'Ship the fix or keep digging?': 'Ship it' },
      "the human's answer reaches the tool",
    )
    assert.deepEqual(continuation.find((event) => event.type === 'approval_resolved')?.payload?.answers, {
      'Ship the fix or keep digging?': 'Ship it',
    })

    await collect(adapter.stopSession(SESSION_INPUT) as ConversationEvent[])
  }

  // 1798, the provider half: a send that lands while a continuation turn is open
  // takes the session's turn over. The queue it replaces has to be ended, or its
  // drain awaits an iterator nobody will ever end — leaking one `for await` per
  // occurrence and stranding the permission that continuation was holding.
  async function testTurnTakeoverEndsTheReplacedContinuationQueue(): Promise<void> {
    const gate = createDeferred<void>()
    const decisions: Array<Record<string, unknown>> = []
    let turns = 0
    const { adapter } = createAdapter(async (_userMessage, context) => {
      turns += 1
      context.emit({ type: 'system', subtype: 'init', session_id: 'cursor-1', model: 'sonnet' })
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'cursor-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      if (turns > 1) return
      // The first turn's child keeps working: a post-`result` tool opens a
      // continuation turn and blocks on its approval.
      await gate.promise
      const canUseTool = context.options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal?: AbortSignal },
      ) => Promise<Record<string, unknown>>
      decisions.push(await canUseTool('Bash', { command: 'ls' }, {}))
    })

    const continuation: ConversationEvent[] = []
    await collect(
      adapter.startSession({
        ...SESSION_INPUT,
        onSessionEvent: (event) => continuation.push(event),
      }) as ConversationEvent[],
    )
    await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)

    gate.resolve()
    await waitForContinuationEvent(continuation, 'approval_requested')

    // The composer flushes a queued message into that window (the runtime guard
    // normally rejects this; the provider must survive it either way).
    const takeover = collect(
      adapter.sendTurn(turnInput({ turnId: 'turn_2', requestId: 'approval_2' })) as AsyncIterable<ConversationEvent>,
    )
    const events = await withTimeout(
      takeover,
      'the replaced continuation queue was left open: its drain never ended, so its permission never resolved',
    )

    assert.equal(events.at(-1)?.type, 'turn_completed', 'the taking-over turn streams and completes normally')
    assert.equal(
      decisions[0]?.behavior,
      'deny',
      'the permission the replaced turn was holding is resolved, not stranded',
    )
    assert.deepEqual(
      continuation.map((event) => event.type),
      ['turn_started', 'approval_requested'],
      'the ended queue forwards nothing further to the session channel',
    )

    await collect(adapter.stopSession(SESSION_INPUT) as ConversationEvent[])
  }

  // Bypass is a preset the SDK control channel cannot deliver — Claude Code reads
  // it from the flag its child was spawned with. Switching to it on a session
  // spawned without it respawns the child with `resume` instead of surfacing a
  // refusal the user cannot act on.
  async function testSwitchingToBypassMidSessionRespawnsInsteadOfBeingRefused(): Promise<void> {
    const emitResult = (context: FakeQueryContext): void => {
      context.emit({ type: 'system', subtype: 'init', session_id: 'cursor-1', model: 'sonnet' })
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'cursor-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }

    // Idle session: the preset is recorded, the child disposed, and the next turn
    // respawns into the same provider session with the bypass opt-in.
    const idle = createAdapter((_userMessage, context) => emitResult(context), {
      onSetPermissionMode: () => {
        throw new Error('setPermissionMode must not be attempted for bypass')
      },
    })
    await collect(idle.adapter.startSession(SESSION_INPUT) as ConversationEvent[])
    await collect(idle.adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    assert.equal(idle.capturedOptions[0]?.permissionMode, undefined)
    assert.equal(idle.adapter.listLiveSessions()[0]?.hasChildProcess, true)

    assert.deepEqual(await idle.adapter.setPermissionPreset({ ...SESSION_INPUT, permissionPreset: 'bypass' }), {
      ok: true,
    })
    assert.deepEqual(idle.permissionModes, [], 'the child is replaced, not asked')
    const disposed = idle.adapter.listLiveSessions()[0]
    assert.equal(disposed?.hasChildProcess, false, 'the query is disposed so the next turn respawns')
    assert.equal(disposed?.providerSessionId, 'cursor-1', 'the resume cursor is kept')

    await collect(
      idle.adapter.sendTurn(
        turnInput({ turnId: 'turn_2', requestId: 'approval_2' }),
      ) as AsyncIterable<ConversationEvent>,
    )
    assert.equal(idle.capturedOptions[1]?.permissionMode, 'bypassPermissions')
    assert.equal(idle.capturedOptions[1]?.allowDangerouslySkipPermissions, true)
    assert.equal(idle.capturedOptions[1]?.resume, 'cursor-1', 'the conversation continues in the same provider session')
    await collect(idle.adapter.stopSession(SESSION_INPUT) as ConversationEvent[])

    // Mid-turn: disposing would drop the reply being streamed, so the preset is
    // recorded with a plain sentence about when it starts, and the swap happens at
    // the next turn.
    const gate = createDeferred<void>()
    const inFlight = createAdapter(async (_userMessage, context) => {
      context.emit({ type: 'system', subtype: 'init', session_id: 'cursor-1', model: 'sonnet' })
      context.emit({
        type: 'stream_event',
        session_id: 'cursor-1',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'thinking' } },
      })
      await gate.promise
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'cursor-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })
    await collect(inFlight.adapter.startSession({ ...SESSION_INPUT, permissionPreset: 'none' }) as ConversationEvent[])
    const streamed: ConversationEvent[] = []
    const streaming = (async () => {
      for await (const event of inFlight.adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
        streamed.push(event)
    })()
    await waitForContinuationEvent(streamed, 'content_delta')

    assert.deepEqual(await inFlight.adapter.setPermissionPreset({ ...SESSION_INPUT, permissionPreset: 'bypass' }), {
      ok: true,
      notice:
        'The new permissions start with your next message — this reply finishes under the permissions it started with.',
    })
    assert.equal(inFlight.adapter.listLiveSessions()[0]?.hasChildProcess, true, 'the streaming reply is not torn down')

    gate.resolve()
    await withTimeout(streaming, 'the in-flight turn never completed')
    assert.equal(streamed.at(-1)?.type, 'turn_completed')

    await collect(
      inFlight.adapter.sendTurn(
        turnInput({ turnId: 'turn_2', requestId: 'approval_2' }),
      ) as AsyncIterable<ConversationEvent>,
    )
    assert.equal(
      inFlight.capturedOptions[1]?.permissionMode,
      'bypassPermissions',
      'the next turn runs under the recorded preset',
    )
    assert.equal(inFlight.capturedOptions[1]?.allowDangerouslySkipPermissions, true)
    assert.equal(inFlight.capturedOptions[1]?.resume, 'cursor-1')
    await collect(inFlight.adapter.stopSession(SESSION_INPUT) as ConversationEvent[])
  }

  async function withTimeout<T>(promise: Promise<T>, message: string, ms = 2000): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((resolvePromise) => {
      resolve = resolvePromise
    })
    return { promise, resolve }
  }

  async function waitForContinuationEvent(
    events: ConversationEvent[],
    type: ConversationEvent['type'],
  ): Promise<string> {
    // A wall-clock deadline, not a tick count: under full-suite load the fake
    // query's first event can take longer than a few hundred turns of the loop.
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const match = events.find((event) => event.type === type)
      if (match) return typeof match.payload?.requestId === 'string' ? match.payload.requestId : ''
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`Timed out waiting for continuation ${type}`)
  }

  const suiteRun = main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })

  await suiteRun
})

function mapperState() {
  return {
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    providerSessionId: 'native' as string | null,
    turn: { turnId: 'turn_1' } as { turnId: string } | null,
    queryCostUsd: 0,
    declinedToolUseIds: new Set<string>(),
  }
}

test('a Claude result that reports no cost does not make the next turn report the whole session', () => {
  const state = mapperState()
  const result = (total: number, crashed = false) =>
    mapSdkMessage(state, {
      type: 'result',
      subtype: crashed ? 'error_during_execution' : 'success',
      is_error: crashed,
      session_id: 'native',
      total_cost_usd: total,
    }).find((event) => event.type === 'turn_completed')?.payload?.costUsd
  assert.equal(result(0.25), 0.25)
  // A crash reports a zero total; it is not a restarted count.
  state.turn = { turnId: 'turn_2' }
  result(0, true)
  state.turn = { turnId: 'turn_3' }
  assert.equal(Number((result(0.3) as number).toFixed(6)), 0.05)
})

test('each Claude turn reports the cost it added, not the running total of the live query', () => {
  const state = mapperState()
  const result = (total: number) =>
    mapSdkMessage(state, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'native',
      total_cost_usd: total,
    }).find((event) => event.type === 'turn_completed')?.payload?.costUsd
  assert.equal(result(0.25), 0.25)
  state.turn = { turnId: 'turn_2' }
  assert.equal(Number((result(0.4) as number).toFixed(6)), 0.15)
  // A running total that restarts (a fresh child, or /clear) is all new cost.
  state.turn = { turnId: 'turn_3' }
  assert.equal(result(0.1), 0.1)
})

test('each main-chain request reports its prompt cache as it starts: size, lifetime and whether anything was cached', () => {
  const state = mapperState()
  const start = (usage: Record<string, unknown>, parent?: string) =>
    mapSdkMessage(state, {
      type: 'stream_event',
      session_id: 'native',
      parent_tool_use_id: parent ?? null,
      event: { type: 'message_start', message: { usage } },
    })
  const [first] = start({
    input_tokens: 40,
    cache_creation_input_tokens: 2_000,
    cache_read_input_tokens: 300_000,
    cache_creation: { ephemeral_1h_input_tokens: 2_000, ephemeral_5m_input_tokens: 0 },
  })
  assert.equal(first?.type, 'usage_updated')
  assert.deepEqual(first?.payload, {
    turnId: 'turn_1',
    promptCache: { ttl: '1h', cached: true, recacheTokens: 302_040 },
  })
  // A request that only reads says nothing of the lifetime: it carries over.
  const [readOnly] = start({ input_tokens: 10, cache_read_input_tokens: 302_040 })
  assert.deepEqual(readOnly?.payload?.promptCache, { ttl: '1h', cached: true, recacheTokens: 302_050 })
  // Nothing cached at all is a cold request.
  const [uncached] = start({ input_tokens: 9_000 })
  assert.deepEqual(uncached?.payload?.promptCache, { ttl: '1h', cached: false, recacheTokens: 9_000 })
  // A subagent's requests are its own conversation, with its own cache.
  assert.deepEqual(start({ input_tokens: 5, cache_read_input_tokens: 5 }, 'task_1'), [])
  // And a start with no usage reports nothing.
  assert.deepEqual(start({}), [])
})

test('a Claude compact boundary marks the transcript with what triggered it and the context it freed', () => {
  const state = mapperState()
  const [compacted] = mapSdkMessage(state, {
    type: 'system',
    subtype: 'compact_boundary',
    session_id: 'native',
    compact_metadata: { trigger: 'auto', pre_tokens: 182_000, post_tokens: 24_000, preserved_segment: {} },
  })
  assert.equal(compacted?.type, 'context_compacted')
  assert.deepEqual(compacted?.payload, { turnId: 'turn_1', trigger: 'auto', preTokens: 182_000, postTokens: 24_000 })
  // A boundary the CLI stamps without its metadata still marks the seam.
  const [bare] = mapSdkMessage(state, { type: 'system', subtype: 'compact_boundary', session_id: 'native' })
  assert.deepEqual(bare?.payload, { turnId: 'turn_1' })
  // Other system messages carry nothing the transcript shows.
  assert.deepEqual(mapSdkMessage(state, { type: 'system', subtype: 'status', session_id: 'native' }), [])
})

test('Claude shell results say whether a command was declined, stopped or exited non-zero', () => {
  const state = mapperState()
  const output = (id: string, block: Record<string, unknown>, structured?: Record<string, unknown>) =>
    mapSdkMessage(state, {
      type: 'user',
      session_id: 'native',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, ...block }] },
      ...(structured ? { tool_use_result: structured } : {}),
    }).find((event) => event.type === 'tool_output')?.payload

  assert.deepEqual(
    [output('ok', { content: 'done', is_error: false }, { stdout: 'done', stderr: '', interrupted: false })].map(
      (payload) => [payload?.status, payload?.exitCode],
    ),
    [['ok', 0]],
  )
  const failed = output('failed', { content: 'Exit code 2\nnpm ERR! missing script', is_error: true })
  assert.equal(failed?.status, 'error')
  assert.equal(failed?.exitCode, 2)
  const stopped = output(
    'stopped',
    { content: 'partial', is_error: false },
    { stdout: 'partial', stderr: '', interrupted: true },
  )
  assert.equal(stopped?.status, 'stopped')
  state.declinedToolUseIds.add('declined')
  const declined = output('declined', { content: 'The user denied this tool use in SprintEngine.', is_error: true })
  assert.equal(declined?.status, 'declined')
  assert.equal(declined?.exitCode, undefined)
  assert.equal(state.declinedToolUseIds.size, 0)
  // Other tools keep their plain error status and carry no exit code.
  const read = output('read', { content: 'File does not exist.', is_error: true })
  assert.deepEqual([read?.status, read?.exitCode], ['error', undefined])
})

/** A stand-in SDK whose queries answer every prompt with a result, after an optional delay in loading. */
function skillsHarness(tempDir: string, loadDelayMs = 0) {
  const queries: Record<string, unknown>[] = []
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
    queries.push(params.options)
    const pending: Record<string, unknown>[] = []
    let wake = null as (() => void) | null
    let ended = false
    void (async () => {
      for await (const _message of params.prompt) {
        pending.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'native' })
        wake?.()
      }
    })()
    return {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (!pending.length) await new Promise<void>((resolve) => (wake = resolve))
          while (pending.length) yield pending.shift()!
        }
      },
      interrupt: async () => {
        ended = true
        wake?.()
      },
      setPermissionMode: async () => undefined,
    }
  }
  const loadQuery = async () => {
    await new Promise((resolve) => setTimeout(resolve, loadDelayMs))
    return query
  }
  const adapter = createClaudeAgentProvider({
    loadQuery: loadQuery as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: () => ({ PATH: '/usr/bin' }),
    tempDir,
  })
  return { adapter, queries }
}

async function skillsWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'claude-skill-plugins-'))
  const workspaceRoot = join(root, 'workspace')
  const tempDir = join(root, 'tmp')
  await mkdir(join(workspaceRoot, '.claude', 'skills', 'example'), { recursive: true })
  await mkdir(tempDir)
  await writeFile(join(workspaceRoot, '.claude', 'skills', 'example', 'SKILL.md'), '---\nname: example\n---\nDo it.')
  const turn = (turnId: string): MockAdapterTurnInput => ({
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    workspaceRoot,
    turnId,
    requestId: `approval_${turnId}`,
    message: 'hello',
    skills: ['example'],
  })
  return { root, tempDir, turn }
}

async function drain(stream: AsyncIterable<ConversationEvent> | ConversationEvent[]): Promise<ConversationEvent[]> {
  const events: ConversationEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

test('turns racing to start the Claude child stage one skills plugin and spawn one child', async () => {
  const f = await skillsWorkspace()
  const { adapter, queries } = skillsHarness(f.tempDir, 30)
  try {
    await adapter.startSession(f.turn('turn_1'))
    const first = adapter.sendTurn(f.turn('turn_1'))
    const second = adapter.sendTurn(f.turn('turn_2'))
    await Promise.all([drain(await first), drain(await second)])
    assert.equal(queries.length, 1)
    assert.equal((await readdir(f.tempDir)).length, 1)
  } finally {
    await adapter.disposeAll()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('disposing every Claude child settles only once their skills plugins are removed', async () => {
  const f = await skillsWorkspace()
  const { adapter } = skillsHarness(f.tempDir)
  try {
    await adapter.startSession(f.turn('turn_1'))
    await drain(await adapter.sendTurn(f.turn('turn_1')))
    assert.equal((await readdir(f.tempDir)).length, 1)
    await adapter.disposeAll()
    assert.deepEqual(await readdir(f.tempDir), [])
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('a skills plugin left by a process that is gone is swept, one a live process owns is kept', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-skill-sweep-'))
  try {
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    const folders = {
      // No process can have this id on macOS, Linux or Windows.
      dead: 'sprintengine-claude-skills-99999999-abc',
      live: `sprintengine-claude-skills-${process.ppid}-abc`,
      legacy: 'sprintengine-claude-skills-abc123',
      unrelated: 'other-tool-99999999-abc',
    }
    for (const name of Object.values(folders)) {
      await mkdir(join(tempDir, name, '.claude-plugin'), { recursive: true })
      await utimes(join(tempDir, name), old, old)
    }
    await sweepStaleSkillPlugins(tempDir)
    assert.deepEqual((await readdir(tempDir)).sort(), [folders.live, folders.unrelated].sort())
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

// The sequence Claude Code 2.1 streams for one agent launched in the background
// (recorded from a real run): the launch notice comes back at once, the turn
// ends, and the agent reports its progress and its end through task messages.
test('a background Claude agent keeps its lane open until it reports, then closes it with its answer', () => {
  const state = { ...mapperState(), subagents: new Map() }
  const types = (events: ConversationEvent[]) => events.map((event) => event.type)
  const map = (message: Record<string, unknown>) => mapSdkMessage(state, { session_id: 'native', ...message })

  map({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { subagent_type: 'Explore' } }] },
  })
  const started = map({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task_bg',
    tool_use_id: 'toolu_bg',
    description: 'Count .txt files',
    task_type: 'local_agent',
    subagent_type: 'Explore',
    is_backgrounded: true,
  })
  assert.deepEqual(types(started), ['subagent_status'])
  assert.deepEqual(started[0]?.payload, {
    toolUseId: 'toolu_bg',
    taskId: 'task_bg',
    status: 'running',
    background: true,
    subagentType: 'Explore',
    description: 'Count .txt files',
  })
  assert.equal('turnId' in (started[0]?.payload ?? {}), false, 'an agent outlives its turn, so its status carries none')

  // The launch notice is for the model; the lane waits for the agent.
  const ack = map({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_bg',
          content: [
            { type: 'text', text: 'Async agent launched successfully. (This tool result is internal metadata)' },
          ],
        },
      ],
    },
  })
  assert.deepEqual(ack, [])

  state.turn = null
  const progress = map({
    type: 'system',
    subtype: 'task_progress',
    task_id: 'task_bg',
    tool_use_id: 'toolu_bg',
    description: 'Count .txt files',
    last_tool_name: 'Bash',
    summary: 'Listing the directory',
    usage: { total_tokens: 9287, tool_uses: 1, duration_ms: 6011 },
  })
  assert.equal(progress[0]?.payload?.lastToolName, 'Bash')
  assert.equal(progress[0]?.payload?.progressSummary, 'Listing the directory')
  assert.deepEqual(progress[0]?.payload?.usage, { totalTokens: 9287, toolUses: 1, durationMs: 6011 })

  // The agent's own last words are its answer.
  assert.deepEqual(
    map({
      type: 'assistant',
      parent_tool_use_id: 'toolu_bg',
      message: {
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'There are 2 files.' },
        ],
      },
    }),
    [],
  )
  assert.deepEqual(
    map({ type: 'system', subtype: 'task_updated', task_id: 'task_bg', patch: { status: 'completed', end_time: 42 } }),
    [],
  )
  const finished = map({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task_bg',
    tool_use_id: 'toolu_bg',
    status: 'completed',
    output_file: '/tmp/task_bg.output',
    summary: '2',
    usage: { total_tokens: 10065, tool_uses: 1, duration_ms: 7333 },
  })
  assert.deepEqual(types(finished), ['tool_output', 'subagent_status'])
  assert.equal(finished[0]?.payload?.toolUseId, 'toolu_bg')
  assert.equal(finished[0]?.payload?.output, 'There are 2 files.')
  assert.equal(finished[0]?.payload?.status, 'ok')
  assert.equal(finished[0]?.payload?.backgroundResult, true)
  assert.equal(finished[0]?.payload?.turnId, undefined)
  assert.equal(finished[1]?.payload?.status, 'completed')
  assert.equal(finished[1]?.payload?.endedAt, 42)
  assert.deepEqual(finished[1]?.payload?.usage, { totalTokens: 10065, toolUses: 1, durationMs: 7333 })
  assert.equal(state.subagents.size, 0)
})

test('a foreground Claude agent keeps its own result and background shells are not agents', () => {
  const state = { ...mapperState(), subagents: new Map() }
  const map = (message: Record<string, unknown>) => mapSdkMessage(state, { session_id: 'native', ...message })
  map({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task_fg',
    tool_use_id: 'toolu_fg',
    task_type: 'local_agent',
    is_backgrounded: false,
  })
  const result = map({
    type: 'user',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fg', content: 'Found it in router.ts' }] },
  })
  assert.equal(result[0]?.payload?.output, 'Found it in router.ts')
  const done = map({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task_fg',
    tool_use_id: 'toolu_fg',
    status: 'failed',
    summary: 'Ran out of turns',
  })
  assert.deepEqual(
    done.map((event) => event.type),
    ['subagent_status'],
    'a foreground agent returned its result on its call',
  )
  assert.equal(done[0]?.payload?.status, 'failed')
  assert.equal(done[0]?.payload?.error, 'Ran out of turns')

  assert.deepEqual(
    map({
      type: 'system',
      subtype: 'task_started',
      task_id: 'shell',
      tool_use_id: 'toolu_shell',
      task_type: 'local_bash',
      is_backgrounded: true,
    }),
    [],
  )
  assert.deepEqual(
    map({
      type: 'system',
      subtype: 'task_started',
      task_id: 'watch',
      tool_use_id: 'toolu_watch',
      task_type: 'local_agent',
      ambient: true,
    }),
    [],
  )
})

/**
 * A stand-in SDK driven from the test: every prompt the child reads is
 * recorded, and `emit` plays a message out of the child when the test says so.
 */
function scriptedHarness() {
  const prompts: Record<string, unknown>[] = []
  const spawned: Record<string, unknown>[] = []
  const interrupts: unknown[] = []
  const pending: Record<string, unknown>[] = []
  let wake = null as (() => void) | null
  let ended = false
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
    spawned.push(params.options)
    void (async () => {
      for await (const message of params.prompt) prompts.push(message)
    })()
    return {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (!pending.length) await new Promise<void>((resolve) => (wake = resolve))
          while (pending.length) yield pending.shift()!
        }
      },
      // As the CLI does, the child goes on after an interrupt: it still plays
      // out the tail of the exchange it was stopped in.
      interrupt: async (options?: unknown) => {
        interrupts.push(options)
      },
      setPermissionMode: async () => undefined,
    }
  }
  const adapter = createClaudeAgentProvider({
    loadQuery: (async () => query) as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: () => ({ PATH: '/usr/bin' }),
  })
  const emit = (message: Record<string, unknown>) => {
    pending.push({ session_id: 'native', ...message })
    wake?.()
  }
  const turn = (turnId: string, overrides: Partial<MockAdapterTurnInput> = {}): MockAdapterTurnInput => ({
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    workspaceRoot: '/Users/dev/app',
    turnId,
    requestId: `approval_${turnId}`,
    message: 'hello',
    ...overrides,
  })
  // The id each prompt was sent with, which a result names to say it answered it.
  const uuidOf = (index: number) => String(prompts[index]?.uuid)
  return { adapter, prompts, spawned, interrupts, emit, turn, uuidOf }
}

/** Read a turn's stream in the background, so the test can act between its events. */
function reader(stream: AsyncIterable<ConversationEvent>) {
  const events: ConversationEvent[] = []
  const done = (async () => {
    for await (const event of stream) events.push(event)
  })()
  return { events, done }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
/** Wait for the child to have read `count` prompts: spawning it is several awaits deep. */
async function promptsRead(prompts: unknown[], count: number): Promise<void> {
  for (let attempt = 0; prompts.length < count && attempt < 200; attempt++) await settle()
  assert.equal(prompts.length, count)
}
const textDelta = (text: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
})
const init = { type: 'system', subtype: 'init' }
const success = (extra: Record<string, unknown>) => ({ type: 'result', subtype: 'success', is_error: false, ...extra })
const turnScoped = (events: ConversationEvent[]) =>
  events.filter((event) => event.type !== 'session_updated').map((event) => [event.type, event.payload?.turnId])

/** Start a session and a first turn, and wait for the child to have its message. */
async function running(h: ReturnType<typeof scriptedHarness>, onSessionEvent?: (event: ConversationEvent) => void) {
  await h.adapter.startSession({ ...h.turn('turn_1'), ...(onSessionEvent ? { onSessionEvent } : {}) })
  const first = reader((await h.adapter.sendTurn(h.turn('turn_1'))) as AsyncIterable<ConversationEvent>)
  await promptsRead(h.prompts, 1)
  h.emit(init)
  return first
}

test('a message steered in while a Claude tool runs is folded into the running turn, which ends on its one result', async () => {
  const h = scriptedHarness()
  try {
    const continued: ConversationEvent[] = []
    const first = await running(h, (event) => continued.push(event))
    h.emit({ type: 'assistant', uuid: 'reply-1', message: { content: [{ type: 'text', text: 'Running the tests' }] } })
    h.emit({
      type: 'assistant',
      uuid: 'call-1',
      message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } }] },
    })
    await settle()
    // A different mode would respawn the child on an ordinary send; a steer
    // never does, or the work it redirects would be lost.
    const steered = await h.adapter.steer({ ...h.turn('turn_1', { mode: 'ask' }), message: 'use the staging file' })
    // Going back to before the message lands before the call that is still
    // waiting for its result, not on it.
    assert.deepEqual(steered, { ok: true, providerCursor: { sessionId: 'native', at: 'reply-1' } })
    await promptsRead(h.prompts, 2)
    assert.match(JSON.stringify(h.prompts[1]), /use the staging file/)
    assert.notEqual(h.uuidOf(0), h.uuidOf(1))
    h.emit({
      type: 'user',
      uuid: 'result-1',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
    })
    h.emit(textDelta('Switching to staging'))
    // The CLI takes the message in at the tool round and answers both at once.
    h.emit(success({ user_message_uuids: [h.uuidOf(0), h.uuidOf(1)], total_cost_usd: 0.2 }))
    await first.done

    assert.equal(h.spawned.length, 1, 'the steer reused the running child')
    assert.deepEqual(turnScoped(first.events), [
      ['turn_started', 'turn_1'],
      ['tool_started', 'turn_1'],
      ['tool_output', 'turn_1'],
      ['content_delta', 'turn_1'],
      ['turn_completed', 'turn_1'],
    ])
    assert.equal(first.events.at(-1)?.payload?.costUsd, 0.2)
    // The turn is over, so nothing is steered into it any more, and what the
    // child does next reaches the session channel rather than a closed stream.
    assert.equal((await h.adapter.steer({ ...h.turn('turn_1'), message: 'late' })).ok, false)
    h.emit(textDelta('A background task finished'))
    await settle()
    assert.deepEqual(
      continued.map((event) => event.type),
      ['turn_started', 'content_delta'],
    )
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a message steered in while Claude writes its last reply keeps the turn open for the result that answers it', async () => {
  const h = scriptedHarness()
  try {
    const first = await running(h)
    h.emit(textDelta('Done. '))
    await settle()
    assert.equal((await h.adapter.steer({ ...h.turn('turn_1'), message: 'also add a test' })).ok, true)
    await promptsRead(h.prompts, 2)
    // No tool round was left to take it in: the CLI answers the first message,
    // then starts an exchange of its own for the steered one.
    h.emit(success({ user_message_uuids: [h.uuidOf(0)], queued_turn_count: 0, total_cost_usd: 0.1 }))
    await settle()
    assert.equal(
      first.events.some((event) => event.type === 'turn_completed'),
      false,
      'the first result answers only the first message',
    )
    h.emit(init)
    h.emit(textDelta('Added the test.'))
    h.emit(success({ user_message_uuids: [h.uuidOf(1)], result_index: 1, total_cost_usd: 0.25 }))
    await first.done

    const completed = first.events.filter((event) => event.type === 'turn_completed')
    assert.equal(completed.length, 1)
    assert.equal(completed[0]?.payload?.costUsd, 0.25, 'both exchanges are counted once, at the end')
    assert.equal(
      first.events
        .filter((event) => event.type === 'content_delta')
        .map((event) => event.payload?.text)
        .join(''),
      // The second reply starts a paragraph of its own rather than running on.
      'Done. \n\nAdded the test.',
    )
    assert.ok(first.events.every((event) => event.type === 'session_updated' || event.payload?.turnId === 'turn_1'))
  } finally {
    await h.adapter.disposeAll()
  }
})

test('two messages steered into one Claude turn are answered together, and the turn waits for that', async () => {
  const h = scriptedHarness()
  try {
    const first = await running(h)
    h.emit(textDelta('Done.'))
    await settle()
    assert.equal((await h.adapter.steer({ ...h.turn('turn_1'), message: 'also lint' })).ok, true)
    assert.equal((await h.adapter.steer({ ...h.turn('turn_1'), message: 'and format' })).ok, true)
    await promptsRead(h.prompts, 3)
    h.emit(success({ user_message_uuids: [h.uuidOf(0)], queued_turn_count: 0 }))
    await settle()
    assert.equal(first.events.filter((event) => event.type === 'turn_completed').length, 0)
    // The CLI merges both into one entry and one result, which names only the
    // last of them where it predates the full list.
    h.emit(init)
    h.emit(success({ user_message_uuid: h.uuidOf(2) }))
    await first.done
    assert.equal(first.events.filter((event) => event.type === 'turn_completed').length, 1)
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a Claude turn takes no steer before its own message has reached the child', async () => {
  const h = scriptedHarness()
  try {
    await h.adapter.startSession(h.turn('turn_1'))
    const first = reader((await h.adapter.sendTurn(h.turn('turn_1'))) as AsyncIterable<ConversationEvent>)
    // The child is still being started: there is nothing yet to join.
    assert.deepEqual(await h.adapter.steer({ ...h.turn('turn_1'), message: 'too early' }), {
      ok: false,
      message: 'The agent is not working on that turn any more.',
    })
    await promptsRead(h.prompts, 1)
    assert.equal((await h.adapter.steer({ ...h.turn('turn_9'), message: 'another turn' })).ok, false)
    assert.equal((await h.adapter.steer({ ...h.turn('turn_1'), message: 'now' })).ok, true)
    await promptsRead(h.prompts, 2)
    h.emit(success({ user_message_uuids: [h.uuidOf(0), h.uuidOf(1)] }))
    await first.done
  } finally {
    await h.adapter.disposeAll()
  }
})

test('stopping a Claude turn cancels a steered message the CLI has not taken in yet', async () => {
  const h = scriptedHarness()
  try {
    const first = await running(h)
    h.emit(textDelta('Almost done'))
    await settle()
    assert.equal((await h.adapter.steer({ ...h.turn('turn_1'), message: 'also add a test' })).ok, true)
    const stopped = (await h.adapter.interrupt(h.turn('turn_1'))) as ConversationEvent[]
    await first.done
    assert.deepEqual(h.interrupts, [{ cancelQueued: true }])
    assert.equal(stopped[0]?.type, 'turn_failed')
    assert.equal(stopped[0]?.payload?.reason, 'interrupted')
  } finally {
    await h.adapter.disposeAll()
  }
})

/** What the CLI plays out after an interrupt: the rest of the reply, its note, and a failed result. */
function emitInterruptedTail(h: ReturnType<typeof scriptedHarness>, uuids: string[], totalCostUsd: number) {
  h.emit(textDelta(' 3, 4'))
  h.emit({
    type: 'assistant',
    uuid: 'cut-reply',
    message: { content: [{ type: 'text', text: 'Counting: 1, 2, 3, 4' }] },
  })
  h.emit({
    type: 'user',
    uuid: 'cut-note',
    message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
  })
  h.emit({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    user_message_uuids: uuids,
    usage: { input_tokens: 10, output_tokens: 5 },
    total_cost_usd: totalCostUsd,
  })
}

test('what a stopped Claude exchange still plays out reaches no turn, and its cost goes to the next one', async () => {
  const h = scriptedHarness()
  try {
    const continued: ConversationEvent[] = []
    const first = await running(h, (event) => continued.push(event))
    h.emit(textDelta('Counting: 1, 2,'))
    await settle()
    await h.adapter.interrupt(h.turn('turn_1'))
    await first.done
    emitInterruptedTail(h, [h.uuidOf(0)], 0.011)
    await settle()
    assert.deepEqual(
      continued.filter((event) => event.type !== 'session_updated'),
      [],
      'no continuation turn is opened for the tail',
    )

    const second = reader((await h.adapter.sendTurn(h.turn('turn_2'))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 2)
    h.emit(init)
    h.emit(textDelta('Hi'))
    h.emit(success({ user_message_uuids: [h.uuidOf(1)], total_cost_usd: 0.015 }))
    await second.done
    const completed = second.events.find((event) => event.type === 'turn_completed')
    assert.equal(completed?.payload?.costUsd, 0.015, 'the stopped exchange is paid for by the next turn')
    // The tail still moved the session on: the next turn ends past it.
    assert.deepEqual(completed?.payload?.providerCursor, { sessionId: 'native', at: 'cut-note' })

    const third = reader((await h.adapter.sendTurn(h.turn('turn_3'))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 3)
    h.emit(init)
    h.emit(success({ user_message_uuids: [h.uuidOf(2)], total_cost_usd: 0.02 }))
    await third.done
    const costs = third.events.filter((event) => event.type === 'turn_completed').map((event) => event.payload?.costUsd)
    assert.equal(costs.length, 1)
    assert.ok(Math.abs(Number(costs[0]) - 0.005) < 1e-9, 'and only once')
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a message sent right after a Stop is answered in its own turn, which the stopped result does not end', async () => {
  const h = scriptedHarness()
  try {
    const continued: ConversationEvent[] = []
    const first = await running(h, (event) => continued.push(event))
    h.emit(textDelta('Counting: 1, 2,'))
    await settle()
    // Stop and send: the new message is on its way before the CLI has played
    // out what it was stopped in.
    await h.adapter.interrupt(h.turn('turn_1'))
    await first.done
    const second = reader((await h.adapter.sendTurn(h.turn('turn_2'))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 2)
    emitInterruptedTail(h, [h.uuidOf(0)], 0.011)
    await settle()
    assert.deepEqual(turnScoped(second.events), [['turn_started', 'turn_2']], 'the new turn is still open')

    h.emit(init)
    h.emit(textDelta('BANANA'))
    h.emit(success({ user_message_uuids: [h.uuidOf(1)], total_cost_usd: 0.02 }))
    await second.done
    assert.deepEqual(turnScoped(second.events), [
      ['turn_started', 'turn_2'],
      ['content_delta', 'turn_2'],
      ['turn_completed', 'turn_2'],
    ])
    assert.equal(second.events.find((event) => event.type === 'content_delta')?.payload?.text, 'BANANA')
    assert.equal(second.events.at(-1)?.payload?.costUsd, 0.02)
    assert.deepEqual(
      continued.filter((event) => event.type !== 'session_updated'),
      [],
    )
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a Stop after a message steered into the last reply leaves no stray turn and no failed session', async () => {
  const h = scriptedHarness()
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'claude-stop-runtime-'))
  const runtime = new ConversationRuntime({
    adapters: [h.adapter],
    getProviderById: () => undefined,
    secretStore: { getStatus: async () => ({ ok: false, message: 'unused' }) },
  })
  try {
    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: CLAUDE_AGENT_PROVIDER_ID,
      modelId: 'sonnet',
    })
    assert.ok(started.ok)
    const sessionId = started.session.sessionId
    const events: ConversationEvent[] = []
    runtime.onEvent((event) => events.push(event))
    const sent = runtime.sendTurn({ sessionId, message: 'count to ten' })
    await promptsRead(h.prompts, 1)
    h.emit(init)
    h.emit(textDelta('Counting: 1, 2,'))
    await settle()
    // A steer settles with the stream it joined.
    const steered = runtime.sendTurn({ sessionId, message: 'in French', steer: true })
    await promptsRead(h.prompts, 2)
    assert.equal((await runtime.interrupt({ sessionId })).ok, true)
    assert.equal((await sent).ok, true)
    assert.equal((await steered).ok, true)
    // The CLI names both messages as the ones its stopped exchange answered.
    emitInterruptedTail(h, [h.uuidOf(0), h.uuidOf(1)], 0.011)
    await settle()
    await settle()
    const turnIds = new Set(events.map((event) => event.payload?.turnId).filter(Boolean))
    assert.equal(
      Array.from(turnIds).some((turnId) => String(turnId).includes('_cont_')),
      false,
      'no continuation turn',
    )
    assert.deepEqual(
      events.filter((event) => event.type === 'turn_failed').map((event) => event.payload?.reason),
      ['interrupted'],
    )
    const listed = runtime.listSessions({ workspaceId: 'workspace' })
    assert.ok(listed.ok)
    assert.equal(listed.sessions[0]?.status, 'ready')
  } finally {
    await runtime.shutdown().catch(() => undefined)
    await h.adapter.disposeAll()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('a failed Claude result that names only messages nothing waits on does not end the running turn', async () => {
  const h = scriptedHarness()
  try {
    const first = await running(h)
    await h.adapter.interrupt(h.turn('turn_1'))
    await first.done
    const second = reader((await h.adapter.sendTurn(h.turn('turn_2'))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 2)
    // The new exchange has begun before the stopped one's result arrived.
    h.emit(init)
    h.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, user_message_uuids: [h.uuidOf(0)] })
    await settle()
    assert.equal(
      second.events.some((event) => event.type === 'turn_failed' || event.type === 'turn_completed'),
      false,
    )
    h.emit(success({ user_message_uuids: [h.uuidOf(1)] }))
    await second.done
    assert.equal(second.events.at(-1)?.type, 'turn_completed')
  } finally {
    await h.adapter.disposeAll()
  }
})

// ── Slash commands ──────────────────────────────────────────────────────────

/** The text the child was handed for prompt `index`. */
const promptText = (h: ReturnType<typeof scriptedHarness>, index: number) =>
  (h.prompts[index]?.message as { content: unknown } | undefined)?.content

test('a slash command reaches Claude Code as the message itself, with no skill note ahead of it', async () => {
  const h = scriptedHarness()
  try {
    const skills = { skills: ['acme:deploy'] }
    await h.adapter.startSession(h.turn('turn_1'))
    const command = reader(
      (await h.adapter.sendTurn(
        h.turn('turn_1', { ...skills, message: '/review HEAD~1' }),
      )) as AsyncIterable<ConversationEvent>,
    )
    await promptsRead(h.prompts, 1)
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
    await command.done
    const prose = reader(
      (await h.adapter.sendTurn(
        h.turn('turn_2', { ...skills, message: 'now ship it' }),
      )) as AsyncIterable<ConversationEvent>,
    )
    await promptsRead(h.prompts, 2)
    h.emit(success({ user_message_uuids: [h.uuidOf(1)] }))
    await prose.done
    assert.equal(promptText(h, 0), '/review HEAD~1')
    assert.equal(promptText(h, 1), 'Use the attached skills: acme:deploy.\n\nnow ship it')
    // The skills are loaded for the command all the same.
    assert.deepEqual(h.spawned[0]?.skills, ['acme:deploy'])
  } finally {
    await h.adapter.disposeAll()
  }
})

test('images sent with a slash command go ahead of it, so the command is the last block Claude Code reads', () => {
  const image = { mediaType: 'image/png', dataBase64: 'AAAA' } as never
  const command = buildUserMessageContent('/review this screenshot', [image]) as Array<{ type: string }>
  assert.deepEqual(
    command.map((block) => block.type),
    ['image', 'text'],
  )
  const prose = buildUserMessageContent('what is /tmp for?', [image]) as Array<{ type: string }>
  assert.deepEqual(
    prose.map((block) => block.type),
    ['text', 'image'],
  )
})

/** A turn whose message is `message`, answered by `reply` once the child has it. */
async function commandTurn(message: string, reply: (h: ReturnType<typeof scriptedHarness>) => void) {
  const h = scriptedHarness()
  try {
    await h.adapter.startSession(h.turn('turn_1'))
    const turn = reader((await h.adapter.sendTurn(h.turn('turn_1', { message }))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 1)
    h.emit(init)
    reply(h)
    await turn.done
    return turn.events.filter((event) => event.type !== 'session_updated')
  } finally {
    await h.adapter.disposeAll()
  }
}

// The shapes Claude Code 2.1.284 sends for `/context`: an assistant message of
// its own making that nothing streams, then a result that repeats the output.
const CONTEXT_OUTPUT = '## Context Usage\n\n**Tokens:** 9.7k / 1m (1%)'
const localTwin = (command: string, text: string) => ({
  type: 'assistant',
  uuid: 'twin-1',
  parent_tool_use_id: null,
  local_command_source: `<local-command-stdout>${text}</local-command-stdout>`,
  local_command_run: { command, args: '' },
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] },
})

test('what a local command printed becomes the turn’s output, shown once', async () => {
  const events = await commandTurn('/context', (h) => {
    h.emit(localTwin('context', CONTEXT_OUTPUT))
    h.emit(
      success({ user_message_uuids: [h.uuidOf(0)], local_command: 'context', result: CONTEXT_OUTPUT, num_turns: 0 }),
    )
  })
  assert.deepEqual(
    events.map((event) => event.type),
    ['turn_started', 'command_output', 'turn_completed'],
  )
  assert.deepEqual(events[1]?.payload, { turnId: 'turn_1', command: 'context', output: CONTEXT_OUTPUT })
})

test('a local command reported only on its result, or as system output, still shows', async () => {
  const onResult = await commandTurn('/usage', (h) => {
    h.emit(success({ user_message_uuids: [h.uuidOf(0)], local_command: 'usage', result: 'Current session: 6% used' }))
  })
  assert.deepEqual(
    onResult.filter((event) => event.type === 'command_output').map((event) => event.payload),
    [{ turnId: 'turn_1', command: 'usage', output: 'Current session: 6% used' }],
  )
  const asSystem = await commandTurn('/usage', (h) => {
    h.emit({
      type: 'system',
      subtype: 'local_command_output',
      content: '<local-command-stdout>6% used</local-command-stdout>',
    })
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
  })
  assert.deepEqual(
    asSystem.filter((event) => event.type === 'command_output').map((event) => event.payload?.output),
    ['6% used'],
  )
})

test('/compact still marks the compaction, and what it printed is left to that divider', async () => {
  const events = await commandTurn('/compact', (h) => {
    h.emit({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 180000, post_tokens: 20000 },
    })
    h.emit(localTwin('compact', 'Compacted'))
    h.emit(success({ user_message_uuids: [h.uuidOf(0)], local_command: 'compact', result: 'Compacted' }))
  })
  assert.deepEqual(
    events.map((event) => event.type),
    ['turn_started', 'context_compacted', 'turn_completed'],
  )
  assert.deepEqual(events[1]?.payload, { turnId: 'turn_1', trigger: 'manual', preTokens: 180000, postTokens: 20000 })
})

test('a /clear typed into the chat leaves a note that the model no longer has what came before', async () => {
  const events = await commandTurn('/clear', (h) => {
    h.emit({ type: 'conversation_reset', new_conversation_id: 'fresh', uuid: 'reset-1' })
    h.emit({ ...init, session_id: 'fresh' })
    h.emit(success({ user_message_uuids: [h.uuidOf(0)], session_id: 'fresh' }))
  })
  const note = events.find((event) => event.type === 'command_output')
  assert.equal(note?.payload?.command, 'clear')
  assert.equal(note?.payload?.adapterNote, true)
  assert.equal(events.at(-1)?.type, 'turn_completed')
})

test("a live session's init publishes the folder's command list when it changed, and a push replaces it", async () => {
  const cwd = '/Users/dev/live-commands'
  publishConversationCommands({
    cli: 'claude-code',
    cwd,
    commands: [{ name: 'compact', description: 'Free up context', source: 'cli' }],
  })
  const published: string[][] = []
  const stop = onConversationCommandsChanged((catalog) => {
    if (catalog.cwd === cwd) published.push(catalog.commands.map((command) => command.name))
  })
  const h = scriptedHarness()
  try {
    await h.adapter.startSession(h.turn('turn_1', { workspaceRoot: cwd }))
    const turn = reader(
      (await h.adapter.sendTurn(h.turn('turn_1', { workspaceRoot: cwd }))) as AsyncIterable<ConversationEvent>,
    )
    await promptsRead(h.prompts, 1)
    const liveInit = { ...init, slash_commands: ['compact', 'mcp__docs__summarise', 'color'], skills: [] }
    h.emit(liveInit)
    // Every exchange repeats its init; the same names are not news.
    h.emit(liveInit)
    h.emit({
      type: 'system',
      subtype: 'commands_changed',
      commands: [
        { name: 'compact', description: 'Free up context', argumentHint: '', builtin: true },
        { name: 'fresh', description: 'New', argumentHint: '' },
      ],
    })
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
    await turn.done
    assert.deepEqual(published, [
      ['compact', 'mcp__docs__summarise'],
      ['compact', 'fresh'],
    ])
    // The known row kept its description through the init.
    assert.equal(conversationCommandsFor('claude-code', cwd).commands[0]?.description, 'Free up context')
    // Nothing of it went into the transcript.
    assert.equal(
      turn.events.some((event) => JSON.stringify(event).includes('mcp__docs__summarise')),
      false,
    )
  } finally {
    stop()
    await h.adapter.disposeAll()
  }
})

test("a chat with skills attached keeps its own command list out of the folder's", async () => {
  const cwd = '/Users/dev/attached-commands'
  const published: unknown[] = []
  const stop = onConversationCommandsChanged((catalog) => {
    if (catalog.cwd === cwd) published.push(catalog)
  })
  const h = scriptedHarness()
  try {
    const input = h.turn('turn_1', { workspaceRoot: cwd, skills: ['acme:deploy'] })
    await h.adapter.startSession(input)
    const turn = reader((await h.adapter.sendTurn(input)) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 1)
    h.emit({ ...init, slash_commands: ['acme:deploy'] })
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
    await turn.done
    assert.deepEqual(published, [])
  } finally {
    stop()
    await h.adapter.disposeAll()
  }
})
