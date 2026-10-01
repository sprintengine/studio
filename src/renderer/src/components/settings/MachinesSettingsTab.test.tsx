// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { ExecutionHostSettings, HostsListResult } from '../../../../shared/execution-host'

const fixtures = vi.hoisted(() => ({
  state: {
    appSettings: { hosts: {} as Record<string, unknown> },
    pluginCatalogEntries: [] as unknown[],
    setHostSettings: (() => {}) as (id: string, settings: unknown) => void,
  },
}))
vi.mock('../../store/workspaceStore', () => ({
  useWorkspaceStore: (select: (state: typeof fixtures.state) => unknown) => select(fixtures.state),
}))

const { MachinesSettingsTab, formatEnvLines, machineStateWords, parseEnvLines } = await import('./MachinesSettingsTab')

let root: Root
let host: HTMLDivElement
const writes: Array<[string, ExecutionHostSettings | null]> = []
const listCalls: unknown[] = []
let listing: HostsListResult = { hosts: [], wsl: null }

beforeEach(() => {
  writes.length = 0
  listCalls.length = 0
  fixtures.state.appSettings.hosts = {}
  fixtures.state.setHostSettings = (id, settings) => {
    writes.push([id, settings as ExecutionHostSettings | null])
  }
  listing = {
    hosts: [
      { id: 'local', kind: 'windows', label: 'This PC (Windows)', pathStyle: 'windows', state: 'ready' },
      {
        id: 'wsl:Ubuntu',
        kind: 'wsl',
        label: 'WSL: Ubuntu',
        pathStyle: 'wsl',
        state: 'ready',
        isDefaultDistro: true,
        enabled: false,
        wslVersion: 2,
      },
    ],
    wsl: { available: true },
  }
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    platform: 'win32',
    hostsList: async (options: unknown) => {
      listCalls.push(options)
      return listing
    },
    onHostsChanged: () => () => {},
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function render(onShowAgentClis?: (id: string) => void): Promise<void> {
  await act(async () => root.render(<MachinesSettingsTab onShowAgentClis={onShowAgentClis} />))
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

test('every distribution is listed with its state, and Settings asks WSL afresh on open', async () => {
  await render()
  expect(listCalls).toEqual([{ all: true, refresh: true }])
  expect(host.textContent).toContain('This PC (Windows)')
  expect(host.textContent).toContain('WSL: Ubuntu')
  expect(host.textContent).toContain('Running · WSL 2')
})

test('turning a distribution on writes its settings whole', async () => {
  await render()
  const toggle = host.querySelector<HTMLElement>('[role="switch"]')
  expect(toggle).toBeTruthy()
  await act(async () => toggle!.click())
  expect(writes).toEqual([['wsl:Ubuntu', { enabled: true, cliCommands: {}, env: {} }]])
})

test('each machine that is on opens its agent CLIs on the Agents tab', async () => {
  const shown: string[] = []
  fixtures.state.appSettings.hosts = { 'wsl:Ubuntu': { enabled: true, cliCommands: {}, env: {} } }
  await render((id) => shown.push(id))
  const links = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).filter(
    (button) => button.textContent === 'Agent CLIs on this machine',
  )
  expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
    'Agent CLIs on this machine, This PC (Windows)',
    'Agent CLIs on this machine, WSL: Ubuntu',
  ])
  await act(async () => links[1].click())
  await act(async () => links[0].click())
  expect(shown).toEqual(['wsl:Ubuntu', 'local'])
})

test('a distribution that is off offers no link: the Agents tab does not list it', async () => {
  await render(() => {})
  const labels = Array.from(host.querySelectorAll('button')).map((button) => button.getAttribute('aria-label'))
  expect(labels).toContain('Agent CLIs on this machine, This PC (Windows)')
  expect(labels).not.toContain('Agent CLIs on this machine, WSL: Ubuntu')
})

test('the machine detail holds the machine, and no list of CLIs', async () => {
  fixtures.state.pluginCatalogEntries = [{ id: 'codex', displayName: 'Codex', binary: 'codex', source: 'bundled' }]
  await render()
  const disclosure = host.querySelector<HTMLElement>('[aria-expanded="false"]')
  await act(async () => disclosure!.click())
  expect(host.querySelector('textarea[aria-label="WSL: Ubuntu environment"]')).toBeTruthy()
  expect(host.querySelector('input[aria-label="WSL: Ubuntu shell"]')).toBeTruthy()
  expect(host.textContent).not.toContain('Codex')
  expect(host.textContent).not.toContain('Command override')
})

test('WSL that did not answer says so', async () => {
  listing = { hosts: [listing.hosts[0]], wsl: { available: false, reason: 'WSL is not installed on this PC.' } }
  await render()
  expect(host.textContent).toContain('WSL did not answer.')
})

async function openUbuntuEnvironment(): Promise<HTMLTextAreaElement> {
  await render()
  const disclosure = host.querySelector<HTMLElement>('[aria-expanded="false"]')
  expect(disclosure).toBeTruthy()
  await act(async () => disclosure!.click())
  const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="WSL: Ubuntu environment"]')
  expect(field).toBeTruthy()
  return field!
}

async function type(field: HTMLTextAreaElement, text: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('an environment edit is written when the panel goes away without a blur', async () => {
  const field = await openUbuntuEnvironment()
  await type(field, 'API_URL=http://localhost:3000')
  expect(writes).toEqual([])
  // Escape closes Settings by unmounting it; the field never blurs.
  await act(async () => root.unmount())
  expect(writes).toEqual([
    ['wsl:Ubuntu', { enabled: false, cliCommands: {}, env: { API_URL: 'http://localhost:3000' } }],
  ])
  root = createRoot(host)
})

test('an environment edit is written a moment after typing stops', async () => {
  const field = await openUbuntuEnvironment()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await type(field, 'A=1')
    await type(field, 'A=12')
    expect(writes).toEqual([])
    await act(async () => vi.advanceTimersByTime(1_000))
    expect(writes).toEqual([['wsl:Ubuntu', { enabled: false, cliCommands: {}, env: { A: '12' } }]])
  } finally {
    vi.useRealTimers()
  }
})

test('closing the panel with no edit writes nothing', async () => {
  await openUbuntuEnvironment()
  await act(async () => root.unmount())
  expect(writes).toEqual([])
  root = createRoot(host)
})

test('the environment is edited as NAME=value lines', () => {
  expect(parseEnvLines('A=1\n# note\n\nB = two words\nbad-name=x\nC=a=b')).toEqual({
    A: '1',
    B: ' two words',
    C: 'a=b',
  })
  expect(formatEnvLines({ A: '1', C: 'a=b' })).toBe('A=1\nC=a=b')
})

test('a machine state reads in words', () => {
  const base = { id: 'wsl:Ubuntu', kind: 'wsl', label: 'WSL: Ubuntu', pathStyle: 'wsl' } as const
  expect(machineStateWords({ ...base, state: 'stopped' })).toBe('Stopped — starts when a workspace on it needs it')
  expect(machineStateWords({ ...base, state: 'unavailable', reason: 'This distribution is not installed.' })).toBe(
    'This distribution is not installed.',
  )
})
