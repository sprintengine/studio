import assert from 'node:assert/strict'
import { test } from 'vitest'

import { chatLinkFor, chatLinkFromArgv, parseDeepLink } from './deep-link'

const chat = (chatId: string, agentId: string | null = null) => ({ kind: 'chat', chatId, agentId })

test('a chat link names its chat, and its agent when it has one', () => {
  assert.deepEqual(parseDeepLink('sprintengine://chat/V1StGXR8_Z5jdHi6B-myT'), chat('V1StGXR8_Z5jdHi6B-myT'))
  assert.deepEqual(
    parseDeepLink('sprintengine://chat/ws-1?agent=agent-claude-0a1b2c3d4e5f6g7h'),
    chat('ws-1', 'agent-claude-0a1b2c3d4e5f6g7h'),
  )
})

test('scheme and host are read in any case, the ids exactly as written', () => {
  assert.deepEqual(parseDeepLink('SprintEngine://CHAT/AbC'), chat('AbC'))
})

test('the trailing slash a browser on Windows adds is allowed', () => {
  assert.deepEqual(parseDeepLink('sprintengine://chat/ws-1/'), chat('ws-1'))
  assert.deepEqual(parseDeepLink('sprintengine://chat/ws-1/?agent=a1'), chat('ws-1', 'a1'))
})

test('other parameters and a fragment are ignored, never acted on', () => {
  assert.deepEqual(
    parseDeepLink('sprintengine://chat/ws-1?prompt=rm%20-rf%20~&send=1&agent=a1#top'),
    chat('ws-1', 'a1'),
  )
})

test('an agent that is not a plain id, or is named twice, is dropped and the chat still opens', () => {
  assert.deepEqual(parseDeepLink('sprintengine://chat/ws-1?agent=../../etc'), chat('ws-1'))
  assert.deepEqual(parseDeepLink('sprintengine://chat/ws-1?agent='), chat('ws-1'))
  assert.deepEqual(parseDeepLink('sprintengine://chat/ws-1?agent=a1&agent=a2'), chat('ws-1'))
  assert.deepEqual(parseDeepLink('sprintengine://chat/ws-1?agent=a%20b'), chat('ws-1'))
})

test('the sign-in callback is recognised as auth and nothing else', () => {
  assert.deepEqual(parseDeepLink('sprintengine://auth/callback?code=abc&state=xyz'), { kind: 'auth' })
  assert.deepEqual(parseDeepLink('sprintengine://auth/callback'), { kind: 'auth' })
  assert.equal(parseDeepLink('sprintengine://auth/other'), null)
  assert.equal(chatLinkFromArgv(['/Applications/app', 'sprintengine://auth/callback?code=abc']), null)
})

test('a host or path the app does not answer is refused', () => {
  for (const raw of [
    'sprintengine://new?project=/Users/dev/app&prompt=hello',
    'sprintengine://chat',
    'sprintengine://chat/',
    'sprintengine://chat/ws-1/agent-1',
    'sprintengine://chats/ws-1',
    'sprintengine:chat/ws-1',
    'sprintengine:///chat/ws-1',
  ]) {
    assert.equal(parseDeepLink(raw), null, raw)
  }
})

test('another scheme is refused', () => {
  for (const raw of ['https://chat/ws-1', 'file:///chat/ws-1', 'javascript://chat/ws-1', 'sprintengine2://chat/ws-1']) {
    assert.equal(parseDeepLink(raw), null, raw)
  }
})

test('an id that could mean something to a shell or a file system is refused', () => {
  for (const raw of [
    'sprintengine://chat/..',
    'sprintengine://chat/../../etc/passwd',
    'sprintengine://chat/ws-1/../ws-2',
    'sprintengine://chat/%2e%2e',
    'sprintengine://chat/ws%2F1',
    'sprintengine://chat/ws-1;rm',
    'sprintengine://chat/$(id)',
    'sprintengine://chat/`id`',
    'sprintengine://chat/ws"1',
    "sprintengine://chat/ws'1",
    'sprintengine://chat/ws.1',
    'sprintengine://chat/ws\\1',
    `sprintengine://chat/${'a'.repeat(129)}`,
  ]) {
    assert.equal(parseDeepLink(raw), null, raw)
  }
})

test('a user, password or port in the authority is refused', () => {
  for (const raw of [
    'sprintengine://evil@chat/ws-1',
    'sprintengine://user:pass@chat/ws-1',
    'sprintengine://chat:80/ws-1',
    'sprintengine://chat.example.com/ws-1',
  ]) {
    assert.equal(parseDeepLink(raw), null, raw)
  }
})

test('whitespace, control characters and oversized links are refused', () => {
  for (const raw of [
    ' sprintengine://chat/ws-1',
    'sprintengine://chat/ws-1 ',
    'sprintengine://chat/ws 1',
    'sprintengine://chat/ws-1\n--inspect',
    'sprintengine://chat/ws-1\u0000',
    'sprintengine://chat/ws-1\u007f',
    `sprintengine://chat/ws-1?pad=${'x'.repeat(2048)}`,
    '',
  ]) {
    assert.equal(parseDeepLink(raw), null, JSON.stringify(raw))
  }
})

test('anything that is not a string is refused', () => {
  for (const raw of [undefined, null, 42, {}, ['sprintengine://chat/ws-1']]) {
    assert.equal(parseDeepLink(raw), null)
  }
})

test('a launch hands its link over among other arguments', () => {
  assert.deepEqual(
    chatLinkFromArgv([
      'C:\\Program Files\\SprintEngine Studio\\SprintEngine Studio.exe',
      '--allow-file-access-from-files',
      'sprintengine://chat/ws-1?agent=a1',
    ]),
    chat('ws-1', 'a1'),
  )
  assert.equal(chatLinkFromArgv(['/opt/app/sprintengine', '--no-sandbox']), null)
  assert.equal(chatLinkFromArgv([]), null)
})

test('the link the app writes is the link it reads', () => {
  const link = chatLinkFor('V1StGXR8_Z5jdHi6B-myT')
  assert.equal(link, 'sprintengine://chat/V1StGXR8_Z5jdHi6B-myT')
  assert.deepEqual(parseDeepLink(link), chat('V1StGXR8_Z5jdHi6B-myT'))
  const withAgent = chatLinkFor('ws-1', 'agent-codex-0a1b2c3d4e5f6g7h')
  assert.equal(withAgent, 'sprintengine://chat/ws-1?agent=agent-codex-0a1b2c3d4e5f6g7h')
  assert.deepEqual(parseDeepLink(withAgent), chat('ws-1', 'agent-codex-0a1b2c3d4e5f6g7h'))
})

test('no link is written for an id a link cannot carry', () => {
  assert.equal(chatLinkFor('ws.legacy'), null)
  assert.equal(chatLinkFor(''), null)
  assert.equal(chatLinkFor('ws-1', 'agent/1'), null)
})
