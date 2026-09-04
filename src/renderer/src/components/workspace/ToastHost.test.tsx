import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// The toast host's event bridges (remote-sessions-ux / toast-host-region +
// incoming-pair-request-prompt), mounted for real: the pair-request toast
// announces, never carries the code, and is RETRACTED when the request
// resolves from any surface — while one the person dismissed stays dismissed.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})
const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window
anyGlobal.document = dom.window.document
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.Node = dom.window.Node
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

type Handler<T> = (payload: T) => void
const tailnetHandlers: Array<Handler<unknown>> = []
const fleetHandlers: Array<Handler<unknown>> = []
;(dom.window as unknown as { api: unknown }).api = {
  onTailnetEvent: (cb: Handler<unknown>) => {
    tailnetHandlers.push(cb)
    return () => tailnetHandlers.splice(tailnetHandlers.indexOf(cb), 1)
  },
  onFleetEvent: (cb: Handler<unknown>) => {
    fleetHandlers.push(cb)
    return () => fleetHandlers.splice(fleetHandlers.indexOf(cb), 1)
  },
}

/* eslint-disable import/first -- jsdom globals must exist before React mounts */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ToastHost } from './ToastHost'
import { useToastStore } from '../../store/toastStore'

let failures = 0
function run(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

let revision = 0
function pairEvent(
  phase: 'received' | 'approved' | 'denied' | 'expired' | 'cancelled',
  requestId = 'req1',
  peerNode: string | null = null
): unknown {
  return {
    revision: ++revision,
    event: { kind: 'pair-request', phase, requestId, deviceName: 'macbook-air', peerNode },
    status: {},
    live: { revision, devices: [] },
  }
}

function fleetEvent(body: Record<string, unknown>): unknown {
  return { revision: ++revision, ...body }
}
function attachment(attachId: string, state: string, connectionId = 'c1', machineName = 'Air'): unknown {
  return fleetEvent({ kind: 'attachment', attachId, connectionId, machineName, sessionId: 's1', state, detail: '' })
}
function fireFleet(payload: unknown): void {
  act(() => {
    for (const handler of [...fleetHandlers]) handler(payload)
  })
}
function titles(): string[] {
  return useToastStore.getState().toasts.map((toast) => toast.title)
}

let root: Root | null = null
let host: HTMLElement | null = null
function mount(): HTMLElement {
  const created = dom.window.document.createElement('div')
  host = created
  dom.window.document.body.appendChild(created)
  act(() => {
    root = createRoot(created)
    root.render(<ToastHost />)
  })
  return created
}
function unmount(): void {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
}
function fireTailnet(payload: unknown): void {
  act(() => {
    for (const handler of [...tailnetHandlers]) handler(payload)
  })
}
function reset(): void {
  act(() => {
    useToastStore.setState({ toasts: [] })
  })
}

run('a pair request announces as a persistent warn toast, without the code', () => {
  reset()
  const mounted = mount()
  fireTailnet(pairEvent('received'))
  assert.match(mounted.innerHTML, /Pair request from macbook-air/)
  assert.match(mounted.innerHTML, /role="alert"/, 'warn interrupts and persists')
  assert.doesNotMatch(mounted.innerHTML, /\d{6}/, 'no comparison code in the announcement')
  unmount()
})

run('the same request announced twice is one toast', () => {
  reset()
  const mounted = mount()
  fireTailnet(pairEvent('received'))
  fireTailnet(pairEvent('received'))
  assert.equal(useToastStore.getState().toasts.length, 1)
  unmount()
  void mounted
})

run('the toast names the transport-proven node first and the self-declared name second', () => {
  reset()
  const mounted = mount()
  fireTailnet(pairEvent('received', 'req-named', 'dev-macbook-air'))
  assert.match(mounted.innerHTML, /Pair request from dev-macbook-air/)
  assert.match(mounted.innerHTML, /Calls itself “macbook-air”/)
  unmount()
})

for (const phase of ['approved', 'denied', 'expired', 'cancelled'] as const) {
  run(`every terminal phase retracts the standing toast — ${phase}`, () => {
    reset()
    const mounted = mount()
    fireTailnet(pairEvent('received', `req-${phase}`))
    assert.match(mounted.innerHTML, /Pair request/)
    fireTailnet(pairEvent(phase, `req-${phase}`))
    assert.equal(mounted.innerHTML, '', 'the invitation to review a request that no longer exists is gone')
    unmount()
  })
}

run('the toast’s id is the request’s, so a retraction can never orphan', () => {
  reset()
  mount()
  fireTailnet(pairEvent('received', 'req-id'))
  assert.deepEqual(
    useToastStore.getState().toasts.map((toast) => toast.id),
    ['pair-request:req-id']
  )
  unmount()
})

run('a toast the person dismissed stays dismissed — resolution does not resurrect it', () => {
  reset()
  const mounted = mount()
  fireTailnet(pairEvent('received'))
  act(() => {
    const id = useToastStore.getState().toasts[0]?.id
    if (id) useToastStore.getState().dismissToast(id)
  })
  fireTailnet(pairEvent('expired'))
  assert.equal(useToastStore.getState().toasts.length, 0)
  assert.equal(mounted.innerHTML, '')
  unmount()
})

// ── the fleet bridge ─────────────────────────────────────────────────────

run('a machine paired announces good; a machine removed announces neutral', () => {
  reset()
  const mounted = mount()
  fireFleet(fleetEvent({ kind: 'machine-paired', connection: { id: 'c1', machineName: 'Air' } }))
  assert.match(mounted.innerHTML, /Machine paired/)
  assert.match(mounted.innerHTML, /Air is in your fleet/)
  assert.ok(mounted.querySelector('[role="status"]'), 'good is polite')
  fireFleet(fleetEvent({ kind: 'machine-forgotten', connectionId: 'c1', machineName: 'Air' }))
  assert.match(mounted.innerHTML, /Machine removed/)
  assert.match(mounted.innerHTML, /Air was removed from your fleet/)
  unmount()
})

run('a lost connection is one warn toast per MACHINE, however many panes it has', () => {
  reset()
  const mounted = mount()
  fireFleet(attachment('pane-a', 'reconnecting'))
  assert.equal(titles().length, 0, 'reconnecting is the pane’s own business; no toast yet')
  fireFleet(attachment('pane-a', 'offline'))
  fireFleet(attachment('pane-b', 'offline'))
  fireFleet(attachment('pane-c', 'offline'))
  assert.deepEqual(titles(), ['Connection to Air lost'], 'three panes, one loss')
  assert.deepEqual(useToastStore.getState().toasts.map((toast) => toast.id), ['fleet:c1'], 'keyed by the connection')
  assert.ok(mounted.querySelector('[role="alert"]'), 'warn persists')
  // A second machine losing its link is a second toast, not a replacement.
  fireFleet(attachment('pane-z', 'offline', 'c2', 'Mini'))
  assert.deepEqual(titles(), ['Connection to Air lost', 'Connection to Mini lost'])
  unmount()
})

run('reconnected is only news after a loss, and it RETRACTS the loss', () => {
  reset()
  const mounted = mount()
  fireFleet(attachment('pane-a', 'connecting'))
  fireFleet(attachment('pane-a', 'live'))
  assert.equal(titles().length, 0, 'a first connection is not a reconnection')
  fireFleet(attachment('pane-a', 'offline'))
  assert.deepEqual(titles(), ['Connection to Air lost'])
  fireFleet(attachment('pane-a', 'live'))
  assert.deepEqual(titles(), ['Reconnected to Air'], 'the standing loss is gone and the recovery announced')
  assert.doesNotMatch(mounted.innerHTML, /lost/)
  // Only once: a second pane going live on the same recovered machine is quiet.
  fireFleet(attachment('pane-b', 'live'))
  assert.deepEqual(titles(), ['Reconnected to Air'])
  unmount()
})

run('a pane closed for good retracts the loss toast without claiming a recovery', () => {
  reset()
  mount()
  fireFleet(attachment('pane-a', 'offline'))
  assert.deepEqual(titles(), ['Connection to Air lost'])
  fireFleet(attachment('pane-a', 'closed'))
  assert.deepEqual(titles(), [], 'retracted, and no “Reconnected” invented')
  unmount()
})

if (failures > 0) {
  console.error(`ToastHost.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('ToastHost.test.tsx: ok')
