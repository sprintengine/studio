import { expect, test } from 'vitest'
import {
  createCodexConversationProvider,
  codexPermissionPolicy,
  codexChildEnv,
  probeCodexConversationCommands,
} from './codex-conversation-provider'
import { CodexRpcError, type CodexRpcOptions, type RpcMessage } from './codex-json-rpc'
import type { ConversationEvent } from '../../shared/conversation-runtime'
import { conversationCommandsFor } from '../conversation-commands/registry'

function fixture(
  setup: { env?: NodeJS.ProcessEnv; account?: unknown; resume?: (params: unknown) => unknown; skills?: unknown } = {},
) {
  let connection!: CodexRpcOptions
  const calls: { method: string; params: unknown }[] = []
  const replies: { id: string | number; result: unknown }[] = []
  let resolveStarted!: () => void
  let started = new Promise<void>((resolve) => {
    resolveStarted = resolve
  })
  const transports = { created: 0, closed: 0 }
  const adapter = createCodexConversationProvider({
    resolveExecutable: async () => '/usr/bin/codex',
    buildEnv: async () => setup.env ?? {},
    createTransport(options) {
      connection = options
      transports.created++
      return {
        pid: 123,
        async request(method, params) {
          calls.push({ method, params })
          if (method === 'account/read')
            return setup.account ?? { requiresOpenaiAuth: true, account: { type: 'chatgpt' } }
          if (method === 'thread/resume' && setup.resume) return setup.resume(params)
          if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'native-thread' } }
          if (method === 'turn/start') {
            resolveStarted()
            return { turn: { id: 'native-turn' } }
          }
          if (method === 'skills/list') return setup.skills ?? { data: [] }
          if (method === 'thread/compact/start') {
            resolveStarted()
            return {}
          }
          if (method === 'turn/interrupt')
            await options.onMessage({
              method: 'turn/completed',
              params: { threadId: 'native-thread', turn: { status: 'interrupted' } },
            })
          return {}
        },
        notify: (method, params) => calls.push({ method, params }),
        respond: (id, result) => replies.push({ id, result }),
        reject: (id, message) => replies.push({ id, result: { error: message } }),
        close() {
          transports.closed++
        },
      }
    },
  })
  const input = {
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'codex-agent',
    modelId: 'gpt-6-sol',
    workspaceRoot: '/workspace/app',
    permissionPreset: 'none' as 'none' | 'bypass',
  }
  const events: ConversationEvent[] = []
  const send = async (reasoningEffort?: string, mode?: 'default' | 'ask' | 'plan', message = 'Make a change.') => {
    for await (const event of (await adapter.sendTurn({
      ...input,
      turnId: 'turn',
      requestId: 'request',
      message,
      reasoningEffort,
      mode,
    })) as AsyncIterable<ConversationEvent>)
      events.push(event)
  }
  const message = (value: RpcMessage) => connection.onMessage(value)
  return {
    adapter,
    input,
    events,
    send,
    get started() {
      return started
    },
    // Re-arms `started` for a later turn.
    nextTurn() {
      started = new Promise<void>((resolve) => {
        resolveStarted = resolve
      })
    },
    transports,
    message,
    calls,
    replies,
    crash: () => connection.onClose(new Error('Child process exited.')),
  }
}

test('command output streams only its new text and closes without repeating it', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  const item = { id: 'command', type: 'commandExecution', command: 'build' }
  await f.message({ method: 'item/started', params: { item } })
  const chunks = ['first-line\n', 'x'.repeat(1024 * 1024), '\nlast-line']
  for (const delta of chunks)
    await f.message({ method: 'item/commandExecution/outputDelta', params: { itemId: 'command', delta } })
  await f.message({ method: 'item/completed', params: { item: { ...item, status: 'completed', exitCode: 0 } } })
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  const outputs = f.events.filter((event) => event.type === 'tool_output').map((event) => event.payload!)
  expect(outputs.slice(0, 3).map((payload) => payload.output)).toEqual(chunks)
  expect(outputs.slice(0, 3).every((payload) => payload.outputMode === 'append' && payload.partial === true)).toBe(true)
  expect(outputs.at(-1)).toMatchObject({
    output: '',
    outputMode: 'append',
    totalBytes: Buffer.byteLength(chunks.join('')),
    exitCode: 0,
  })
  expect(outputs.at(-1)!.partial).toBeUndefined()
})

test('streams text and command output, preserves nonzero exit as an ordinary tool result', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send('high')
  await f.started
  expect(f.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({ effort: 'high' })
  await f.message({
    method: 'item/agentMessage/delta',
    params: { threadId: 'native-thread', itemId: 'text', delta: 'Hello' },
  })
  await f.message({ method: 'item/completed', params: { item: { id: 'text', type: 'agentMessage', text: 'Hello' } } })
  await f.message({
    method: 'item/started',
    params: { item: { id: 'command', type: 'commandExecution', command: 'rg missing', cwd: '/workspace/app' } },
  })
  await f.message({ method: 'item/commandExecution/outputDelta', params: { itemId: 'command', delta: 'No matches' } })
  await f.message({
    method: 'item/completed',
    params: {
      item: {
        id: 'command',
        type: 'commandExecution',
        command: 'rg missing',
        status: 'completed',
        exitCode: 1,
        aggregatedOutput: 'No matches',
      },
    },
  })
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  expect(f.events.filter((event) => event.type === 'content_delta')).toHaveLength(1)
  expect(f.events.filter((event) => event.type === 'tool_output').map((event) => event.payload)).toMatchObject([
    { partial: true },
    { status: 'ok', exitCode: 1 },
  ])
  expect(f.calls.map((call) => call.method).slice(0, 4)).toEqual([
    'initialize',
    'initialized',
    'account/read',
    'thread/start',
  ])
  // `none` sends no override anywhere: Codex runs on its own configured default.
  for (const call of f.calls.filter((entry) => ['thread/start', 'turn/start'].includes(entry.method))) {
    expect(call.params).not.toHaveProperty('approvalPolicy')
    expect(call.params).not.toHaveProperty('sandbox')
    expect(call.params).not.toHaveProperty('sandboxPolicy')
  }
})

test('command and patch approvals stay pending until individually answered', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  await f.message({
    method: 'item/started',
    params: {
      item: { type: 'fileChange', id: 'patch', changes: [{ path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new\n' }] },
    },
  })
  await f.message({
    id: 21,
    method: 'item/commandExecution/requestApproval',
    params: { itemId: 'command', command: 'npm test' },
  })
  await f.message({ id: 'patch-approval', method: 'item/fileChange/requestApproval', params: { itemId: 'patch' } })
  expect(f.replies).toHaveLength(0)
  await f.adapter.resolveApproval({ ...f.input, turnId: 'turn', requestId: 'turn:patch-approval', approved: true })
  await f.adapter.resolveApproval({ ...f.input, turnId: 'turn', requestId: 'turn:21', approved: false })
  expect(f.replies).toEqual([
    { id: 'patch-approval', result: { decision: 'accept' } },
    { id: 21, result: { decision: 'decline' } },
  ])
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  expect(
    f.events.find((event) => event.type === 'approval_requested' && event.payload?.action === 'Edit')?.payload?.input,
  ).toMatchObject({ edits: [{ path: 'src/a.ts', patch: expect.stringContaining('+new') }] })
})

test('a patch approval that arrives before its item waits for the diff', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  await f.message({ id: 'early', method: 'item/fileChange/requestApproval', params: { itemId: 'patch' } })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.events.some((event) => event.type === 'approval_requested')).toBe(false)
  await f.message({
    method: 'item/started',
    params: {
      item: { type: 'fileChange', id: 'patch', changes: [{ path: 'src/b.ts', diff: '@@ -1 +1 @@\n-old\n+new\n' }] },
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  const approval = f.events.find((event) => event.type === 'approval_requested')
  expect(approval?.payload?.input).toMatchObject({
    edits: [{ path: 'src/b.ts', patch: expect.stringContaining('+new') }],
  })
  await f.adapter.resolveApproval({ ...f.input, turnId: 'turn', requestId: 'turn:early', approved: true })
  expect(f.replies).toEqual([{ id: 'early', result: { decision: 'accept' } }])
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
})

test('interrupt uses native turn identity and ends the event stream', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  await f.message({ method: 'turn/started', params: { turn: { id: 'native-turn' } } })
  await f.adapter.interrupt(f.input)
  await done
  expect(f.calls.find((call) => call.method === 'turn/interrupt')?.params).toEqual({
    threadId: 'native-thread',
    turnId: 'native-turn',
  })
  expect(f.events.at(-1)?.payload?.interrupted).toBe(true)
})

test('resume uses a stored thread cursor and crash terminates a running turn', async () => {
  const f = fixture()
  await f.adapter.startSession({ ...f.input, resumeSessionId: 'previous-thread' })
  const done = f.send()
  await f.started
  f.crash()
  await done
  expect(f.calls.find((call) => call.method === 'thread/resume')?.params).toMatchObject({ threadId: 'previous-thread' })
  expect(f.events.at(-1)?.type).toBe('turn_failed')
  expect(f.adapter.listLiveSessions?.()[0]?.hasChildProcess).toBe(false)
})

test('unowned threads and unknown server requests never get an implicit approval', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  await f.message({
    id: 1,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'other-thread', command: 'danger' },
  })
  await f.message({ id: 2, method: 'item/permissions/requestApproval', params: {} })
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  expect(f.replies).toHaveLength(2)
  expect(f.replies.every((reply) => typeof (reply.result as { error: string }).error === 'string')).toBe(true)
  expect(f.events.some((event) => event.type === 'approval_requested')).toBe(false)
})

test('bypass is YOLO — never ask, full access — and none sends no override', () => {
  expect(codexPermissionPolicy('bypass')).toEqual({
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    sandboxPolicy: { type: 'dangerFullAccess' },
  })
  expect(codexPermissionPolicy('none')).toEqual({})
  expect(codexPermissionPolicy()).toEqual({})
})

test('a bypass session sends never and full access on thread start and every turn', async () => {
  const f = fixture()
  await f.adapter.startSession({ ...f.input, permissionPreset: 'bypass' })
  const done = f.send()
  await f.started
  expect(f.calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  })
  expect(f.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
  })
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await done
})

test('interrupt during connection setup cancels before the native turn starts', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const iterator = (
    (await f.adapter.sendTurn({
      ...f.input,
      turnId: 'turn',
      requestId: 'request',
      message: 'hello',
    })) as AsyncIterable<ConversationEvent>
  )[Symbol.asyncIterator]()
  expect((await iterator.next()).value?.type).toBe('turn_started')
  await f.adapter.interrupt(f.input)
  const remaining: ConversationEvent[] = []
  for (;;) {
    const next = await iterator.next()
    if (next.done) break
    remaining.push(next.value)
  }
  expect(remaining.at(-1)?.payload?.interrupted).toBe(true)
  expect(f.calls.some((call) => call.method === 'turn/start')).toBe(false)
  f.adapter.disposeAll?.()
})

test('stopping during executable discovery never spawns a late orphan process', async () => {
  let resolve!: (value: string) => void
  const executable = new Promise<string>((done) => {
    resolve = done
  })
  let spawned = false
  const adapter = createCodexConversationProvider({
    resolveExecutable: () => executable,
    buildEnv: async () => ({}),
    createTransport() {
      spawned = true
      throw new Error('Unexpected spawn')
    },
  })
  const input = {
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'codex-agent',
    modelId: 'gpt-6-sol',
    workspaceRoot: '/workspace/app',
  }
  await adapter.startSession(input)
  const iterator = (
    (await adapter.sendTurn({
      ...input,
      turnId: 'turn',
      requestId: 'request',
      message: 'hello',
    })) as AsyncIterable<ConversationEvent>
  )[Symbol.asyncIterator]()
  await iterator.next()
  await adapter.stopSession(input)
  resolve('/usr/bin/codex')
  await new Promise((done) => setImmediate(done))
  expect(spawned).toBe(false)
  expect(adapter.listLiveSessions?.()).toEqual([])
})

test('leaving bypass reconnects, so the thread resumes with no override instead of keeping full access', async () => {
  const f = fixture()
  f.input.permissionPreset = 'bypass'
  await f.adapter.startSession(f.input)
  const first = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await first
  expect(f.transports).toEqual({ created: 1, closed: 0 })

  expect(await f.adapter.setPermissionPreset?.({ ...f.input, permissionPreset: 'none' })).toEqual({ ok: true })
  expect(f.transports.closed).toBe(1)
  expect(f.adapter.listLiveSessions?.()[0]?.hasChildProcess).toBe(false)

  f.input.permissionPreset = 'none'
  f.calls.length = 0
  f.nextTurn()
  const second = f.send()
  await f.started
  expect(f.transports.created).toBe(2)
  const resume = f.calls.find((call) => call.method === 'thread/resume')
  expect(resume?.params).toMatchObject({ threadId: 'native-thread' })
  expect(resume?.params).not.toHaveProperty('approvalPolicy')
  expect(resume?.params).not.toHaveProperty('sandbox')
  const turn = f.calls.find((call) => call.method === 'turn/start')
  expect(turn?.params).not.toHaveProperty('approvalPolicy')
  expect(turn?.params).not.toHaveProperty('sandboxPolicy')
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await second
})

test('entering bypass keeps the connection: the next turn carries the override itself', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const first = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await first
  expect(await f.adapter.setPermissionPreset?.({ ...f.input, permissionPreset: 'bypass' })).toEqual({ ok: true })
  expect(f.transports).toEqual({ created: 1, closed: 0 })
})

test('a preset change waits for the running Codex turn to finish', async () => {
  const f = fixture()
  f.input.permissionPreset = 'bypass'
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  expect(await f.adapter.setPermissionPreset?.({ ...f.input, permissionPreset: 'none' })).toMatchObject({ ok: false })
  expect(f.transports.closed).toBe(0)
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await done
})

test('Ask is read-only without escalation even when the session preset bypasses approval', async () => {
  const f = fixture()
  await f.adapter.startSession({ ...f.input, permissionPreset: 'bypass' })
  const done = f.send(undefined, 'ask')
  await f.started
  expect(f.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  })
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await done
})

test('OpenAI API keys never reach the Codex child, so a chat cannot bill API usage', async () => {
  expect(
    codexChildEnv(
      {
        OPENAI_API_KEY: 'sk-test',
        CODEX_API_KEY: 'ck-test',
        OPENAI_BASE_URL: 'https://example.com',
        PATH: '/usr/bin',
        ELECTRON_RUN_AS_NODE: '1',
      },
      { sessionId: 'session' },
    ),
  ).toEqual({ PATH: '/usr/bin', SPRINTENGINE_CONVERSATION_SESSION_ID: 'session' })
  // A key alone is not a Codex login: the person is sent to codex login.
  const signedOut = fixture({
    env: { OPENAI_API_KEY: 'sk-test' },
    account: { requiresOpenaiAuth: true, account: null },
  })
  await signedOut.adapter.startSession(signedOut.input)
  await signedOut.send()
  expect(String(signedOut.events.at(-1)?.payload?.message)).toContain('not logged in')
})

test('a thread Codex no longer has continues in a new thread with the conversation replayed', async () => {
  const f = fixture({
    resume: () => {
      throw new CodexRpcError('thread not found')
    },
  })
  await f.adapter.startSession({
    ...f.input,
    resumeSessionId: 'lost-thread',
    fallbackHistory: [
      { role: 'user', content: 'persisted question' },
      { role: 'assistant', content: 'persisted answer' },
    ],
  })
  const done = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  expect(f.calls.map((call) => call.method)).toContain('thread/resume')
  const update = f.events.find((event) => event.type === 'session_updated')
  expect(update?.payload?.providerSessionId).toBe('native-thread')
  expect(String(update?.payload?.notice)).toContain('could not be resumed')
  const prompt = JSON.stringify(f.calls.find((call) => call.method === 'turn/start')?.params)
  expect(prompt).toContain('persisted question')
  expect(prompt).toContain('Make a change.')
  expect(f.events.at(-1)?.type).toBe('turn_completed')
})

test('a resume Codex refuses for now fails the turn and keeps the thread to resume next time', async () => {
  let busy = true
  const f = fixture({
    resume: () => {
      if (busy) throw new CodexRpcError('thread is busy with another turn; rate limit reached')
      return { thread: { id: 'kept-thread' } }
    },
  })
  await f.adapter.startSession({ ...f.input, resumeSessionId: 'kept-thread' })
  // Falling back to a new thread would start the turn and wait on it.
  expect(await Promise.race([f.send().then(() => 'failed'), f.started.then(() => 'started')])).toBe('failed')
  expect(f.calls.map((call) => call.method)).not.toContain('thread/start')
  expect(f.events.at(-1)).toMatchObject({ type: 'turn_failed' })
  expect(f.events.some((event) => event.type === 'session_updated')).toBe(false)
  busy = false
  const done = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  const resumes = f.calls.filter((call) => call.method === 'thread/resume')
  expect(resumes.map((call) => (call.params as { threadId?: string }).threadId)).toEqual(['kept-thread', 'kept-thread'])
  expect(f.calls.map((call) => call.method)).not.toContain('thread/start')
})

test('a resume that is never answered fails the turn instead of dropping the thread', async () => {
  const f = fixture({
    resume: () => {
      throw new Error('Codex thread/resume timed out.')
    },
  })
  await f.adapter.startSession({ ...f.input, resumeSessionId: 'slow-thread' })
  await f.send()
  expect(f.calls.map((call) => call.method)).not.toContain('thread/start')
  expect(f.events.at(-1)).toMatchObject({ type: 'turn_failed' })
})

test('a model switch rides the next turn without a reconnect, and the running turn keeps its model', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  expect(f.adapter.capabilities?.liveModelSwitch).toBe(true)
  const first = f.send()
  await f.started
  expect(await f.adapter.setModel?.({ ...f.input, nextModelId: 'gpt-6-luna' })).toMatchObject({
    ok: true,
    notice: expect.stringContaining('next message'),
  })
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await first

  // The runtime hands every turn the session's current model.
  f.input.modelId = 'gpt-6-luna'
  f.calls.length = 0
  f.nextTurn()
  const second = f.send()
  await f.started
  expect(f.transports).toEqual({ created: 1, closed: 0 })
  expect(f.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({ model: 'gpt-6-luna' })
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await second

  // The CLI's own default row passes no model at all.
  expect(await f.adapter.setModel?.({ ...f.input, nextModelId: 'default' })).toEqual({ ok: true })
  f.input.modelId = 'default'
  f.calls.length = 0
  f.nextTurn()
  const third = f.send()
  await f.started
  expect(f.calls.find((call) => call.method === 'turn/start')?.params).not.toHaveProperty('model')
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await third
})

const names = (cwd: string) => conversationCommandsFor('codex', cwd).commands.map((command) => command.name)

test('Codex offers /compact as soon as a chat starts, and its skills once the app-server connects', async () => {
  const skills = {
    data: [
      { cwd: '/workspace/skills', skills: [{ name: 'release-notes', description: 'Release notes', enabled: true }] },
    ],
  }
  const f = fixture({ skills })
  f.input.workspaceRoot = '/workspace/skills'
  await f.adapter.startSession(f.input)
  expect(names('/workspace/skills')).toEqual(['compact'])
  // A stand-in, not an answer: the folder's skills are still due to be asked for.
  expect(conversationCommandsFor('codex', '/workspace/skills').fetchedAt).toBe(0)
  const done = f.send()
  await f.started
  await expect.poll(() => names('/workspace/skills')).toEqual(['compact', 'release-notes'])
  expect(conversationCommandsFor('codex', '/workspace/skills').commands[1]).toMatchObject({
    insertText: '$release-notes ',
    source: 'skill',
  })
  expect(f.calls.find((call) => call.method === 'skills/list')?.params).toEqual({ cwds: ['/workspace/skills'] })
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  // A change on disk is announced outside any turn, and the list is read again from disk.
  skills.data[0].skills.push({ name: 'changelog', description: 'Changelogs', enabled: true })
  await f.message({ method: 'skills/changed', params: {} })
  await expect.poll(() => names('/workspace/skills')).toEqual(['compact', 'release-notes', 'changelog'])
  expect(f.calls.filter((call) => call.method === 'skills/list').at(-1)?.params).toEqual({
    cwds: ['/workspace/skills'],
    forceReload: true,
  })
  expect(f.events.at(-1)?.type).toBe('turn_completed')
})

test('/compact at the start of a message compacts the thread natively instead of sending it as a turn', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const first = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await first
  f.nextTurn()
  f.events.length = 0
  const compacting = f.send(undefined, undefined, '/compact')
  await f.started
  expect(f.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
  expect(f.calls.at(-1)).toEqual({ method: 'thread/compact/start', params: { threadId: 'native-thread' } })
  await f.message({ method: 'turn/started', params: { threadId: 'native-thread', turn: { id: 'compact-turn' } } })
  await f.message({ method: 'item/started', params: { item: { id: 'summary', type: 'contextCompaction' } } })
  await f.message({ method: 'item/completed', params: { item: { id: 'summary', type: 'contextCompaction' } } })
  await f.message({ method: 'turn/completed', params: { turn: { id: 'compact-turn', status: 'completed' } } })
  await compacting
  expect(f.events.map((event) => [event.type, event.payload?.turnId, event.payload?.trigger])).toEqual([
    ['turn_started', 'turn', undefined],
    ['context_compacted', 'turn', 'manual'],
    ['turn_completed', 'turn', undefined],
  ])
})

test('Codex marks a compaction it makes on its own mid-turn as automatic', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  await f.message({ method: 'item/completed', params: { item: { id: 'summary', type: 'contextCompaction' } } })
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  expect(f.events.find((event) => event.type === 'context_compacted')?.payload).toMatchObject({ trigger: 'auto' })
})

test('/compact with instructions, or before anything was said, is refused without reaching Codex', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  await f.send(undefined, undefined, '/compact keep the API notes')
  expect(f.events.at(-1)).toMatchObject({
    type: 'turn_failed',
    payload: { message: 'Send /compact on its own: Codex compacts the conversation without instructions or images.' },
  })
  await f.send(undefined, undefined, '/compact')
  expect(f.events.at(-1)).toMatchObject({
    type: 'turn_failed',
    payload: { message: 'There is no conversation to compact yet.' },
  })
  expect(f.calls.some((call) => call.method === 'turn/start' || call.method === 'thread/compact/start')).toBe(false)
})

test('Codex lists a folder before any chat there has started from an app-server that opens no thread', async () => {
  const calls: string[] = []
  let closed = false
  const commands = await probeCodexConversationCommands(
    { cwd: '/workspace/probe' },
    {
      resolveExecutable: async () => '/usr/bin/codex',
      buildEnv: async () => ({}),
      createTransport: () => ({
        pid: 1,
        async request(method) {
          calls.push(method)
          return method === 'skills/list'
            ? {
                data: [
                  {
                    cwd: '/workspace/probe',
                    skills: [{ name: 'release-notes', description: 'Release notes', enabled: true }],
                  },
                ],
              }
            : {}
        },
        notify: (method) => calls.push(method),
        respond: () => undefined,
        reject: () => undefined,
        close: () => (closed = true),
      }),
    },
  )
  expect(commands.map((command) => command.name)).toEqual(['compact', 'release-notes'])
  expect(names('/workspace/probe')).toEqual(['compact', 'release-notes'])
  expect(calls).toEqual(['initialize', 'initialized', 'skills/list'])
  expect(closed).toBe(true)
})
