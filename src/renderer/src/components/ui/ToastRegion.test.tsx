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

// jsdom globals must exist before React mounts
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
  assert.match(region.innerHTML, /surface-glass/, 'the card is the one glass surface (ruling 2026-09-04)')
  assert.match(region.innerHTML, /shadow-\[var\(--shadow-popover\)\]/, 'its edge is drawn by shadow.popover')
  assert.doesNotMatch(region.innerHTML, /bg-\[color:var\(--bg-surface-raised\)\]/, 'no flat fill under the glass')
  assert.doesNotMatch(region.getAttribute('class') ?? '', /surface-glass|shadow/, 'the region draws nothing itself')
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

run('a second toast arriving does not extend the first one’s life — the clock is keyed on policy, not the callback', () => {
  reset()
  // A hand-driven clock over jsdom's window timers: the primitive schedules
  // through `window.setTimeout`, and the region hands each toast a fresh
  // `onDismiss` closure per render — the exact shape that used to restart
  // every toast's 5 s whenever any toast came or went.
  const realSetTimeout = dom.window.setTimeout
  const realClearTimeout = dom.window.clearTimeout
  type Scheduled = { id: number; at: number; fn: () => void }
  let clock = 0
  let nextId = 1
  const scheduled: Scheduled[] = []
  const fakeSetTimeout = ((fn: () => void, ms?: number) => {
    const id = nextId++
    scheduled.push({ id, at: clock + (ms ?? 0), fn })
    return id
  }) as unknown as typeof dom.window.setTimeout
  const fakeClearTimeout = ((id?: number) => {
    const index = scheduled.findIndex((entry) => entry.id === id)
    if (index !== -1) scheduled.splice(index, 1)
  }) as unknown as typeof dom.window.clearTimeout
  const advance = (ms: number): void => {
    clock += ms
    for (;;) {
      const due = scheduled.filter((entry) => entry.at <= clock).sort((a, b) => a.at - b.at)[0]
      if (!due) return
      scheduled.splice(scheduled.indexOf(due), 1)
      act(() => due.fn())
    }
  }
  dom.window.setTimeout = fakeSetTimeout
  dom.window.clearTimeout = fakeClearTimeout
  try {
    const mounted = mount()
    act(() => {
      showToast({ tone: 'good', title: 'First arrived' })
    })
    advance(4000)
    // The first toast is one second from its deadline when a second arrives.
    act(() => {
      showToast({ tone: 'good', title: 'Second arrived' })
    })
    advance(1000)
    assert.doesNotMatch(mounted.innerHTML, /First arrived/, 'the first toast left on ITS 5 s, unextended by the arrival')
    assert.match(mounted.innerHTML, /Second arrived/, 'the second is still on its own clock')
    // And the first leaving (a store change that re-renders the second with a
    // fresh onDismiss) did not restart the second's clock either.
    advance(4000)
    assert.doesNotMatch(mounted.innerHTML, /Second arrived/, 'the second left exactly 5 s after it arrived')
    assert.equal(useToastStore.getState().toasts.length, 0)
    unmount()
  } finally {
    dom.window.setTimeout = realSetTimeout
    dom.window.clearTimeout = realClearTimeout
  }
})

run('a toast re-shown under its stable id is replaced in place and keeps that id', () => {
  reset()
  const mounted = mount()
  act(() => {
    showToast({ id: 'fleet:c1', tone: 'warn', title: 'Connection to Air lost' })
    showToast({ id: 'fleet:c2', tone: 'warn', title: 'Connection to Air lost' })
    showToast({ id: 'fleet:c1', tone: 'warn', title: 'Connection to Air lost', description: 'Still reconnecting.' })
  })
  const ids = useToastStore.getState().toasts.map((toast) => toast.id)
  assert.deepEqual(ids, ['fleet:c1', 'fleet:c2'], 'same title, different ids — two machines, two toasts; the re-show replaced c1 in place')
  assert.match(mounted.innerHTML, /Still reconnecting\./)
  act(() => {
    useToastStore.getState().dismissToast('fleet:c1')
  })
  assert.deepEqual(useToastStore.getState().toasts.map((toast) => toast.id), ['fleet:c2'], 'the handle a producer kept still retracts')
  unmount()
})

run('a re-show drops the fields it leaves out — a finished update no longer offers to run', () => {
  reset()
  const mounted = mount()
  act(() => {
    showToast({
      id: 'cli-update:codex',
      tone: 'neutral',
      cli: 'codex',
      title: 'Update available: Codex 0.155.0',
      autoDismissMs: false,
      actions: [{ id: 'update', label: 'Update', primary: true, run: () => {} }],
    })
    showToast({ id: 'cli-update:codex', tone: 'good', cli: 'codex', title: 'Codex updated to 0.155.0' })
  })
  const [toast] = useToastStore.getState().toasts
  assert.equal(toast?.actions, undefined, 'the question\'s buttons left with the question')
  assert.equal(toast?.autoDismissMs, undefined, 'the report takes its tone\'s dismissal, not the question\'s never')
  assert.doesNotMatch(mounted.innerHTML, />Update</)
  unmount()
})

if (failures > 0) {
  console.error(`ToastRegion.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('ToastRegion.test.tsx: ok')
