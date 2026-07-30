import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// MC-2035 — Get on the Extensions shelf lands the user in the Automations door
// with the new automation selected and its editor open, in ONE step. That path
// crosses three modules, and every seam in it is silent when it breaks: a Get
// that adds and stays put reads as "nothing happened", and a deep-link that
// selects without opening the editor reads as "it was added somewhere, go and
// find it". So this drives the whole path in a real DOM:
//
//   1. the shelf's Get → the store-issued id, off the install receipt;
//   2. that id through the door's own deep-link seam, asking for the editor;
//   3. the Automations door → the editor, pre-filled, with Save in the door bar.
//
// The one seam not driven here is the prop that joins (1) to (2) inside
// ExtensionsGlobalSurface: mounting that door means standing up the whole
// marketplace source stack for one line of wiring.

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
anyGlobal.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
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

const WORKSPACE_ROOT = '/repo/app'
const CATALOGUE_ID = 'multicode.dead-code-sweep'

// What the shelf entry looks like in the registry, and what the store holds once
// the install has written it. The install stamps the provenance pair and forces
// `status: 'enabled'`; the action config names no cli, so the editor has to
// resolve the runtime the launch would.
const shelfEntry = {
  id: CATALOGUE_ID,
  name: 'Dead code sweep',
  publisher: { name: 'Multicode Labs', verified: false },
  summary: 'Finds code nothing reaches.',
  category: 'Development',
  latest: 1,
  provides: ['automation'],
}

const installedDefinition = {
  id: 'auto-installed-1',
  name: 'Dead code sweep',
  status: 'enabled',
  trigger: {
    kind: 'schedule',
    config: { kind: 'schedule', timezone: 'UTC', cadence: { type: 'daily', timeLocal: '02:00' } },
  },
  action: { kind: 'spawn-agent', config: { prompt: 'Find code in this repository that nothing reaches.' } },
  runInWorktree: true,
  sourceCatalogueId: CATALOGUE_ID,
  sourcePublisher: 'Multicode Labs',
  nextRunAt: null,
  lastRunAt: null,
  lastRunId: null,
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
}

const providers = {
  triggers: [
    { kind: 'schedule', configSchema: { type: 'object' }, requiredIntegrations: [], missingIntegrations: [] },
  ],
  actions: [
    {
      kind: 'spawn-agent',
      configSchema: {
        type: 'object',
        properties: { cli: { type: 'string' }, prompt: { type: 'string' } },
        required: ['prompt'],
      },
      requiredIntegrations: [],
      missingIntegrations: [],
    },
  ],
}

// The project's store: empty until the install lands, so the shelf row starts on
// "Not added" and offers a Get.
let storeHasAutomation = false

const api: Record<string, unknown> = {
  platform: 'darwin',
  mcpListCatalog: async () => ({ ok: true, servers: [] }),
  listInstanceAutomations: async () => ({
    ok: true,
    value: {
      entries: storeHasAutomation
        ? [{
            workspaceRoot: WORKSPACE_ROOT,
            workspaceId: 'ws-1',
            definition: installedDefinition,
            lastRun: null,
            isRunningNow: false,
          }]
        : [],
      problems: [],
    },
  }),
  listAutomationProviders: async () => ({ ok: true, value: providers }),
  getAutomationsEngineStatus: async () => ({ ok: true, value: { running: true } }),
  installMarketplacePluginFromRegistry: async () => {
    storeHasAutomation = true
    return {
      ok: true,
      id: CATALOGUE_ID,
      displayName: 'Dead code sweep',
      version: 1,
      trust: 'trusted',
      loadEligible: true,
      // The receipt names the id the STORE issued — never the catalogue id.
      installed: [{ kind: 'automation', id: installedDefinition.id, message: 'Added "Dead code sweep" to this project.' }],
    }
  },
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
  return ([...scope.querySelectorAll('button')].find((candidate) =>
    label.test(candidate.textContent ?? ''),
  ) ?? null) as HTMLButtonElement | null
}

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { ExtensionKindCanvas } = await import('../../../panels/ConnectorsPanel/ExtensionKindCanvas')
  const { default: AutomationsGlobalSurface } = await import('./AutomationsGlobalSurface')
  const { ConfirmDialogProvider } = await import('../../../ui/ConfirmDialog')
  const { automationsDoorTarget } = await import('../../../automations/runTarget')
  const { dispatchAutomationSurfaceTarget } = await import('./automationSurfaceTarget')

  // ── 1. The shelf hands over the id the store issued ───────────────────────
  const added: string[] = []
  const shelfHost = dom.window.document.createElement('div')
  dom.window.document.body.append(shelfHost)
  const shelfRoot = createRoot(shelfHost)
  await act(async () => {
    shelfRoot.render(
      React.createElement(ExtensionKindCanvas, {
        kind: 'automation',
        sources: {
          registryLoad: { status: 'ready', data: [shelfEntry] },
          catalogLoad: { status: 'ready', data: [] },
          mcpSettings: { syncEnabled: true, servers: {} },
          installedServerIds: new Set<string>(),
          registryUrl: null,
          loadRegistry: async () => {},
          upsertMcpServer: async () => {},
        } as never,
        workspaceRoot: WORKSPACE_ROOT,
        automationDefaultCli: 'claude-code',
        onAutomationAdded: (id: string) => added.push(id),
      }),
    )
  })

  const get = findButton(shelfHost, /^Get$/)
  run('the shelf offers Get once it knows the project does not have it', () => {
    assert.ok(get, 'a Get button is offered against a known-empty project')
  })
  await act(async () => { get!.click() })
  run('Get hands the store-issued id over, not the catalogue id', () => {
    assert.deepEqual(added, [installedDefinition.id])
  })
  act(() => shelfRoot.unmount())
  shelfHost.remove()

  // ── 2 + 3. That id opens the door on the editor ───────────────────────────
  // The Extensions door's own hand-off, verbatim: the same deep-link seam a run
  // notification uses, asking for the editor rather than the run history.
  dispatchAutomationSurfaceTarget(automationsDoorTarget(added[0]!, '', WORKSPACE_ROOT), 'editor')

  const doorHost = dom.window.document.createElement('div')
  dom.window.document.body.append(doorHost)
  const doorRoot = createRoot(doorHost)
  await act(async () => {
    doorRoot.render(
      React.createElement(
        ConfirmDialogProvider,
        null,
        React.createElement(AutomationsGlobalSurface),
      ),
    )
  })
  // One more turn for the index load and the target application to settle.
  await act(async () => { await Promise.resolve() })

  run('the door opens on the editor for the automation that was just added', () => {
    const name = doorHost.querySelector('#automation-name') as HTMLInputElement | null
    assert.ok(name, 'the editor is showing, not the run history')
    assert.equal(name!.value, 'Dead code sweep', 'pre-filled with the automation the shelf added')
  })

  run('the editor shows the starter’s own setup, with nothing left empty', () => {
    const text = doorHost.textContent ?? ''
    assert.match(text, /Multicode Labs/, 'the head names the publisher')
    assert.match(text, /Extensions shelf/, 'the aside names where it came from')
    assert.match(text, /Bypass all — runs unattended/, 'permission reads the unattended default')
    assert.match(text, /Daily/, 'the cadence is the real one')
    const prompt = doorHost.querySelector('#automation-config-prompt') as HTMLTextAreaElement | null
    assert.ok(prompt, 'the prompt field is present')
    assert.match(prompt!.value, /Find code in this repository that nothing reaches\./)
    const enabled = doorHost.querySelector('#automation-enabled')
    assert.equal(enabled?.getAttribute('aria-checked'), 'true', 'and it arrives enabled')
  })

  run('the door bar carries the one call to action, and the form does not repeat it', () => {
    const bar = doorHost.querySelector('section[aria-label="Automations"] > div')
    assert.ok(bar, 'the door renders its bar')
    assert.ok(findButton(bar!, /^Save$/), 'Save rides the door bar')
    assert.match(bar!.textContent ?? '', /\.multi-code\/automations/, 'beside where the save lands')
    const form = doorHost.querySelector('#automation-editor')
    assert.ok(form, 'the editor form is mounted')
    assert.equal(findButton(form!, /^Save$/), null, 'and carries no second Save of its own')
  })

  act(() => doorRoot.unmount())
  doorHost.remove()

  console.log('all automation shelf hand-off tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
