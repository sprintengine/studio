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
    fleet: deferred<unknown>(),
    fleetLive: deferred<unknown>(),
  }
  let tailnetListener: ((payload: unknown) => void) | null = null
  let fleetListener: ((event: unknown) => void) | null = null
  ;(dom.window as unknown as { api: unknown }).api = {
    tailnetGetStatus: () => reads.status.promise,
    tailnetGetLiveState: () => reads.live.promise,
    fleetListConnections: () => reads.fleet.promise,
    fleetGetLiveState: () => reads.fleetLive.promise,
    onTailnetEvent: (listener: (payload: unknown) => void) => {
      tailnetListener = listener
      return () => {
        tailnetListener = null
      }
    },
    onFleetEvent: (listener: (event: unknown) => void) => {
      fleetListener = listener
      return () => {
        fleetListener = null
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
    attachedTerminalSessions: [],
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
    assert.ok(tailnetListener && fleetListener, 'both channels are subscribed on mount')

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

    // The fleet channel folds the same way, keyed by attachId.
    reads.fleet.resolve([])
    reads.fleetLive.resolve({
      revision: 2,
      attachments: [
        { attachId: 'a1', connectionId: 'air', sessionId: 's1', state: 'live' },
        { attachId: 'a2', connectionId: 'air', sessionId: 's1', state: 'live' },
      ],
    })
    await flush()
    assert.deepEqual(
      [...(current().fleetLiveSessions.get('air') ?? [])],
      ['s1'],
      'the fleet snapshot seeds live sessions',
    )
    await act(async () => {
      fleetListener!({
        kind: 'attachment',
        revision: 3,
        attachId: 'a1',
        connectionId: 'air',
        sessionId: 's1',
        state: 'closed',
      })
    })
    assert.deepEqual(
      [...(current().fleetLiveSessions.get('air') ?? [])],
      ['s1'],
      'closing one of two panes keeps the session live',
    )
    await act(async () => {
      fleetListener!({
        kind: 'attachment',
        revision: 1,
        attachId: 'a2',
        connectionId: 'air',
        sessionId: 's1',
        state: 'closed',
      })
    })
    assert.equal(current().fleetAttachments.size, 1, 'an older fleet revision is dropped')
    await act(async () => {
      fleetListener!({
        kind: 'attachment',
        revision: 4,
        attachId: 'a2',
        connectionId: 'air',
        sessionId: 's1',
        state: 'closed',
      })
    })
    assert.equal(current().fleetLiveSessions.get('air'), undefined, 'the last pane closing ends the live session')

    // The change feed: a machine saying it changed lands as the latest change
    // for that machine, and never as an attachment.
    await act(async () => {
      fleetListener!({
        kind: 'remote-changed',
        revision: 5,
        connectionId: 'air',
        machineName: 'air',
        what: 'terminals',
      })
    })
    assert.equal(current().fleetRemoteChanges.get('air')?.what, 'terminals', 'the change is recorded per machine')
    assert.equal(current().fleetRemoteChanges.get('air')?.revision, 5)
    assert.equal(current().fleetAttachments.size, 0, 'a change push is not an attachment')
    await act(async () => {
      fleetListener!({ kind: 'machine-forgotten', revision: 6, connectionId: 'air', machineName: 'air' })
    })
    assert.equal(current().fleetRemoteChanges.get('air'), undefined, 'forgetting the machine drops its change')

    act(() => root.unmount())
    assert.equal(tailnetListener, null, 'unmount releases the tailnet subscription')
    assert.equal(fleetListener, null, 'unmount releases the fleet subscription')
    console.log('useTailnetPresence.test.tsx: ok')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
