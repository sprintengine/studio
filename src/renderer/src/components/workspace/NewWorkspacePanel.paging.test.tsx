import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// The creation hub pages its pane: one step at a time, a Continue footer, and a
// pinned primary action. Every other renderer test in this repo is a static
// renderToStaticMarkup, which cannot click — and paging IS clicking, so this
// suite stands up a real DOM and drives the panel the way a person does.
//
// It also proves the sprint handoff (MC-2062): sprint creation is the New
// sprint dialog, so BOTH routes that used to enter the wizard's sprint flow —
// a host preselect of the sprint mode, and the rail's Sprint row — must hand
// off to the dialog instead of paging a sprint flow that no longer exists.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
anyGlobal.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
// React 18 only allows act() when the environment opts in.
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
dom.window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
})) as unknown as typeof dom.window.matchMedia

const FOLDER = '/tmp/multicode-paging-test'
// Page markers, each unique to one page of a flow. The first page carries the
// type's own heading plus the shared name/folder fields; every later page is a
// ConfigStepSection whose STEP_HEADING title is its marker.
const WORKSPACE_PAGE = 'Workspace name'
const IDEA_PAGE = 'Tell us about your idea'
// The layout picker was removed from the standard flow; its heading is kept here
// only so the single-page assertion can prove it renders nowhere.
const LAYOUT_PAGE = 'Pick an IDE layout'

// Every payload the panel pushes across its host seams during the drive.
type Recorded = { created: unknown[]; sprintDialogOpens: Array<string | null> }

function installApi(): void {
  const authState = {
    authenticated: true,
    entitlements: { features: { 'multicode.sprintengine': true } },
    selectedOrganization: null,
  }
  const api = {
    // Folder surface: an existing, empty project folder.
    pathExists: async (path: string) => path === FOLDER,
    ensureDir: async () => ({ ok: true }),
    readdir: async () => [],
    readfile: async () => '',
    statPath: async () => null,
    openDir: async () => null,
    readBacklogObjectStore: async () => null,
    // Premium gate: signed in, with the Sprint Engine entitlement.
    authGetState: async () => authState,
    authRefreshEntitlements: async () => authState,
    authCheckPremiumAccess: async () => ({ allowed: true }),
  }
  // Anything the panel touches that this test does not model resolves to null
  // rather than throwing — a missing stub must not read as a product failure.
  anyGlobal.window = new Proxy(dom.window, {
    get(target, prop) {
      if (prop === 'api') {
        return new Proxy(api, {
          get: (apiTarget, apiProp) =>
            apiProp in apiTarget
              ? (apiTarget as Record<string | symbol, unknown>)[apiProp]
              : async () => null,
        })
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function main(): Promise<void> {
  const recorded: Recorded = { created: [], sprintDialogOpens: [] }
  installApi()

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { default: NewWorkspacePanel } = await import('./NewWorkspacePanel')
  const { SPRINT_ENGINE_WORKSPACE_MODE } = await import('../../types/workspace')

  type PanelProps = Parameters<typeof NewWorkspacePanel>[0]

  function mount(initialState: unknown) {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    const props = {
      onCreate: (args: unknown) => recorded.created.push(args),
      onClose: () => {},
      workspaceWindowId: 'w1',
      initialState,
      onOpenNewSprintDialog: (folderPath: string | null) =>
        recorded.sprintDialogOpens.push(folderPath),
    } as unknown as PanelProps
    act(() => {
      root.render(React.createElement(NewWorkspacePanel, props))
    })

    const buttons = (): HTMLButtonElement[] =>
      [...container.querySelectorAll('button')] as unknown as HTMLButtonElement[]
    const button = (label: string): HTMLButtonElement | undefined =>
      buttons().find((element) => element.textContent?.trim() === label)
    const click = async (element: Element | undefined): Promise<void> => {
      assert.ok(element, 'expected the control to exist before clicking it')
      await act(async () => {
        element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    }
    // The footer's primary is the last button in the pinned footer.
    const primary = (): HTMLButtonElement => {
      const footer = container.querySelector('footer')
      assert.ok(footer, 'the pinned footer must render for every non-chat pane')
      const footerButtons = [...footer.querySelectorAll('button')] as unknown as HTMLButtonElement[]
      const last = footerButtons[footerButtons.length - 1]
      assert.ok(last, 'the footer must carry a primary action')
      return last
    }
    // WizardProgress renders a jump control per COMPLETED step and nothing for
    // upcoming ones — the back-jump-only contract, read off the real DOM.
    const jumpControls = (): HTMLButtonElement[] =>
      buttons().filter((element) => /^Go back to step /.test(element.getAttribute('aria-label') ?? ''))

    return { container, root, button, click, primary, jumpControls, text: () => container.textContent ?? '' }
  }

  // ------------------------------------------------- standard is a single page
  // Creating a standard workspace is folder -> Create. The layout picker used to
  // be page 2, asking the user to confirm the Solo Dev default the panel had
  // already chosen; it was removed, so the shortest path into the product now has
  // no page turn at all.
  const SKIP = 'Skip the rest and create'
  {
    const panel = mount({ mode: 'standard', folderPath: FOLDER })

    assert.ok(panel.text().includes(WORKSPACE_PAGE), 'the flow opens on the name/folder page')
    assert.ok(!panel.text().includes(LAYOUT_PAGE), 'the layout picker is gone from the creation flow')
    assert.equal(panel.primary().textContent?.trim(), 'Create workspace',
      'the only page is the last page, so its primary is the create action')
    assert.equal(panel.button('Continue'), undefined, 'a single-page flow never offers Continue')
    assert.equal(panel.jumpControls().length, 0, 'a single-page flow has no step to jump back to')
    // Single page == last page, and the skip affordance is never offered there:
    // the primary already IS create.
    assert.equal(panel.button(SKIP), undefined, 'a single-page flow offers no skip')
    // The layout page carried the Advanced setup disclosure (MCP servers,
    // knowledge graph, design system). Removing the page must not remove that —
    // only the layout picker was ruled out.
    assert.ok(panel.text().includes('Advanced setup'),
      'the standard flow keeps create-time Advanced setup after losing its layout page')

    panel.root.unmount()
  }

  // ---------------------------------------------------------------- navigation
  // Paging itself is driven on the guided-brief flow, which is two pages:
  // name/folder, then the idea step.
  {
    const panel = mount({ mode: 'guided-brief', folderPath: FOLDER })

    // Page 1 renders ONLY page 1. The idea step is a later page, so its heading
    // must be nowhere in the DOM — this is the check that the pane is no longer
    // one stacked scroll.
    assert.ok(panel.text().includes(WORKSPACE_PAGE), 'the flow opens on the name/folder page')
    assert.ok(!panel.text().includes(IDEA_PAGE), 'only the active step renders')
    assert.equal(panel.primary().textContent?.trim(), 'Continue', 'a non-final page continues')

    // Nothing is completed yet, so there is nothing to jump back to.
    assert.equal(panel.jumpControls().length, 0, 'no jump control exists for an unreached step')

    // Continue advances.
    await panel.click(panel.primary())
    assert.ok(panel.text().includes(IDEA_PAGE), 'Continue advances to the next page')
    assert.ok(!panel.text().includes(WORKSPACE_PAGE),
      'the previous page unmounts on advance')
    // Each type labels its own create verb; guided-brief's is "Start design".
    assert.equal(panel.primary().textContent?.trim(), 'Start design',
      'the final page primary is the create action, not Continue')

    // The completed first step is now jumpable; the current one is not.
    assert.equal(panel.jumpControls().length, 1, 'exactly the completed steps are jumpable')

    // Back returns.
    await panel.click(panel.button('Back'))
    assert.ok(panel.text().includes(WORKSPACE_PAGE),
      'Back returns to the previous page')
    assert.equal(panel.primary().textContent?.trim(), 'Continue')

    // Forward jumps are refused: WizardProgress offers no control for an
    // unreached step, so a forward jump is unreachable by construction.
    assert.equal(panel.jumpControls().length, 0, 'a forward jump control is never offered')

    // Back-jump works from the last page.
    await panel.click(panel.primary())
    await panel.click(panel.jumpControls()[0])
    assert.ok(panel.text().includes(WORKSPACE_PAGE),
      'the progress bar jumps back to a completed step')

    panel.root.unmount()
  }

  // ------------------------------------------------- sprint preselect handoff
  // A host preselect of the sprint mode (a stale route, a persisted mode) must
  // not page a sprint flow — the panel hands off to the New sprint dialog with
  // the folder it holds, and its own pane stays the standard one.
  {
    recorded.sprintDialogOpens.length = 0
    const panel = mount({ mode: SPRINT_ENGINE_WORKSPACE_MODE, folderPath: FOLDER })
    assert.deepEqual(
      recorded.sprintDialogOpens,
      [FOLDER],
      'a sprint preselect opens the New sprint dialog with the preselected folder',
    )
    assert.ok(panel.text().includes(WORKSPACE_PAGE), 'the hub itself stays on the standard name/folder page')
    assert.equal(panel.primary().textContent?.trim(), 'Create workspace',
      'no sprint flow mounted — the pane is the standard single page')
    panel.root.unmount()
  }

  // ------------------------------------------------------- rail Sprint handoff
  // The rail keeps its Sprint row, but selecting it is a handoff, not a mode
  // switch: the dialog opens with the hub's current folder and the pane the
  // user was on does not change.
  {
    recorded.sprintDialogOpens.length = 0
    const panel = mount({ mode: 'standard', folderPath: FOLDER })
    const sprintRailRow = panel.container.querySelector(
      `#creation-tab-${SPRINT_ENGINE_WORKSPACE_MODE}`,
    )
    assert.ok(sprintRailRow, 'the rail still offers the Sprint row')
    await panel.click(sprintRailRow)
    assert.deepEqual(
      recorded.sprintDialogOpens,
      [FOLDER],
      'the rail Sprint row opens the New sprint dialog with the hub folder',
    )
    assert.ok(panel.text().includes(WORKSPACE_PAGE), 'the hub pane does not switch')
    assert.equal(panel.primary().textContent?.trim(), 'Create workspace',
      'the standard pane is still the one on screen')
    panel.root.unmount()
  }

  // ------------------------------------------------------------- guard contract
  // The page-turn guards are pure, so the cases a DOM drive cannot hold open —
  // above all "a create is in flight" — are asserted directly against them, on a
  // synthetic multi-page flow of surviving step ids (every real flow is short
  // now that the five-page sprint flow is gone).
  {
    const nav = await import('./newWorkspace/stepNavigation')
    const steps = ['workspace', 'guided-idea', 'mcp-servers', 'knowledge', 'module-step'] as const
    const at = (step: (typeof steps)[number], busy = false) => ({ steps: [...steps], step, busy })

    assert.equal(
      nav.nextStepFrom({ ...at('workspace'), currentStepReady: false }),
      null,
      'Continue refuses to leave a page the user has not answered',
    )
    assert.equal(
      nav.nextStepFrom({ ...at('module-step'), currentStepReady: true }),
      null,
      'the last page has no Continue — its primary is create',
    )
    // Forward jumps are the refusal the progress bar depends on.
    assert.equal(nav.jumpTargetFor(at('guided-idea'), 2), null, 'a forward jump is refused')
    assert.equal(nav.jumpTargetFor(at('guided-idea'), 1), null, 'a jump to the current page is refused')
    assert.equal(nav.jumpTargetFor(at('guided-idea'), 0), 'workspace', 'a back-jump is allowed')

    // Mid-create, the pane freezes: the deferred create reads the state of the
    // page the user confirmed on, so a page turn underneath it would create
    // something they never saw.
    assert.equal(
      nav.nextStepFrom({ ...at('workspace', true), currentStepReady: true }),
      null,
      'Continue is a no-op mid-create',
    )
    assert.equal(nav.previousStepFrom(at('guided-idea', true)), null, 'Back is a no-op mid-create')
    assert.equal(nav.jumpTargetFor(at('guided-idea', true), 0), null, 'a back-jump is a no-op mid-create')

    assert.equal(
      nav.shouldShowSkipToCreate({ createReady: true, isLastStep: true }),
      false,
      'skip is withheld on the last page even when create is ready',
    )
    // A rail switch swaps the flow under the current page; a page the new flow
    // does not have falls back to its first page rather than stranding the user.
    assert.equal(nav.stepWithinFlow(['workspace', 'guided-idea'], 'mcp-servers'), 'workspace')
    assert.equal(nav.stepWithinFlow(['workspace', 'guided-idea'], 'guided-idea'), 'guided-idea')
  }

  console.log('NewWorkspacePanel.paging.test.tsx: ok')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
