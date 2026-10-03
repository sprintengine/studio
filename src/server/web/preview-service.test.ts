import { afterEach, beforeEach, expect, test } from 'vitest'

import type { PreviewProxy, PreviewProxyOptions } from './preview-proxy'
import { MAX_PREVIEWS_PER_SESSION, PREVIEW_IDLE_MS, createPreviewService, type PreviewService } from './preview-service'

// Fake proxies: the service's rules are tested here, the listener in
// preview-proxy.test.ts.
let clock: number
let started: PreviewProxyOptions[]
let stopped: string[]
let lastUsed: Map<string, number>
let service: PreviewService

function fakeProxy(options: PreviewProxyOptions): PreviewProxy {
  started.push(options)
  lastUsed.set(options.previewId, clock)
  let codes = 0
  return {
    start: async () => ({ port: 50_000 + started.length }),
    port: () => 50_000 + started.length,
    origin: (name = '127.0.0.1') => `http://${name}:${50_000 + started.length}`,
    mintEnterCode: (name = '127.0.0.1') => ({
      code: `code-${++codes}`,
      enterUrl: `http://${name}/enter-${options.previewId}-${codes}`,
      expiresAt: clock,
    }),
    lastUsedAt: () => lastUsed.get(options.previewId) ?? clock,
    stop: async () => void stopped.push(options.previewId),
  }
}

beforeEach(() => {
  clock = 0
  started = []
  stopped = []
  lastUsed = new Map()
  service = createPreviewService({
    ownPorts: () => [4791],
    studioOrigins: () => ['http://127.0.0.1:4791'],
    listPorts: async () => [{ port: 5173, pid: 300, command: 'node vite' }],
    createProxy: fakeProxy,
    now: () => clock,
    idleCheckMs: 5,
  })
})
afterEach(() => service.stop())

test('a port an agent listens on opens, and the service lists it', async () => {
  expect((await service.list()).ports.map((entry) => entry.port)).toEqual([5173])
  const opened = await service.open({ port: 5173, sessionId: 'session-a' })
  expect(opened.ok).toBe(true)
  expect(started[0]).toMatchObject({ targetPort: 5173, studioOrigins: ['http://127.0.0.1:4791'] })
})

test('a port nobody listed opens only when the owner typed it', async () => {
  expect((await service.open({ port: 8080, sessionId: 'session-a' })).ok).toBe(false)
  expect((await service.open({ port: 8080, sessionId: 'session-a', typed: true })).ok).toBe(true)
})

test('a port under 1024 and the server’s own port are refused, typed or not', async () => {
  expect((await service.open({ port: 80, sessionId: 'session-a', typed: true })).ok).toBe(false)
  expect((await service.open({ port: 4791, sessionId: 'session-a', typed: true })).ok).toBe(false)
  expect((await service.open({ port: '5173', sessionId: 'session-a' })).ok).toBe(false)
  expect(started).toHaveLength(0)
})

test('the ninth preview in a session is refused with a sentence', async () => {
  for (let index = 0; index < MAX_PREVIEWS_PER_SESSION; index++) {
    expect((await service.open({ port: 3000 + index, sessionId: 'session-a', typed: true })).ok).toBe(true)
  }
  const ninth = await service.open({ port: 4000, sessionId: 'session-a', typed: true })
  expect(ninth.ok === false && ninth.message).toMatch(/8 previews open/u)
  // Another session has its own eight.
  expect((await service.open({ port: 4000, sessionId: 'session-b', typed: true })).ok).toBe(true)
})

test('the same port twice is one preview with a fresh way in', async () => {
  const first = await service.open({ port: 5173, sessionId: 'session-a' })
  const second = await service.open({ port: 5173, sessionId: 'session-a' })
  expect(first.ok && second.ok && first.previewId === second.previewId).toBe(true)
  expect(first.ok && second.ok && first.enterUrl !== second.enterUrl).toBe(true)
  expect(started).toHaveLength(1)
})

test('a preview closes after thirty minutes with no request, and its session hears it', async () => {
  const heard: number[] = []
  service.onChanged((_session, previews) => heard.push(previews.length))
  await service.open({ port: 5173, sessionId: 'session-a' })
  clock = PREVIEW_IDLE_MS - 1
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(service.previewsOf('session-a')).toHaveLength(1)
  clock = PREVIEW_IDLE_MS
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(service.previewsOf('session-a')).toHaveLength(0)
  expect(stopped).toHaveLength(1)
  expect(heard).toEqual([1, 0])
})

test('closing a session closes all of its previews, and no one else’s', async () => {
  await service.open({ port: 5173, sessionId: 'session-a' })
  await service.open({ port: 8080, sessionId: 'session-a', typed: true })
  await service.open({ port: 8080, sessionId: 'session-b', typed: true })
  await service.closeSession('session-a')
  expect(service.previewsOf('session-a')).toHaveLength(0)
  expect(service.previewsOf('session-b')).toHaveLength(1)
  expect(stopped).toHaveLength(2)
})

test('a session cannot close another session’s preview', async () => {
  const opened = await service.open({ port: 5173, sessionId: 'session-a' })
  if (!opened.ok) throw new Error('not opened')
  expect(await service.close(opened.previewId, 'session-b')).toBe(false)
  expect(await service.close(opened.previewId, 'session-a')).toBe(true)
})

test('a tab opened on localhost gets its preview on localhost, the site it is on', async () => {
  const opened = await service.open({ port: 5173, sessionId: 'session-a', name: 'localhost' })
  expect(opened).toMatchObject({ ok: true, origin: 'http://localhost:50001' })
  expect(opened.ok && opened.enterUrl.startsWith('http://localhost/')).toBe(true)
  expect(service.previewsOf('session-a')[0].origin).toBe('http://localhost:50001')
})
