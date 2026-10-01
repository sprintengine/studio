import assert from 'node:assert/strict'

// The account menu is identity and sign-out, and nothing else: the app is open
// source and signing in unlocks nothing (owner ruling 2026-09-27), so no plan,
// tier or upgrade may appear on it. This renders the real surface, because an
// upgrade row or a plan label is a regression in what the element shows.
import { JSDOM } from 'jsdom'

import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import SidebarAccountBar from './SidebarAccountBar'
import type { SprintEngineAuthState } from '../../../../shared/electron-api'
import { test } from 'vitest'

test('SidebarAccountBar.accountMenu', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
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
  domWindow.api = {}

  function state(message: string | null = null): SprintEngineAuthState {
    return {
      authenticated: true,
      user: { id: 'u1', email: 'dev@example.com', displayName: 'Dev Person', photoUrl: null },
      selectedOrganization: { id: 'o1', name: 'Acme', slug: 'acme', type: 'team' },
      status: 'signed_in',
      message,
    }
  }
  let retries = 0

  function render(authState: SprintEngineAuthState): HTMLElement {
    const host = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(host)
    const root = createRoot(host as unknown as Element)
    act(() => {
      root.render(
        React.createElement(SidebarAccountBar, {
          collapsed: false,
          authState,
          authMessage: authState.message,
          accountOpen: true,
          setAccountOpen: () => {},
          startLogin: () => {},
          refreshAuthState: () => {
            retries += 1
          },
          logout: () => {},
          openSettings: () => {},
          settingsOpen: false,
        }),
      )
    })
    return dom.window.document.body as unknown as HTMLElement
  }

  function texts(): string[] {
    const buttons = [...dom.window.document.querySelectorAll('button')] as HTMLElement[]
    return buttons.map((button) => (button.textContent ?? '').trim())
  }

  // Signed in: who, which organisation, and the way out. No plan, no upgrade.
  render(state())
  const body = (): string => dom.window.document.body.textContent ?? ''
  assert.ok(body().includes('Dev Person'), 'the name is shown')
  assert.ok(body().includes('dev@example.com'), 'the address is shown')
  assert.ok(body().includes('Acme'), 'the organisation is shown')
  assert.deepEqual(
    texts().filter((text) => text === 'Sign out'),
    ['Sign out'],
    'sign-out is offered',
  )
  for (const word of ['Upgrade', 'Pro', 'Free', 'plan', 'Plan']) {
    assert.ok(!new RegExp(`\\b${word}\\b`).test(body()), `no "${word}" on the account menu`)
  }
  assert.ok(!texts().includes('Try again'), 'nothing to retry while the account read is fine')
  dom.window.document.body.innerHTML = ''

  // A failed account read says so and offers a retry, which refreshes the account.
  render(state('The SprintEngine account service could not be reached.'))
  assert.ok(body().includes('could not be reached'), 'the message is shown')
  const retry = [...dom.window.document.querySelectorAll('button')].find(
    (button) => (button.textContent ?? '').trim() === 'Try again',
  ) as HTMLButtonElement | undefined
  assert.ok(retry, 'a retry is offered')
  act(() => retry.click())
  assert.equal(retries, 1, 'the retry refreshes the account')
  dom.window.document.body.innerHTML = ''

  // The cluster is the account control and the gear, nothing else (app
  // shell, 2026-09-05): the modal-surface trigger glyphs that used to render
  // before the gear are rows of the sidebar's Extensions section now — see
  // ExtensionsRail.test.tsx for that contract.
  render(state())
  assert.ok(dom.window.document.querySelector('button[aria-label="Settings"]'), 'the gear keeps its slot')
  assert.deepEqual(
    [...dom.window.document.querySelectorAll('button[aria-label]')]
      .map((button) => button.getAttribute('aria-label') ?? '')
      .filter((label) => label !== 'Settings' && !label.startsWith('Account')),
    [],
    'the cluster is exactly the account control and the gear — no trigger glyphs',
  )

  console.log('SidebarAccountBar.accountMenu.test.tsx: ok')
})
