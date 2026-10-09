// @vitest-environment jsdom
//
// Settings → Extensions, driven the way a person does: review and trust,
// the one switch, the glyphs and what they name, the details, Update only
// where Studio can really update, the restart line, the filters, the folded
// built-ins, and uninstall through the one channel that handles any install.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { MarketplaceUpdateStatesResult, ThirdPartyModuleUninstallInput } from '../../../../shared/electron-api'
import { HOST_API_VERSION } from '../../../../shared/modules/host-api'
import type { CapabilityManifest, ThirdPartyModuleView } from '../../../../shared/modules/manifest'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { ConfirmDialogProvider } from '../ui/ConfirmDialog'
import { ModulesSettingsTab } from './ModulesSettingsTab'

const registry = {
  getWorkspaceTypeModule: () => null,
  getGlobalSurfaces: () => [{ moduleId: 'decision-log', id: 'decisions', label: 'Decisions' }],
  getWorkspaceTypes: () => [],
  getModalSurfaces: () => [],
  getModuleCommands: () => [{ moduleId: 'decision-log' }, { moduleId: 'decision-log' }],
  getSettingsSections: () => [],
  getTopBarItems: () => [],
  getBacklogItemActions: () => [],
  getFileActions: () => [],
}

vi.mock('../../modules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules')>()),
  getRendererHost: () => registry,
  onThirdPartyRendererModulesLoaded: () => () => {},
  refreshThirdPartyRendererModules: async () => {},
}))

vi.mock('../../modules/third-party-loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/third-party-loader')>()),
  getThirdPartyRendererLoadState: (id: string) => (id === 'decision-log' ? { status: 'loaded' } : undefined),
}))

function module(
  id: string,
  displayName: string,
  overrides: Partial<Omit<ThirdPartyModuleView, 'manifest' | 'launch'>> & {
    manifest?: Partial<CapabilityManifest>
    launch?: Partial<ThirdPartyModuleView['launch']>
  } = {},
): ThirdPartyModuleView {
  const { manifest, launch, ...rest } = overrides
  return {
    trust: 'trusted',
    trustedVia: 'grant',
    origin: { kind: 'folder' },
    mcpTools: [],
    ...rest,
    manifest: {
      id,
      displayName,
      version: 1,
      defaultEnabled: true,
      source: 'third-party',
      engines: { hostApi: HOST_API_VERSION },
      ...manifest,
    },
    launch: {
      status: 'trusted_executable',
      hasMainEntry: true,
      expectedToLoad: true,
      mainLoaded: true,
      rendererEntry: { availability: 'available' },
      ...launch,
    },
  }
}

const INSIGHTS = module('insights', 'Insights', {
  trust: 'unsigned',
  launch: { status: 'blocked_unsigned', mainLoaded: false },
  manifest: {
    summary: 'Usage and equivalent API cost across your chats, and prompt coaching every morning.',
    permissions: ['conversation:operate', 'filesystem:read-home', 'ipc:invoke', 'storage'],
  },
})
const SIGNED = module('kanban', 'Task Board', {
  trust: 'signed',
  launch: { status: 'blocked_signed', mainLoaded: false },
  manifest: { permissions: ['backlog.read'] },
})
const DECISION_LOG = module('decision-log', 'Decision Log', {
  mcpTools: ['decisions.record', 'decisions.search'],
  manifest: { summary: 'Durable decisions.', permissions: ['mcp:tools', 'storage', 'ipc:invoke'] },
})
const PR_RADAR = module('pr-radar', 'PR Radar', {
  origin: { kind: 'github', pluginId: 'weather', repo: 'acme/pr-radar' },
  launch: { mainLoaded: false },
  manifest: { publisher: 'acme', permissions: ['github'] },
})
const WEATHER = module('weather-deck', 'Weather Deck', {
  origin: { kind: 'marketplace', pluginId: 'weather' },
  manifest: { publisher: 'acme', version: 3, engines: { hostApi: HOST_API_VERSION + 1 } },
  launch: { status: 'blocked_host_api', mainLoaded: false },
})
const TAMPERED = module('tampered', 'Tampered', {
  trust: 'invalid',
  launch: { status: 'blocked_invalid', mainLoaded: false },
})

const UPDATES: MarketplaceUpdateStatesResult = {
  ok: true,
  checked: true,
  registryState: 'ok',
  registrySource: 'network',
  stale: false,
  fetchedAt: '2026-10-09T00:00:00.000Z',
  entries: [
    {
      id: 'weather',
      displayName: 'Weather Deck',
      availability: { state: 'update-available', installedVersion: 3, latestVersion: 4 },
    },
  ],
} as MarketplaceUpdateStatesResult

let installed: ThirdPartyModuleView[] = []
const trustCalls: Array<[string, boolean]> = []
const uninstallCalls: ThirdPartyModuleUninstallInput[] = []
const restartApp = vi.fn(async () => ({ restarting: false }))
let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  installed = [INSIGHTS, SIGNED, DECISION_LOG, PR_RADAR, WEATHER, TAMPERED]
  trustCalls.length = 0
  uninstallCalls.length = 0
  restartApp.mockClear()
  ;(window as unknown as { api: unknown }).api = {
    listThirdPartyModules: async () => ({ modules: installed, rejected: [] }),
    readMarketplacePluginUpdateStates: async () => UPDATES,
    setThirdPartyModuleTrust: async (id: string, trusted: boolean) => {
      trustCalls.push([id, trusted])
      return { ok: true }
    },
    uninstallThirdPartyModule: async (input: ThirdPartyModuleUninstallInput) => {
      uninstallCalls.push(input)
      installed = installed.filter((candidate) => candidate.manifest.id !== input.id)
      return { ok: true, removedModuleIds: [input.id], mcpSettings: { syncEnabled: true, servers: {} } }
    },
    restartApp,
    clipboardWriteText: async () => undefined,
  }
  useWorkspaceStore.setState((state) => ({
    appSettings: {
      ...state.appSettings,
      modules: { 'decision-log': true, 'other-ext': false },
      moduleSettings: { 'module:decision-log': { theme: 'dark' } },
    },
  }))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
  document.body.innerHTML = ''
})

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  const created = createRoot(host)
  root = created
  await act(async () =>
    created.render(
      <ConfirmDialogProvider>
        <ModulesSettingsTab />
      </ConfirmDialogProvider>,
    ),
  )
  await act(async () => {})
}

const panel = () => document.getElementById('settings-panel-modules')!
const buttons = (scope: ParentNode = document) => [...scope.querySelectorAll('button')] as HTMLButtonElement[]
const button = (name: string, scope: ParentNode = document) =>
  buttons(scope).find(
    (candidate) => candidate.getAttribute('aria-label') === name || candidate.textContent?.trim() === name,
  )
const list = (label: string) => panel().querySelector(`ul[aria-label="${label}"]`)
const rowOf = (name: string) =>
  [...panel().querySelectorAll('li')].find((li) => li.querySelector('button')?.textContent?.trim() === name)!
const click = async (element: Element | undefined | null) => {
  expect(element).toBeTruthy()
  await act(async () => (element as HTMLElement).click())
  await act(async () => {})
}
const modal = () => document.querySelector('[role="dialog"][aria-modal="true"]')

test('the page is Extensions, with Browse marketplace and an Install menu, and says nothing about itself', async () => {
  await mount()
  expect(panel().querySelector('h3')?.textContent).toBe('Extensions')
  expect(button('Browse marketplace', panel())).toBeTruthy()
  await click(button('Install', panel()))
  const menu = document.querySelector('[role="menu"][aria-label="Install"]')!
  expect([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())).toEqual([
    'From a folder',
    'From GitHub',
    'Browse marketplace',
  ])
  // No trailing ellipsis on any label.
  expect(buttons().some((candidate) => (candidate.textContent?.trim() ?? '').endsWith('…'))).toBe(false)
})

test('untrusted extensions come first under Needs review, each with Review and no switch', async () => {
  await mount()
  const review = list('Needs review')!
  expect([...review.querySelectorAll(':scope > li')].length).toBe(3)
  expect(review.querySelectorAll('[role="switch"]').length).toBe(0)
  expect(button('Review Insights', review)).toBeTruthy()
  // An invalid signature can never be trusted: words, and no Review.
  const tampered = rowOf('Tampered')
  expect(tampered.textContent).toContain('Can’t be trusted')
  expect(button('Review Tampered', tampered)).toBeUndefined()
})

test('review asks for the unsigned answer before it trusts and turns on in one step', async () => {
  await mount()
  await click(button('Review Insights'))
  const dialog = modal()!
  expect(dialog.textContent).toContain('Trust Insights?')
  expect(dialog.textContent).toContain('Needs care')
  expect(dialog.textContent).toContain('Runs chats with your agents')
  expect(dialog.textContent).toContain('Starts, messages and stops chats')
  expect(dialog.querySelector('ul[aria-label="Also"]')?.textContent).toContain('Saves its own data')
  expect(dialog.textContent).toContain('Starts after a restart')
  const trust = button('Trust and turn on', dialog)!
  expect(trust.disabled).toBe(true)

  const box = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  expect(box.closest('label')?.textContent).toBe('I trust this unsigned code')
  await click(box)
  expect(trust.disabled).toBe(false)
  await click(trust)

  expect(trustCalls).toEqual([['insights', true]])
  expect(useWorkspaceStore.getState().appSettings.modules.insights).toBe(true)
  expect(modal()).toBeNull()
})

test('a signed extension needs no unsigned answer', async () => {
  await mount()
  await click(button('Review Task Board'))
  expect(modal()!.querySelector('input[type="checkbox"]')).toBeNull()
  expect(button('Trust and turn on', modal()!)!.disabled).toBe(false)
})

test('an installed extension has one switch, its state in words, and no trust switch', async () => {
  await mount()
  const row = rowOf('Decision Log')
  const switches = row.querySelectorAll('[role="switch"]')
  expect(switches.length).toBe(1)
  expect(switches[0]!.getAttribute('aria-label')).toBe('Enable Decision Log')
  expect(row.textContent).toContain('Running')
  expect(rowOf('PR Radar').textContent).toContain('Starts after restart')
  await click(switches[0])
  expect(useWorkspaceStore.getState().appSettings.modules['decision-log']).toBe(false)
})

test('sensitive access is one glyph per scope, named in full, listed on hover', async () => {
  await mount()
  const glyphs = rowOf('Insights').querySelector('[role="img"][aria-label^="Insights needs care"]') as HTMLElement
  expect(glyphs.getAttribute('aria-label')).toBe(
    'Insights needs care: Runs chats with your agents, Reads your home folder, Broad access to Studio',
  )
  expect(glyphs.querySelectorAll('svg').length).toBe(3)
  // The row never carries the consent sentences themselves.
  expect(rowOf('Insights').textContent).not.toContain('internal APIs')
  await act(async () => {
    glyphs.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))
    await new Promise((resolve) => setTimeout(resolve, 260))
  })
  const tip = document.querySelector('[role="tooltip"]')
  expect(tip?.textContent).toContain('Reads your home folder')
  expect(tip?.querySelectorAll('li').length).toBe(3)
})

test('the full summary is on the row, never clipped to a line', async () => {
  await mount()
  const summary = [...rowOf('Insights').querySelectorAll('p')].find((p) => p.textContent?.startsWith('Usage'))!
  expect(summary.className).not.toMatch(/truncate|line-clamp/)
})

test('the name opens the details: what it adds, its access with ids, and the facts', async () => {
  await mount()
  await click(button('Decision Log'))
  const details = document.querySelector('[role="dialog"][aria-label="Decision Log details"]')!
  expect(details).toBeTruthy()
  const adds = details.querySelector('section[aria-label="Adds"]')!
  expect([...adds.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
    'Decisions door',
    '2 commands',
    '2 agent tools',
  ])
  expect(details.textContent).toContain('ipc:invoke')
  expect(details.textContent).toContain('Unsigned')
  expect(details.textContent).toContain('Local build')
  expect(button('Revoke trust', details)).toBeTruthy()
  // Escape closes it and hands focus back to the name.
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(document.querySelector('[aria-label="Decision Log details"]')).toBeNull()
  expect(document.activeElement?.textContent).toBe('Decision Log')
})

test('an untrusted extension’s details offer Review and trust, and claim nothing about what it adds', async () => {
  await mount()
  await click(button('Insights'))
  const details = document.querySelector('[aria-label="Insights details"]')!
  expect(details.querySelector('section[aria-label="Adds"]')).toBeNull()
  expect(details.textContent).toContain('Not trusted')
  expect(button('Review and trust', details)).toBeTruthy()
})

test('Update appears only for a marketplace install with a newer version, labelled with it', async () => {
  await mount()
  const weather = rowOf('Weather Deck')
  expect(weather.textContent).toContain('Built for a newer version of Studio.')
  expect(button('Update to v4', weather)).toBeTruthy()
  // Same registry entry id, but installed from GitHub: no update path here.
  expect(buttons(rowOf('PR Radar')).some((candidate) => /Update/.test(candidate.textContent ?? ''))).toBe(false)
})

test('the restart line names what waits on the next launch and offers one primary action', async () => {
  await mount()
  const banner = panel().querySelector('[role="status"]')!
  expect(banner.textContent).toContain('Restart Studio to start PR Radar')
  await click(button('Restart now', banner))
  expect(restartApp).toHaveBeenCalledTimes(1)
  await click(button('Later', banner))
  expect(panel().textContent).not.toContain('Restart Studio to start')
})

test('filters and search narrow the groups', async () => {
  await mount()
  await click(panel().querySelector('[role="radio"][aria-label^="Needs review"]'))
  expect(list('Needs review')).toBeTruthy()
  expect(list('Installed')).toBeNull()
  expect(list('Built in')).toBeNull()

  await click(panel().querySelector('[role="radio"]'))
  const input = panel().querySelector<HTMLInputElement>('input[aria-label="Search extensions"]')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, 'radar')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(list('Needs review')).toBeNull()
  expect([...list('Installed')!.querySelectorAll(':scope > li')].length).toBe(1)
})

test('built-in modules are folded away until asked for', async () => {
  await mount()
  const toggle = button('Built in', panel())!
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(list('Built in')!.closest('[hidden]')).toBeTruthy()
  await click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(list('Built in')!.closest('[hidden]')).toBeNull()
  expect(list('Built in')!.textContent).toContain('Always on')
})

test('uninstall goes through the channel that handles any install, and forgets the module here', async () => {
  await mount()
  await click(button('More for Decision Log'))
  await click([...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'Uninstall'))
  const confirm = buttons(document.querySelector('[role="alertdialog"], [role="dialog"]')!).find(
    (candidate) => candidate.textContent?.trim() === 'Uninstall',
  )
  expect(document.body.textContent).toContain('Work it saved in your projects stays')
  await click(confirm)

  expect(uninstallCalls).toHaveLength(1)
  expect(uninstallCalls[0]?.id).toBe('decision-log')
  expect(uninstallCalls[0]?.mcpSettings).toBeDefined()
  const settings = useWorkspaceStore.getState().appSettings
  expect(settings.modules).toEqual({ 'other-ext': false })
  expect(settings.moduleSettings?.['module:decision-log']).toBeUndefined()
  expect(rowOf('PR Radar')).toBeTruthy()
  expect(panel().textContent).not.toContain('Decision Log')
})
