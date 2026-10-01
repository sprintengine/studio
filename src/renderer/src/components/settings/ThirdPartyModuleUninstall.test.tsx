// @vitest-environment jsdom
//
// Settings → Modules: uninstall goes through the one channel that handles a
// module however it arrived, carries the envelope an MCP or skill removal
// needs, and forgets what this window kept for the module; "Install an
// extension from GitHub" sits beside "Install a module from a folder".
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { ThirdPartyModuleUninstallInput } from '../../../../shared/electron-api'
import type { ThirdPartyModuleView } from '../../../../shared/modules/manifest'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { ConfirmDialogProvider } from '../ui/ConfirmDialog'
import { ThirdPartyModuleList } from './ThirdPartyModuleList'

vi.mock('../../modules', () => ({
  getRendererHost: () => ({ getWorkspaceTypeModule: () => null }),
  onThirdPartyRendererModulesLoaded: () => () => {},
  refreshThirdPartyRendererModules: async () => {},
  installAndActivateRendererModules: (install: () => Promise<unknown>) => install(),
}))

const MODULE: ThirdPartyModuleView = {
  manifest: { id: 'notes-ext', displayName: 'Notes', version: 1, defaultEnabled: false, source: 'third-party' },
  trust: 'trusted',
  launch: { status: 'trusted_manifest_only', hasMainEntry: false, expectedToLoad: false },
}

const uninstallCalls: ThirdPartyModuleUninstallInput[] = []
let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  uninstallCalls.length = 0
  let installed = [MODULE]
  ;(window as unknown as { api: unknown }).api = {
    listThirdPartyModules: async () => ({ modules: installed, rejected: [] }),
    uninstallThirdPartyModule: async (input: ThirdPartyModuleUninstallInput) => {
      uninstallCalls.push(input)
      installed = []
      return { ok: true, removedModuleIds: ['notes-ext'], mcpSettings: { syncEnabled: true, servers: {} } }
    },
  }
  useWorkspaceStore.setState((state) => ({
    appSettings: {
      ...state.appSettings,
      modules: { 'notes-ext': true, 'other-ext': false },
      moduleSettings: { 'module:notes-ext': { theme: 'dark' } },
    },
  }))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  const created = createRoot(host)
  root = created
  await act(async () =>
    created.render(
      <ConfirmDialogProvider>
        <ThirdPartyModuleList overrides={{}} onSetEnabled={() => {}} />
      </ConfirmDialogProvider>,
    ),
  )
  await act(async () => {})
}

const buttonNamed = (label: string) =>
  [...document.querySelectorAll('button')].find(
    (candidate) => candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined

test('uninstall goes through the channel that handles any install, and forgets the module here', async () => {
  await mount()
  await act(async () => buttonNamed('Uninstall Notes')!.click())
  const confirm = [
    ...(document.querySelector('[role="alertdialog"], [role="dialog"]')?.querySelectorAll('button') ?? []),
  ].find((candidate) => candidate.textContent?.trim() === 'Uninstall')
  expect(confirm).toBeTruthy()
  await act(async () => confirm!.click())
  await act(async () => {})

  expect(uninstallCalls).toHaveLength(1)
  expect(uninstallCalls[0]?.id).toBe('notes-ext')
  expect(uninstallCalls[0]?.mcpSettings).toBeDefined()
  const settings = useWorkspaceStore.getState().appSettings
  expect(settings.modules).toEqual({ 'other-ext': false })
  expect(settings.moduleSettings?.['module:notes-ext']).toBeUndefined()
  expect(document.body.textContent).toContain('Uninstalled "Notes"')
})

test('"Install an extension from GitHub" sits beside the folder install and opens the dialog', async () => {
  await mount()
  expect(buttonNamed('Install a module from a folder')).toBeTruthy()
  await act(async () => buttonNamed('Install an extension from GitHub')!.click())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Install extension from GitHub')
})
