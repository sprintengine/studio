// @vitest-environment jsdom
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'

import type { SprintEngineAuthState } from '../../../../shared/electron-api'
import SidebarAccountBar from './SidebarAccountBar'

// The gear's tooltip opens beside the rail when the sidebar is collapsed: on
// top it covered the account button stacked right above the gear.

vi.mock('../ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ui')>()),
  Tooltip: ({ content, placement, children }: { content: string; placement: string; children: React.ReactNode }) => (
    <span data-tooltip={content} data-placement={placement}>
      {children}
    </span>
  ),
}))

const SIGNED_OUT: SprintEngineAuthState = {
  authenticated: false,
  user: null,
  selectedOrganization: null,
  status: 'signed_out',
  message: null,
}

function gearPlacement(collapsed: boolean): string | null {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(
    <SidebarAccountBar
      collapsed={collapsed}
      authState={SIGNED_OUT}
      authMessage={null}
      accountOpen={false}
      setAccountOpen={() => {}}
      startLogin={() => {}}
      refreshAuthState={() => {}}
      logout={() => {}}
      openSettings={() => {}}
      settingsOpen={false}
      settingsBadge={null}
    />,
  )
  return host.querySelector('[data-tooltip="Settings"]')?.getAttribute('data-placement') ?? null
}

test('on the collapsed rail the gear tooltip opens to the right, clear of the account button', () => {
  expect(gearPlacement(true)).toBe('right')
})

test('in the open sidebar the gear tooltip keeps opening on top', () => {
  expect(gearPlacement(false)).toBe('top')
})
