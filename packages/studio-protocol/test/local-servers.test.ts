import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_ERROR_CODES } from '../src/envelope'
import { STUDIO_LOCAL_SERVERS_CAPABILITY } from '../src/handshake'
import {
  STUDIO_LOCAL_SERVERS_MAX_IDS,
  STUDIO_LOCAL_SERVERS_METHODS,
  STUDIO_LOCAL_SERVERS_TOPICS,
  isStudioLocalServersMethod,
  parseStudioLocalServersParams,
} from '../src/local-servers'
import { STUDIO_METHODS, STUDIO_TOPICS, parseStudioMethodParams, parseStudioTopicParams } from '../src/methods'

const conversation = { workspaceId: 'ws-1', agentId: 'agent-1' }
const refusal = (parsed: { ok: boolean; code?: string }) => (parsed.ok ? null : parsed.code)

test('every localServers method and its topic are owner-only, behind the local-servers capability', () => {
  for (const [method, spec] of Object.entries(STUDIO_LOCAL_SERVERS_METHODS)) {
    assert.equal(spec.owner, true, method)
    assert.equal(spec.capability, STUDIO_LOCAL_SERVERS_CAPABILITY, method)
    assert.equal(STUDIO_METHODS[method as keyof typeof STUDIO_METHODS], spec, method)
    assert.equal(isStudioLocalServersMethod(method), true)
  }
  assert.equal(STUDIO_LOCAL_SERVERS_METHODS['localServers.list'].scope, 'workspaces:read')
  // Running a command drives the conversation's work.
  assert.equal(STUDIO_LOCAL_SERVERS_METHODS['localServers.run'].scope, 'conversation:operate')
  assert.equal(STUDIO_TOPICS['localServers.changed'], STUDIO_LOCAL_SERVERS_TOPICS['localServers.changed'])
  assert.equal(isStudioLocalServersMethod('localServers.link'), false)
  assert.equal(isStudioLocalServersMethod('toString'), false)
})

test('a list keeps its two target lists, de-duplicates workspace ids, and drops what it does not define', () => {
  const parsed = parseStudioLocalServersParams('localServers.list', {
    workspaceIds: ['ws-1', 'ws-1', 'ws-2'],
    conversations: [{ ...conversation, extra: true }],
    extra: 1,
  })
  assert.deepEqual(parsed, { ok: true, params: { workspaceIds: ['ws-1', 'ws-2'], conversations: [conversation] } })
  assert.deepEqual(parseStudioLocalServersParams('localServers.list', undefined), { ok: true, params: {} })
  assert.equal(refusal(parseStudioLocalServersParams('localServers.list', { workspaceIds: 'ws-1' })), 'invalid_params')
  assert.equal(refusal(parseStudioLocalServersParams('localServers.list', { workspaceIds: [''] })), 'invalid_params')
  assert.equal(
    refusal(
      parseStudioLocalServersParams('localServers.list', {
        workspaceIds: Array.from({ length: STUDIO_LOCAL_SERVERS_MAX_IDS + 1 }, (_, index) => `ws-${index}`),
      }),
    ),
    'invalid_params',
  )
  assert.equal(
    refusal(parseStudioLocalServersParams('localServers.list', { conversations: [{ workspaceId: 'ws-1' }] })),
    'invalid_params',
  )
  assert.equal(refusal(parseStudioLocalServersParams('localServers.list', [])), 'invalid_params')
})

test('run, stop and remove take a conversation and a server id, and nothing else', () => {
  for (const method of ['localServers.run', 'localServers.stop', 'localServers.remove'] as const) {
    assert.deepEqual(parseStudioMethodParams(method, { conversation, id: 'srv-1', commandId: 'c1' }), {
      ok: true,
      params: { conversation, id: 'srv-1' },
    })
    assert.equal(refusal(parseStudioLocalServersParams(method, { id: 'srv-1' })), 'invalid_params', method)
    assert.equal(refusal(parseStudioLocalServersParams(method, { conversation })), 'invalid_params', method)
    assert.equal(
      refusal(parseStudioLocalServersParams(method, { conversation, id: 'x'.repeat(201) })),
      'invalid_params',
      method,
    )
  }
})

test('the changed topic takes no params, and conflict is a code a refusal may carry', () => {
  assert.deepEqual(parseStudioTopicParams('localServers.changed', undefined), { ok: true, params: {} })
  assert.deepEqual(parseStudioTopicParams('localServers.changed', { ignored: true }), { ok: true, params: {} })
  assert.equal(refusal(parseStudioTopicParams('localServers.changed', 'x')), 'invalid_params')
  assert.ok((STUDIO_ERROR_CODES as readonly string[]).includes('conflict'))
})
