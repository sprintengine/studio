import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('installedInventoryUpdates', async () => {
  // Update staleness, as the surface shows it — the Extensions manage canvas surfaces staleness as ONE
  // banner above the Capability modules group and settles without an app
  // restart. This drives the real InstalledExtensionsInventory in a DOM against
  // a stubbed window.api:
  //   • fixture registry serves latest=2 over installed v1 → banner with the
  //     delta ("Acme Design Kit update · v1 → v2", action "Update to v2");
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

  const acmeKitManifest = {
    id: 'acme-design-kit',
    displayName: 'Acme Design Kit',
    version: 1,
    summary: 'A third-party design kit',
    source: 'third-party',
    defaultEnabled: true,
  }

  const api: Record<string, unknown> = {
    platform: 'darwin',
    listThirdPartyModules: async () => ({
      modules: [{ manifest: { ...acmeKitManifest, version: installedVersion }, trust: 'trusted' }],
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
              id: 'acme-design-kit',
              displayName: 'Acme Design Kit',
              availability: { state: 'unknown', installedVersion, reason: 'registry-unreachable' },
            },
          ],
        }
      }
      const state = aheadOfRegistry ? 'ahead-of-registry' : installedVersion < 2 ? 'update-available' : 'current'
      return {
        ok: true,
        checked: true,
        registryState: 'ok',
        registrySource: 'network',
        stale: false,
        fetchedAt: '2026-08-01T00:00:00Z',
        entries: [
          {
            id: 'acme-design-kit',
            displayName: 'Acme Design Kit',
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
        displayName: 'Acme Design Kit',
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
      return {
        ok: true,
        cli,
        installed: true,
        version: '2.4.2',
        resolvedPath: '/usr/local/bin/claude',
        log: '',
        error: null,
      }
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

  const acmeKitEntry = {
    id: 'acme-design-kit',
    name: 'Acme Design Kit',
    publisher: { name: 'SprintEngine Labs', verified: true },
    summary: 'A third-party design kit',
    category: 'Design',
    icon: '',
    latest: 2,
    provides: ['module'],
    signature: { keyId: 'k1', value: 'sig' },
  }
  const cursorEntry = {
    id: 'cursor',
    name: 'Cursor',
    publisher: { name: 'SprintEngine Labs', verified: true },
    summary: 'Drive the Cursor agent.',
    category: 'Agent Runtime',
    icon: '',
    latest: 2,
    provides: ['cli'],
  }

  function findButton(scope: ParentNode, label: RegExp): HTMLButtonElement | null {
    return ([...scope.querySelectorAll('button')].find((candidate) => label.test(candidate.textContent ?? '')) ??
      null) as HTMLButtonElement | null
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
            registryPlugins: [acmeKitEntry, cursorEntry] as never,
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
    assert.match(bannerText, /Acme Design Kit update · v1 → v2/)
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
    assert.equal(updateInput.entry.id, 'acme-design-kit')
    assert.equal(updateInput.trustGranted, false, 'a verified update never fabricates a trust grant')
    const settled = first.host.textContent ?? ''
    assert.doesNotMatch(settled, /update · v1 → v2/, 'the banner is gone once the row is current')
    assert.match(settled, /Acme Design Kit updated to v2\./)
    assert.match(settled, /Acme Design Kit/, 'the module row is still listed')
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

    await sourceOwnedServersNameTheirSourceAndSayWhenTheyLeaveIt()

    console.log('installed inventory updates: all assertions passed')
  }

  /**
   * The Installed tab, source-grouped: a server a source installed sits under
   * that source's heading, and one the source has stopped declaring keeps its row
   * — still listed, still enabled — and says so
   * (backlog/2026-09-06-mcp-installs-carry-source-provenance.md).
   */
  async function sourceOwnedServersNameTheirSourceAndSayWhenTheyLeaveIt(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { InstalledExtensionsInventory } = await import('./InstalledExtensionsInventory')

    const ref = { sourceId: 'github:acme/plugins', itemId: 'context7', commitSha: 'b81f77a' }
    const mcpServers = [
      {
        id: 'context7',
        name: 'Context7',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        enabled: true,
        clients: ['claude-code'],
        scope: 'workspace',
        source: 'source',
        sourceRef: ref,
        riskLevel: 'local-command',
      },
      {
        id: 'departed',
        name: 'Departed',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        enabled: true,
        clients: ['claude-code'],
        scope: 'workspace',
        source: 'source',
        sourceRef: { ...ref, itemId: 'departed', missing: true },
        riskLevel: 'local-command',
      },
      {
        id: 'typed-by-hand',
        name: 'Typed by hand',
        transport: 'stdio',
        command: 'node',
        args: ['mine.js'],
        enabled: true,
        clients: ['claude-code'],
        scope: 'workspace',
        source: 'custom',
        riskLevel: 'local-command',
      },
    ]
    const sources = [
      {
        id: 'github:acme/plugins',
        kind: 'github',
        name: 'acme/plugins',
        repo: 'acme/plugins',
        monogram: 'AP',
        blurb: '',
        commitSha: 'b81f77a',
        scannedAt: '',
      },
    ]

    const host = dom.window.document.createElement('div')
    dom.window.document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        React.createElement(InstalledExtensionsInventory, {
          mcpServers: mcpServers as never,
          moduleOverrides: {},
          workspaceRoot: '/repo',
          kinds: ['mcp'],
          sourceGrouping: { sources, records: [] } as never,
          mcpSettings: { syncEnabled: true, servers: {} } as never,
        }),
      )
    })
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await Promise.resolve()
      })
    }

    const text = host.textContent ?? ''
    assert.match(text, /acme\/plugins/, 'a source-installed server is listed under the source it came from')
    assert.match(text, /Added on this machine/, 'and a hand-typed one keeps its own provenance heading')
    // On the state line, beside the state it is still in — not as a second chip:
    // the name column is narrow, and a chip there pushes the server's own name
    // out of the row and clips itself.
    assert.match(text, /Active · No longer in source/, 'a server its source dropped says so on its state line')
    assert.match(text, /Departed/, 'and is still listed rather than deleted')
    assert.equal((text.match(/No longer in source/g) ?? []).length, 1, 'only the server that actually left says it')
    // The state is on the row that lost its source, not on the group.
    const rows = [...host.querySelectorAll('*')].filter((node) =>
      (node.textContent ?? '').includes('No longer in source'),
    )
    assert.ok(rows.length > 0)
    root.unmount()
    console.log('ok - installed MCP servers name their source, and one that left it says so')
  }

  const suiteRun = main().then(
    () => undefined,
    (error) => {
      console.error(error)
      process.exit(1)
    },
  )

  await suiteRun
})
