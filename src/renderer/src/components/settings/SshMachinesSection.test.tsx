// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { DEFAULT_SSH_ENVIRONMENT_SETTINGS, type SshEnvironmentSummary } from '../../../../shared/ssh-environments'
import { ConfirmDialogProvider } from '../ui'
import { SshMachinesSection } from './SshMachinesSection'

let root: Root
let host: HTMLDivElement
const calls: Array<[string, unknown]> = []
let machines: SshEnvironmentSummary[] = []

const machine = (patch: Partial<SshEnvironmentSummary>): SshEnvironmentSummary => ({
  id: 'e1',
  label: 'build-box',
  destination: 'build-box',
  resolved: { hostname: '192.0.2.10', user: 'dev', port: 22, proxyJump: null },
  environmentId: null,
  settings: { ...DEFAULT_SSH_ENVIRONMENT_SETTINGS },
  addedAt: 0,
  state: 'idle',
  stateText: 'Not connected',
  working: false,
  action: 'connect',
  server: null,
  notes: [],
  ...patch,
})

const api = {
  sshEnvironmentsList: async () => machines,
  sshEnvironmentResolve: async (destination: string) => {
    calls.push(['resolve', destination])
    return {
      ok: true as const,
      destination,
      resolved: { hostname: '192.0.2.10', user: 'dev', port: 2222, proxyJump: 'bastion', notes: [] },
    }
  },
  sshEnvironmentSuggestions: async () => ['build-box', 'mac-mini'],
  sshEnvironmentAdd: async (input: { destination: string }) => (
    calls.push(['add', input]),
    { ok: true as const, id: 'e2' }
  ),
  sshEnvironmentUpdate: async (id: string, patch: unknown) => (
    calls.push(['update', { id, patch }]),
    { ok: true as const }
  ),
  sshEnvironmentConnect: async (id: string) => (calls.push(['connect', id]), { ok: true as const }),
  sshEnvironmentDisconnect: async (id: string) => (calls.push(['disconnect', id]), { ok: true as const }),
  sshEnvironmentStopServer: async () => ({ ok: true as const }),
  sshEnvironmentUpgradeServer: async () => ({ ok: true as const }),
  sshEnvironmentForget: async () => ({ ok: true as const }),
  sshEnvironmentDiagnostics: async () => ({ ok: true as const, text: 'Machine: build-box' }),
  onSshEnvironmentsChanged: () => () => undefined,
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve())
}
const button = (name: string) =>
  [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === name,
  ) as HTMLButtonElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = async () => {
  act(() =>
    root.render(
      <ConfirmDialogProvider>
        <SshMachinesSection api={api as never} />
      </ConfirmDialogProvider>,
    ),
  )
  await flush()
}

test('each machine says its state in words; the working mark shows only while a step runs', async () => {
  machines = [
    machine({
      id: 'e1',
      state: 'connected',
      stateText: 'Connected',
      action: null,
      server: { version: '0.4.0', origin: 'bootstrap', startedBy: 'Studio on dev-macbook-air' },
    }),
    machine({
      id: 'e2',
      label: 'mac-mini',
      state: 'installing',
      stateText: 'Installing Studio server 0.4.0 on mac-mini (34 MB)…',
      working: true,
      action: null,
    }),
    machine({
      id: 'e3',
      label: 'old-box',
      state: 'unsupported',
      stateText: "Can't run here: old-box uses musl (as Alpine does)…",
    }),
  ]
  await render()
  const text = document.body.textContent ?? ''
  expect(text).toContain('Connected')
  expect(text).toContain('Installing Studio server 0.4.0 on mac-mini (34 MB)…')
  expect(text).toContain('uses musl')
  expect(document.querySelectorAll('[class*="rounded-full"][class*="size-2"]').length).toBe(0)
  act(() => button('Disconnect').click())
  expect(calls).toContainEqual(['disconnect', 'e1'])
})

test('adding: suggestions from the SSH config, the resolved route shown before it is saved', async () => {
  machines = []
  await render()
  expect(document.body.textContent).toContain('From your SSH config:')
  act(() => button('build-box').click())
  await flush()
  expect(calls).toContainEqual(['resolve', 'build-box'])
  expect(document.body.textContent).toContain('dev@192.0.2.10:2222')
  expect(document.body.textContent).toContain('bastion')
  act(() => button('Add build-box').click())
  await flush()
  expect(calls).toContainEqual(['add', { destination: 'build-box' }])
})
