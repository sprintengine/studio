import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import type { RemoteConversationBackend } from '../wsl/backend-wire'
import type { ConversationBackend } from './conversation-backend'
import { createRoutedConversationBackend, type SshRoutedConnection } from './routed-conversation-backend'

// The router with an SSH machine (phase 8): a workspace recorded on one runs
// its chats there on any platform, with its paths as they are, and a call
// that carries a command id is sent again once a dropped session is back,
// where the server's receipts answer it once.

type Call = { member: string; args: unknown[] }

function fakeBackend(
  name: string,
  behave: (member: string, args: unknown[]) => unknown = () => ({ ok: true, from: name }),
) {
  const calls: Call[] = []
  const listeners = new Set<(event: ConversationEvent) => void>()
  let open = true
  const backend = new Proxy(
    {},
    {
      get(_target, member: string) {
        if (member === 'then') return undefined
        if (member === 'onEvent')
          return (listener: (event: ConversationEvent) => void) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          }
        if (member === 'listSessions') return () => ({ ok: true, sessions: [] })
        if (member === 'listLiveConversationRoots') return () => []
        if (member === 'isOpen') return () => open
        return async (...args: unknown[]) => {
          calls.push({ member, args })
          return behave(member, args)
        }
      },
    },
  )
  return {
    backend: backend as ConversationBackend & RemoteConversationBackend,
    calls,
    emit: (event: ConversationEvent) => listeners.forEach((listener) => listener(event)),
    drop: () => (open = false),
  }
}

function setup() {
  const local = fakeBackend('local')
  let first = true
  const dropped = fakeBackend('ssh-1', () => {
    // The first wire goes down under the call.
    dropped.drop()
    throw new Error('The connection closed.')
  })
  const back = fakeBackend('ssh-2', (member) => ({ ok: true, from: 'ssh-2', member }))
  let current: SshRoutedConnection = { key: 'ssh:e1', label: 'build-box', backend: dropped.backend }
  const connects: string[] = []
  const router = createRoutedConversationBackend({
    local: local.backend,
    workspace: (id) =>
      id === 'ws-ssh'
        ? { folderPath: '/home/dev/repo', environment: { kind: 'ssh', id: 'e1' } }
        : { folderPath: '/Users/dev/repo' },
    chatServerOn: () => false,
    servers: null,
    ssh: {
      connect: async (key) => {
        connects.push(key)
        if (!first) current = { key: 'ssh:e1', label: 'build-box', backend: back.backend }
        first = false
        return current
      },
      current: () => current,
      touch: () => undefined,
    },
    platform: 'darwin',
  })
  return { router, local, dropped, back, connects }
}

test('a workspace on an SSH machine runs there on any platform; others stay here', async () => {
  const { router, local, back, connects } = setup()
  assert.equal(router.routeOf('ws-ssh'), 'ssh:e1')
  assert.equal(router.routeOf('ws-mac'), null)
  await router.listThreads({ workspaceId: 'ws-mac', workspaceRoot: '/Users/dev/repo' } as never)
  assert.equal(local.calls[0]?.member, 'listThreads')
  assert.equal(connects.length, 0, 'nothing reaches for the machine for a local workspace')
  // The first wire fails a call with no command id: it is not repeated, and fails in words.
  const result = (await router.readTranscript({
    workspaceId: 'ws-ssh',
    workspaceRoot: '/home/dev/repo',
    agentId: 'a',
  } as never)) as {
    ok: boolean
    message?: string
  }
  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /connection closed/u)
  assert.equal(back.calls.length, 0)
})

test('a command lost with the session is sent again once it is back, with its id and its paths unchanged', async () => {
  const { router, dropped, back, connects } = setup()
  const started = (await router.startSession({
    workspaceId: 'ws-ssh',
    agentId: 'a',
    workspaceRoot: '/home/dev/repo',
    commandId: 'c-start',
  } as never)) as { ok: boolean; from?: string }
  assert.equal(started.ok, true)
  assert.equal(started.from, 'ssh-2')
  assert.equal(dropped.calls.length, 1)
  assert.equal(back.calls.length, 1)
  assert.deepEqual(back.calls[0]?.args[0], {
    workspaceId: 'ws-ssh',
    agentId: 'a',
    workspaceRoot: '/home/dev/repo',
    commandId: 'c-start',
  })
  assert.deepEqual(connects, ['ssh:e1', 'ssh:e1'])
})

test("a remote machine's events reach every caller", async () => {
  const { router, back } = setup()
  const seen: string[] = []
  router.onEvent((event) => seen.push(event.type))
  router.attach({ key: 'ssh:e1', label: 'build-box', backend: back.backend })
  back.emit({ type: 'turn_started', sessionId: 's', workspaceId: 'ws-ssh', agentId: 'a' } as ConversationEvent)
  assert.deepEqual(seen, ['turn_started'])
})

test("a turn sent with no command id (a window's IPC sends none) is given one; a read is not", async () => {
  const local = fakeBackend('local')
  const machine = fakeBackend('ssh', (member) =>
    member === 'startSession' ? { ok: true, session: { sessionId: 'remote-1' } } : { ok: true, from: 'ssh' },
  )
  const connection: SshRoutedConnection = { key: 'ssh:e1', label: 'build-box', backend: machine.backend }
  const router = createRoutedConversationBackend({
    local: local.backend,
    workspace: () => ({ folderPath: '/home/dev/repo', environment: { kind: 'ssh', id: 'e1' } }),
    chatServerOn: () => false,
    ssh: { connect: async () => connection, current: () => connection, touch: () => undefined },
    platform: 'linux',
  })
  await router.startSession({ workspaceId: 'ws-ssh', agentId: 'a', workspaceRoot: '/home/dev/repo' } as never)
  await router.sendTurn({ sessionId: 'remote-1', message: 'hello' } as never)
  const sent = machine.calls.find((call) => call.member === 'sendTurn')
  assert.match(String((sent?.args[0] as { commandId?: string }).commandId), /^route-/u)
  await router.sendTurn({ sessionId: 'remote-1', message: 'again', commandId: 'mine' } as never)
  assert.equal((machine.calls.at(-1)?.args[0] as { commandId?: string }).commandId, 'mine', 'a given id is kept')
  await router.readTranscript({ workspaceId: 'ws-ssh', agentId: 'a', workspaceRoot: '/home/dev/repo' } as never)
  assert.equal((machine.calls.at(-1)?.args[0] as { commandId?: string }).commandId, undefined, 'a read carries none')
  assert.equal(local.calls.length, 0)
})
