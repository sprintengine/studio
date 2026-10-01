import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

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

test('revoking an app mid-stream ends its streams and the client, for good', async () => {
  const target = await studio()
  const app = await client(target, pairFakeClient(target.auth, 'doomed', ['conversation:read']))
  const stream = app.conversation(ref).events()
  await read(stream, (frame) => frame.type === 'synchronized')
  target.auth.revoke('doomed')
  await assert.rejects(stream.next(), (error: StudioError) => error.code === 'revoked')
  await assert.rejects(app.closed, (error: StudioError) => error.code === 'revoked')
  assert.equal(app.state, 'closed')
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
      return () => undefined
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
})
