import assert from 'node:assert/strict'

// MC-2188: the account bar used to decide "Upgrade to Pro" from `plan.code ===
// 'pro'`. It now asks feature keys, and the plan's name is only ever printed.
// This renders the real surface because the decision logic's unit coverage
// (workspaceManagerHelpers.test.ts) cannot show which element each answer
// drives — which is the half that regressed if the wiring is wrong.
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
const anyGlobal = globalThis as unknown as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
anyGlobal.window = domWindow
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.localStorage = dom.window.localStorage
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
class FakeResizeObserver { observe() {} unobserve() {} disconnect() {} }
anyGlobal.ResizeObserver = FakeResizeObserver
domWindow.ResizeObserver = FakeResizeObserver
dom.window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })) as unknown as typeof dom.window.matchMedia
domWindow.api = { authOpenUpgrade: async () => ({ opened: true, url: '' }) }

import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import SidebarAccountBar from './SidebarAccountBar'
import type { MulticodeAuthState } from '../../../../shared/electron-api'

function state(planCode: string, features: Record<string, boolean>, entitlementStatus: MulticodeAuthState['entitlementStatus'] = 'fresh'): MulticodeAuthState {
  return {
    authenticated: true,
    user: { id: 'u1', email: 'dev@example.com', displayName: 'Dev Person' } as MulticodeAuthState['user'],
    selectedOrganization: null,
    entitlements: {
      userId: 'u1', organizationId: 'o1', product: 'multicode', roles: [], features, limits: {}, sources: {},
      plan: { code: planCode, status: 'active' },
      issuedAt: '2026-08-01T00:00:00.000Z', expiresAt: '2026-08-04T00:00:00.000Z', schemaVersion: 1,
    },
    status: 'signed_in', entitlementStatus, message: null, lastRefreshAt: null, graceExpiresAt: null,
  }
}
const FREE = { 'multicode.sprintengine': true, 'multicode.frontier_models': false, 'multicode.mobile_companion': false }
const PRO = { 'multicode.sprintengine': true, 'multicode.frontier_models': true, 'multicode.mobile_companion': true }

function render(authState: MulticodeAuthState): HTMLElement {
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host as unknown as Element)
  act(() => {
    root.render(
      React.createElement(SidebarAccountBar, {
        collapsed: false, authState, authMessage: null, accountOpen: true,
        setAccountOpen: () => {}, startLogin: () => {}, refreshAuthState: () => {},
        logout: () => {}, openSettings: () => {}, settingsOpen: false,
      }),
    )
  })
  return dom.window.document.body as unknown as HTMLElement
}

function texts(): string[] {
  const buttons = [...dom.window.document.querySelectorAll('button')] as HTMLElement[]
  return buttons.map((button) => (button.textContent ?? '').trim())
}

// Free: the upgrade affordance is offered, the badge reads Free.
render(state('free', FREE))
assert.ok(texts().includes('Upgrade to Pro'), 'free account is offered the upgrade')
assert.ok(dom.window.document.body.textContent?.includes('Free plan'), 'free plan label rendered')
dom.window.document.body.innerHTML = ''

// Pro: no upgrade affordance, badge reads Pro.
render(state('pro', PRO))
assert.ok(!texts().includes('Upgrade to Pro'), 'paid account is not offered the upgrade')
assert.ok(dom.window.document.body.textContent?.includes('Pro plan'), 'pro plan label rendered')
dom.window.document.body.innerHTML = ''

// Pro on a stale snapshot: still no upgrade, and the re-check appears.
render(state('pro', PRO, 'offline_grace'))
assert.ok(!texts().includes('Upgrade to Pro'), 'stale paid account is still not told to upgrade')
assert.ok(texts().includes('Check access again'), 'stale access offers the re-check')
dom.window.document.body.innerHTML = ''

// A plan NAMED pro that grants nothing paid: the upgrade is offered (the gate
// no longer believes the plan's name), while the label still prints that name.
render(state('pro', FREE))
assert.ok(texts().includes('Upgrade to Pro'), 'access follows the feature keys, not the plan name')
assert.ok(dom.window.document.body.textContent?.includes('Pro plan'), 'the label still prints the plan name')

dom.window.document.body.innerHTML = ''

// Doors→modals (2026-09-01): the settings cluster renders one trigger glyph
// per enabled registered modal surface, before the gear — each an icon button
// named by its label (the tooltip carries the same text) with `aria-pressed`
// tracking the open modal. Registered through the real host under the bundled
// `design` module id (enabled by default), like the real triggers are.
{
  // Static requires, not top-level await: this file compiles to CJS. Both
  // modules are already in the graph through SidebarAccountBar itself.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getRendererHost } = require('../../modules') as typeof import('../../modules')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useWorkspaceStore } = require('../../store/workspaceStore') as typeof import('../../store/workspaceStore')
  const host = getRendererHost()
  let onOpenCalls = 0
  if (!host.getModalSurface('compass-test')) {
    host.hostFor('design').registerModalSurface({
      id: 'compass-test',
      order: 5,
      label: 'Compass',
      Icon: ({ className }: { className?: string }) => React.createElement('svg', { className }),
      // A plain trigger open runs onOpen first — the seam the Plugins surface
      // uses to discard a stale deep-link latch.
      onOpen: () => {
        onOpenCalls += 1
      },
      Component: () => null,
    })
  }
  render(state('free', FREE))
  const trigger = dom.window.document.querySelector('button[aria-label="Compass"]')
  assert.ok(trigger, 'a registered modal surface renders its trigger glyph in the settings cluster')
  assert.equal(trigger?.getAttribute('aria-pressed'), 'false', 'the trigger reads unpressed while its modal is closed')
  const gear = dom.window.document.querySelector('button[aria-label="Settings"]')
  assert.ok(gear, 'the gear keeps its slot')
  assert.ok(
    gear && trigger && Boolean(trigger.compareDocumentPosition(gear) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING),
    'trigger glyphs render before the gear',
  )
  act(() => {
    ;(trigger as HTMLElement).click()
  })
  assert.equal(
    useWorkspaceStore.getState().activeModalSurface,
    'compass-test',
    'clicking a trigger opens its modal surface on the local store',
  )
  assert.equal(onOpenCalls, 1, 'a plain trigger open ran the surface’s onOpen hook first')
  assert.equal(
    dom.window.document.querySelector('button[aria-label="Compass"]')?.getAttribute('aria-pressed'),
    'true',
    'the trigger reads pressed while its modal is open',
  )
  act(() => {
    useWorkspaceStore.getState().closeModalSurface()
  })
}

console.log('SidebarAccountBar.entitlements.test.tsx: ok')
