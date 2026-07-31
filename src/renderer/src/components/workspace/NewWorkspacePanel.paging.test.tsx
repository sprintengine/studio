import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// The creation hub pages its pane: one step at a time, a Continue footer, and a
// "Skip the rest and create" affordance that leaves the moment the flow is
// answerable. Every other renderer test in this repo is a static
// renderToStaticMarkup, which cannot click — and paging IS clicking, so this
// suite stands up a real DOM and drives the panel the way a person does.
//
// The parity test is the one that matters: it asserts that skipping produces the
// SAME payload at the engine boundary as walking every page and touching nothing.
// That is what makes the skip affordance safe to offer, and it is asserted at
// `initializeSprintEngineState` — the real mutation path — not on internal state.

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

// Every payload the panel pushes across the preload boundary during a create.
type Recorded = { initializeSprintEngineState: unknown[]; created: unknown[] }

function installApi(recorded: Recorded): void {
  const authState = {
    authenticated: true,
    entitlements: { features: { 'multicode.sprintengine': true } },
    selectedOrganization: null,
  }
  const api = {
    // Folder + scan surface: an existing, empty project folder that holds no
    // sprint team yet. The create path asks pathExists(statePath) to refuse a
    // duplicate team, so a blanket `true` here would make every team look taken.
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
    // The seam under test: what actually reaches the engine. The create parses
    // the projection this returns and aborts with `invalid-projection` if it does
    // not, so a stub without `data` would let both create paths fail IDENTICALLY
    // — and a parity test over two failed creates proves nothing.
    initializeSprintEngineState: async (payload: unknown) => {
      recorded.initializeSprintEngineState.push(payload)
      return {
        ok: true,
        data: {
          projectionContent: JSON.stringify({
            ok: true,
            projectionVersion: 1,
            source: 'folder_store',
            generatedAt: '2026-06-16T11:00:00Z',
            updatedAt: '2026-06-16T11:00:00Z',
            run: {
              id: 'run-id',
              name: 'Parity team',
              goal: 'Ship the paged creation hub',
              status: 'planning',
              rosterConfigured: true,
              updatedAt: '2026-06-16T11:00:00Z',
            },
            roster: { architect: { role: 'architect', status: 'idle', currentTaskId: null } },
            tasks: [],
            artifacts: [],
            events: [],
          }),
        },
      }
    },
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
  const recorded: Recorded = { initializeSprintEngineState: [], created: [] }
  installApi(recorded)

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { default: NewWorkspacePanel } = await import('./NewWorkspacePanel')

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
    const type = async (element: Element | undefined, value: string): Promise<void> => {
      assert.ok(element, 'expected the field to exist before typing into it')
      const field = element as unknown as HTMLInputElement
      const prototype = field.tagName === 'TEXTAREA'
        ? dom.window.HTMLTextAreaElement.prototype
        : dom.window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
      await act(async () => {
        setter?.call(field, value)
        field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
    }

    return { container, root, button, click, primary, jumpControls, type, text: () => container.textContent ?? '' }
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

  // --------------------------------------------------------- skip affordance
  // "Skip the rest and create" appears exactly when the flow is create-ready AND
  // the user is not on the last page — never as a second skip-shaped control.
  {
    // A blocked flow offers no skip: the sprint's team page carries the run's
    // only required intent, so until it is answered there is nothing to skip to.
    const panel = mount({ mode: 'sprintengine', folderPath: FOLDER })
    await panel.click(panel.primary())
    assert.ok(panel.text().includes('What should the team work on?'), 'the sprint pages to its team step')
    assert.equal(panel.button(SKIP), undefined, 'skip is withheld while the flow is still blocked')
    panel.root.unmount()
  }

  // ------------------------------------------------------------ defaults parity
  // Skipping must not silently create a DIFFERENT run than walking the pages.
  // Both paths are driven end to end and compared at the engine boundary.
  // A sprint's configuration lands in TWO places, and parity has to hold across
  // both: the engine's initial state (team, roster, per-role runtimes, worktrees)
  // and the workspace creation args (max parallel agents, permission preset,
  // automation). Comparing only one half would let the other half drift.
  async function createSprint(skip: boolean): Promise<{ init: unknown; created: unknown }> {
    recorded.initializeSprintEngineState.length = 0
    recorded.created.length = 0
    const panel = mount({ mode: 'sprintengine', folderPath: FOLDER })
    await panel.click(panel.primary()) // workspace -> team

    // Answer the run's only required intent, and nothing else. Every later page
    // is left exactly as the flow seeded it — that is the point of the test.
    await panel.type(
      panel.container.querySelector('input[placeholder="Interface Team"]') ?? undefined,
      'Parity team',
    )
    await panel.type(
      panel.container.querySelector('textarea[placeholder="What outcome should this team deliver?"]') ?? undefined,
      'Ship the paged creation hub',
    )

    // The positive half of the skip contract: answering the intent on a
    // non-final page makes the flow create-ready, and the skip appears.
    assert.ok(panel.button(SKIP), 'skip is offered once a create-ready non-final page is answered')

    if (skip) {
      await panel.click(panel.button(SKIP))
    } else {
      await panel.click(panel.primary()) // team -> roster
      assert.ok(panel.text().includes('Who plans and builds this sprint.'), 'the sprint pages to its Team step')
      await panel.click(panel.primary()) // roster -> tools
      assert.ok(panel.text().includes('Tools & skills'), 'the sprint pages to its Tools step')
      await panel.click(panel.primary()) // tools -> start
      assert.ok(panel.text().includes('Review & start'), 'the sprint ends on the Review & start step')
      await panel.click(panel.primary()) // create
    }

    const init = recorded.initializeSprintEngineState[0]
    const created = recorded.created[0]
    assert.ok(init, `the ${skip ? 'skipped' : 'walked'} path must reach initializeSprintEngineState`)
    assert.ok(created, `the ${skip ? 'skipped' : 'walked'} path must reach the workspace create`)
    panel.root.unmount()
    return { init, created }
  }

  // ------------------------------------------------------------- guard contract
  // The page-turn guards are pure, so the cases a DOM drive cannot hold open —
  // above all "a create is in flight" — are asserted directly against them.
  {
    const nav = await import('./newWorkspace/stepNavigation')
    const steps = [
      'workspace',
      'sprintengine-team',
      'sprintengine-roster',
      'sprintengine-tools',
      'sprintengine-start',
    ] as const
    const at = (step: (typeof steps)[number], busy = false) => ({ steps: [...steps], step, busy })

    assert.equal(
      nav.nextStepFrom({ ...at('workspace'), currentStepReady: false }),
      null,
      'Continue refuses to leave a page the user has not answered',
    )
    assert.equal(
      nav.nextStepFrom({ ...at('sprintengine-start'), currentStepReady: true }),
      null,
      'the last page has no Continue — its primary is create',
    )
    // Forward jumps are the refusal the progress bar depends on.
    assert.equal(nav.jumpTargetFor(at('sprintengine-team'), 2), null, 'a forward jump is refused')
    assert.equal(nav.jumpTargetFor(at('sprintengine-team'), 1), null, 'a jump to the current page is refused')
    assert.equal(nav.jumpTargetFor(at('sprintengine-team'), 0), 'workspace', 'a back-jump is allowed')

    // Mid-create, the pane freezes: the deferred create reads the state of the
    // page the user confirmed on, so a page turn underneath it would create
    // something they never saw.
    assert.equal(
      nav.nextStepFrom({ ...at('workspace', true), currentStepReady: true }),
      null,
      'Continue is a no-op mid-create',
    )
    assert.equal(nav.previousStepFrom(at('sprintengine-team', true)), null, 'Back is a no-op mid-create')
    assert.equal(nav.jumpTargetFor(at('sprintengine-team', true), 0), null, 'a back-jump is a no-op mid-create')

    assert.equal(
      nav.shouldShowSkipToCreate({ createReady: true, isLastStep: true }),
      false,
      'skip is withheld on the last page even when create is ready',
    )
    // A rail switch swaps the flow under the current page; a page the new flow
    // does not have falls back to its first page rather than stranding the user.
    assert.equal(nav.stepWithinFlow(['workspace', 'guided-idea'], 'sprintengine-roster'), 'workspace')
    assert.equal(nav.stepWithinFlow(['workspace', 'guided-idea'], 'guided-idea'), 'guided-idea')
  }

  const walked = await createSprint(false)
  const skipped = await createSprint(true)

  // Guard the parity assertions against passing vacuously — two empty payloads
  // are deep-equal too. The seeded roster and the run settings must actually be
  // in there, or this proves nothing.
  const engineState = walked.init as Record<string, unknown>
  for (const key of ['agents', 'roleRuntimes', 'enabledRoles', 'useWorktrees']) {
    assert.ok(key in engineState, `the engine state must carry ${key} for parity to mean anything`)
  }
  assert.ok(
    Object.keys((engineState.agents ?? {}) as object).length > 0,
    'the seeded roster must be non-empty — parity over an empty team proves nothing',
  )

  // The whole promise of the skip affordance: every page it skipped was already
  // holding its default, so the run it creates is identical to the one you get by
  // walking every page and changing nothing. A future step whose default only
  // materializes when its page renders breaks HERE, not in production.
  //
  // A sprint's configuration lands in two places and BOTH must match. The engine
  // state carries the team: seeded agents, per-role runtimes, enabled roles, and
  // worktrees.
  assert.deepEqual(
    skipped.init,
    walked.init,
    'skipping must seed the engine with the same team as walking every page unchanged',
  )
  // The workspace creation args carry the rest of the run page: max parallel
  // agents, the permission preset, and the automation mode. Comparing only the
  // engine state would let these drift unnoticed.
  //
  // `changedAt` is a wall-clock stamp of when the automation mode was last set,
  // so it differs between any two creates by construction. It is the one field
  // that is not a setting, and it is dropped rather than the comparison being
  // loosened — everything else must match exactly.
  const runSettings = (args: unknown): Record<string, unknown> => {
    const record = { ...(args as Record<string, unknown>) }
    const auto = record.sprintEngineAutoState as Record<string, unknown> | undefined
    assert.ok(auto, 'the create args must carry the run settings')
    for (const key of ['maxConcurrentAgents', 'cliPermissionPreset', 'desiredMode']) {
      assert.ok(key in auto, `the run settings must carry ${key} for parity to mean anything`)
    }
    const { changedAt: _changedAt, ...settings } = auto
    record.sprintEngineAutoState = settings
    return record
  }
  assert.deepEqual(
    runSettings(skipped.created),
    runSettings(walked.created),
    'skipping must create the workspace with the same run settings as walking every page unchanged',
  )

  console.log('NewWorkspacePanel.paging.test.tsx: ok')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
