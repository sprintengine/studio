import assert from 'node:assert/strict'

// MC-2220: the account badge shows the provider profile photo when the session
// carries one, in the footer badge and the account popover header; a session
// without one shows the tier-coloured initials exactly as before; a photo that
// fails to decode falls back to the initials silently. This renders the real
// surface because the fallback is wiring (an <img> error handler and state),
// and wiring is what a unit test of `accountInitials` cannot see.
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
anyGlobal.Event = dom.window.Event
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.localStorage = dom.window.localStorage
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
anyGlobal.ResizeObserver = FakeResizeObserver
domWindow.ResizeObserver = FakeResizeObserver
dom.window.matchMedia = ((q: string) => ({
  matches: false,
  media: q,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
})) as unknown as typeof dom.window.matchMedia
domWindow.api = { authOpenUpgrade: async () => ({ opened: true, url: '' }) }

import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import SidebarAccountBar from './SidebarAccountBar'
import type { MulticodeAuthState, SessionUser } from '../../../../shared/electron-api'

const PHOTO = 'data:image/png;base64,iVBORw0KGgo='

function state(user: SessionUser | null, authenticated = true): MulticodeAuthState {
  return {
    authenticated,
    user,
    selectedOrganization: null,
    entitlements: authenticated
      ? {
          userId: 'u1',
          organizationId: 'o1',
          product: 'multicode',
          roles: [],
          features: { 'multicode.sprintengine': true },
          limits: {},
          sources: {},
          plan: { code: 'free', status: 'active' },
          issuedAt: '2026-08-01T00:00:00.000Z',
          expiresAt: '2026-08-04T00:00:00.000Z',
          schemaVersion: 1,
        }
      : null,
    status: authenticated ? 'signed_in' : 'signed_out',
    entitlementStatus: authenticated ? 'fresh' : 'missing',
    message: null,
    lastRefreshAt: null,
    graceExpiresAt: null,
  }
}

function render(authState: MulticodeAuthState, accountOpen = true): void {
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host as unknown as Element)
  act(() => {
    root.render(
      React.createElement(SidebarAccountBar, {
        collapsed: false,
        authState,
        authMessage: null,
        accountOpen,
        setAccountOpen: () => {},
        startLogin: () => {},
        refreshAuthState: () => {},
        logout: () => {},
        openSettings: () => {},
        settingsOpen: false,
      }),
    )
  })
}

function avatars(): HTMLElement[] {
  return [...dom.window.document.querySelectorAll('[data-account-avatar]')] as HTMLElement[]
}

function reset(): void {
  dom.window.document.body.innerHTML = ''
}

// The cluster mounts at the foot of the app rail, which is an `app-drag`
// window region. A drag region swallows the pointer before React sees it, so
// the cluster has to opt out (`app-no-drag`) or its buttons paint and do not
// click — which is what happened the day it moved there (2026-09-05).
render(state({ id: 'u1', email: 'dev@example.com', displayName: 'Dev', photoUrl: null }), false)
{
  const settings = dom.window.document.querySelector('button[aria-label="Settings"]') as HTMLElement | null
  assert.ok(settings, 'the Settings gear renders')
  const optedOut = (element: HTMLElement | null): boolean => {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      if ((node.getAttribute('class') ?? '').split(/\s+/).includes('app-no-drag')) return true
    }
    return false
  }
  assert.ok(
    optedOut(settings),
    'the Settings gear sits inside an app-no-drag element, so the rail’s drag region does not eat its clicks',
  )
  const account = dom.window.document.querySelector('button[aria-label^="Account"]') as HTMLElement | null
  assert.ok(account, 'the account badge renders')
  assert.ok(optedOut(account), 'the account badge sits inside an app-no-drag element too')
}
reset()

// A session with a photo: the footer badge and the popover header both show
// it, as a decorative image, and neither prints the initials.
render(state({ id: 'u1', email: 'dev@example.com', displayName: 'Dev Person', photoUrl: PHOTO }))
{
  const discs = avatars()
  assert.equal(discs.length, 2, 'the footer badge and the popover header each carry the disc')
  for (const disc of discs) {
    assert.equal(disc.getAttribute('data-account-avatar'), 'photo')
    const img = disc.querySelector('img')
    assert.ok(img, 'the disc renders the photo')
    assert.equal(img?.getAttribute('src'), PHOTO)
    assert.equal(img?.getAttribute('alt'), '', 'decorative: the surface names the account in text')
    assert.equal(disc.getAttribute('aria-hidden'), 'true')
    assert.ok(!(disc.textContent ?? '').includes('DP'), 'no initials beside the photo')
  }
  const trigger = dom.window.document.querySelector('button[aria-label^="Account"]')
  assert.ok(trigger?.querySelector('img'), 'the photo sits inside the footer account button')
  assert.ok(dom.window.document.body.textContent?.includes('Dev Person'), 'the popover still names the account')
}
reset()

// The same session without a photo: the tier-coloured initials, exactly as today.
render(state({ id: 'u1', email: 'dev@example.com', displayName: 'Dev Person', photoUrl: null }))
{
  const discs = avatars()
  assert.equal(discs.length, 2)
  for (const disc of discs) {
    assert.equal(disc.getAttribute('data-account-avatar'), 'initials')
    assert.equal(disc.querySelector('img'), null, 'no image element without a photo')
    assert.equal((disc.textContent ?? '').trim(), 'DP')
  }
}
reset()

// No name and no email: the neutral person glyph, not a "?".
render(state({ id: 'u1', email: null, displayName: null, photoUrl: null }))
{
  for (const disc of avatars()) {
    assert.equal(disc.getAttribute('data-account-avatar'), 'glyph')
    assert.ok(disc.querySelector('svg'), 'the glyph is drawn')
  }
}
reset()

// A photo that fails to decode falls back to the initials, silently.
render(state({ id: 'u1', email: 'dev@example.com', displayName: 'Dev Person', photoUrl: PHOTO }))
{
  const [footer] = avatars()
  const img = footer.querySelector('img')
  assert.ok(img)
  act(() => {
    img?.dispatchEvent(new dom.window.Event('error'))
  })
  assert.equal(footer.getAttribute('data-account-avatar'), 'initials', 'a broken photo becomes initials')
  assert.equal(footer.querySelector('img'), null)
  assert.equal((footer.textContent ?? '').trim(), 'DP')
}
reset()

// Signed out is unchanged: a Sign in button, no identity disc at all.
render(state(null, false), false)
assert.equal(avatars().length, 0, 'signed out renders no avatar')
assert.ok(dom.window.document.querySelector('button[aria-label="Sign in"]'), 'signed out offers sign-in')
reset()

console.log('sidebar-account-bar avatar: ok')
