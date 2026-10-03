import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

import { blocksForeignLoopback, environmentPartition, PanePartitions, type PaneRequest } from './pane-partitions'

// Which partition a workspace's tabs use, and the life of the forward behind
// an SSH machine's: opened for its first tab, its proxy set before the tab is
// made, closed after its last, and its credential given only to its own
// partition for its own port.

function harness(traffic: 'all' | 'loopback' | 'off' = 'all') {
  const proxies: Array<{ partition: string; proxyRules: string; proxyBypassRules: string }> = []
  const cleared: string[] = []
  const guards = new Map<string, (details: PaneRequest) => boolean>()
  const panes = new PanePartitions({
    machineOf: (workspaceId) => (workspaceId === 'ws-ssh' ? { id: 'e1', label: 'build-box' } : null),
    environmentIdOf: () => 'env-1234',
    traffic: () => traffic,
    current: () => null,
    connect: async () => false,
    sessionFor: (partition) => ({
      setProxy: async (config) => void proxies.push({ partition, ...config }),
      clearStorageData: async () => void cleared.push(partition),
      webRequest: {
        onBeforeRequest: (listener) =>
          void guards.set(partition, (details) => {
            let cancelled = false
            listener(details, (response) => (cancelled = response.cancel))
            return cancelled
          }),
      },
    }),
    closeDelayMs: 20,
  })
  return { panes, proxies, cleared, guards }
}

test("a machine's tabs get its partition, its proxy set to its forward, loopback included", async () => {
  const { panes, proxies } = harness()
  assert.equal(await panes.forWorkspace('ws-local'), null, "this computer's workspace keeps its partition")
  const config = await panes.forWorkspace('ws-ssh')
  assert.deepEqual(config, { partition: 'persist:env-env-1234', label: 'build-box' })
  assert.equal(proxies.length, 1)
  assert.match(proxies[0]!.proxyRules, /^127\.0\.0\.1:\d+$/u)
  assert.equal(proxies[0]!.proxyBypassRules, '<-loopback>')
  assert.ok(panes.isPrepared('persist:env-env-1234'))
  assert.ok(!panes.isPrepared('persist:env-other'))
  const port = Number(proxies[0]!.proxyRules.split(':')[1])

  // The credential: only for that partition, only for its own port, only for a proxy.
  assert.ok(panes.answerLogin('persist:env-env-1234', { isProxy: true, host: '127.0.0.1', port }))
  assert.equal(panes.answerLogin('persist:sprintengine-browser', { isProxy: true, host: '127.0.0.1', port }), null)
  assert.equal(panes.answerLogin('persist:env-env-1234', { isProxy: true, host: '127.0.0.1', port: port + 1 }), null)
  assert.equal(panes.answerLogin('persist:env-env-1234', { isProxy: false, host: '127.0.0.1', port }), null)

  // Open while a tab is; closed a moment after the last.
  vi.useFakeTimers()
  try {
    panes.tabOpened('persist:env-env-1234', 't1')
    await vi.advanceTimersByTimeAsync(60)
    assert.ok(panes.answerLogin('persist:env-env-1234', { isProxy: true, host: '127.0.0.1', port }), 'still open')
    panes.tabClosed('t1')
    await vi.advanceTimersByTimeAsync(60)
  } finally {
    vi.useRealTimers()
  }
  assert.equal(panes.answerLogin('persist:env-env-1234', { isProxy: true, host: '127.0.0.1', port }), null, 'closed')
  assert.ok(!panes.isPrepared('persist:env-env-1234'), 'no guest attaches to it until a new forward is open')

  // The next tab opens a new forward and points the session at it first.
  await panes.forWorkspace('ws-ssh')
  assert.equal(proxies.length, 2)
  await panes.shutdown()
})

test("a machine whose browser traffic is off uses this computer's partition; forgetting clears its data when asked", async () => {
  assert.equal(await harness('off').panes.forWorkspace('ws-ssh'), null)
  const { panes, cleared } = harness()
  await panes.forWorkspace('ws-ssh')
  await panes.forget('e1', { clearBrowsingData: true, environmentId: 'env-1234' })
  assert.deepEqual(cleared, ['persist:env-env-1234'])
  assert.equal(environmentPartition('e1', null), 'persist:env-ssh-e1')
  assert.equal(environmentPartition('e1', '../x y'), 'persist:env-xy')
})

test("a site in a machine's tabs cannot reach that machine's loopback; the person, an agent and a dev page can (V-P3)", async () => {
  const { panes, guards } = harness()
  await panes.forWorkspace('ws-ssh')
  const guard = guards.get('persist:env-env-1234')
  assert.ok(guard, 'the guard is set before any tab loads')
  const ask = (url: string, initiatorOrigin: string | undefined, resourceType = 'xhr', method = 'GET') =>
    guard({ url, method, resourceType, ...(initiatorOrigin === undefined ? {} : { initiatorOrigin }) })

  // A public page, blind requests to the machine's services.
  assert.equal(ask('http://localhost:5173/api/delete', 'https://example.com', 'xhr', 'POST'), true)
  assert.equal(ask('http://127.0.0.1:9229/json', 'https://example.com', 'image'), true)
  assert.equal(ask('http://[::1]:8080/', 'https://example.com', 'subFrame'), true)
  assert.equal(ask('http://0.0.0.0:5173/', 'https://example.com', 'script'), true)
  assert.equal(ask('http://[::ffff:7f00:1]:5173/', 'https://example.com', 'script'), true)
  assert.equal(ask('ws://localhost:5173/hmr', 'https://example.com', 'webSocket'), true)
  assert.equal(ask('http://localhost:5173/form', 'https://example.com', 'mainFrame', 'POST'), true)
  // A sandboxed frame such a page made has an opaque origin.
  assert.equal(ask('http://localhost:5173/', 'null', 'xhr'), true)

  // What stays allowed.
  assert.equal(ask('http://localhost:5173/', undefined, 'mainFrame'), false, 'typed, or browser.open')
  assert.equal(ask('http://localhost:3000/api', 'http://localhost:5173', 'xhr', 'POST'), false, 'a dev page')
  assert.equal(ask('ws://localhost:5173/hmr', 'http://127.0.0.1:5173', 'webSocket'), false)
  assert.equal(ask('http://localhost:5173/', 'https://example.com', 'mainFrame'), false, 'a link to it')
  assert.equal(ask('http://localhost:5173/app.js.map', 'devtools://devtools', 'other'), false)
  assert.equal(ask('https://example.com/x.js', 'https://example.com', 'script'), false, 'not loopback')
  assert.equal(blocksForeignLoopback({ url: 'not a url', method: 'GET', resourceType: 'xhr' }), false)
  await panes.shutdown()
})
