import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  STUDIO_MAX_FRAME_BYTES,
  createStudioChunkAssembler,
  parseStudioClientFrame,
  parseStudioServerFrame,
  studioClientFrameIds,
  studioWireFrames,
} from '../src/envelope'
import {
  STUDIO_CAPABILITIES,
  STUDIO_PROTOCOL_MIN_SUPPORTED,
  STUDIO_PROTOCOL_VERSION,
  checkStudioProtocolVersion,
  studioPeerSupports,
} from '../src/handshake'
import { normalizeStudioScopes, studioScopesGrant } from '../src/scopes'
import { parseStudioServerDiscovery, studioServerDiscovery } from '../src/discovery'
import { CONVERSATION_CAPABILITY, CONVERSATION_PROTOCOL_VERSION } from '../src/conversation'

const TOKEN = 'sest_0123456789abcdefghij'
const hello = (extra: Record<string, unknown> = {}) => ({
  t: 'hello',
  protocolVersion: 1,
  client: { name: 'release-bot', version: '1.2.0' },
  auth: { token: TOKEN },
  ...extra,
})

test('a hello carries a version, a named client and exactly one credential', () => {
  assert.deepEqual(parseStudioClientFrame(hello()), {
    t: 'hello',
    protocolVersion: 1,
    client: { name: 'release-bot', version: '1.2.0' },
    auth: { token: TOKEN },
  })
  assert.deepEqual(parseStudioClientFrame(hello({ auth: { pairingCode: 'sepair_0123456789abcdef' } }))?.t, 'hello')
  // No credential, a credential nobody minted, no name, no version.
  assert.equal(parseStudioClientFrame(hello({ auth: {} })), null)
  assert.equal(parseStudioClientFrame(hello({ auth: { token: 'short' } })), null)
  assert.equal(parseStudioClientFrame(hello({ auth: { token: `${TOKEN} with spaces` } })), null)
  assert.equal(parseStudioClientFrame(hello({ client: { name: '  ' } })), null)
  assert.equal(parseStudioClientFrame(hello({ protocolVersion: 0 })), null)
})

test('requests and subscriptions keep only their documented members', () => {
  assert.deepEqual(parseStudioClientFrame({ t: 'req', id: 'r1', method: 'conversation.list', extra: 1 }), {
    t: 'req',
    id: 'r1',
    method: 'conversation.list',
  })
  assert.deepEqual(
    parseStudioClientFrame({
      t: 'sub',
      id: 's1',
      topic: 'conversation.session',
      params: { key: { workspaceId: 'w', agentId: 'a' } },
      cursor: { afterSeq: 9, generation: 'log-1' },
    }),
    {
      t: 'sub',
      id: 's1',
      topic: 'conversation.session',
      params: { key: { workspaceId: 'w', agentId: 'a' } },
      cursor: { afterSeq: 9, generation: 'log-1' },
    },
  )
  // A cursor without its generation is no cursor at all.
  assert.equal(parseStudioClientFrame({ t: 'sub', id: 's1', topic: 'x', cursor: { afterSeq: 9 } }), null)
  assert.deepEqual(studioClientFrameIds({ t: 'req', id: 'r9', method: 1 }), { requestId: 'r9' })
  assert.deepEqual(studioClientFrameIds({ t: 'sub', id: 's9' }), { subscriptionId: 's9' })
  assert.deepEqual(studioClientFrameIds({ t: 'hello' }), {})
})

test('the version window refuses a peer outside it and names both numbers', () => {
  assert.deepEqual(checkStudioProtocolVersion(STUDIO_PROTOCOL_VERSION), { ok: true, version: STUDIO_PROTOCOL_VERSION })
  // A newer client that still speaks this one is spoken to at this one.
  assert.deepEqual(checkStudioProtocolVersion(STUDIO_PROTOCOL_VERSION + 1, STUDIO_PROTOCOL_VERSION), {
    ok: true,
    version: STUDIO_PROTOCOL_VERSION,
  })
  const tooNew = checkStudioProtocolVersion(STUDIO_PROTOCOL_VERSION + 2, STUDIO_PROTOCOL_VERSION + 2)
  assert.equal(tooNew.ok, false)
  assert.match(
    !tooNew.ok ? tooNew.message : '',
    new RegExp(`${STUDIO_PROTOCOL_VERSION + 2}.*${STUDIO_PROTOCOL_VERSION}`),
  )
  const tooOld = checkStudioProtocolVersion(STUDIO_PROTOCOL_MIN_SUPPORTED - 1 || 0)
  assert.equal(tooOld.ok, false)
  assert.match(!tooOld.ok ? tooOld.message : '', /Update the other end/)
})

test('capabilities are asked by name, and a peer that listed none has none', () => {
  assert.equal(studioPeerSupports(['conversations', 'conversation-create'], 'conversation-create'), true)
  assert.equal(studioPeerSupports(null, 'conversations'), false)
  assert.equal(studioPeerSupports([], 'conversations'), false)
  assert.equal(new Set(STUDIO_CAPABILITIES).size, STUDIO_CAPABILITIES.length)
})

test('operate covers read; create covers only itself; unknown scopes are dropped', () => {
  assert.equal(studioScopesGrant(['conversation:operate'], 'conversation:read'), true)
  assert.equal(studioScopesGrant(['conversation:create'], 'conversation:read'), false)
  assert.equal(studioScopesGrant(['conversation:read'], 'conversation:operate'), false)
  assert.deepEqual(
    normalizeStudioScopes(['conversation:create', 'terminal:control', 'conversation:read', 'conversation:read']),
    ['conversation:read', 'conversation:create'],
  )
})

const welcome = {
  t: 'welcome',
  protocolVersion: 1,
  minProtocolVersion: 1,
  server: { name: 'SprintEngine Studio', version: '0.9.0' },
  environment: { id: 'env-1', hostKind: 'local', os: 'darwin', arch: 'arm64' },
  capabilities: ['conversations', 'conversation-create'],
  conversation: {
    protocolVersion: CONVERSATION_PROTOCOL_VERSION,
    minProtocolVersion: 1,
    capabilities: [CONVERSATION_CAPABILITY],
  },
  grant: { clientId: 'sc_1', name: 'release-bot', owner: false, scopes: ['conversation:read'], ceiling: 'auto' },
}

test('a welcome is read whole, with the conversation hello answer nested unchanged', () => {
  const parsed = parseStudioServerFrame(welcome)
  assert.equal(parsed?.t, 'welcome')
  assert.deepEqual(parsed?.t === 'welcome' ? parsed.conversation.capabilities : null, [CONVERSATION_CAPABILITY])
  assert.equal(parseStudioServerFrame({ ...welcome, grant: { ...welcome.grant, ceiling: 'yolo' } }), null)
  assert.equal(parseStudioServerFrame({ ...welcome, pairing: { token: TOKEN } })?.t === 'welcome', true)
})

test('a stream frame is the conversation lane’s frame, validated by the lane’s own parser', () => {
  const synchronized = { t: 'frame', sub: 's1', frame: { type: 'synchronized', seq: 4, generation: 'log-1' } }
  assert.deepEqual(parseStudioServerFrame(synchronized), {
    t: 'frame',
    sub: 's1',
    frame: { type: 'synchronized', seq: 4, generation: 'log-1' },
  })
  // An event the client cannot read refuses the whole frame, so no cursor moves past it.
  assert.equal(parseStudioServerFrame({ t: 'frame', sub: 's1', frame: { type: 'event', event: { id: 'e' } } }), null)
  assert.equal(parseStudioServerFrame({ t: 'something-newer' }), null)
  assert.deepEqual(parseStudioServerFrame({ t: 'bye', code: 'revoked', message: 'Revoked in Settings.' }), {
    t: 'bye',
    code: 'revoked',
    message: 'Revoked in Settings.',
  })
  assert.deepEqual(
    parseStudioServerFrame({
      t: 'res',
      id: 'r1',
      ok: false,
      error: { code: 'busy', message: 'Busy.', retryAfterMs: 250 },
    }),
    { t: 'res', id: 'r1', ok: false, error: { code: 'busy', message: 'Busy.', retryAfterMs: 250 } },
  )
})

test('a frame over the cap is chunked contiguously and reassembles exactly', () => {
  const big = JSON.stringify({ t: 'res', id: 'r1', ok: true, result: { text: 'é'.repeat(STUDIO_MAX_FRAME_BYTES) } })
  const wire = studioWireFrames(big, 'c:1')
  assert.ok(wire.length > 1)
  const assembler = createStudioChunkAssembler()
  let out: string | null = null
  for (const line of wire) {
    const chunk = parseStudioServerFrame(JSON.parse(line))
    assert.equal(chunk?.t, 'chunk')
    assert.ok(Buffer.byteLength(line) <= STUDIO_MAX_FRAME_BYTES)
    const step = assembler.push(chunk as never)
    if (step.kind === 'frame') out = step.json
    else assert.equal(step.kind, 'pending')
  }
  assert.equal(out, big)
  // A small frame is itself.
  assert.deepEqual(studioWireFrames('{"t":"bye"}', 'c:2'), ['{"t":"bye"}'])
  // Out of order is an error, never a guess.
  const fresh = createStudioChunkAssembler()
  assert.equal(fresh.push({ t: 'chunk', frameId: 'x', index: 1, total: 2, json: '' }).kind, 'error')
})

test('a discovery file is written in the shape a client reads back', () => {
  const written = studioServerDiscovery({
    socketPath: '/Users/dev/Library/Application Support/SprintEngine Studio/run/studio.sock',
    transport: 'unix-socket',
    pid: 4242,
    version: '0.9.0',
    startedAt: '2026-10-01T00:00:00.000Z',
  })
  assert.deepEqual(parseStudioServerDiscovery(JSON.parse(JSON.stringify(written))), written)
  assert.equal(parseStudioServerDiscovery({ ...written, framing: 'websocket' }), null)
})
