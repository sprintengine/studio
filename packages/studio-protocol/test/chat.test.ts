import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  STUDIO_CHAT_METHODS,
  STUDIO_CHAT_TOPICS,
  STUDIO_MAX_UPLOAD_BYTES,
  STUDIO_UPLOAD_CHUNK_BYTES,
  parseStudioChatParams,
  type StudioChatMethod,
} from '../src/chat'
import { parseStudioServerFrame } from '../src/envelope'
import { STUDIO_CAPABILITIES, STUDIO_CHAT_CAPABILITIES } from '../src/handshake'
import { parseStudioConversationKey } from '../src/key'
import { STUDIO_METHODS, parseStudioMethodParams, parseStudioTopicParams } from '../src/methods'

const key = { workspaceId: 'ws-1', agentId: 'agent-1' }
const folderKey = { ...key, workspaceRoot: '/Users/dev/project/.worktrees/run-1' }

test('the chat surface is an owner’s, method by method, and each names a scope and a chat capability', () => {
  for (const [method, spec] of Object.entries(STUDIO_CHAT_METHODS)) {
    assert.equal(spec.owner, true, method)
    assert.ok(spec.scope, method)
    assert.ok((STUDIO_CHAT_CAPABILITIES as readonly string[]).includes(spec.capability!), method)
    assert.equal(STUDIO_METHODS[method as StudioChatMethod], spec)
  }
  for (const [topic, spec] of Object.entries(STUDIO_CHAT_TOPICS)) {
    assert.deepEqual([topic, spec.owner, spec.push], [topic, true, true])
  }
  // Every chat capability is one this package knows.
  for (const capability of STUDIO_CHAT_CAPABILITIES) assert.ok(STUDIO_CAPABILITIES.includes(capability))
})

test('every chat mutation needs a command id, and a read never takes one', () => {
  for (const [method, spec] of Object.entries(STUDIO_CHAT_METHODS)) {
    if (!spec.mutation) continue
    const parsed = parseStudioChatParams(method as StudioChatMethod, {
      sessionId: 's1',
      key,
      turnSeq: 2,
      message: 'hi',
      requestId: 'r1',
      approved: true,
      permissionPreset: 'auto',
      modelId: 'm',
      newAgentId: 'agent-2',
      side: 'user',
      workspaceRoot: '/Users/dev/project',
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      providerId: 'mock',
    })
    assert.equal(parsed.ok, false, method)
    assert.match(parsed.ok ? '' : parsed.message, /commandId/, method)
  }
})

test('a conversation may be named by its folder, and a folder that is not a path makes no key', () => {
  assert.deepEqual(parseStudioConversationKey(folderKey), folderKey)
  assert.deepEqual(parseStudioConversationKey({ ...key, extra: 1 }), key)
  assert.equal(parseStudioConversationKey({ ...key, workspaceRoot: '' }), null)
  assert.equal(parseStudioConversationKey({ ...key, workspaceRoot: 'a\0b' }), null)
  assert.equal(parseStudioConversationKey({ ...key, workspaceRoot: 7 }), null)
  // Every method and the session stream carry it through, for the router to hold to owners.
  assert.deepEqual(parseStudioMethodParams('conversation.loadEarlier', { key: folderKey, beforeCursor: 3 }), {
    ok: true,
    params: { key: folderKey, beforeCursor: 3 },
  })
  assert.deepEqual(parseStudioTopicParams('conversation.session', { key: folderKey }), {
    ok: true,
    params: { key: folderKey },
  })
  assert.deepEqual(parseStudioTopicParams('conversation.commands', undefined), { ok: true, params: {} })
})

test('a send keeps what the composer sends and drops the rest', () => {
  assert.deepEqual(
    parseStudioMethodParams('session.send', {
      commandId: 'c1',
      sessionId: 's1',
      message: 'look',
      localTurnId: 'turn-1',
      mentions: [{ path: 'src/a.ts', kind: 'file' }],
      skills: [{ id: 'review', sourcePath: '/Users/dev/.skills/review/SKILL.md' }],
      reasoningEffort: 'high',
      mode: 'plan',
      steer: true,
      attachments: [{ id: 'img-1', uploadId: 'u1', name: 'shot.png' }],
      junk: true,
    }),
    {
      ok: true,
      params: {
        commandId: 'c1',
        sessionId: 's1',
        message: 'look',
        localTurnId: 'turn-1',
        mentions: [{ path: 'src/a.ts', kind: 'file' }],
        skills: [{ id: 'review', sourcePath: '/Users/dev/.skills/review/SKILL.md' }],
        reasoningEffort: 'high',
        mode: 'plan',
        steer: true,
        attachments: [{ id: 'img-1', uploadId: 'u1', name: 'shot.png' }],
      },
    },
  )
  const refused = (params: Record<string, unknown>) => {
    const parsed = parseStudioChatParams('session.send', { commandId: 'c', sessionId: 's', message: 'x', ...params })
    return parsed.ok ? null : parsed.code
  }
  assert.equal(refused({ mode: 'yolo' }), 'invalid_params')
  assert.equal(refused({ steer: 'yes' }), 'invalid_params')
  assert.equal(refused({ reasoningEffort: 'very high!' }), 'invalid_params')
  assert.equal(refused({ mentions: ['src/a.ts'] }), 'invalid_params')
  assert.equal(
    refused({ attachments: Array.from({ length: 17 }, (_, i) => ({ id: `i${i}`, uploadId: `u${i}` })) }),
    'invalid_params',
  )
  assert.equal(refused({ message: 'x'.repeat(200_001) }), 'too_large')
})

test('a picture is staged in pieces no larger than a frame holds, of a size and type a send may carry', () => {
  assert.deepEqual(parseStudioChatParams('uploads.begin', { mediaType: 'image/png', byteLength: 10, name: 'a.png' }), {
    ok: true,
    params: { mediaType: 'image/png', byteLength: 10, name: 'a.png' },
  })
  const begin = (params: Record<string, unknown>) => {
    const parsed = parseStudioChatParams('uploads.begin', params)
    return parsed.ok ? null : parsed.code
  }
  assert.equal(begin({ mediaType: 'image/svg+xml', byteLength: 10 }), 'invalid_params')
  assert.equal(begin({ mediaType: 'image/png', byteLength: 0 }), 'invalid_params')
  assert.equal(begin({ mediaType: 'image/png', byteLength: STUDIO_MAX_UPLOAD_BYTES + 1 }), 'too_large')
  const fits = 'A'.repeat(Math.ceil(STUDIO_UPLOAD_CHUNK_BYTES / 3) * 4)
  assert.equal(parseStudioChatParams('uploads.append', { uploadId: 'u', offset: 0, dataBase64: fits }).ok, true)
  const over = parseStudioChatParams('uploads.append', { uploadId: 'u', offset: 0, dataBase64: `${fits}AAAA` })
  assert.equal(over.ok ? null : over.code, 'too_large')
  const notBase64 = parseStudioChatParams('uploads.append', { uploadId: 'u', offset: 0, dataBase64: 'not base64!' })
  assert.equal(notBase64.ok, false)
  assert.deepEqual(parseStudioChatParams('uploads.discard', { uploadIds: ['u1', 'u2'] }), {
    ok: true,
    params: { uploadIds: ['u1', 'u2'] },
  })
  assert.equal(parseStudioChatParams('uploads.discard', { uploadIds: 'u1' }).ok, false)
  assert.equal(parseStudioChatParams('uploads.discard', { uploadIds: Array.from({ length: 33 }, () => 'u') }).ok, false)
})

test('revert, rewind and fork take a conversation and a turn; a fork is from a reply or before a message', () => {
  assert.deepEqual(
    parseStudioChatParams('conversation.revert', {
      commandId: 'c',
      key: folderKey,
      turnSeq: 4,
      confirmed: true,
      files: ['src/a.ts'],
    }),
    { ok: true, params: { commandId: 'c', key: folderKey, turnSeq: 4, confirmed: true, files: ['src/a.ts'] } },
  )
  assert.equal(parseStudioChatParams('conversation.rewind', { commandId: 'c', key, turnSeq: 0 }).ok, false)
  assert.deepEqual(
    parseStudioChatParams('conversation.fork', {
      commandId: 'c',
      key,
      newAgentId: 'a2',
      side: 'assistant',
      turnId: 't',
    }),
    { ok: true, params: { commandId: 'c', key, newAgentId: 'a2', side: 'assistant', turnId: 't' } },
  )
  assert.equal(
    parseStudioChatParams('conversation.fork', { commandId: 'c', key, newAgentId: 'a2', side: 'user' }).ok,
    false,
  )
})

test('the reads around a chat take their own shapes', () => {
  assert.deepEqual(
    parseStudioChatParams('files.search', {
      rootPath: '/Users/dev/project',
      query: 'app',
      limit: 50,
      purpose: 'mention',
      channel: 'mention:1',
      recentAt: { '/Users/dev/project/a.ts': 3, '': 1, '/Users/dev/project/b.ts': 'later' },
    }),
    {
      ok: true,
      params: {
        rootPath: '/Users/dev/project',
        query: 'app',
        limit: 50,
        purpose: 'mention',
        channel: 'mention:1',
        recentAt: { '/Users/dev/project/a.ts': 3 },
      },
    },
  )
  assert.equal(parseStudioChatParams('files.search', { rootPath: '/a', query: 'q', limit: 501 }).ok, false)
  assert.equal(parseStudioChatParams('files.stat', { path: '' }).ok, false)
  assert.deepEqual(
    parseStudioChatParams('providers.list', { cliRuntimes: { codex: { command: '/usr/local/bin/codex' } } }),
    {
      ok: true,
      params: { cliRuntimes: { codex: { command: '/usr/local/bin/codex' } } },
    },
  )
  assert.equal(parseStudioChatParams('providers.list', { cliRuntimes: { codex: 'codex' } }).ok, false)
  assert.equal(parseStudioChatParams('conversation.commands', { cli: 'codex', cwd: '/a', probe: true }).ok, false)
  assert.deepEqual(parseStudioChatParams('workspaces.list', undefined), { ok: true, params: {} })
})

test('a push frame carries its stream’s payload, and one without a payload is broken', () => {
  assert.deepEqual(parseStudioServerFrame({ t: 'push', sub: 'p1', payload: { cli: 'codex' } }), {
    t: 'push',
    sub: 'p1',
    payload: { cli: 'codex' },
  })
  assert.equal(parseStudioServerFrame({ t: 'push', sub: 'p1' }), null)
  assert.deepEqual(
    parseStudioServerFrame({ t: 'res', id: 'r1', ok: false, error: { code: 'owner_required', message: 'No.' } }),
    { t: 'res', id: 'r1', ok: false, error: { code: 'owner_required', message: 'No.' } },
  )
})
