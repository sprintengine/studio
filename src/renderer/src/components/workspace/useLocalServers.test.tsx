// @vitest-environment jsdom
//
// The open chat's strip and the sidebar's rows read the local servers agents
// started from the Studio, over the window's own client: asked on mount, again
// (once per burst) when the server names what moved and when the connection
// comes back, and an answer that reads the same commits nothing. The actions
// never throw.
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { StudioLocalServer } from '../../../../../packages/studio-protocol/src/public'

type Listener = { onPayload: () => void }

const studio = vi.hoisted(() => ({
  supports: true,
  requests: [] as Array<{ method: string; params: unknown }>,
  answer: (_method: string, _params: unknown): unknown => ({ workspaces: {}, conversations: [] }),
  topics: new Map<string, Set<Listener>>(),
  watchers: new Set<() => void>(),
  state: 'open',
}))

vi.mock('../../studio/windowStudioClient', () => {
  const client = {
    supports: () => studio.supports,
    request: async (method: string, params: unknown) => {
      studio.requests.push({ method, params })
      return studio.answer(method, params)
    },
    subscribe: (topic: string, _params: unknown, listener: Listener) => {
      const set = studio.topics.get(topic) ?? new Set<Listener>()
      studio.topics.set(topic, set)
      set.add(listener)
      return () => set.delete(listener)
    },
  }
  return {
    windowStudioClient: async () => client,
    windowStudioState: () => studio.state,
    watchWindowStudio: (_api: object, listener: () => void) => {
      studio.watchers.add(listener)
      return () => studio.watchers.delete(listener)
    },
  }
})

const {
  removeLocalServer,
  runLocalServer,
  sameLocalServerList,
  stopLocalServer,
  useLocalServersOfConversation,
  useWorkspaceLocalServers,
} = await import('./useLocalServers')

function server(overrides: Partial<StudioLocalServer> = {}): StudioLocalServer {
  return {
    id: 'srv-1',
    agentId: 'agent-1',
    url: 'http://localhost:5173/',
    title: 'localhost:5173',
    port: 5173,
    state: 'running',
    linkedAt: 1,
    stateAt: 1,
    command: 'npm run dev',
    cwd: '/Users/dev/app',
    ...overrides,
  }
}

const CONVERSATION = { workspaceId: 'ws-1', agentId: 'agent-1' }

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { api: unknown }).api = { studioConnect: () => undefined }
  studio.supports = true
  studio.requests.length = 0
  studio.topics.clear()
  studio.watchers.clear()
  studio.state = 'open'
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
  vi.useRealTimers()
})

async function render(node: React.ReactNode): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(node))
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await act(async () => await Promise.resolve())
}

function push(topic = 'localServers.changed'): void {
  for (const listener of studio.topics.get(topic) ?? []) listener.onPayload()
}

/** The conversation's answer, from a table the test edits. */
function answerConversation(list: () => StudioLocalServer[]): void {
  studio.answer = (_method, params) => {
    const conversations = (params as { conversations?: Array<{ workspaceId: string; agentId: string }> }).conversations
    return {
      workspaces: {},
      conversations: (conversations ?? []).map((owner) => ({ ...owner, servers: list() })),
    }
  }
}

function ConversationProbe({
  conversation,
  seen,
}: {
  conversation: { workspaceId: string; agentId: string } | null
  seen: Array<readonly StudioLocalServer[]>
}) {
  seen.push(useLocalServersOfConversation(conversation))
  return null
}

test('a conversation is asked about by conversation, and its servers come back', async () => {
  answerConversation(() => [server()])
  const seen: Array<readonly StudioLocalServer[]> = []
  await render(<ConversationProbe conversation={CONVERSATION} seen={seen} />)
  await settle()
  expect(studio.requests[0]).toEqual({ method: 'localServers.list', params: { conversations: [CONVERSATION] } })
  expect(seen.at(-1)?.map((entry) => entry.id)).toEqual(['srv-1'])
})

test('no conversation (a chat on a paired machine) asks nothing', async () => {
  const seen: Array<readonly StudioLocalServer[]> = []
  await render(<ConversationProbe conversation={null} seen={seen} />)
  await settle()
  expect(studio.requests).toEqual([])
  expect(seen.at(-1)).toEqual([])
})

test('a Studio without the local-servers capability is not asked', async () => {
  studio.supports = false
  const seen: Array<readonly StudioLocalServer[]> = []
  await render(<ConversationProbe conversation={CONVERSATION} seen={seen} />)
  await settle()
  expect(studio.requests).toEqual([])
  expect(seen.at(-1)).toEqual([])
})

test('a push asks again, once for a burst, and the new state is drawn', async () => {
  let state: StudioLocalServer['state'] = 'running'
  answerConversation(() => [server({ state })])
  const seen: Array<readonly StudioLocalServer[]> = []
  await render(<ConversationProbe conversation={CONVERSATION} seen={seen} />)
  await settle()
  expect(studio.topics.get('localServers.changed')?.size).toBe(1)

  vi.useFakeTimers()
  state = 'stopped'
  push()
  push()
  push()
  await act(async () => vi.advanceTimersByTime(300))
  vi.useRealTimers()
  await settle()
  expect(studio.requests.length).toBe(2)
  expect(seen.at(-1)?.[0].state).toBe('stopped')
})

test('an answer that reads the same commits nothing: the list keeps its identity', async () => {
  let stateAt = 1
  answerConversation(() => [server({ stateAt })])
  const seen: Array<readonly StudioLocalServer[]> = []
  await render(<ConversationProbe conversation={CONVERSATION} seen={seen} />)
  await settle()
  const first = seen.at(-1)

  // A check that found nothing new still stamps `stateAt`.
  stateAt = 2
  vi.useFakeTimers()
  push()
  await act(async () => vi.advanceTimersByTime(300))
  vi.useRealTimers()
  await settle()
  expect(studio.requests.length).toBe(2)
  // The same list, so nothing downstream (a memoized strip, a row) is drawn again.
  expect(seen.at(-1)).toBe(first)
})

test('the connection coming back asks again', async () => {
  answerConversation(() => [server()])
  await render(<ConversationProbe conversation={CONVERSATION} seen={[]} />)
  await settle()
  const before = studio.requests.length

  vi.useFakeTimers()
  for (const watcher of studio.watchers) watcher()
  await act(async () => vi.advanceTimersByTime(300))
  vi.useRealTimers()
  await settle()
  expect(studio.requests.length).toBe(before + 1)
})

test('workspaces are asked about by id, and an unchanged workspace keeps its list', async () => {
  const lists: Record<string, StudioLocalServer[]> = {
    'ws-1': [server()],
    'ws-2': [server({ id: 'srv-2', port: 6006, url: 'http://localhost:6006/', title: 'Storybook' })],
  }
  studio.answer = (_method, params) => {
    const ids = (params as { workspaceIds: string[] }).workspaceIds
    return {
      workspaces: Object.fromEntries(ids.filter((id) => lists[id]).map((id) => [id, lists[id]])),
      conversations: [],
    }
  }
  const seen: Array<Readonly<Record<string, readonly StudioLocalServer[]>>> = []
  function Probe({ ids }: { ids: string[] }) {
    seen.push(useWorkspaceLocalServers(ids))
    return null
  }
  await render(<Probe ids={['ws-1', 'ws-2', 'ws-3']} />)
  await settle()
  expect(studio.requests[0]).toEqual({
    method: 'localServers.list',
    params: { workspaceIds: ['ws-1', 'ws-2', 'ws-3'] },
  })
  const first = seen.at(-1)!
  expect(Object.keys(first).sort()).toEqual(['ws-1', 'ws-2'])

  lists['ws-2'] = [{ ...lists['ws-2'][0], state: 'stopped' }]
  lists['ws-1'] = [{ ...lists['ws-1'][0] }]
  vi.useFakeTimers()
  push()
  await act(async () => vi.advanceTimersByTime(300))
  vi.useRealTimers()
  await settle()
  const next = seen.at(-1)!
  expect(next).not.toBe(first)
  expect(next['ws-1']).toBe(first['ws-1'])
  expect(next['ws-2'][0].state).toBe('stopped')
})

test('run, stop and remove name the conversation and the server', async () => {
  studio.answer = () => ({ started: true })
  expect(await runLocalServer(CONVERSATION, 'srv-1')).toEqual({ ok: true })
  expect(await stopLocalServer(CONVERSATION, 'srv-1')).toEqual({ ok: true })
  expect(await removeLocalServer(CONVERSATION, 'srv-1')).toEqual({ ok: true })
  expect(studio.requests).toEqual([
    { method: 'localServers.run', params: { conversation: CONVERSATION, id: 'srv-1' } },
    { method: 'localServers.stop', params: { conversation: CONVERSATION, id: 'srv-1' } },
    { method: 'localServers.remove', params: { conversation: CONVERSATION, id: 'srv-1' } },
  ])
})

test('an action the Studio refuses answers its message instead of throwing', async () => {
  studio.answer = () => {
    throw new Error('it is already running')
  }
  const result = await runLocalServer(CONVERSATION, 'srv-1')
  expect(result.ok).toBe(false)
  expect(!result.ok && result.message).toContain('it is already running')

  studio.supports = false
  const unsupported = await stopLocalServer(CONVERSATION, 'srv-1')
  expect(unsupported.ok).toBe(false)
})

test('two lists are the same when everything drawn is, and differ on any of it', () => {
  const base = server({ lastExit: { code: 1, at: 5, output: 'boom' }, state: 'stopped' })
  expect(sameLocalServerList([base], [{ ...base, stateAt: 99 }])).toBe(true)
  expect(sameLocalServerList([base], [{ ...base, state: 'running' }])).toBe(false)
  expect(sameLocalServerList([base], [{ ...base, title: 'Docs' }])).toBe(false)
  expect(sameLocalServerList([base], [{ ...base, url: 'http://localhost:5174/' }])).toBe(false)
  // Another agent took the address over: the row's actions must name it.
  expect(sameLocalServerList([base], [{ ...base, agentId: 'agent-2' }])).toBe(false)
  expect(sameLocalServerList([base], [{ ...base, cwd: '/Users/dev/other' }])).toBe(false)
  expect(sameLocalServerList([base], [{ ...base, command: undefined }])).toBe(false)
  expect(sameLocalServerList([base], [{ ...base, startedByStudio: true }])).toBe(false)
  expect(sameLocalServerList([base], [{ ...base, lastExit: { code: 1, at: 6, output: 'boom' } }])).toBe(false)
  expect(sameLocalServerList([base], [])).toBe(false)
})
