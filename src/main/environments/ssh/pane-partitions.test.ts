import assert from 'node:assert/strict'
import { test } from 'vitest'

import { environmentPartition, PanePartitions } from './pane-partitions'

// Which partition a workspace's tabs use, and the life of the forward behind
// an SSH machine's: opened for its first tab, its proxy set before the tab is
// made, closed after its last, and its credential given only to its own
// partition for its own port.

function harness(traffic: 'all' | 'loopback' | 'off' = 'all') {
  const proxies: Array<{ partition: string; proxyRules: string; proxyBypassRules: string }> = []
  const cleared: string[] = []
  const panes = new PanePartitions({
    machineOf: (workspaceId) => (workspaceId === 'ws-ssh' ? { id: 'e1', label: 'build-box' } : null),
    environmentIdOf: () => 'env-1234',
    traffic: () => traffic,
    current: () => null,
    connect: async () => false,
    sessionFor: (partition) => ({
      setProxy: async (config) => void proxies.push({ partition, ...config }),
      clearStorageData: async () => void cleared.push(partition),
    }),
    closeDelayMs: 20,
  })
  return { panes, proxies, cleared }
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
  panes.tabOpened('persist:env-env-1234', 't1')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.ok(panes.answerLogin('persist:env-env-1234', { isProxy: true, host: '127.0.0.1', port }), 'still open')
  panes.tabClosed('t1')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(panes.answerLogin('persist:env-env-1234', { isProxy: true, host: '127.0.0.1', port }), null, 'closed')

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
