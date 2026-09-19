import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('builtinAutomations', async () => {
  // The five automations that ship inside the app, in the Automations door
  // (Extensions drawer ruling, 2026-09-05, frame 4). Driven in a real DOM because
  // every claim here is about what a person sees in the door and none of it is
  // visible from a pure function:
  //
  //   1. the rail lists "Yours" and then "Built in", with the five under it;
  //   2. selecting a built-in gives the bar its tag and the one call to action,
  //      naming the project the add would land in;
  //   3. pressing it writes through main and the row and the control both flip to
  //      "Added" — pressing it again is refused rather than writing a duplicate;
  //   4. with no project open, the control is inert and says why.

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

  const WORKSPACE_ROOT = '/repo/demo-repo'

  const yoursDefinition = {
    id: 'auto-yours-1',
    name: 'Nightly review',
    status: 'enabled',
    trigger: {
      kind: 'schedule',
      config: { kind: 'schedule', timezone: 'UTC', cadence: { type: 'daily', timeLocal: '01:00' } },
    },
    action: { kind: 'spawn-agent', config: { prompt: 'Review the day.' } },
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }

  // What the built-in write produces in the project's store: the provenance pair
  // is what makes "already added" answerable, so the stub stamps it exactly as the
  // catalogue install does.
  const addedDefinition = {
    ...yoursDefinition,
    id: 'auto-added-1',
    name: 'Dead code sweep',
    trigger: {
      kind: 'schedule',
      config: { kind: 'schedule', timezone: 'Europe/Dublin', cadence: { type: 'daily', timeLocal: '02:00' } },
    },
    action: { kind: 'spawn-agent', config: { prompt: 'Find code nothing reaches.' } },
    sourceCatalogueId: 'dead-code-sweep-automation',
    sourcePublisher: 'Multicode Labs',
  }

  let storeHasAdded = false
  let addFails = false
  const addCalls: unknown[] = []

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

  async function main(): Promise<void> {
    const { BUILTIN_AUTOMATIONS } = await import('../../../../../../shared/automations/builtin')

    const api: Record<string, unknown> = {
      platform: 'darwin',
      listInstanceAutomations: async () => ({
        ok: true,
        value: {
          entries: [
            {
              workspaceRoot: WORKSPACE_ROOT,
              workspaceId: 'ws-1',
              definition: yoursDefinition,
              lastRun: null,
              isRunningNow: false,
            },
            ...(storeHasAdded
              ? [
                  {
                    workspaceRoot: WORKSPACE_ROOT,
                    workspaceId: 'ws-1',
                    definition: addedDefinition,
                    lastRun: null,
                    isRunningNow: false,
                  },
                ]
              : []),
          ],
          problems: [],
        },
      }),
      listAutomationProviders: async () => ({ ok: true, value: { triggers: [], actions: [] } }),
      getAutomationsEngineStatus: async () => ({ ok: true, value: { running: true } }),
      // Main is the authority on what ships; the door reads it rather than
      // importing the module, so the stub answers with the real records.
      listBuiltinAutomations: async () => ({ ok: true, value: [...BUILTIN_AUTOMATIONS] }),
      addBuiltinAutomation: async (input: unknown) => {
        addCalls.push(input)
        if (addFails) return { ok: false, code: 'store_error', message: 'The automations store could not be written.' }
        const alreadyAdded = storeHasAdded
        storeHasAdded = true
        return { ok: true, value: { definition: addedDefinition, alreadyAdded, workspaceRoot: WORKSPACE_ROOT } }
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

    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { default: AutomationsGlobalSurface } = await import('./AutomationsGlobalSurface')
    const { ConfirmDialogProvider } = await import('../../../ui/ConfirmDialog')
    const { useWorkspaceStore } = await import('../../../../store/workspaceStore')

    // One project open, and active: that is what "Add to <project>" names.
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: 'ws-1',
          name: 'demo-repo',
          mode: 'standard',
          folderPath: WORKSPACE_ROOT,
          agents: {},
          openFiles: [],
          createdAt: 1,
        },
      ],
      activeWorkspaceId: 'ws-1',
    } as never)

    const host = dom.window.document.createElement('div')
    dom.window.document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(React.createElement(ConfirmDialogProvider, null, React.createElement(AutomationsGlobalSurface)))
    })
    await act(async () => {
      await Promise.resolve()
    })

    run('the rail lists Yours, then Built in with the five that ship', () => {
      const lists = [...host.querySelectorAll('ul[role="list"]')].map((list) => list.getAttribute('aria-label'))
      assert.deepEqual(
        lists,
        ['Automations: Yours', 'Automations: Built in'],
        'two groups, in that order — what runs here, then what could',
      )
      const builtinList = host.querySelector('ul[aria-label="Automations: Built in"]')!
      assert.equal(builtinList.querySelectorAll('li').length, 5, 'five built-in rows')
      const text = builtinList.textContent ?? ''
      for (const name of [
        'Dead code sweep',
        'Duplication review',
        'Unit test coverage',
        'UI & UX review',
        'Merged-PR seam review',
      ]) {
        assert.match(text, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')), `lists ${name}`)
      }
    })

    run('a built-in row states its schedule in words, not a cron line', () => {
      const builtinList = host.querySelector('ul[aria-label="Automations: Built in"]')!
      const text = builtinList.textContent ?? ''
      assert.match(text, /Nightly 02:00/, 'the 02:00 daily cadence reads as nightly')
      assert.match(text, /Daily 18:00/, 'and an evening one reads as daily')
      assert.doesNotMatch(text, /\* \* \*/u, 'no cron expression in the rail')
    })

    const deadCodeRow = findButton(host, /Dead code sweep/)
    await act(async () => {
      deadCodeRow!.click()
    })

    const bar = () => host.querySelector('section[aria-label="Automations"] > div')!

    run('selecting a built-in gives the bar its name, the Built in tag, and one Add', () => {
      const text = bar().textContent ?? ''
      assert.match(text, /Dead code sweep/, 'the bar carries the name')
      assert.match(text, /Built in/, 'and the tag that says where it comes from')
      assert.ok(findButton(bar(), /^Add to demo-repo$/), 'and the one call to action, naming the project')
      assert.equal(findButton(bar(), /^Run now$/), null, 'nothing has run, so there is no Run now')
      assert.equal(findButton(bar(), /^Edit$/), null, 'and a built-in is never edited in place')
    })

    run('the card states what it is, and the prompt read-only', () => {
      const text = host.textContent ?? ''
      assert.match(text, /Deletes code nothing reaches/, 'the description leads')
      assert.match(text, /0 2 \* \* \* · Nightly 02:00/, 'the schedule is the cron line and the words')
      const cron = [...host.querySelectorAll('code')].map((node) => node.textContent)
      assert.ok(cron.includes('0 2 * * *'), 'and the cron half is set as code, not as prose')
      assert.match(text, /Bypass all — runs unattended/, 'the permission the run will actually use')
      assert.match(text, /A worktree of its own/, 'where it runs')
      assert.match(text, /A pull request per run/, 'and what it delivers')
      const prompt = host.querySelector('pre')
      assert.ok(prompt, 'the prompt is a code block')
      assert.match(prompt!.textContent ?? '', /Find code in this repository that nothing reaches/)
      assert.equal(host.querySelector('textarea'), null, 'and nothing on this card is editable')
    })

    await act(async () => {
      findButton(bar(), /^Add to demo-repo$/)!.click()
    })
    await act(async () => {
      await Promise.resolve()
    })

    run('Add writes the built-in into the active project, by id', () => {
      assert.deepEqual(addCalls, [{ workspaceRoot: WORKSPACE_ROOT, builtinId: 'dead-code-sweep-automation' }])
    })

    run('after adding, the row and the control both say so, and Add is refused', () => {
      const builtinList = host.querySelector('ul[aria-label="Automations: Built in"]')!
      assert.match(builtinList.textContent ?? '', /Added · Nightly 02:00/, 'the row leads with Added')
      const added = findButton(bar(), /^Added to demo-repo$/)
      assert.ok(added, 'the control states the outcome')
      assert.equal(added!.disabled, true, 'and stops offering the write, so a second press cannot duplicate it')
      const yours = host.querySelector('ul[aria-label="Automations: Yours"]')!
      assert.match(yours.textContent ?? '', /Dead code sweep/, 'and the copy is listed under Yours')
    })

    // A failure belongs to the row it was raised on. Left standing, it followed
    // the selection and reported itself against four automations that never
    // failed.
    addFails = true
    await act(async () => {
      findButton(host, /Duplication review/)!.click()
    })
    await act(async () => {
      findButton(bar(), /^Add to demo-repo$/)!.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    run('a failed add is reported on the automation it was attempted for', () => {
      assert.match(host.textContent ?? '', /The automations store could not be written\./)
    })
    await act(async () => {
      findButton(host, /Unit test coverage/)!.click()
    })
    run('and does not follow the selection to the next automation', () => {
      assert.doesNotMatch(host.textContent ?? '', /The automations store could not be written\./)
    })
    addFails = false

    act(() => root.unmount())
    host.remove()

    // ── No project open ────────────────────────────────────────────────────────
    // Back to a store with nothing added, so the rail's only "Dead code sweep" is
    // the built-in row — otherwise this would click the copy the section above
    // wrote and assert against the wrong card.
    storeHasAdded = false
    useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null } as never)
    const bareHost = dom.window.document.createElement('div')
    dom.window.document.body.append(bareHost)
    const bareRoot = createRoot(bareHost)
    await act(async () => {
      bareRoot.render(React.createElement(ConfirmDialogProvider, null, React.createElement(AutomationsGlobalSurface)))
    })
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      findButton(bareHost, /Dead code sweep/)!.click()
    })

    run('with no project open the add is inert and says what is missing', () => {
      const barText = bareHost.querySelector('section[aria-label="Automations"] > div')!
      const control = findButton(barText, /Open a project to add it/)
      assert.ok(control, 'the control names what is missing rather than a project that is not there')
      assert.equal(control!.disabled, true, 'and refuses the write')
      // A disabled button is not focusable, so the reason has to live somewhere a
      // keyboard can actually reach — in the card, in reading order.
      assert.match(
        bareHost.textContent ?? '',
        /Open the project this automation should run in, then add it there\./,
        'and the reason is readable without focusing the control',
      )
    })

    act(() => bareRoot.unmount())
    bareHost.remove()

    console.log('all built-in automation tests passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })

  await suiteRun
})
