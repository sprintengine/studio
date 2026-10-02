import assert from 'node:assert/strict'
import { test } from 'vitest'

import { parseStudioClientFrame, parseStudioServerFrame } from '../src/envelope'
import { STUDIO_METHODS, STUDIO_TOPICS, parseStudioMethodParams, parseStudioTopicParams } from '../src/methods'
import { STUDIO_SCOPES } from '../src/scopes'
import {
  STUDIO_MAX_TOOL_RESULT_BYTES,
  STUDIO_TOOL_LIMITS,
  isStudioBuiltInToolset,
  parseStudioToolResult,
  parseStudioToolsetOffer,
  studioToolWireName,
  studioUtf8Length,
} from '../src/tools'

const tool = (extra: Record<string, unknown> = {}) => ({
  name: 'spawn_enemy',
  description: 'Spawn an enemy at a grid cell.',
  inputSchema: { type: 'object', properties: { x: { type: 'integer' } } },
  ...extra,
})
const offer = (extra: Record<string, unknown> = {}) => ({ name: 'game', tools: [tool()], ...extra })
const refusal = (value: unknown) => {
  const parsed = parseStudioToolsetOffer(value)
  return parsed.ok ? null : parsed.code
}

test('an offer keeps only its documented members', () => {
  assert.deepEqual(parseStudioToolsetOffer(offer({ title: ' Acme Game ', junk: 1 })), {
    ok: true,
    offer: { name: 'game', title: 'Acme Game', tools: [tool()] },
  })
  const withFlags = parseStudioToolsetOffer(offer({ tools: [tool({ mutates: false, timeoutMs: 10_000, junk: 2 })] }))
  assert.deepEqual(withFlags.ok && withFlags.offer.tools[0], tool({ mutates: false, timeoutMs: 10_000 }))
})

test('toolset and tool names follow their patterns', () => {
  // No underscore in a toolset: a rewritten wire name splits at its first one.
  assert.equal(refusal(offer({ name: 'my_game' })), 'invalid_params')
  assert.equal(refusal(offer({ name: 'Game' })), 'invalid_params')
  assert.equal(refusal(offer({ name: 'g' })), 'invalid_params')
  assert.equal(refusal(offer({ name: 'a-very-long-toolset' })), 'invalid_params')
  assert.equal(refusal(offer({ name: 'my-game' })), null)
  assert.equal(refusal(offer({ tools: [tool({ name: 'Spawn' })] })), 'invalid_params')
  assert.equal(refusal(offer({ tools: [tool({ name: '_spawn' })] })), 'invalid_params')
  assert.equal(refusal(offer({ tools: [tool({ name: 'x'.repeat(33) })] })), 'invalid_params')
  assert.equal(refusal(offer({ tools: [tool(), tool()] })), 'invalid_params')
  assert.equal(studioToolWireName('game', 'spawn_enemy'), 'game.spawn_enemy')
  assert.equal(isStudioBuiltInToolset('browser'), true)
  assert.equal(isStudioBuiltInToolset('game'), false)
})

test('counts and sizes are bounded', () => {
  const many = Array.from({ length: STUDIO_TOOL_LIMITS.toolsPerToolset + 1 }, (_, index) =>
    tool({ name: `tool_${index}` }),
  )
  assert.equal(refusal(offer({ tools: many })), 'too_large')
  assert.equal(refusal(offer({ tools: [] })), 'invalid_params')
  assert.equal(refusal(offer({ tools: [tool({ description: '' })] })), 'invalid_params')
  assert.equal(refusal(offer({ tools: [tool({ description: 'x'.repeat(2_001) })] })), 'invalid_params')
  assert.equal(refusal(offer({ description: 'x'.repeat(301) })), 'invalid_params')
  assert.equal(refusal(offer({ title: 'x'.repeat(61) })), 'invalid_params')
  const bigSchema = { type: 'object', description: 'x'.repeat(STUDIO_TOOL_LIMITS.inputSchemaBytes) }
  assert.equal(refusal(offer({ tools: [tool({ inputSchema: bigSchema })] })), 'invalid_params')
  const bulky = Array.from({ length: 30 }, (_, index) =>
    tool({ name: `tool_${index}`, inputSchema: { type: 'object', description: 'é'.repeat(5_000) } }),
  )
  assert.equal(refusal(offer({ tools: bulky })), 'too_large')
  assert.equal(refusal(offer({ tools: [tool({ timeoutMs: 999 })] })), 'invalid_params')
  assert.equal(refusal(offer({ tools: [tool({ timeoutMs: 600_001 })] })), 'invalid_params')
  assert.equal(refusal(offer({ tools: [tool({ mutates: 'yes' })] })), 'invalid_params')
})

test('a schema is an object at its root and refers to nothing outside itself', () => {
  assert.equal(refusal(offer({ tools: [tool({ inputSchema: { type: 'string' } })] })), 'invalid_params')
  assert.equal(refusal(offer({ tools: [tool({ inputSchema: [] })] })), 'invalid_params')
  const local = { type: 'object', properties: { a: { $ref: '#/$defs/a' } }, $defs: { a: { type: 'string' } } }
  assert.equal(refusal(offer({ tools: [tool({ inputSchema: local })] })), null)
  const remote = { type: 'object', properties: { a: { $ref: 'https://example.com/schema.json' } } }
  assert.equal(refusal(offer({ tools: [tool({ inputSchema: remote })] })), 'invalid_params')
  const nested = { type: 'object', anyOf: [{ properties: { b: { $ref: 'other.json#/x' } } }] }
  assert.equal(refusal(offer({ tools: [tool({ inputSchema: nested })] })), 'invalid_params')
})

test('a result carries text and pictures of the four types, and nothing else', () => {
  const text = { content: [{ type: 'text', text: 'ok' }], structuredContent: { id: 3 } }
  assert.deepEqual(parseStudioToolResult({ ...text, junk: 1 }), text)
  for (const mimeType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    assert.ok(parseStudioToolResult({ content: [{ type: 'image', data: 'AAAA', mimeType }] }))
  assert.equal(parseStudioToolResult({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/svg+xml' }] }), null)
  assert.equal(parseStudioToolResult({ content: [{ type: 'resource', uri: 'file:///x' }] }), null)
  assert.equal(parseStudioToolResult({ content: 'ok' }), null)
  assert.equal(parseStudioToolResult({ content: [], isError: 'yes' }), null)
  assert.equal(parseStudioToolResult({ content: [], structuredContent: [1] }), null)
  assert.equal(STUDIO_MAX_TOOL_RESULT_BYTES, 960 * 1024)
  assert.equal(studioUtf8Length('é😀'), 6)
})

test('reply and progress are client frames; call and cancel are server frames', () => {
  const reply = { t: 'reply', id: 'c1', ok: true, result: { content: [{ type: 'text', text: 'done' }] } }
  assert.deepEqual(parseStudioClientFrame(reply), reply)
  assert.deepEqual(
    parseStudioClientFrame({ t: 'reply', id: 'c1', ok: false, error: { code: 'tool_failed', message: 'x' } }),
    {
      t: 'reply',
      id: 'c1',
      ok: false,
      error: { code: 'tool_failed', message: 'x' },
    },
  )
  assert.equal(parseStudioClientFrame({ t: 'reply', id: 'c1', ok: true, result: { content: 'x' } }), null)
  assert.equal(
    parseStudioClientFrame({ t: 'reply', id: 'c1', ok: false, error: { code: 'Bad Code', message: '' } }),
    null,
  )
  assert.deepEqual(
    parseStudioClientFrame({ t: 'progress', id: 'c1', progress: 1, total: 4, message: 'm'.repeat(300) }),
    {
      t: 'progress',
      id: 'c1',
      progress: 1,
      total: 4,
      message: 'm'.repeat(200),
    },
  )
  assert.equal(parseStudioClientFrame({ t: 'progress', id: 'c1', progress: 'half' }), null)

  const call = {
    t: 'call',
    id: 'call-1',
    toolset: 'game',
    tool: 'spawn_enemy',
    input: { x: 1 },
    context: {
      connection: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'a1' },
      conversation: { workspaceId: 'ws-1', agentId: 'a1' },
    },
    timeoutMs: 10_000,
    redelivery: true,
  }
  assert.deepEqual(parseStudioServerFrame(call), call)
  assert.equal(parseStudioServerFrame({ ...call, toolset: 'Game' }), null)
  assert.equal(parseStudioServerFrame({ ...call, context: { connection: { kind: 'someone' } } }), null)
  assert.deepEqual(parseStudioServerFrame({ t: 'cancel', id: 'call-1', reason: 'timeout' }), {
    t: 'cancel',
    id: 'call-1',
    reason: 'timeout',
  })
  // A reason a newer Studio adds is read as an interruption, never refused.
  assert.deepEqual(parseStudioServerFrame({ t: 'cancel', id: 'call-1', reason: 'later' }), {
    t: 'cancel',
    id: 'call-1',
    reason: 'interrupted',
  })
})

test('a hello may say what kind of client it is and which process run', () => {
  const hello = (client: Record<string, unknown>) =>
    parseStudioClientFrame({ t: 'hello', protocolVersion: 1, client, auth: { token: 'sest_0123456789abcdefghij' } })
  const instanceId = 'inst_0123456789abcdef'
  assert.deepEqual(hello({ name: 'desk', kind: 'desktop', instanceId }), {
    t: 'hello',
    protocolVersion: 1,
    client: { name: 'desk', kind: 'desktop', instanceId },
    auth: { token: 'sest_0123456789abcdefghij' },
  })
  // Hints in the wrong shape are dropped, and the hello stands.
  assert.deepEqual(hello({ name: 'desk', kind: 'robot', instanceId: 'short' }), {
    t: 'hello',
    protocolVersion: 1,
    client: { name: 'desk' },
    auth: { token: 'sest_0123456789abcdefghij' },
  })
})

test('the tools methods name their scopes, and their params are checked', () => {
  assert.ok(STUDIO_SCOPES.includes('tools:offer'))
  assert.ok(STUDIO_SCOPES.includes('files:write'))
  assert.equal(STUDIO_METHODS['tools.offer'].scope, 'tools:offer')
  assert.equal(STUDIO_METHODS['tools.grant'].owner, true)
  assert.equal(STUDIO_METHODS['tools.grant'].mutation, true)
  assert.equal(STUDIO_TOPICS['tools.catalog'].push, true)
  assert.deepEqual(parseStudioMethodParams('tools.offer', { toolset: offer(), reach: 'all' }), {
    ok: true,
    params: { toolset: offer(), reach: 'all' },
  })
  const badReach = parseStudioMethodParams('tools.offer', { toolset: offer(), reach: 'everyone' })
  assert.equal(badReach.ok, false)
  assert.deepEqual(parseStudioMethodParams('tools.focus', { focused: true, workspaceIds: ['a', 'a', 'b'] }), {
    ok: true,
    params: { focused: true, workspaceIds: ['a', 'b'] },
  })
  const grant = parseStudioMethodParams('tools.grant', {
    key: { workspaceId: 'ws-1', agentId: 'a1' },
    toolset: 'game',
    granted: true,
  })
  assert.equal(grant.ok, false)
  assert.deepEqual(parseStudioTopicParams('tools.catalog', undefined), { ok: true, params: {} })
})
