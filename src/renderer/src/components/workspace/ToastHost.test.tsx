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

function pairEvent(phase: 'received' | 'resolved', requestId = 'req1'): unknown {
  return {
    event: { kind: 'pair-request', phase, requestId, deviceName: 'macbook-air' },
    status: {},
    live: { devices: [] },
  }
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

run('resolution from any surface retracts the standing toast', () => {
  reset()
  const mounted = mount()
  fireTailnet(pairEvent('received'))
  assert.match(mounted.innerHTML, /Pair request/)
  fireTailnet(pairEvent('resolved'))
  assert.equal(mounted.innerHTML, '', 'the invitation to review a request that no longer exists is gone')
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
  fireTailnet(pairEvent('resolved'))
  assert.equal(useToastStore.getState().toasts.length, 0)
  assert.equal(mounted.innerHTML, '')
  unmount()
})

if (failures > 0) {
  console.error(`ToastHost.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('ToastHost.test.tsx: ok')
