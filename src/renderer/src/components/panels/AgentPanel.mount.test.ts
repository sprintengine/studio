import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'vitest'

test('AgentPanel.mount', async () => {
  // AgentPanel itself, rendered: a brand-new agent — no attached session id, no
  // `cliSessionId` yet — mounts its terminal. The helper test beside this one
  // (`AgentPanel.test.ts`) pins `agentPaneMountsTerminal`, but the regression
  // that shipped with a green suite was in the panel's own gate: every New chat
  // parked on an inert pane and no agent could start. This
  // proves the panel takes the mount branch, not only that the helper answers.
  //
  // The terminal branch is recognised by what only it renders — the Suspense
  // boundary around the lazy TerminalView and the paused-footer control beside
  // it — and by the absence of the CLI install row the missing-CLI branch renders.
  // TerminalView itself is lazy, so it never paints here; the panel is unmounted
  // before its module could resolve.

  // jsdom stays out of the bundle: this directory's profile bundles packages, and
  // jsdom does not bundle. A require the bundler cannot see loads it at run time.
  const loadAtRuntime = createRequire(join(process.cwd(), 'package.json'))
  const { JSDOM } = loadAtRuntime('jsdom') as typeof import('jsdom')

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/?windowId=primary',
    pretendToBeVisual: true,
  })

  // Every preload method the store and the panel's hooks reach answers inertly:
  // a call returns something that is both an unsubscribe function and a promise
  // of `undefined`, which covers `onX(cb)` subscriptions and `await api.x()`.
  function inert(): unknown {
    const handle = (() => {}) as (() => void) & { then?: unknown; catch?: unknown; finally?: unknown }
    const settled = Promise.resolve(undefined)
    // oxlint-disable-next-line unicorn/no-thenable -- the fake handle stands in for a promise-like one
    handle.then = settled.then.bind(settled)
    handle.catch = settled.catch.bind(settled)
    handle.finally = settled.finally.bind(settled)
    return handle
  }
  const api = new Proxy(
    {
      workspaceSyncGetSnapshot: () =>
        Promise.resolve({
          sequence: 0,
          state: { workspaces: [], activeWorkspaceId: null, primaryWorkspaceWindowId: 'primary', workspaceWindows: [] },
        }),
      workspaceSyncGetEventsAfter: () => Promise.resolve([]),
      workspaceSyncDispatch: () => Promise.resolve({ ok: false, reason: 'test', message: 'test' }),
    } as Record<string, unknown>,
    {
      get: (target, property) => (property in target ? target[property as string] : () => inert()),
    },
  )

  const anyGlobal = globalThis as unknown as Record<string, unknown>
  Object.assign(dom.window, { api })
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.CustomEvent = dom.window.CustomEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.localStorage = dom.window.localStorage
  anyGlobal.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { useWorkspaceStore } = await import('../../store/workspaceStore')
    const { default: AgentPanel } = await import('./AgentPanel')

    function seed(agentCliUnavailable: boolean): void {
      const agent = {
        id: 'agent-new',
        name: 'Scout',
        cli: 'claude-code',
        status: 'idle',
        streamBuffer: '',
        runtimeKind: 'terminal',
        execution: { mode: 'workspace' },
        // A New chat: nothing launched, no session id minted or attached.
        cliSessionId: undefined,
        cliHasLaunched: false,
      }
      useWorkspaceStore.setState({
        workspaces: [
          {
            id: 'ws-new',
            name: 'Chat 1',
            mode: 'standard',
            folderPath: '/repo',
            templateId: 'solo',
            layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
            agents: { 'agent-new': agent },
            editorState: { openFiles: [], activeFilePath: null },
            createdAt: 1,
          } as never,
        ],
        // A ready catalog that holds the agent's CLI (or, for the control case,
        // does not), with availability still being probed so it cannot block.
        pluginCatalogStatus: 'ready',
        pluginCatalogEntries: agentCliUnavailable
          ? []
          : ([
              { id: 'claude-code', displayName: 'Claude Code', source: 'bundled', version: 1, binary: 'claude' },
            ] as never),
        cliAvailabilityStatus: 'loading',
      } as never)
    }

    function render(): { container: HTMLElement; unmount: () => void } {
      const container = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(container)
      const root = createRoot(container)
      act(() => {
        root.render(React.createElement(AgentPanel, { workspaceId: 'ws-new', agentId: 'agent-new' }))
      })
      return {
        container: container as unknown as HTMLElement,
        unmount: () => {
          act(() => root.unmount())
          container.remove()
        },
      }
    }

    const buttonLabels = (container: HTMLElement): string[] =>
      [...container.querySelectorAll('button')].map(
        (button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '',
      )

    // The regression: a new agent with an installed CLI and no session id.
    seed(false)
    const fresh = render()
    try {
      const labels = buttonLabels(fresh.container)
      assert.equal(
        labels.some((label) => label.startsWith('Spawn') || label.startsWith('Install an agent CLI')),
        false,
        `a new agent must not park on the missing-CLI pane (rendered: ${JSON.stringify(labels)})`,
      )
      assert.equal(
        labels.includes('Resume paused agent — click or type to resume'),
        true,
        `the terminal branch (and its paused footer) is mounted (rendered: ${JSON.stringify(labels)})`,
      )
    } finally {
      fresh.unmount()
    }

    // The control: the same agent whose CLI is not installed shows the install
    // call to action, so the assertions above can tell the two branches apart.
    seed(true)
    const missing = render()
    try {
      const labels = buttonLabels(missing.container)
      assert.equal(
        labels.some((label) => label.startsWith('Install an agent CLI')),
        true,
        `the missing-CLI pane offers the CLI install row (rendered: ${JSON.stringify(labels)})`,
      )
      assert.equal(
        labels.some((label) => label.startsWith('Spawn')),
        false,
        'no Spawn button remains',
      )
      assert.equal(labels.includes('Resume paused agent — click or type to resume'), false)
      assert.match(missing.container.textContent ?? '', /is not installed/)
    } finally {
      missing.unmount()
    }

    console.log('AgentPanel.mount.test.ts: ok')
  }

  const suiteRun = main().then(
    () => undefined,
    (error: unknown) => {
      console.error(error)
      process.exit(1)
    },
  )

  await suiteRun
})
