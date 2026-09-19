import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('agentCliShelfInstall', async () => {
  // The Agent CLIs canvas installs through CliInstallControl's runtime
  // install and the row reads installed WITHOUT an app restart. That path has
  // three silent seams: the Install action must appear only once the platform's
  // install methods are known; the install must run the CLI runtime installer
  // (cliInstall), never the bundle-download flow; and the post-install
  // force-refresh must flip the row to the probe's own "Ready" reading. This
  // drives the whole loop in a real DOM against a stubbed window.api.

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

  // ── window.api: the CLI runtime install stack, stubbed ───────────────────────

  const calls: Record<string, unknown[]> = { cliInstall: [], cliInstallMethods: [], cliDetect: [] }

  const api: Record<string, unknown> = {
    platform: 'darwin',
    cliDetect: async (cli: string) => {
      calls.cliDetect.push(cli)
      return {
        cli,
        binary: 'cursor-agent',
        installed: false,
        version: null,
        resolvedPath: null,
        useWsl: false,
        error: null,
      }
    },
    cliInstallMethods: async (cli: string) => {
      calls.cliInstallMethods.push(cli)
      return [
        {
          id: 'npm',
          label: 'npm (global)',
          available: true,
          unavailableReason: null,
          recommended: true,
          commandPreview: 'npm install -g cursor-agent',
          platform: 'darwin',
        },
      ]
    },
    cliInstall: async (input: { cli: string; methodId: string }) => {
      calls.cliInstall.push(input)
      return {
        ok: true,
        cli: input.cli,
        installed: true,
        version: '1.7.0',
        resolvedPath: '/usr/local/bin/cursor-agent',
        log: '',
        error: null,
      }
    },
    onCliInstallOutput: () => () => {},
  }
  domWindow.api = new Proxy(api, {
    get: (target, prop: string) =>
      prop in target
        ? target[prop]
        : prop.startsWith('on')
          ? () => () => {}
          : async () => ({ ok: false, message: 'not stubbed' }),
  })

  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  function findButton(scope: ParentNode, label: RegExp): HTMLButtonElement | null {
    return ([...scope.querySelectorAll('button')].find((candidate) => label.test(candidate.textContent ?? '')) ??
      null) as HTMLButtonElement | null
  }

  const cursorEntry = {
    id: 'cursor',
    name: 'Cursor',
    publisher: { name: 'Multicode Labs', verified: true },
    summary: 'Drive the Cursor agent from Multicode.',
    category: 'Agent Runtime',
    latest: 1,
    provides: ['cli'],
    cli: { pluginId: 'cursor' },
  }
  const builtinEntry = {
    id: 'claude-agent',
    name: 'Claude Code (SDK)',
    publisher: { name: 'Multicode Labs', verified: true },
    summary: 'Claude conversation agents in the app.',
    category: 'Agent Runtime',
    latest: 1,
    provides: ['cli'],
    cli: { pluginId: 'claude-agent' },
  }

  async function main(): Promise<void> {
    const React = await import('react')
    const { act, useState } = React
    const { createRoot } = await import('react-dom/client')
    const { AgentCliRuntimeRows } = await import('./AgentCliShelfRows')
    const { registryEntriesForKinds } = await import('./connectorsFacets')
    // The rows the Agent CLIs catalogue hands one page of at a time. It used to
    // be `ExtensionKindCanvas` reading the whole registry for itself; the
    // source-tabs ruling (2026-09-05) moved the reading up to the catalogue, so
    // the rows take the entries they are given.
    const cliEntries = registryEntriesForKinds([cursorEntry, builtinEntry] as never, ['cli'])

    const setRuntimeCalls: Array<[string, unknown]> = []

    // The store's role, played by a stateful host: the availability map lives
    // above the canvas, and a force-refresh after an install re-probes — here it
    // flips cursor to installed, exactly what the real probe would find.
    function Host(): JSX.Element {
      const [availability, setAvailability] = useState<Record<string, unknown>>({
        cursor: { cli: 'cursor', installed: false, resolvedPath: null, version: null },
      })
      return React.createElement(AgentCliRuntimeRows, {
        entries: cliEntries,
        registryUrl: null,
        runtime: {
          platform: 'darwin',
          availability: availability as never,
          availabilityStatus: 'ready',
          availabilityError: null,
          catalogEntries: [
            {
              id: 'cursor',
              displayName: 'Cursor',
              source: 'bundled',
              version: 1,
              binary: 'cursor-agent',
              resumeSession: false,
              sessionIdFromCaller: false,
            },
          ] as never,
          catalogStatus: 'ready',
          versionAdvisories: {},
          cliRuntimes: {},
          refreshAvailability: async (options?: { force?: boolean }) => {
            if (options?.force) {
              setAvailability({
                cursor: {
                  cli: 'cursor',
                  installed: true,
                  resolvedPath: '/usr/local/bin/cursor-agent',
                  version: '1.7.0',
                },
              })
            }
          },
          refreshCatalog: async () => {},
          setCliRuntime: (cli: string, update: unknown) => setRuntimeCalls.push([cli, update]),
        } as never,
      })
    }

    const host = dom.window.document.createElement('div')
    dom.window.document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(React.createElement(Host))
    })
    // Let the install-methods probe land.
    await act(async () => {
      await Promise.resolve()
    })

    run('an absent CLI with an install path offers Install; built-in offers none', () => {
      assert.ok(findButton(host, /^Install$/), 'cursor row offers Install once methods are known')
      assert.deepEqual(calls.cliInstallMethods, ['cursor'], 'methods probed only for the definitively-missing CLI')
      assert.match(host.textContent ?? '', /Not installed — no cursor-agent on PATH/)
      assert.match(host.textContent ?? '', /Built into the app — nothing to install/)
    })

    // Install → the row expands into CliInstallControl's method picker.
    await act(async () => {
      findButton(host, /^Install$/)!.click()
    })
    // detect + auto-open + methods load inside the control.
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })

    const runInstall = findButton(host, /^Run install$/)
    run('Install opens the runtime install flow, with the real command preview', () => {
      assert.ok(runInstall, 'the method picker offers Run install')
      assert.match(host.textContent ?? '', /npm install -g cursor-agent/)
    })

    await act(async () => {
      runInstall!.click()
    })
    await act(async () => {
      await Promise.resolve()
    })

    run('the install runs the CLI runtime installer, never a bundle download', () => {
      assert.deepEqual(calls.cliInstall, [{ cli: 'cursor', methodId: 'npm' }])
    })

    run('the row reads installed without an app restart', () => {
      const text = host.textContent ?? ''
      assert.match(text, /Ready/, 'the probe vocabulary flips to Ready')
      assert.match(text, /1\.7\.0/, 'with the installed version')
      assert.equal(findButton(host, /^Install$/), null, 'and Install is gone')
    })

    run('the resolved binary path is persisted for launches, like Settings does', () => {
      assert.deepEqual(setRuntimeCalls, [['cursor', { command: '/usr/local/bin/cursor-agent', useWsl: false }]])
    })

    act(() => root.unmount())
    host.remove()
    console.log('all agent-cli shelf install tests passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })

  await suiteRun
})
