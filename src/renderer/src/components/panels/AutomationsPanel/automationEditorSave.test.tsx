import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// MC-2035 — there is ONE editor and ONE save path. A starter added from the
// Extensions shelf lands in this editor pre-filled, and everything after that is
// ordinary editing: the same form, the same `updateAutomation` call, the same
// patch shape as an automation written by hand. A starter-only branch through
// the editor is how this becomes two editors, so the claim is tested by
// exercising BOTH through the real form rather than by reading the JSX.
//
// Also held here, because each is silent when it breaks:
//   • The provenance the install stamped (`sourceCatalogueId` / `sourcePublisher`)
//     is never written back by an edit — it is stamped once and read-only.
//   • The switch honours the ARIA switch contract: Space toggles, Enter does not.
//   • The door's bar carries the save affordance (mockup §.canvas-bar): given a
//     slot, the buttons paint THERE and not a second time in the form.

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

type UpdateCall = { workspaceRoot: string; automationId: string; patch: Record<string, unknown> }
const updateCalls: UpdateCall[] = []

domWindow.api = {
  platform: 'darwin',
  mcpListCatalog: async () => ({ ok: true, servers: [] }),
  updateAutomation: async (input: UpdateCall) => {
    updateCalls.push(input)
    return { ok: true, value: { id: input.automationId } }
  },
  readdir: async () => [],
}

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

async function main(): Promise<void> {
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { AutomationEditor } = await import('./AutomationEditor')
  const type = await import('../../../../../shared/automations/contracts')
  void type

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

  const baseDefinition = {
    id: 'auto-1',
    name: 'Nightly job',
    status: 'enabled',
    trigger: {
      kind: 'schedule',
      config: { kind: 'schedule', timezone: 'UTC', cadence: { type: 'daily', timeLocal: '02:00' } },
    },
    action: { kind: 'spawn-agent', config: { prompt: 'Sweep the repo.' } },
    runInWorktree: true,
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }

  // The same automation, as the shelf install writes it: provenance stamped, and
  // an action config that names no cli (the launch resolves that).
  const starterDefinition = {
    ...baseDefinition,
    id: 'auto-2',
    name: 'Dead code sweep',
    sourceCatalogueId: 'multicode.dead-code-sweep',
    sourcePublisher: 'Multicode Labs',
  }

  async function mount(
    definition: Record<string, unknown>,
    options: { actionsSlot?: HTMLElement } = {},
  ): Promise<{ container: HTMLElement; unmount: () => void }> {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        React.createElement(AutomationEditor, {
          editor: { mode: 'edit', definition } as never,
          providers: providers as never,
          workspaceRoot: '/repo/app',
          ...(options.actionsSlot ? { actionsSlot: { el: options.actionsSlot } } : {}),
          onCancel: () => {},
          onSaved: () => {},
        }),
      )
    })
    return {
      container,
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  function saveButton(scope: HTMLElement): HTMLButtonElement {
    const button = [...scope.querySelectorAll('button')].find((candidate) =>
      /^(Save|Saving…)$/.test(candidate.textContent ?? ''),
    )
    assert.ok(button, 'the editor offers a Save button')
    return button as HTMLButtonElement
  }

  // ── One editor, one save path ──────────────────────────────────────────────
  for (const definition of [baseDefinition, starterDefinition]) {
    updateCalls.length = 0
    const mounted = await mount(definition)
    await act(async () => {
      saveButton(mounted.container).click()
    })
    run(`saving "${definition.name}" goes through updateAutomation`, () => {
      assert.equal(updateCalls.length, 1, 'exactly one write, through the shared save path')
      const call = updateCalls[0]!
      assert.equal(call.workspaceRoot, '/repo/app')
      assert.equal(call.automationId, definition.id)
      assert.equal(call.patch.name, definition.name, 'the patch carries the edited name')
      assert.equal(call.patch.status, 'enabled', 'and the lifecycle the switch holds')
      assert.deepEqual(
        call.patch.action,
        { kind: 'spawn-agent', config: { prompt: 'Sweep the repo.' } },
        'and the action config, rebuilt the same way for both',
      )
      // Provenance is stamped by the host at install and is not an editable
      // field; sending it back would let the renderer forge it.
      assert.equal(Object.hasOwn(call.patch, 'sourceCatalogueId'), false, 'an edit never writes provenance back')
      assert.equal(Object.hasOwn(call.patch, 'sourcePublisher'), false, 'nor its publisher')
    })
    mounted.unmount()
  }

  // The two patches are the same shape — that is the claim, so compare them.
  {
    updateCalls.length = 0
    const handWritten = await mount(baseDefinition)
    await act(async () => { saveButton(handWritten.container).click() })
    handWritten.unmount()
    const starter = await mount(starterDefinition)
    await act(async () => { saveButton(starter.container).click() })
    starter.unmount()
    run('a starter and a hand-written automation produce the same patch shape', () => {
      assert.equal(updateCalls.length, 2)
      assert.deepEqual(
        Object.keys(updateCalls[0]!.patch).sort(),
        Object.keys(updateCalls[1]!.patch).sort(),
        'same keys — one save path, no starter branch',
      )
    })
  }

  // ── The ARIA switch contract ───────────────────────────────────────────────
  {
    const mounted = await mount(starterDefinition)
    const enabled = mounted.container.querySelector('#automation-enabled') as HTMLButtonElement
    assert.ok(enabled, 'the aside carries the Enabled switch')
    run('the automation arrives enabled', () => {
      assert.equal(enabled.getAttribute('role'), 'switch')
      assert.equal(enabled.getAttribute('aria-checked'), 'true')
    })

    await act(async () => {
      enabled.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    run('Enter does not toggle the switch', () => {
      assert.equal(enabled.getAttribute('aria-checked'), 'true')
    })

    await act(async () => {
      enabled.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    })
    run('Space toggles it', () => {
      assert.equal(enabled.getAttribute('aria-checked'), 'false')
    })
    mounted.unmount()
  }

  // ── The door bar owns the call to action ───────────────────────────────────
  {
    const slot = dom.window.document.createElement('div')
    slot.setAttribute('data-testid', 'door-bar-actions')
    dom.window.document.body.append(slot)
    const mounted = await mount(starterDefinition, { actionsSlot: slot })
    run('given a bar slot, Save paints there and only there', () => {
      const inSlot = saveButton(slot as unknown as HTMLElement)
      assert.equal(inSlot.getAttribute('form'), 'automation-editor', 'and stays associated with the form it submits')
      const inForm = [...mounted.container.querySelectorAll('button')].filter((candidate) =>
        /^(Save|Cancel)$/.test(candidate.textContent ?? ''),
      )
      assert.equal(inForm.length, 0, 'the form carries no second copy of the buttons')
    })
    mounted.unmount()
    slot.remove()
  }

  console.log('all automation editor save-path tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
