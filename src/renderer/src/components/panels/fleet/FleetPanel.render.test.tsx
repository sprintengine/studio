import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

import type { FleetBrowse, FleetConnection } from '../../../../../shared/tailnet-fleet'

// The Fleet pane, mounted and driven the way a person drives it: open a
// machine, see what it holds, click a terminal open.
//
// The model test beside this one pins the wording and the rules; this one pins
// that the surface actually reaches them — that the browse lands, that a
// watch-only pairing gets no "New terminal" button, and that opening a terminal
// asks the layout for a pane carrying the machine it belongs to.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window
anyGlobal.document = dom.window.document
// `globalThis.navigator` is getter-only on modern Node, so it is defined rather
// than assigned; React reads it during render.
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
// jsdom ships no ResizeObserver; PanelHeader's truncation measurement subscribes
// to one on mount. A no-op is honest here — this suite asserts what the panel
// says and does, not how it measures itself.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
anyGlobal.ResizeObserver = NoopResizeObserver
;(dom.window as unknown as Record<string, unknown>).ResizeObserver = NoopResizeObserver

const connection: FleetConnection = {
  id: 'tnc_1',
  machineName: 'mini',
  endpoint: '100.64.0.5:8787',
  deviceId: 'tnd_1',
  deviceName: 'laptop',
  scopes: ['workspace:read', 'terminal:control'],
  pairedAt: '2026-08-07T09:00:00.000Z',
  lastConnectedAt: null,
}

function browseFor(access: FleetBrowse['terminalAccess']): FleetBrowse {
  return {
    connectionId: connection.id,
    reachable: true,
    unreachableReason: null,
    unauthorized: false,
    scopes: access === 'control' ? ['workspace:read', 'terminal:control'] : ['workspace:read', 'terminal:observe'],
    terminalAccess: access,
    workspaces: [{ id: 'ws-1', name: 'Atlas', mode: 'code', folderPath: '/repos/atlas' }],
    terminals: [
      {
        sessionId: 'session_one',
        kind: 'agent',
        workspaceId: 'ws-1',
        agentName: 'Scout',
        cli: 'claude-code',
        cwd: '/repos/atlas',
        processAlive: true,
        suspended: false,
        phase: null,
      },
    ],
    gaps: [],
  }
}

function installApi(access: FleetBrowse['terminalAccess']): void {
  anyGlobal.window = dom.window
  ;(dom.window as unknown as { api: unknown }).api = {
    fleetListConnections: async () => [connection],
    fleetBrowse: async () => browseFor(access),
    fleetListRuns: async () => ({ ok: true, runs: [{ slug: 'nightly', statePath: 'run.yaml' }] }),
    fleetCreateTerminal: async () => ({ ok: true, sessionId: 'session_two', workspaceId: 'ws-1', agentId: 'a', title: 'Rook' }),
    fleetForget: async () => [],
    fleetPair: async () => ({ ok: false, code: 'invalid_pairing_link', message: 'no' }),
  }
  anyGlobal.api = (dom.window as unknown as { api: unknown }).api
}

let failures = 0

async function run(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

/**
 * Mount the panel over a REAL FlexLayout model, so "open a terminal" is proved
 * by a tab landing in the layout rather than by a spy agreeing it was called.
 */
async function mountPanel(
  access: FleetBrowse['terminalAccess']
): Promise<{ container: HTMLElement; tabs: () => Array<Record<string, unknown>> }> {
  installApi(access)
  const { Model } = await import('flexlayout-react')
  const { registerModel, unregisterModel } = await import('../../../utils/modelRegistry')
  const model = Model.fromJson({
    global: {},
    borders: [],
    layout: {
      type: 'row',
      children: [{ type: 'tabset', children: [{ type: 'tab', name: 'Terminal', component: 'terminal' }] }],
    },
  })
  unregisterModel('ws-local')
  registerModel('ws-local', model)

  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { default: FleetPanel } = await import('../FleetPanel')

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<FleetPanel workspaceId="ws-local" />)
  })
  await act(async () => {})

  const tabs = (): Array<Record<string, unknown>> => {
    const found: Array<Record<string, unknown>> = []
    const walk = (node: Record<string, unknown>): void => {
      if (node.type === 'tab') found.push(node)
      const children = Array.isArray(node.children) ? node.children : []
      for (const child of children) walk(child as Record<string, unknown>)
    }
    walk(model.toJson().layout as unknown as Record<string, unknown>)
    return found
  }
  return { container, tabs }
}

function findByText(container: HTMLElement, text: string): HTMLElement | null {
  const nodes = [...container.querySelectorAll('button, div, span, p, h3, li')] as HTMLElement[]
  return nodes.find((node) => node.textContent?.trim() === text) ?? null
}

function findButtonContaining(container: HTMLElement, text: string): HTMLElement | null {
  const buttons = [...container.querySelectorAll('button')] as HTMLElement[]
  return buttons.find((button) => (button.textContent ?? '').includes(text)) ?? null
}

async function click(element: HTMLElement): Promise<void> {
  const { act } = await import('react')
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

await run('a paired machine opens to show its terminals and workspaces', async () => {
  const { container } = await mountPanel('control')
  assert.ok(container.textContent?.includes('mini'), 'the machine is listed by name')

  const row = findButtonContaining(container, 'mini')
  assert.ok(row, 'the machine row is a control')
  await click(row)

  assert.ok(container.textContent?.includes('Scout'), 'its terminal is listed')
  assert.ok(container.textContent?.includes('Atlas'), 'its workspace is listed')
})

await run('opening a terminal docks a remote pane that names the machine', async () => {
  const { container, tabs } = await mountPanel('control')
  await click(findButtonContaining(container, 'mini') as HTMLElement)
  const open = findByText(container, 'Open')
  assert.ok(open, 'each terminal offers to open')
  await click(open)

  const pane = tabs().find((tab) => tab.component === 'fleet-terminal')
  assert.ok(pane, 'a remote terminal pane was docked into the workspace layout')
  const config = pane.config as Record<string, unknown>
  assert.equal(config.connectionId, 'tnc_1')
  assert.equal(config.remoteSessionId, 'session_one')
  assert.equal(config.machineName, 'mini')
  // The machine is in the tab name, not only in a tooltip: a remote pane must
  // be identifiable from the tab strip alone.
  assert.equal(pane.name, 'Scout · mini')
  // And it docks WITH the local terminals, which is what "like a local pane" means.
  assert.ok(tabs().some((tab) => tab.component === 'terminal'), 'the local terminal is still there')
})

// A watch-only pairing cannot create a terminal over there, so the affordance is
// absent rather than present and refused after the click.
await run('a watch-only pairing is offered no way to create a terminal', async () => {
  const { container } = await mountPanel('observe')
  await click(findButtonContaining(container, 'mini') as HTMLElement)
  assert.ok(container.textContent?.includes('Scout'), 'it can still watch what is running')
  assert.equal(findButtonContaining(container, 'New terminal'), null)
})

if (failures > 0) {
  console.error(`\n${failures} failing`)
  process.exit(1)
}
console.log('\nfleet panel renders ok')
