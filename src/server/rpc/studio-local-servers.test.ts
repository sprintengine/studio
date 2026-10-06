import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import type { StudioLocalServer, StudioLocalServersMethodMap } from '../../../packages/studio-protocol/src/public'
import type { LocalServersChanged, StudioLocalServers } from '../local-servers/local-server-domain'
import { connectLineClient, hello, OWNER_TOKEN, pairFakeClient, startTestServer } from './studio-rpc.test-helper'

// `localServers.*` over the owner socket: the capability, the four methods and
// the stream, as a client reads them. The domain behind them is a stub; what
// it decides is local-server-domain.test.ts's.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const CONVERSATION = { workspaceId: 'ws-1', agentId: 'agent-1' }

const SERVER: StudioLocalServer = {
  id: 'srv-1',
  agentId: 'agent-1',
  url: 'http://localhost:5173/',
  title: 'Web',
  port: 5173,
  state: 'running',
  linkedAt: 1,
  stateAt: 2,
  command: 'npm run dev',
  cwd: '/Users/dev/app',
}

function stubLocalServers() {
  const listeners = new Set<(change: LocalServersChanged) => void>()
  let listening: () => void = () => undefined
  const subscribed = new Promise<void>((resolve) => {
    listening = resolve
  })
  const asked: Array<[string, unknown]> = []
  const stub: StudioLocalServers = {
    list: async (target): Promise<StudioLocalServersMethodMap['localServers.list']['result']> => ({
      workspaces: (target.workspaceIds ?? []).includes('ws-1') ? { 'ws-1': [SERVER] } : {},
      conversations: (target.conversations ?? [])
        .filter((key) => key.agentId === 'agent-1')
        .map((key) => ({ ...key, servers: [SERVER] })),
    }),
    run: async (input) => {
      asked.push(['run', input])
      if (input.id === 'srv-1') return { ok: false, code: 'conflict', message: 'This server is already running.' }
      if (input.id === 'srv-bare') return { ok: false, code: 'invalid_params', message: 'No command.' }
      return { ok: true }
    },
    stop: async (input) => {
      asked.push(['stop', input])
      if (input.id === 'srv-agents') return { ok: false, code: 'conflict', message: 'Not ours.' }
      if (input.id === 'srv-none') return { ok: false, code: 'not_found', message: 'None.' }
      return { ok: true, stopped: true }
    },
    remove: async (input) => {
      asked.push(['remove', input])
      return { removed: input.id === 'srv-1' }
    },
    onChanged: (listener) => {
      listeners.add(listener)
      listening()
      return () => listeners.delete(listener)
    },
  }
  return {
    stub,
    asked,
    subscribed,
    emit: (change: LocalServersChanged) => listeners.forEach((listener) => listener(change)),
  }
}

async function ownerOver(localServers?: StudioLocalServers) {
  const started = await startTestServer(localServers ? { localServers } : {})
  cleanups.push(() => started.dispose())
  const owner = await connectLineClient(started.path)
  cleanups.push(() => owner.close())
  owner.send(hello({ token: OWNER_TOKEN }))
  const welcome = await owner.next((frame) => frame.t === 'welcome')
  let seq = 0
  const request = async (method: string, params: unknown) => {
    const id = `r${++seq}`
    owner.send({ t: 'req', id, method, params })
    return owner.next((frame) => frame.t === 'res' && frame.id === id)
  }
  return { started, owner, welcome, request }
}

const codeOf = (frame: { t: string; ok?: boolean; error?: { code: string } }) =>
  frame.t === 'res' && !frame.ok ? frame.error?.code : null

test('a Studio with local servers advertises them, and one without does not', async () => {
  const withThem = await ownerOver(stubLocalServers().stub)
  assert.equal(withThem.welcome.t === 'welcome' && withThem.welcome.capabilities.includes('local-servers'), true)
  const without = await ownerOver()
  assert.equal(without.welcome.t === 'welcome' && without.welcome.capabilities.includes('local-servers'), false)
  const refused = await without.request('localServers.list', { workspaceIds: ['ws-1'] })
  assert.equal(codeOf(refused), 'unavailable')
})

test('an owner lists by workspace and by conversation, and malformed params are refused', async () => {
  const { stub } = stubLocalServers()
  const { request } = await ownerOver(stub)
  const listed = await request('localServers.list', {
    workspaceIds: ['ws-1', 'ws-2'],
    conversations: [CONVERSATION, { workspaceId: 'ws-1', agentId: 'agent-2' }],
  })
  const result =
    listed.t === 'res' && listed.ok
      ? (listed.result as StudioLocalServersMethodMap['localServers.list']['result'])
      : null
  assert.deepEqual(Object.keys(result?.workspaces ?? {}), ['ws-1'])
  assert.deepEqual(result?.conversations, [{ ...CONVERSATION, servers: [SERVER] }])

  for (const [method, params] of [
    ['localServers.list', { workspaceIds: 'ws-1' }],
    ['localServers.list', { conversations: [{ workspaceId: 'ws-1' }] }],
    ['localServers.run', { id: 'srv-1' }],
    ['localServers.run', { conversation: CONVERSATION }],
    ['localServers.stop', { conversation: CONVERSATION, id: '' }],
    ['localServers.remove', { conversation: { agentId: 'agent-1' }, id: 'srv-1' }],
  ] as const) {
    const refused = await request(method, params)
    assert.deepEqual([method, codeOf(refused)], [method, 'invalid_params'])
  }
})

test('run, stop and remove reach the domain, and its refusals keep their codes', async () => {
  const { stub, asked } = stubLocalServers()
  const { request } = await ownerOver(stub)
  const ran = await request('localServers.run', { conversation: CONVERSATION, id: 'srv-2', extra: 'dropped' })
  assert.deepEqual(ran.t === 'res' && ran.ok && ran.result, { started: true })
  assert.deepEqual(asked[0], ['run', { conversation: CONVERSATION, id: 'srv-2' }])
  assert.equal(codeOf(await request('localServers.run', { conversation: CONVERSATION, id: 'srv-1' })), 'conflict')
  assert.equal(
    codeOf(await request('localServers.run', { conversation: CONVERSATION, id: 'srv-bare' })),
    'invalid_params',
  )

  const stopped = await request('localServers.stop', { conversation: CONVERSATION, id: 'srv-2' })
  assert.deepEqual(stopped.t === 'res' && stopped.ok && stopped.result, { stopped: true })
  assert.equal(codeOf(await request('localServers.stop', { conversation: CONVERSATION, id: 'srv-agents' })), 'conflict')
  assert.equal(codeOf(await request('localServers.stop', { conversation: CONVERSATION, id: 'srv-none' })), 'not_found')

  const removed = await request('localServers.remove', { conversation: CONVERSATION, id: 'srv-1' })
  assert.deepEqual(removed.t === 'res' && removed.ok && removed.result, { removed: true })
  const none = await request('localServers.remove', { conversation: CONVERSATION, id: 'srv-9' })
  assert.deepEqual(none.t === 'res' && none.ok && none.result, { removed: false })
})

test('a paired app is refused, whatever it holds', async () => {
  const { stub, asked } = stubLocalServers()
  const { started } = await ownerOver(stub)
  const app = await connectLineClient(started.path)
  cleanups.push(() => app.close())
  app.send(
    hello({
      token: pairFakeClient(started.auth, 'app', ['workspaces:read', 'conversation:read', 'conversation:operate']),
    }),
  )
  await app.next((frame) => frame.t === 'welcome')
  app.send({ t: 'req', id: 'a1', method: 'localServers.run', params: { conversation: CONVERSATION, id: 'srv-2' } })
  const refused = await app.next((frame) => frame.t === 'res' && frame.id === 'a1')
  assert.equal(codeOf(refused), 'owner_required')
  app.send({ t: 'sub', id: 's1', topic: 'localServers.changed', params: {} })
  const failed = await app.next((frame) => frame.t === 'subFailed' && frame.sub === 's1')
  assert.equal(failed.t === 'subFailed' && failed.code, 'owner_required')
  assert.deepEqual(asked, [])
})

test('the stream names what moved, never the lists', async () => {
  const { stub, emit, subscribed } = stubLocalServers()
  const { owner } = await ownerOver(stub)
  owner.send({ t: 'sub', id: 's1', topic: 'localServers.changed' })
  await subscribed
  emit({ workspaceIds: ['ws-1'], conversations: [CONVERSATION] })
  const pushed = await owner.next((frame) => frame.t === 'push' && frame.sub === 's1')
  assert.deepEqual(pushed.t === 'push' && pushed.payload, { workspaceIds: ['ws-1'], conversations: [CONVERSATION] })
})
