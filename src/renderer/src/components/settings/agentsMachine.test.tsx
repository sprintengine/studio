// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { ExecutionHostId, HostsListResult } from '../../../../shared/execution-host'

const fixtures = vi.hoisted(() => ({
  state: { appSettings: { hosts: {} as Record<string, unknown> } },
}))
vi.mock('../../store/workspaceStore', () => ({
  useWorkspaceStore: (select: (state: typeof fixtures.state) => unknown) => select(fixtures.state),
}))

const {
  agentsMachines,
  lastAgentsMachine,
  orderInstalledFirst,
  rememberAgentsMachine,
  resolveAgentsMachine,
  useMachineCliAvailability,
} = await import('./agentsMachine')

const windowsListing = (enabled: boolean): HostsListResult => ({
  hosts: [
    { id: 'local', kind: 'windows', label: 'This PC (Windows)', pathStyle: 'windows', state: 'ready' },
    { id: 'wsl:Ubuntu', kind: 'wsl', label: 'WSL: Ubuntu', pathStyle: 'wsl', state: 'ready', enabled },
    { id: 'wsl:Debian', kind: 'wsl', label: 'WSL: Debian', pathStyle: 'wsl', state: 'stopped', enabled: false },
  ],
  wsl: { available: true },
})

test('macOS offers one machine, so the Agents tab draws no switcher', () => {
  const mac: HostsListResult = {
    hosts: [{ id: 'local', kind: 'posix', label: 'This Mac', pathStyle: 'posix', state: 'ready' }],
    wsl: null,
  }
  expect(agentsMachines(mac, 'This Mac')).toEqual([{ id: 'local', label: 'This Mac' }])
  // Before main answers, this machine alone, under the platform's own name.
  expect(agentsMachines(null, 'This Mac')).toEqual([{ id: 'local', label: 'This Mac' }])
})

test('Windows offers this PC and each distribution that is turned on, and no other', () => {
  expect(agentsMachines(windowsListing(false), 'x')).toEqual([{ id: 'local', label: 'This PC (Windows)' }])
  expect(agentsMachines(windowsListing(true), 'x')).toEqual([
    { id: 'local', label: 'This PC (Windows)' },
    { id: 'wsl:Ubuntu', label: 'WSL: Ubuntu' },
  ])
})

test('a pick holds while its machine is offered, and falls back to this one when it is not', () => {
  const machines = agentsMachines(windowsListing(true), 'x')
  expect(resolveAgentsMachine(machines, 'wsl:Ubuntu').id).toBe('wsl:Ubuntu')
  expect(resolveAgentsMachine(machines, 'wsl:Debian').id).toBe('local')
  expect(resolveAgentsMachine(machines, null).id).toBe('local')
})

test('the window remembers the machine it last showed', () => {
  rememberAgentsMachine('wsl:Ubuntu')
  expect(lastAgentsMachine()).toBe('wsl:Ubuntu')
  rememberAgentsMachine('local')
  expect(lastAgentsMachine()).toBe(null)
})

test('installed first in their own order, then the missing ones in theirs', () => {
  const rows = ['a', 'b', 'c', 'd', 'e']
  const missing = new Set(['a', 'd'])
  expect(orderInstalledFirst(rows, (row) => missing.has(row))).toEqual(['b', 'c', 'e', 'a', 'd'])
  expect(orderInstalledFirst(rows, () => false)).toEqual(rows)
})

// ---------------------------------------------------------------------------
// The WSL machine's own probe
// ---------------------------------------------------------------------------

let root: Root
let host: HTMLDivElement
const probes: unknown[] = []
let seen: ReturnType<typeof useMachineCliAvailability> | null = null

function Probe({ hostId }: { hostId: ExecutionHostId }): null {
  seen = useMachineCliAvailability(hostId, ['claude', 'codex'])
  return null
}

beforeEach(() => {
  probes.length = 0
  seen = null
  fixtures.state.appSettings.hosts = { 'wsl:Ubuntu': { enabled: true, cliCommands: { codex: '/opt/codex' }, env: {} } }
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    pluginsDetectAvailability: async (input: unknown) => {
      probes.push(input)
      return {
        ok: true,
        availability: { claude: { cli: 'claude', installed: true, resolvedPath: '/usr/bin/claude', version: '2.0.1' } },
      }
    },
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function settle(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

test('an override edit waits for typing to stop before it asks the machine again', async () => {
  await act(async () => root.render(<Probe hostId="wsl:Ubuntu" />))
  await settle()
  expect(probes).toHaveLength(1)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    fixtures.state.appSettings.hosts = { 'wsl:Ubuntu': { enabled: true, cliCommands: { codex: '/o' }, env: {} } }
    await act(async () => root.render(<Probe hostId="wsl:Ubuntu" />))
    fixtures.state.appSettings.hosts = { 'wsl:Ubuntu': { enabled: true, cliCommands: { codex: '/op' }, env: {} } }
    await act(async () => root.render(<Probe hostId="wsl:Ubuntu" />))
    expect(probes).toHaveLength(1)
    await act(async () => vi.advanceTimersByTime(1_000))
  } finally {
    vi.useRealTimers()
  }
  await settle()
  expect(probes).toHaveLength(2)
  expect(probes[1]).toMatchObject({ cliRuntimes: { codex: { command: '/op' } } })
})

test('an answer for a machine no longer shown is dropped', async () => {
  let release: (value: unknown) => void = () => {}
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    pluginsDetectAvailability: (input: unknown) => {
      probes.push(input)
      return new Promise((resolve) => {
        release = resolve
      })
    },
  }
  await act(async () => root.render(<Probe hostId="wsl:Ubuntu" />))
  await act(async () => root.render(<Probe hostId="local" />))
  await act(async () =>
    release({
      ok: true,
      availability: { claude: { cli: 'claude', installed: true, resolvedPath: null, version: '1' } },
    }),
  )
  await settle()
  expect(seen?.availability).toBe(null)
})

test('a probe that fails says why', async () => {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    pluginsDetectAvailability: async () => ({ ok: false, message: 'The distribution did not start.' }),
  }
  await act(async () => root.render(<Probe hostId="wsl:Ubuntu" />))
  await settle()
  expect(seen?.availability).toMatchObject({ status: 'error', error: 'The distribution did not start.', map: {} })
})

test('this machine is never probed here — its answer is the store’s', async () => {
  await act(async () => root.render(<Probe hostId="local" />))
  await settle()
  expect(probes).toEqual([])
  expect(seen?.availability).toBe(null)
})

test('a WSL machine is read with its own commands, and a reload reads again without forcing a probe', async () => {
  await act(async () => root.render(<Probe hostId="wsl:Ubuntu" />))
  await settle()
  expect(probes).toEqual([
    {
      cliRuntimes: {
        claude: { command: '', hostId: 'wsl:Ubuntu' },
        codex: { command: '/opt/codex', hostId: 'wsl:Ubuntu' },
      },
    },
  ])
  expect(seen?.availability?.status).toBe('ready')
  expect(seen?.availability?.map.claude?.version).toBe('2.0.1')
  expect(seen?.availability?.checkedAt).toEqual(expect.any(Number))

  // Re-check and an install have already detected in main; reading again
  // picks that answer up, and forcing here would probe every CLI a second time.
  await act(async () => seen!.reload())
  await settle()
  expect(probes).toHaveLength(2)
  expect(probes[1]).not.toHaveProperty('force')
})
