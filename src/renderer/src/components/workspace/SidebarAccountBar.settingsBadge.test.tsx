// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { SprintEngineAuthState } from '../../../../shared/electron-api'
import SidebarAccountBar from './SidebarAccountBar'
import type { RailBadge } from './AppRail'

// The Settings gear at the foot of the app rail wears the updates waiting in
// Settings (owner ruling 2026-09-25): the rail's own corner count, named, and
// nothing at all when there are none.

const SIGNED_OUT: SprintEngineAuthState = {
  authenticated: false,
  user: null,
  selectedOrganization: null,
  entitlements: null,
  status: 'signed_out',
  entitlementStatus: 'missing',
  message: null,
  lastRefreshAt: null,
  graceExpiresAt: null,
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {}
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function render(settingsBadge: RailBadge | null): Promise<void> {
  await act(async () =>
    root.render(
      <SidebarAccountBar
        collapsed
        authState={SIGNED_OUT}
        authMessage={null}
        accountOpen={false}
        setAccountOpen={() => {}}
        startLogin={() => {}}
        refreshAuthState={() => {}}
        logout={() => {}}
        openSettings={() => {}}
        settingsOpen={false}
        settingsBadge={settingsBadge}
      />,
    ),
  )
}

const gear = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!

test('an update waiting in Settings is a named count on the gear', async () => {
  await render({ count: 2, tone: 'accent', label: '2 updates available' })
  const badge = gear().querySelector('[role="status"]')
  expect(badge?.textContent).toBe('2')
  expect(badge?.getAttribute('aria-label')).toBe('2 updates available')
  // Docked on the gear's corner, ringed in the rail's canvas like every rail square's count.
  expect(badge?.className).toMatch(/absolute/)
  expect(badge?.className).toMatch(/--bg-canvas/)
  expect(gear().className).toMatch(/relative/)
})

test('no update, no badge — and a zero is never drawn', async () => {
  await render(null)
  expect(gear().querySelector('[role="status"]')).toBe(null)
  await render({ count: 0, tone: 'accent', label: '0 updates available' })
  expect(gear().querySelector('[role="status"]')).toBe(null)
})
