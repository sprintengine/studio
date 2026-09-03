import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// The toast host (MC: remote-sessions-ux / toast-host-region): one region,
// bottom-trailing, newest at the bottom, producers routed through one store.
// Mounted for real (zustand v5 serves a store's INITIAL state to SSR, so a
// static render can never see a shown toast); the primitive's own tone table
// stays the Toast component's contract — what this file pins is the REGION's.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window
anyGlobal.document = dom.window.document
if (!('navigator' in globalThis) || Object.getOwnPropertyDescriptor(globalThis, 'navigator')?.set) {
  anyGlobal.navigator = dom.window.navigator
}
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.Node = dom.window.Node
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

/* eslint-disable import/first -- jsdom globals must exist before React mounts */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ToastRegion } from './ToastRegion'
import { showToast, useToastStore } from '../../store/toastStore'

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

let root: Root | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  const created = dom.window.document.createElement('div')
  host = created
  dom.window.document.body.appendChild(created)
  act(() => {
    root = createRoot(created)
    root.render(<ToastRegion />)
  })
  return created
}

function unmount(): void {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
}

function reset(): void {
  act(() => {
    useToastStore.setState({ toasts: [] })
  })
}

run('an empty store renders no region at all — not an empty box over the pane', () => {
  reset()
  const mounted = mount()
  assert.equal(mounted.innerHTML, '')
  unmount()
})

run('the region is one fixed bottom-trailing stack at z.toast with space.sm gaps', () => {
  reset()
  const mounted = mount()
  act(() => {
    showToast({ tone: 'good', title: 'Machine paired' })
  })
  const region = mounted.firstElementChild
  assert.ok(region, 'the region mounted')
  const classes = region.getAttribute('class') ?? ''
  assert.match(classes, /fixed/, 'fixed positioning')
  assert.match(classes, /bottom-4/, 'bottom-trailing corner')
  assert.match(classes, /right-4/, 'bottom-trailing corner')
  assert.match(classes, /z-\[var\(--z-toast\)\]/, 'the toast layer of the one z ladder')
  assert.match(classes, /flex-col/, 'a column')
  assert.match(classes, /gap-2/, 'space.sm apart')
  assert.match(classes, /pointer-events-none/, 'the wrapper swallows no clicks')
  assert.match(region.innerHTML, /pointer-events-auto/, 'each surface reclaims its own')
  assert.doesNotMatch(region.innerHTML, /shadow|backdrop/, 'no shadow, no blur — the spec ruling')
  unmount()
})

run('two producers stack in one region, newest at the bottom', () => {
  reset()
  const mounted = mount()
  act(() => {
    showToast({ tone: 'neutral', title: 'First report' })
    showToast({ tone: 'good', title: 'Second report' })
  })
  const markup = mounted.innerHTML
  const first = markup.indexOf('First report')
  const second = markup.indexOf('Second report')
  assert.ok(first !== -1 && second !== -1, 'both toasts render')
  assert.ok(first < second, 'newest renders below (later in the column)')
  assert.equal(mounted.children.length, 1, 'one region, never a second corner')
  unmount()
})

run('tones flow through to the primitive: warn announces assertively, good politely', () => {
  reset()
  const mounted = mount()
  act(() => {
    showToast({ tone: 'warn', title: 'Connection to Air lost' })
    showToast({ tone: 'good', title: 'Machine paired' })
  })
  assert.ok(mounted.querySelector('[role="alert"][aria-live="assertive"]'), 'warn interrupts')
  assert.ok(mounted.querySelector('[role="status"][aria-live="polite"]'), 'good does not')
  unmount()
})

run('dismiss removes exactly the dismissed toast', () => {
  reset()
  const mounted = mount()
  let keep = ''
  let drop = ''
  act(() => {
    keep = showToast({ tone: 'neutral', title: 'Stays' })
    drop = showToast({ tone: 'warn', title: 'Goes' })
  })
  act(() => {
    useToastStore.getState().dismissToast(drop)
  })
  assert.match(mounted.innerHTML, /Stays/)
  assert.doesNotMatch(mounted.innerHTML, /Goes/)
  act(() => {
    useToastStore.getState().dismissToast(keep)
  })
  assert.equal(mounted.innerHTML, '')
  unmount()
})

run('the warn dismiss button dismisses through the store', () => {
  reset()
  const mounted = mount()
  act(() => {
    showToast({ tone: 'warn', title: 'Connection lost' })
  })
  const dismiss = mounted.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement | null
  assert.ok(dismiss, 'a persistent tone carries the dismiss button')
  act(() => {
    dismiss.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(useToastStore.getState().toasts.length, 0)
  assert.equal(mounted.innerHTML, '')
  unmount()
})

if (failures > 0) {
  console.error(`ToastRegion.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('ToastRegion.test.tsx: ok')
