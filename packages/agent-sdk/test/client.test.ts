import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test, vi } from 'vitest'

import { createStudioRpcServer, type StudioRpcServer } from '../../../src/server/rpc/studio-rpc-server'
import {
  createFakeAuthenticator,
  createFakeBackend,
  pairFakeClient,
  type FakeAuthenticator,
  type FakeBackend,
} from '../../../src/server/rpc/studio-rpc.test-helper'
import {
  StudioError,
  approvalRequestOf,
  connect,
  fromModuleConversationService,
  type ConversationFollowFrame,
  type ConversationEventStream,
  type StudioClient,
  type StudioClientState,
} from '../src/index'
import { isTerminalStudioCode } from '../src/errors'
import { connectToStudio, discoverStudio, socketTransport, studioDataDir } from '../src/node'

const ref = { workspaceId: 'ws-1', agentId: 'agent-1' }
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Studio = {
  dataDir: string
  backend: FakeBackend
  auth: FakeAuthenticator
  server: StudioRpcServer
  restart(): Promise<void>
}

async function studio(): Promise<Studio> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-sdk-'))
  const backend = createFakeBackend()
  const auth = createFakeAuthenticator()
  const make = () =>
    createStudioRpcServer({
      dataDir,
      version: '0.0.0-test',
      environmentId: 'env-test',
      backend,
      authenticator: auth,
      resyncRetryAfterMs: () => 50,
    })
  const handle: Studio = {
    dataDir,
    backend,
    auth,
    server: make(),
    async restart() {
      await handle.server.stop(20)
      handle.server = make()
      await handle.server.start()
    },
  }
  await handle.server.start()
  cleanups.push(async () => {
    await handle.server.stop()
    await rm(dataDir, { recursive: true, force: true })
  })
  return handle
}

async function client(target: Studio, token: string, states?: StudioClientState[]): Promise<StudioClient> {
  const connected = await connect({
    transport: socketTransport({ dataDir: target.dataDir }),
    client: { name: 'sdk-test' },
    auth: { token },
    reconnect: { initialDelayMs: 10, maxDelayMs: 50 },
    ...(states ? { onStateChange: (state) => states.push(state) } : {}),
  })
  cleanups.push(() => connected.close())
  return connected
}

/** Read frames until `until` says stop; returns what was read. */
async function read(
  stream: ConversationEventStream,
  until: (frame: ConversationFollowFrame, seen: ConversationFollowFrame[]) => boolean,
): Promise<ConversationFollowFrame[]> {
  // `next` by hand: breaking out of a `for await` would close the stream.
  const seen: ConversationFollowFrame[] = []
  for (;;) {
    const step = await stream.next()
    if (step.done) return seen
    seen.push(step.value)
    if (until(step.value, seen)) return seen
  }
}
const seqs = (frames: ConversationFollowFrame[]): Array<number | string | undefined> =>
  frames.map((frame) =>
    frame.type === 'event' ? frame.event.seq : frame.type === 'synchronized' ? 'fence' : 'snapshot',
  )

test('the data directory and the socket are found the way Studio writes them', async () => {
  assert.equal(
    studioDataDir({ env: {}, platform: 'darwin', home: '/Users/dev' }),
    '/Users/dev/Library/Application Support/SprintEngine Studio',
  )
  assert.equal(
    studioDataDir({ env: { XDG_CONFIG_HOME: '/Users/dev/.cfg' }, platform: 'linux', home: '/Users/dev' }),
    '/Users/dev/.cfg/SprintEngine Studio',
  )
  assert.equal(studioDataDir({ env: { SPRINTENGINE_USER_DATA_DIR: '/Users/dev/p' } }), '/Users/dev/p')
  const target = await studio()
  assert.equal((await discoverStudio({ dataDir: target.dataDir })).socketPath, target.server.socketPath())
  await assert.rejects(
    discoverStudio({ dataDir: join(target.dataDir, 'nowhere') }),
    (error: StudioError) => error.code === 'not_running',
  )
})

test('connect says hello, negotiates, and answers by capability; a bad token is refused for good', async () => {
  const target = await studio()
  const token = pairFakeClient(target.auth, 'app', ['conversation:read'])
  const app = await client(target, token)
  assert.equal(app.welcome.protocolVersion, 1)
  assert.deepEqual(app.grant.scopes, ['conversation:read'])
  assert.equal(app.supports('conversation-create'), true)
  assert.equal((await app.list())[0]?.agentId, 'agent-1')
  await assert.rejects(
    connect({
      transport: socketTransport({ dataDir: target.dataDir }),
      client: { name: 'x' },
      auth: { token: 'sest_unknown_token_00000' },
    }),
    (error: StudioError) => error.code === 'unauthorized',
  )
})

test('a pairing code is redeemed once and its token kept 0600 for every later connection', async () => {
  const target = await studio()
  target.auth.pairingCodes.set('sepair_0123456789abcdef', {
    clientId: 'paired',
    name: 'paired',
    owner: false,
    scopes: ['conversation:read'],
    ceiling: 'auto',
  })
  const tokenFile = join(target.dataDir, 'client', 'token')
  const first = await connectToStudio({
    name: 'paired-app',
    tokenFile,
    pairingCode: 'sepair_0123456789abcdef',
    dataDir: target.dataDir,
  })
  first.close()
  const kept = (await readFile(tokenFile, 'utf8')).trim()
  assert.match(kept, /^sest_paired_/)
  if (process.platform !== 'win32') assert.equal((await stat(tokenFile)).mode & 0o777, 0o600)
  const again = await connectToStudio({
    name: 'paired-app',
    tokenFile,
    pairingCode: 'sepair_0123456789abcdef',
    dataDir: target.dataDir,
  })
  cleanups.push(() => again.close())
  assert.equal(again.grant.clientId, 'paired')
})

test('a token that cannot be kept fails the connect, and the same code works once it can', async () => {
  const target = await studio()
  // The fake authenticator spends codes; this one plays Studio's rule: good
  // until its token is first presented.
  const grant = {
    clientId: 'kept',
    name: 'kept',
    owner: false,
    scopes: ['conversation:read' as const],
    ceiling: 'auto' as const,
  }
  const code = 'sepair_0123456789abcdef'
  const authenticate = target.auth.authenticate
  target.auth.authenticate = (credential, client) => {
    if ('pairingCode' in credential && credential.pairingCode === code) {
      target.auth.grants.set('kept', grant)
      target.auth.tokens.set('sest_kept_token_00000000', 'kept')
      return { ok: true, grant, pairingToken: 'sest_kept_token_00000000' }
    }
    return authenticate(credential, client)
  }
  const options = {
    transport: socketTransport({ dataDir: target.dataDir }),
    client: { name: 'kept' },
    auth: { pairingCode: code },
  }
  await assert.rejects(
    connect({ ...options, onToken: () => Promise.reject(new Error('disk full')) }),
    (error: StudioError) => error.code === 'token_not_kept' && /disk full/.test(error.message),
  )
  const kept: string[] = []
  const app = await connect({ ...options, onToken: (token) => void kept.push(token) })
  cleanups.push(() => app.close())
  assert.deepEqual(kept, ['sest_kept_token_00000000'])
})

test('a connection that closes while its pairing token is being kept is not taken for open', async () => {
  const target = await studio()
  const grant = {
    clientId: 'kept',
    name: 'kept',
    owner: false,
    scopes: ['conversation:read' as const],
    ceiling: 'auto' as const,
  }
  const code = 'sepair_0123456789abcdef'
  const authenticate = target.auth.authenticate
  target.auth.authenticate = (credential, client) => {
    if ('pairingCode' in credential && credential.pairingCode === code) {
      target.auth.grants.set('kept', grant)
      target.auth.tokens.set('sest_kept_token_00000000', 'kept')
      return { ok: true, grant, pairingToken: 'sest_kept_token_00000000' }
    }
    return authenticate(credential, client)
  }
  const base = socketTransport({ dataDir: target.dataDir })
  let latest: Awaited<ReturnType<typeof base>> | null = null
  const app = await connect({
    transport: async () => (latest = await base()),
    client: { name: 'kept' },
    auth: { pairingCode: code },
    reconnect: { initialDelayMs: 10, maxDelayMs: 30 },
    onToken: async () => {
      // Kept slowly, as a keychain prompt is, and the connection goes meanwhile.
      latest!.close()
      await new Promise((resolve) => setTimeout(resolve, 20))
    },
  })
  cleanups.push(() => app.close())
  assert.notEqual(app.state, 'open')
  // The next connection says hello with the kept token, and is open.
  for (let tries = 0; app.state !== 'open' && tries < 200; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(app.state, 'open')
  assert.equal(app.grant.clientId, 'kept')
})

test('events resume across Studio restarting, with no gap and no repeat', async () => {
  const target = await studio()
  const states: StudioClientState[] = []
  const app = await client(target, pairFakeClient(target.auth, 'app', ['conversation:read']), states)
  target.backend.emit('agent-1', 'content_delta', { text: 'a' })
  const stream = app.conversation(ref).events()
  const before = await read(stream, (frame) => frame.type === 'synchronized')
  assert.deepEqual(seqs(before), ['snapshot', 'fence'])
  assert.deepEqual(stream.cursor, { afterSeq: 1, generation: 'log-1' })
  target.backend.emit('agent-1', 'turn_started')
  assert.deepEqual(seqs(await read(stream, () => true)), [2])

  // The app quits mid-stream; events happen while it is away; it comes back.
  await target.server.stop(20)
  target.backend.emit('agent-1', 'content_delta', { text: 'b' })
  target.backend.emit('agent-1', 'turn_completed')
  await new Promise((resolve) => setTimeout(resolve, 30))
  await target.restart()
  const after = await read(stream, (frame) => frame.type === 'synchronized')
  // The two missed, then the fence: no snapshot, nothing repeated.
  assert.deepEqual(seqs(after), [3, 4, 'fence'])
  assert.ok(states.includes('reconnecting'))
  assert.equal(app.state, 'open')
  target.backend.emit('agent-1', 'turn_started')
  assert.deepEqual(seqs(await read(stream, () => true)), [5])
  stream.close()
})

test('a stream refused for now and then resumed by a reconnect is not subscribed a second time', async () => {
  const target = await studio()
  const app = await client(target, pairFakeClient(target.auth, 'app', ['conversation:read']))
  // The first join cannot read the log: Studio refuses it as retryable.
  const follow = target.backend.follow.bind(target.backend)
  let refused = false
  target.backend.follow = (key, cursor, listener) => {
    if (refused) return follow(key, cursor, listener)
    refused = true
    listener({ type: 'error', message: 'The log is being written.' })
    return { ready: Promise.resolve(), dispose: () => undefined }
  }
  const stream = app.conversation(ref).events()
  await vi.waitFor(() => assert.ok(refused))
  // Studio restarts before the retry is due; the reconnect resumes the stream.
  await target.restart()
  assert.deepEqual(seqs(await read(stream, (frame) => frame.type === 'synchronized')), ['snapshot', 'fence'])
  // Past the retry the refusal asked for, the stream is still followed.
  await new Promise((resolve) => setTimeout(resolve, 2_300))
  target.backend.emit('agent-1', 'turn_started')
  assert.deepEqual(seqs(await read(stream, () => true)), [1])
  stream.close()
}, 10_000)

test('a command in flight when the connection drops is sent again under the same id, and runs once', async () => {
  const target = await studio()
  const app = await client(target, pairFakeClient(target.auth, 'app', ['conversation:operate']))
  const sent = app.conversation(ref).interrupt({ commandId: 'stop-it' })
  // Drop the connection under the request: the server is replaced before it answers.
  await target.restart()
  await sent
  await app.conversation(ref).interrupt({ commandId: 'stop-it' })
  const ids = target.backend.commands.map((entry) => entry.commandId)
  assert.deepEqual(ids, ['client:app:stop-it'])
})

test('approvals and questions are read off events and answered through the handle', async () => {
  const target = await studio()
  const app = await client(target, pairFakeClient(target.auth, 'app', ['conversation:operate']))
  const chat = app.conversation(ref)
  const stream = chat.events()
  await read(stream, (frame) => frame.type === 'synchronized')
  target.backend.emit('agent-1', 'approval_requested', {
    requestId: 'r1',
    kind: 'tool',
    action: 'Bash',
    summary: 'npm test',
  })
  target.backend.emit('agent-1', 'approval_requested', {
    requestId: 'q1',
    kind: 'question',
    questions: [{ question: 'Which?', options: [{ label: 'A' }] }],
  })
  const asked = (await read(stream, (_frame, seen) => seen.length === 2)).flatMap((frame) =>
    frame.type === 'event' ? [approvalRequestOf(frame.event)] : [],
  )
  assert.deepEqual(asked[0], { kind: 'tool', requestId: 'r1', action: 'Bash', summary: 'npm test' })
  assert.equal(asked[1]?.kind, 'question')
  await chat.respondToApproval({ requestId: 'r1', decision: 'once' })
  await chat.answerQuestion({ requestId: 'q1', answers: { 'Which?': 'A' } })
  assert.deepEqual(
    target.backend.commands.map((entry) => entry.command.kind),
    ['resolveApproval', 'answerQuestion'],
  )
  const permissions = await chat.setPermissions({ preset: 'bypass', mode: 'bypassPermissions' })
  // Lowered to the app's ceiling, and the mode with it.
  assert.deepEqual(permissions, { permissionPreset: 'auto' })
  stream.close()
})

test('the ref-level service answers as the module SDK does, and the handle throws', async () => {
  const target = await studio()
  const app = await client(target, pairFakeClient(target.auth, 'reader', ['conversation:read']))
  const refused = await app.conversations.send(ref, { message: 'hi' })
  assert.deepEqual(refused.ok ? null : refused.code, 'scope_required')
  await assert.rejects(app.conversation(ref).send('hi'), (error: StudioError) => error.code === 'scope_required')
  await assert.rejects(
    app.createConversation({ workspaceId: 'ws-1', prompt: 'hello' }),
    (error: StudioError) => error.code === 'scope_required',
  )
})

test('revoking an app mid-stream ends its streams and parks the client until it is woken', async () => {
  const target = await studio()
  const states: StudioClientState[] = []
  const app = await client(target, pairFakeClient(target.auth, 'doomed', ['conversation:read']), states)
  const stream = app.conversation(ref).events()
  await read(stream, (frame) => frame.type === 'synchronized')
  states.length = 0
  target.auth.revoke('doomed')
  await assert.rejects(stream.next(), (error: StudioError) => error.code === 'revoked')
  for (let tries = 0; app.state !== 'parked' && tries < 100; tries++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  // Parked, not retrying: another try would only be refused again.
  assert.equal(app.state, 'parked')
  await assert.rejects(app.request('server.info', {}), (error: StudioError) => error.code === 'revoked')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(states, ['parked'])
  // A wake tries once more, and is refused once more.
  app.wake()
  for (let tries = 0; states.length < 3 && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(states, ['parked', 'reconnecting', 'parked'])
  app.close()
  await app.closed
})

test('a quiet connection is pinged, and one that stays silent is made again', async () => {
  // The heartbeat's clock is faked, so how long a ping takes to come back on a
  // busy machine cannot make a healthy line look dead. The socket is real: its
  // frames still need the event loop's turns, which `io` hands it.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  cleanups.push(() => void vi.useRealTimers())
  const io = async (done: () => boolean, what: string) => {
    for (let turns = 0; !done() && turns < 5_000; turns++) await new Promise((resolve) => setImmediate(resolve))
    assert.ok(done(), `waited for ${what}`)
  }
  const target = await studio()
  let silent = false
  const sent: string[] = []
  const heard: string[] = []
  const connecting = connect({
    transport: async () => {
      const transport = await socketTransport({ dataDir: target.dataDir })()
      const listeners: Array<(frame: string) => void> = []
      transport.onMessage((frame) => {
        if (silent) return
        heard.push(frame)
        listeners.forEach((listener) => listener(frame))
      })
      return {
        ...transport,
        send: (frame: string) => {
          sent.push(frame)
          transport.send(frame)
        },
        onMessage: (listener: (frame: string) => void) => void listeners.push(listener),
      }
    },
    client: { name: 'sdk-test' },
    auth: { token: pairFakeClient(target.auth, 'quiet', ['conversation:read']) },
    heartbeat: { intervalMs: 30_000, timeoutMs: 10_000 },
    reconnect: { initialDelayMs: 100, maxDelayMs: 100 },
  })
  let connected: Awaited<typeof connecting> | null = null
  void connecting.then((value) => (connected = value))
  await io(() => connected !== null, 'the welcome')
  const app = connected!
  cleanups.push(() => app.close())
  const pings = () => sent.filter((frame) => frame.includes('"server.ping"')).length
  const pongs = () => heard.filter((frame) => frame.includes('"id":"ping')).length
  const hellos = () => sent.filter((frame) => frame.includes('"t":"hello"')).length
  // Quiet for a spell: one ping, answered, and the line stays.
  vi.advanceTimersByTime(29_999)
  assert.equal(pings(), 0, 'nothing is asked before the spell is up')
  vi.advanceTimersByTime(1)
  assert.equal(pings(), 1)
  await io(() => pongs() === 1, 'the answer to the ping')
  // The answer came at 30s, so the line is quiet again from then: the next ping is due at 60s.
  vi.advanceTimersByTime(10_000)
  assert.equal(app.state, 'open')
  vi.advanceTimersByTime(19_999)
  assert.equal(pings(), 1)
  vi.advanceTimersByTime(1)
  assert.equal(pings(), 2, 'and again after the next quiet spell')
  await io(() => pongs() === 2, 'the second answer')
  vi.advanceTimersByTime(10_000)
  assert.equal(app.state, 'open')
  assert.equal(hellos(), 1, 'a healthy line is never made again')
  // A line that stops answering (a socket left half-open) is given up and made again.
  silent = true
  vi.advanceTimersByTime(20_000)
  assert.equal(pings(), 3)
  vi.advanceTimersByTime(9_999)
  assert.equal(hellos(), 1, 'not before its ping has had its time')
  vi.advanceTimersByTime(1)
  await io(() => app.state === 'reconnecting', 'the line given up')
  vi.advanceTimersByTime(100)
  await io(() => hellos() === 2, 'a new hello')
  assert.equal(hellos(), 2)
})

test('a read unanswered in its time is refused, and a mutation waits for its answer', async () => {
  const target = await studio()
  const token = pairFakeClient(target.auth, 'patient', ['conversation:read', 'conversation:operate'])
  const app = await connect({
    transport: socketTransport({ dataDir: target.dataDir }),
    client: { name: 'sdk-test' },
    auth: { token },
    readTimeoutMs: 40,
    reconnect: { initialDelayMs: 5, maxDelayMs: 10 },
  })
  cleanups.push(() => app.close())
  const slow = target.backend.loadEarlier
  target.backend.loadEarlier = () => new Promise((resolve) => setTimeout(() => resolve(slow(null as never, 1)), 200))
  await assert.rejects(
    app.request('conversation.loadEarlier', { key: ref, beforeCursor: 3 }),
    (error: StudioError) => error.code === 'timeout',
  )
  const sent = await app.request('conversation.send', { key: ref, commandId: 'slow-send', message: 'hi' })
  assert.deepEqual(sent, {})
})

test('a create is retried under one command id and makes one chat', async () => {
  const target = await studio()
  const app = await client(
    target,
    pairFakeClient(target.auth, 'maker', ['conversation:create', 'conversation:operate']),
  )
  const created = await app.createConversation({ workspaceId: 'ws-1', prompt: 'hello', commandId: 'make-1' })
  const again = await app.conversations.create({ workspaceId: 'ws-1', prompt: 'hello', commandId: 'make-1' })
  assert.equal(again.ok && again.conversation.agentId, created.info.agentId)
  assert.equal(target.backend.creates.length, 1)
  assert.equal(created.ref.agentId, created.info.agentId)
})

test('the same handles work in process over a module’s conversation service', async () => {
  const followed: Array<(frame: ConversationFollowFrame | { type: 'error'; message: string }) => void> = []
  const calls: string[] = []
  let unfollowed = 0
  let failAtOnce = false
  const conversations = fromModuleConversationService({
    create: async () => ({
      ok: true,
      conversation: {
        workspaceId: 'ws-1',
        agentId: 'mine',
        sessionId: 's',
        name: 'Mine',
        cli: 'claude-code',
        providerId: 'claude-agent',
        modelId: 'default',
      },
    }),
    send: async (_ref, input) => {
      calls.push(`send:${input.message}`)
      return { ok: true }
    },
    interrupt: async () => ({ ok: true }),
    respondToApproval: async () => ({ ok: true }),
    answerQuestion: async () => ({ ok: true }),
    resolvePlan: async () => ({ ok: true }),
    setPermissionPreset: async (_ref, preset) => ({ ok: true, permissionPreset: preset }),
    setModel: async (_ref, modelId) => ({ ok: true, modelId }),
    stop: async () => ({ ok: false, code: 'not_owned', message: 'Not this module’s chat.' }),
    follow: (_ref, _options, onFrame) => {
      followed.push(onFrame)
      if (failAtOnce) onFrame({ type: 'error', message: 'Not this module’s chat.' })
      return () => void unfollowed++
    },
    list: () => [],
  })
  const chat = await conversations.createConversation({ workspaceId: 'ws-1' })
  await chat.send('hello')
  assert.deepEqual(calls, ['send:hello'])
  await assert.rejects(chat.stop(), (error: StudioError) => error.code === 'not_owned')
  const stream = chat.events()
  followed[0]({ type: 'synchronized', seq: 7, generation: 'g' })
  const event = {
    id: 'e',
    seq: 8,
    sessionId: 's',
    workspaceId: 'ws-1',
    agentId: 'mine',
    providerId: 'claude-agent',
    modelId: 'default',
    type: 'turn_started',
    createdAt: 1,
  }
  followed[0]({ type: 'event', event })
  assert.deepEqual(seqs(await read(stream, (_frame, seen) => seen.length === 2)), ['fence', 8])
  assert.deepEqual(stream.cursor, { afterSeq: 8, generation: 'g' })
  followed[0]({ type: 'error', message: 'No longer readable by this module.' })
  await assert.rejects(stream.next(), (error: StudioError) => error.code === 'unavailable')
  // The stream ended, and the follow behind it was stopped with it.
  assert.equal(unfollowed, 1)
  // Refused before the follow had even returned its stop.
  failAtOnce = true
  const refused = chat.events()
  await assert.rejects(refused.next(), (error: StudioError) => error.code === 'unavailable')
  assert.equal(unfollowed, 2)
})

test('a hello refused as late may be tried again; any other hello refusal ends the client', () => {
  assert.equal(isTerminalStudioCode('hello_required', 1_000), false)
  assert.equal(isTerminalStudioCode('hello_required'), true)
  assert.equal(isTerminalStudioCode('unauthorized', 1_000), true)
  assert.equal(isTerminalStudioCode('shutting_down', 1_000), false)
})
