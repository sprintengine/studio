import { expect, test } from 'vitest'
import { createCodexConversationProvider, codexPermissionPolicy } from './codex-conversation-provider'
import type { CodexRpcOptions, RpcMessage } from './codex-json-rpc'
import type { ConversationEvent } from '../../shared/conversation-runtime'

function fixture() {
  let connection!: CodexRpcOptions
  const calls: { method: string; params: unknown }[] = []
  const replies: { id: string | number; result: unknown }[] = []
  let resolveStarted!: () => void
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve
  })
  const adapter = createCodexConversationProvider({
    resolveExecutable: async () => '/usr/bin/codex',
    buildEnv: async () => ({}),
    createTransport(options) {
      connection = options
      return {
        pid: 123,
        async request(method, params) {
          calls.push({ method, params })
          if (method === 'account/read') return { requiresOpenaiAuth: true, account: { type: 'chatgpt' } }
          if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'native-thread' } }
          if (method === 'turn/start') {
            resolveStarted()
            return { turn: { id: 'native-turn' } }
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
        close() {},
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
    permissionPreset: 'manual' as const,
  }
  const events: ConversationEvent[] = []
  const send = async (reasoningEffort?: string, mode?: 'default' | 'ask' | 'plan') => {
    for await (const event of (await adapter.sendTurn({
      ...input,
      turnId: 'turn',
      requestId: 'request',
      message: 'Make a change.',
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
    started,
    message,
    calls,
    replies,
    crash: () => connection.onClose(new Error('Child process exited.')),
  }
}

test.each([3, 7])('command output preserves its head and tail within the detail budget (%s MB)', async (megabytes) => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  const item = { id: 'command', type: 'commandExecution', command: 'build' }
  await f.message({ method: 'item/started', params: { item } })
  const output = `first-line\n${'x'.repeat(megabytes * 1024 * 1024)}\nlast-line`
  for (let offset = 0; offset < output.length; offset += 1024 * 1024)
    await f.message({
      method: 'item/commandExecution/outputDelta',
      params: { itemId: 'command', delta: output.slice(offset, offset + 1024 * 1024) },
    })
  await f.message({ method: 'item/completed', params: { item: { ...item, status: 'completed', exitCode: 0 } } })
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  const payload = f.events.filter((event) => event.type === 'tool_output').at(-1)!.payload!
  expect(payload.output).toMatch(/^first-line\n/)
  expect(payload.output).toMatch(/\nlast-line$/)
  expect(payload.totalBytes).toBe(Buffer.byteLength(output))
  expect(payload.clipped).toBe(megabytes > 5)
  if (megabytes < 5) expect(payload.output).toBe(output)
  else expect(Buffer.byteLength(String(payload.output))).toBeLessThan(5 * 1024 * 1024 + 30)
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
  expect(f.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
    sandboxPolicy: { type: 'readOnly' },
    approvalPolicy: 'on-request',
  })
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

test('permission presets keep supervised runs sandboxed and require explicit bypass', () => {
  expect(codexPermissionPolicy('manual')).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'read-only' })
  expect(codexPermissionPolicy('auto')).toMatchObject({
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    sandboxPolicy: { networkAccess: false },
  })
  expect(codexPermissionPolicy('bypass')).toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
  expect(codexPermissionPolicy('none')).toEqual({})
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

test('returning to unspecified permissions cannot retain an earlier bypass silently', async () => {
  const f = fixture()
  await f.adapter.startSession({ ...f.input, permissionPreset: 'bypass' })
  expect(await f.adapter.setPermissionPreset?.({ ...f.input, permissionPreset: 'none' })).toMatchObject({ ok: false })
  expect(await f.adapter.setPermissionPreset?.({ ...f.input, permissionPreset: 'manual' })).toEqual({ ok: true })
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
