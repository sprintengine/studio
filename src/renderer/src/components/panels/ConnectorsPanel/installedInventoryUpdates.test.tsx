import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { JSDOM } from 'jsdom'

// MC-1873 (surface) — the Extensions manage canvas surfaces staleness as ONE
// banner above the Capability modules group and settles without an app
// restart. This drives the real InstalledExtensionsInventory in a DOM against
// a stubbed window.api:
//   • fixture registry serves latest=2 over installed v1 → banner with the
//     delta ("Design Wizard update · v1 → v2", action "Update to v2");
//   • the action routes through updateMarketplacePluginFromRegistry and the
//     surface settles to current (banner gone) with no remount;
//   • CLI rows offer Update with no version-delta claim (cliUpdate, never the
//     bundle download);
//   • registry unreachable renders couldn't-check; ahead-of-registry renders
//     neither an update nor an error;
//   • no update UI exists anywhere on the Skills surface (standing ruling).

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
anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
anyGlobal.Node = dom.window.Node
anyGlobal.CustomEvent = dom.window.CustomEvent
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.localStorage = dom.window.localStorage
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
dom.window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
})) as unknown as typeof dom.window.matchMedia
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
anyGlobal.ResizeObserver = NoopResizeObserver
dom.window.ResizeObserver = NoopResizeObserver as unknown as typeof dom.window.ResizeObserver

// ── window.api stub: the T9 seam + the inventory list APIs ───────────────────

// Mutable installed version: the update-entry call bumps it, so the NEXT
// update-states read reports current — exactly the no-restart settle.
let installedVersion = 1
let registryReachable = true
let aheadOfRegistry = false

const calls: Record<string, unknown[]> = {
  updateEntry: [],
  verify: [],
  cliUpdate: [],
  updateStatesReads: [],
}

const designWizardManifest = {
  id: 'design-wizard',
  displayName: 'Design Wizard',
  version: 1,
  summary: 'Design systems from a wizard',
  source: 'third-party',
  defaultEnabled: true,
}

const api: Record<string, unknown> = {
  platform: 'darwin',
  listThirdPartyModules: async () => ({
    modules: [{ manifest: { ...designWizardManifest, version: installedVersion }, trust: 'trusted' }],
    rejected: [],
  }),
  pluginsList: async () => ({
    ok: true,
    plugins: [
      { id: 'claude-code', displayName: 'Claude Code', source: 'bundled' },
      { id: 'cursor', displayName: 'Cursor', source: 'bundled' },
    ],
  }),
  workspaceSkillsList: async () => ({
    ok: true,
    skills: [
      {
        id: 'release-runbook',
        name: 'Release runbook',
        description: 'Ship a release',
        source: 'builtin',
        installState: 'installed',
      },
    ],
  }),
  readMarketplacePluginUpdateStates: async (input?: { forceRefresh?: boolean }) => {
    calls.updateStatesReads.push(input ?? {})
    if (!registryReachable) {
      return {
        ok: true,
        checked: false,
        registryState: 'offline',
        entries: [
          {
            id: 'design-wizard',
            displayName: 'Design Wizard',
            availability: { state: 'unknown', installedVersion, reason: 'registry-unreachable' },
          },
        ],
      }
    }
    const state = aheadOfRegistry
      ? 'ahead-of-registry'
      : installedVersion < 2
        ? 'update-available'
        : 'current'
    return {
      ok: true,
      checked: true,
      registryState: 'ok',
      registrySource: 'network',
      stale: false,
      fetchedAt: '2026-08-01T00:00:00Z',
      entries: [
        {
          id: 'design-wizard',
          displayName: 'Design Wizard',
          availability: { state, installedVersion, latestVersion: aheadOfRegistry ? 1 : 2 },
        },
      ],
    }
  },
  verifyMarketplacePlugin: async (entry: { id: string }) => {
    calls.verify.push(entry.id)
    return { classification: 'verified', permissions: [], sourceUrl: 'https://example.com' }
  },
  updateMarketplacePluginFromRegistry: async (input: { entry: { id: string }; trustGranted?: boolean }) => {
    calls.updateEntry.push(input)
    installedVersion = 2
    return {
      ok: true,
      id: input.entry.id,
      displayName: 'Design Wizard',
      version: 2,
      trust: 'trusted',
      loadEligible: true,
      installed: [],
      classification: 'verified',
      sourceUrl: 'https://example.com',
      updated: true,
    }
  },
  cliUpdate: async (cli: string) => {
    calls.cliUpdate.push(cli)
    return { ok: true, cli, installed: true, version: '2.4.2', resolvedPath: '/usr/local/bin/claude', log: '', error: null }
  },
  terminalList: async () => [],
}
domWindow.api = new Proxy(api, {
  get: (target, prop: string) =>
    prop in target
      ? target[prop]
      : prop.startsWith('on')
        ? () => () => {}
        : async () => ({ ok: false, message: 'not stubbed' }),
})

const designWizardEntry = {
  id: 'design-wizard',
  name: 'Design Wizard',
  publisher: { name: 'Multicode Labs', verified: true },
  summary: 'Design systems from a wizard',
  category: 'Design',
  icon: '',
  latest: 2,
  provides: ['module'],
  signature: { keyId: 'k1', value: 'sig' },
}
const cursorEntry = {
  id: 'cursor',
  name: 'Cursor',
  publisher: { name: 'Multicode Labs', verified: true },
  summary: 'Drive the Cursor agent.',
  category: 'Agent Runtime',
  icon: '',
  latest: 2,
  provides: ['cli'],
}

function findButton(scope: ParentNode, label: RegExp): HTMLButtonElement | null {
  return ([...scope.querySelectorAll('button')].find((candidate) =>
    label.test(candidate.textContent ?? ''),
  ) ?? null) as HTMLButtonElement | null
}

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { InstalledExtensionsInventory } = await import('./InstalledExtensionsInventory')

  const cliAvailability = {
    'claude-code': { cli: 'claude-code', installed: true, resolvedPath: '/usr/local/bin/claude', version: '2.4.1' },
    cursor: { cli: 'cursor', installed: false, resolvedPath: null, version: null },
  }

  let cliUpdatedCalls = 0
  async function mount(): Promise<{ host: HTMLElement; unmount: () => void }> {
    const host = dom.window.document.createElement('div')
    dom.window.document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        React.createElement(InstalledExtensionsInventory, {
          mcpServers: [],
          moduleOverrides: {},
          workspaceRoot: '/repo',
          registryPlugins: [designWizardEntry, cursorEntry] as never,
          mcpSettings: { syncEnabled: false, servers: {} } as never,
          cliAvailability: cliAvailability as never,
          onCliUpdated: () => {
            cliUpdatedCalls += 1
          },
        }),
      )
    })
    return { host, unmount: () => root.unmount() }
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await Promise.resolve()
      })
    }
  }

  // ── 1. update-available: banner with the delta, above the module group ─────
  const first = await mount()
  await settle()
  const bannerText = first.host.textContent ?? ''
  assert.match(bannerText, /Design Wizard update · v1 → v2/)
  const updateButton = findButton(first.host, /^Update to v2$/)
  assert.ok(updateButton, 'the banner offers "Update to v2"')
  // The forbidden bare phrase appears nowhere.
  assert.doesNotMatch(bannerText, /Update available(?! ·)/)
  console.log('ok - banner names the module and the version delta')

  // The banner precedes the Module group rows and lives outside every row.
  assert.equal(first.host.querySelectorAll('svg path[d="M7 11.5v-8M3.5 7 7 3.5 10.5 7"]').length, 1)

  // ── 2. the action updates through updateFromRegistry and settles current ───
  await act(async () => {
    updateButton!.click()
  })
  await settle()
  assert.equal(calls.verify.length, 1, 'update verifies before installing (trust re-check)')
  assert.equal(calls.updateEntry.length, 1)
  const updateInput = calls.updateEntry[0] as { entry: { id: string }; trustGranted?: boolean }
  assert.equal(updateInput.entry.id, 'design-wizard')
  assert.equal(updateInput.trustGranted, false, 'a verified update never fabricates a trust grant')
  const settled = first.host.textContent ?? ''
  assert.doesNotMatch(settled, /update · v1 → v2/, 'the banner is gone once the row is current')
  assert.match(settled, /Design Wizard updated to v2\./)
  assert.match(settled, /Design Wizard/, 'the module row is still listed')
  console.log('ok - update routes through updateFromRegistry and settles current without a remount')

  // ── 3. CLI rows: Update with no version-delta claim ────────────────────────
  const cliUpdateButton = [...first.host.querySelectorAll('button')].find(
    (candidate) => candidate.getAttribute('aria-label') === 'Update Claude Code',
  ) as HTMLButtonElement | undefined
  assert.ok(cliUpdateButton, 'an installed CLI row offers Update')
  assert.equal(cliUpdateButton.textContent, 'Update', 'the CLI action claims no newer version')
  assert.ok(
    ![...first.host.querySelectorAll('button')].some(
      (candidate) => candidate.getAttribute('aria-label') === 'Update Cursor',
    ),
    'a CLI that is not installed offers no Update',
  )
  await act(async () => {
    cliUpdateButton.click()
  })
  await settle()
  assert.deepEqual(calls.cliUpdate, ['claude-code'], 'CLI update runs the runtime updater, never the bundle flow')
  assert.equal(cliUpdatedCalls, 1, 'a finished CLI update re-probes availability')
  assert.match(first.host.textContent ?? '', /Claude Code is on 2\.4\.2\./)
  first.unmount()
  console.log('ok - CLI rows offer Update without a delta claim')

  // ── 4. registry unreachable: couldn't-check, never "up to date" ────────────
  installedVersion = 1
  registryReachable = false
  const offline = await mount()
  await settle()
  const offlineText = offline.host.textContent ?? ''
  assert.match(offlineText, /Couldn’t check for updates/)
  assert.doesNotMatch(offlineText, /up to date/i)
  assert.doesNotMatch(offlineText, /update · v/)
  offline.unmount()
  console.log("ok - unreachable registry renders couldn't-check on the installed group")

  // ── 5. ahead-of-registry: neither an update nor an error ───────────────────
  registryReachable = true
  aheadOfRegistry = true
  installedVersion = 9
  const ahead = await mount()
  await settle()
  const aheadText = ahead.host.textContent ?? ''
  assert.doesNotMatch(aheadText, /update · v/)
  assert.doesNotMatch(aheadText, /Couldn’t check/)
  assert.doesNotMatch(aheadText, /Update to v/)
  ahead.unmount()
  console.log('ok - ahead-of-registry draws neither an update nor an error')

  // ── 6. no update UI anywhere on the Skills surface (standing ruling) ───────
  // The bundle runs from node_modules/.cache, so resolve from the repo root.
  const skillsDir = join(process.cwd(), 'src/renderer/src/components/workspace/globalSurface/extensions/skills')
  for (const file of readdirSync(skillsDir)) {
    if (!/\.(ts|tsx)$/.test(file) || /\.test\./.test(file)) continue
    const source = readFileSync(join(skillsDir, file), 'utf8')
    assert.doesNotMatch(
      source,
      /ExtensionUpdateBanner|ModuleUpdateBanner|readMarketplacePluginUpdateStates|deriveManageUpdateBanner/,
      `${file} must not carry module-update UI`,
    )
  }
  console.log('ok - the Skills surface carries no update banner or detection')

  console.log('installed inventory updates: all assertions passed')
}

void main().then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
