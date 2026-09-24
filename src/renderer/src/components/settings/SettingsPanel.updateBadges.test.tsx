// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { AppUpdateState, CliVersionAdvisoryMap } from '../../../../shared/electron-api'
import type { ExecutionHostId, HostsListResult } from '../../../../shared/execution-host'

// The update badges inside Settings (owner ruling 2026-09-25), through the real
// panel: General wears the app update, Agents the CLI updates, the machine
// switcher's This PC segment the CLI updates, and each appears and clears with
// the update. Also the other half of "links now open Settings ▸ Agents": an
// opener that names a machine lands on it.
//
// Every IPC the panel reaches for on mount answers "nothing" unless named here.

let listing: HostsListResult
let appUpdate: AppUpdateState
let pushState: ((state: AppUpdateState) => void) | null = null

function appState(over: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    status: 'not_available',
    version: '0.6.0',
    channel: 'stable',
    buildChannel: 'stable',
    packaged: true,
    updateVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseNotesUrl: null,
    downloaded: false,
    progress: null,
    errorMessage: null,
    lastCheckedAt: null,
    autoDownload: false,
    installRequiresAdmin: false,
    installOutcome: null,
    ...over,
  }
}

function stubApi(): void {
  const named: Record<string, unknown> = {
    hostsList: async () => listing,
    onHostsChanged: () => () => {},
    // Codex is installed here; a WSL probe finds nothing.
    pluginsDetectAvailability: async (input: { cliRuntimes?: Record<string, { hostId?: string }> }) => {
      const wsl = JSON.stringify(input).includes('"hostId":"wsl:')
      return {
        ok: true,
        availability: wsl
          ? {}
          : { codex: { cli: 'codex', installed: true, resolvedPath: '/usr/local/bin/codex', version: '0.40.0' } },
      }
    },
    pluginsList: async () => ({ ok: true, plugins: [] }),
    getGitHubTokenStatus: async () => ({ configured: false }),
    updateGetState: async () => appUpdate,
    onUpdateStateChanged: (cb: (state: AppUpdateState) => void) => {
      pushState = cb
      return () => {
        pushState = null
      }
    },
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(named, {
    get(target, key) {
      if (key === 'platform') return 'win32'
      if (typeof key !== 'string') return undefined
      if (key in target) return target[key]
      return key.startsWith('on') ? () => () => {} : async () => undefined
    },
  })
}

const { default: SettingsPanel } = await import('./SettingsPanel')
const { ConfirmDialogProvider } = await import('../ui/ConfirmDialog')
const { useWorkspaceStore } = await import('../../store/workspaceStore')
const { useNotificationStore } = await import('../../store/notificationStore')
const { useAppUpdateStore } = await import('../../store/appUpdateStore')
const { rememberAgentsMachine } = await import('./agentsMachine')

function Panel({
  initialTab,
  request,
}: {
  initialTab: string
  request?: { hostId: ExecutionHostId; requestId: number }
}): React.JSX.Element {
  return (
    <ConfirmDialogProvider>
      <SettingsPanel onClose={() => {}} initialTab={initialTab} agentsMachineRequest={request} />
    </ConfirmDialogProvider>
  )
}

const BEHIND: CliVersionAdvisoryMap = {
  codex: {
    cli: 'codex',
    status: 'behind_latest',
    currentVersion: '0.40.0',
    latestVersion: '0.41.0',
    updateCommand: null,
    checkedAt: '2026-09-25T00:00:00.000Z',
  },
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  rememberAgentsMachine('local')
  appUpdate = appState()
  useAppUpdateStore.setState({ state: null })
  useNotificationStore.setState({ dismissedUpdates: [] })
  useWorkspaceStore.getState().setHostSettings('wsl:Ubuntu', { enabled: true, cliCommands: {}, env: {} })
  useWorkspaceStore.setState({
    pluginCatalogStatus: 'ready',
    pluginCatalogEntries: [
      { id: 'codex', kind: 'cli', displayName: 'Codex', binary: 'codex', source: 'bundled' },
    ] as unknown as ReturnType<typeof useWorkspaceStore.getState>['pluginCatalogEntries'],
    cliAvailability: {
      codex: { cli: 'codex', installed: true, resolvedPath: '/usr/local/bin/codex', version: '0.40.0' },
    } as ReturnType<typeof useWorkspaceStore.getState>['cliAvailability'],
    cliAvailabilityStatus: 'ready',
    checkCliVersions: true,
    cliVersionAdvisories: {},
  })
  listing = {
    hosts: [
      { id: 'local', kind: 'windows', label: 'This PC (Windows)', pathStyle: 'windows', state: 'ready' },
      { id: 'wsl:Ubuntu', kind: 'wsl', label: 'WSL: Ubuntu', pathStyle: 'wsl', state: 'ready', enabled: true },
    ],
    wsl: { available: true },
  }
  stubApi()
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

const navTab = (id: string): HTMLElement => host.querySelector<HTMLElement>(`#settings-tab-${id}`)!
const navBadge = (id: string): Element | null => navTab(id).querySelector('[role="status"]')
const segments = (): HTMLButtonElement[] =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Machine"] [role="radio"]'))
const checkedMachine = (): string | null | undefined =>
  segments().find((segment) => segment.getAttribute('aria-checked') === 'true')?.textContent

test('a CLI update badges Agents, This PC’s segment and the row, and clears when installed', async () => {
  useWorkspaceStore.setState({ cliVersionAdvisories: BEHIND })
  await act(async () => root.render(<Panel initialTab="agents" />))
  await settle()

  expect(navTab('agents').getAttribute('aria-label')).toBe('Agents, 1 CLI update available')
  expect(navBadge('agents')?.textContent).toBe('1')
  expect(navBadge('general')).toBe(null)

  const [thisPc, ubuntu] = segments()
  expect(thisPc.getAttribute('aria-label')).toBe('This PC (Windows), 1 CLI update available')
  expect(ubuntu.querySelector('[role="status"]')).toBe(null)

  expect(host.querySelector('[aria-label="Codex — update available: 0.41.0"]')).toBeTruthy()

  // Installed: the advisory stops saying behind.
  await act(async () =>
    useWorkspaceStore.setState({ cliVersionAdvisories: { codex: { ...BEHIND.codex!, status: 'current' } } }),
  )
  expect(navBadge('agents')).toBe(null)
  expect(navTab('agents').getAttribute('aria-label')).toBe(null)
  expect(segments()[0].querySelector('[role="status"]')).toBe(null)
  expect(host.querySelector('[aria-label="Codex — update available: 0.41.0"]')).toBe(null)
})

test('a dismissed CLI update loses every badge but keeps its Update button', async () => {
  useWorkspaceStore.setState({ cliVersionAdvisories: BEHIND })
  await act(async () => root.render(<Panel initialTab="agents" />))
  await settle()
  expect(navBadge('agents')).toBeTruthy()

  await act(async () => useNotificationStore.getState().dismissUpdate('cli:codex@0.41.0'))
  expect(navBadge('agents')).toBe(null)
  expect(segments()[0].querySelector('[role="status"]')).toBe(null)
  expect(host.querySelector('[aria-label="Codex — update available: 0.41.0"]')).toBe(null)
  expect(Array.from(host.querySelectorAll('button')).some((button) => button.textContent === 'Update')).toBe(true)
})

test('an app update badges General and fills the version row; it clears when installed or dismissed', async () => {
  appUpdate = appState({ status: 'available', updateVersion: '0.7.0' })
  await act(async () => root.render(<Panel initialTab="general" />))
  await settle()

  expect(navTab('general').getAttribute('aria-label')).toBe('General, Update available')
  expect(navBadge('general')?.textContent).toBe('1')
  expect(navBadge('agents')).toBe(null)
  expect(host.textContent).toContain('0.7.0 available')
  expect(host.querySelector('button[aria-label="Download SprintEngine Studio 0.7.0"]')).toBeTruthy()

  // Downloading, then ready: the badge stays through both.
  await act(async () =>
    pushState?.(
      appState({
        status: 'downloading',
        updateVersion: '0.7.0',
        progress: { percent: 50, transferred: 1, total: 2, bytesPerSecond: 1 },
      }),
    ),
  )
  expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50')
  expect(navBadge('general')).toBeTruthy()
  await act(async () => pushState?.(appState({ status: 'downloaded', downloaded: true, updateVersion: '0.7.0' })))
  expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Restart to update')).toBe(true)
  expect(navTab('general').getAttribute('aria-label')).toBe('General, Update ready to install')

  // Installing: still waiting on the restart, still badged.
  await act(async () => pushState?.(appState({ status: 'installing', downloaded: true, updateVersion: '0.7.0' })))
  expect(navBadge('general')).toBeTruthy()

  // Refused: back to ready with the reason — still an update to take.
  await act(async () =>
    pushState?.(
      appState({ status: 'downloaded', downloaded: true, updateVersion: '0.7.0', errorMessage: 'Installer busy.' }),
    ),
  )
  expect(navBadge('general')).toBeTruthy()
  expect(host.textContent).toContain('Installer busy.')

  // Dismissed at this step (Later on the ready toast).
  await act(async () => useNotificationStore.getState().dismissUpdate('app@0.7.0:ready'))
  expect(navBadge('general')).toBe(null)
  expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Restart to update')).toBe(true)

  // Installed: a new start reports the new version and nothing pending.
  await act(async () => useNotificationStore.setState({ dismissedUpdates: [] }))
  await act(async () => pushState?.(appState({ version: '0.7.0' })))
  expect(navBadge('general')).toBe(null)
  expect(host.textContent).toContain('SprintEngine Studio 0.7.0')
})

test('a download that failed keeps General badged and the row offers Download again', async () => {
  appUpdate = appState({ status: 'error', updateVersion: '0.7.0', errorMessage: 'net::ERR_CONNECTION_RESET' })
  await act(async () => root.render(<Panel initialTab="general" />))
  await settle()
  expect(navBadge('general')?.textContent).toBe('1')
  expect(host.querySelector('button[aria-label="Download SprintEngine Studio 0.7.0"]')).toBeTruthy()
  // The offer waved off: gone until the next step or the next release.
  await act(async () => useNotificationStore.getState().dismissUpdate('app@0.7.0:offer'))
  expect(navBadge('general')).toBe(null)
})

test('an opener that names a machine lands on it, even when the tab last showed another', async () => {
  rememberAgentsMachine('wsl:Ubuntu')
  await act(async () => root.render(<Panel initialTab="agents" request={{ hostId: 'local', requestId: 1 }} />))
  await settle()
  expect(host.querySelector('#settings-panel-agents')).toBeTruthy()
  expect(checkedMachine()).toBe('This PC (Windows)')

  // Moved away, then asked again (a second CLI update toast's Settings).
  await act(async () => segments()[1].click())
  expect(checkedMachine()).toBe('WSL: Ubuntu')
  await act(async () => root.render(<Panel initialTab="agents" request={{ hostId: 'local', requestId: 2 }} />))
  await settle()
  expect(checkedMachine()).toBe('This PC (Windows)')
})
