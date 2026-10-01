import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// jsdom globals must exist before React mounts
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

import { useTailnetPresence, type TailnetPresence } from './useTailnetPresence'
import { test } from 'vitest'

test('useTailnetPresence', async () => {
  // The Remote glyph's data source folds two IPC channels by `revision`
  // (remote-sessions-ux / tailnet-live-state-push, reviewed 2026-09-04): a push
  // that lands before an initial read resolves must win, the status read must
  // yield only to a PUSH (never to its sibling live-state read), and an older
  // pushed revision is dropped. Mounted under jsdom with a deferred bridge so
  // the order of replies is the test's to choose.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
  function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  const reads = {
    status: deferred<unknown>(),
    live: deferred<unknown>(),
    mesh: deferred<unknown>(),
    meshLive: deferred<unknown>(),
  }
  let tailnetListener: ((payload: unknown) => void) | null = null
  let meshListener: ((event: unknown) => void) | null = null
  ;(dom.window as unknown as { api: unknown }).api = {
    tailnetGetStatus: () => reads.status.promise,
    tailnetGetLiveState: () => reads.live.promise,
    meshListConnections: () => reads.mesh.promise,
    meshGetLiveState: () => reads.meshLive.promise,
    onTailnetEvent: (listener: (payload: unknown) => void) => {
      tailnetListener = listener
      return () => {
        tailnetListener = null
      }
    },
    onMeshEvent: (listener: (event: unknown) => void) => {
      meshListener = listener
      return () => {
        meshListener = null
      }
    },
  }
  /* eslint-enable import/first */

  let latest: TailnetPresence | null = null
  function Probe() {
    latest = useTailnetPresence()
    return null
  }
  /** The presence the probe rendered last; narrowed through a function, since the assignment happens in React's render. */
  function current(): TailnetPresence {
    assert.ok(latest, 'the probe has rendered')
    return latest
  }

  const status = (running: boolean) =>
    ({ enabled: true, running, endpoint: running ? 'host:1' : null, pairRequests: [] }) as never
  const device = (id: string) => ({
    deviceId: id,
    deviceName: id,
    connected: true,
    lastActivityAt: 1,
    connectedSince: 1,
    peerNode: null,
    peerAddress: null,
  })
  const flush = async () => {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  async function main(): Promise<void> {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(Probe))
    })
    assert.ok(tailnetListener && meshListener, 'both channels are subscribed on mount')

    // A push lands before any initial read resolves.
    await act(async () => {
      tailnetListener!({
        revision: 5,
        event: { kind: 'device-connection', deviceId: 'phone', deviceName: 'phone', connected: true },
        status: status(true),
        live: { revision: 5, devices: [device('phone')] },
      })
    })
    assert.equal(current().status?.running, true, 'the push seeds status')
    assert.deepEqual(
      current().live.devices.map((d) => d.deviceId),
      ['phone'],
    )

    // The initial status read resolves late and stale: it must not roll status back.
    reads.status.resolve(status(false))
    await flush()
    assert.equal(current().status?.running, true, 'a late initial status read yields to the push')

    // The initial live-state read resolves with an OLDER revision: dropped.
    reads.live.resolve({ revision: 3, devices: [] })
    await flush()
    assert.deepEqual(
      current().live.devices.map((d) => d.deviceId),
      ['phone'],
      'an older initial live read is dropped',
    )

    // An out-of-order push older than the applied revision is dropped too.
    await act(async () => {
      tailnetListener!({
        revision: 4,
        event: { kind: 'listener', running: false, error: null },
        status: status(false),
        live: { revision: 4, devices: [] },
      })
    })
    assert.equal(current().status?.running, true, 'an older pushed revision is dropped')

    // The mesh channel folds the same way, by its own revision.
    reads.mesh.resolve([])
    reads.meshLive.resolve({
      revision: 2,
      requests: [],
      reachability: [
        {
          connectionId: 'air',
          machineName: 'air',
          checking: false,
          checkedAt: 1,
          reachable: true,
          unauthorized: false,
          detail: null,
          lastReachedAt: 1,
        },
      ],
    })
    await flush()
    assert.equal(current().meshReachability.get('air')?.reachable, true, 'the mesh snapshot seeds reachability')

    // The change feed: a machine saying it changed lands as the latest change
    // for that machine.
    await act(async () => {
      meshListener!({
        kind: 'remote-changed',
        revision: 3,
        connectionId: 'air',
        machineName: 'air',
        what: 'conversations',
      })
    })
    assert.equal(current().meshRemoteChanges.get('air')?.what, 'conversations', 'the change is recorded per machine')
    assert.equal(current().meshRemoteChanges.get('air')?.revision, 3)
    await act(async () => {
      meshListener!({
        kind: 'remote-changed',
        revision: 1,
        connectionId: 'air',
        machineName: 'air',
        what: 'workspaces',
      })
    })
    assert.equal(current().meshRemoteChanges.get('air')?.revision, 3, 'an older mesh revision is dropped')
    // A push of the other kind keeps the first kind's revision, so a reader
    // that re-reads by kind loses neither when both land between two renders.
    await act(async () => {
      meshListener!({
        kind: 'remote-changed',
        revision: 4,
        connectionId: 'air',
        machineName: 'air',
        what: 'workspaces',
      })
    })
    assert.deepEqual(current().meshRemoteChanges.get('air')?.revisions, { conversations: 3, workspaces: 4 })
    await act(async () => {
      meshListener!({ kind: 'machine-forgotten', revision: 6, connectionId: 'air', machineName: 'air' })
    })
    assert.equal(current().meshRemoteChanges.get('air'), undefined, 'forgetting the machine drops its change')
    assert.equal(current().meshReachability.get('air'), undefined, 'and its reachability')

    act(() => root.unmount())
    assert.equal(tailnetListener, null, 'unmount releases the tailnet subscription')
    assert.equal(meshListener, null, 'unmount releases the mesh subscription')
    console.log('useTailnetPresence.test.tsx: ok')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})

test('useTailnetPresence is one set of reads and one subscription per window', async () => {
  // The top bar and the Remote band both ask for presence in every window.
  // They share one set of initial reads and one subscription to each channel.
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  const reads = { status: 0, live: 0, mesh: 0, meshLive: 0 }
  const tailnetListeners = new Set<(payload: unknown) => void>()
  const meshListeners = new Set<(event: unknown) => void>()
  ;(dom.window as unknown as { api: unknown }).api = {
    tailnetGetStatus: async () => (reads.status++, null),
    tailnetGetLiveState: async () => (reads.live++, { revision: 0, devices: [] }),
    meshListConnections: async () => (reads.mesh++, []),
    meshGetLiveState: async () => (reads.meshLive++, { revision: 0, requests: [], reachability: [] }),
    onTailnetEvent: (listener: (payload: unknown) => void) => {
      tailnetListeners.add(listener)
      return () => tailnetListeners.delete(listener)
    },
    onMeshEvent: (listener: (event: unknown) => void) => {
      meshListeners.add(listener)
      return () => meshListeners.delete(listener)
    },
  }

  const seen: TailnetPresence[] = []
  function Surface() {
    seen.push(useTailnetPresence())
    return null
  }
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement('div', null, createElement(Surface), createElement(Surface)))
  })
  await act(async () => {
    await Promise.resolve()
  })
  assert.deepEqual(reads, { status: 1, live: 1, mesh: 1, meshLive: 1 }, 'one set of initial reads')
  assert.equal(tailnetListeners.size, 1, 'one tailnet subscription')
  assert.equal(meshListeners.size, 1, 'one mesh subscription')

  await act(async () => {
    for (const listener of meshListeners)
      listener({ kind: 'remote-changed', revision: 1, connectionId: 'mini', machineName: 'mini', what: 'workspaces' })
  })
  assert.equal(seen.at(-1)?.meshRemoteChanges.get('mini')?.what, 'workspaces', 'every surface sees the push')

  act(() => root.unmount())
  assert.equal(tailnetListeners.size + meshListeners.size, 0, 'the last one out releases both channels')
})
