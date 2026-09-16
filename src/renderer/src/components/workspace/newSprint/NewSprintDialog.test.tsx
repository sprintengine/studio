import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { bindSprintEngineIpc } from '../../../modules/sprint-engine-ipc'

// NewSprintDialog (MC-2062) — the two contracts this suite pins are the ones
// the acceptance names:
//
// 1. The preloaded path: a `FuturePlanWorkspaceSource` handed in (the backlog
//    context action's "Start a sprint from these N items", and every other
//    `initialFuturePlan` producer) opens the dialog with the selection already
//    made — picked rows, source chips, and the derived run name as the heading.
// 2. Screen 2 is a SCREEN SWAP, not a nested modal: the roster editor mounts
//    bare inside the one dialog, exactly one aria-modal exists at all times,
//    entering moves focus into the editor, leaving restores it to the opener,
//    and the source picks + derived run name survive the round trip.

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
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
// TruncatedText measures itself with a ResizeObserver, which JSDOM lacks.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
anyGlobal.ResizeObserver = ResizeObserverStub
;(dom.window as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub
// `ui/Select` keeps its active option in view; JSDOM implements no scrolling.
dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(): void {}
dom.window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
})) as unknown as typeof dom.window.matchMedia

// --- a tiny in-memory project the real scanBacklog walks --------------------
const ROOT = '/proj'
const FILES: Record<string, string> = {
  '/proj/backlog/epics/demo-epic.md': [
    '---',
    'type: epic',
    // Ordering declared finished (MC-2137), which is what makes this epic's
    // Planning-agent default None. Its unmarked twin below is the other half.
    'dependenciesPlanned: true',
    'id: 900',
    '---',
    '',
    '# Demo epic title',
  ].join('\n'),
  '/proj/backlog/epics/unplanned-epic.md': [
    '---',
    'type: epic',
    'id: 903',
    '---',
    '',
    '# Unplanned epic title',
  ].join('\n'),
  '/proj/backlog/unplanned-child.md': [
    '---',
    'type: feature',
    'status: ready',
    'epic: unplanned-epic',
    'id: 904',
    '---',
    '',
    '# Unplanned child title',
  ].join('\n'),
  '/proj/backlog/child-item.md': [
    '---',
    'type: feature',
    'status: ready',
    'epic: demo-epic',
    'id: 901',
    '---',
    '',
    '# Child item title',
  ].join('\n'),
  '/proj/backlog/loose-item.md': [
    '---',
    'type: feature',
    'status: ready',
    'id: 902',
    '---',
    '',
    '# Loose item title',
  ].join('\n'),
}
const DIRS: Record<string, Array<{ name: string; isDir: boolean }>> = {
  '/proj/backlog': [
    { name: 'epics', isDir: true },
    { name: 'child-item.md', isDir: false },
    { name: 'loose-item.md', isDir: false },
    { name: 'unplanned-child.md', isDir: false },
  ],
  '/proj/backlog/epics': [
    { name: 'demo-epic.md', isDir: false },
    { name: 'unplanned-epic.md', isDir: false },
  ],
}

;(dom.window as unknown as { api: Record<string, unknown> }).api = {
  platform: 'darwin',
  pathExists: async (path: string) => path in FILES || path in DIRS,
  readdir: async (path: string) => DIRS[path] ?? [],
  readfile: async (path: string) => {
    const content = FILES[path]
    if (content === undefined) throw new Error(`no such file: ${path}`)
    return content
  },
  statPath: async (path: string) => ({
    isFile: path in FILES,
    isDirectory: path in DIRS,
    sizeBytes: (FILES[path] ?? '').length,
    modifiedAt: '2026-07-31T00:00:00.000Z',
    modifiedAtMs: 1753920000000,
  }),
  readBacklogObjectStore: async () => ({ ok: false, message: 'not in this test' }),
  openFile: async () => null,
  // The New-item capture path writes through the same IPC surface the Backlog
  // panel uses; these stubs land the file in the in-memory project so the
  // dialog's post-create rescan genuinely re-reads it.
  ensureDir: async (root: string, name: string) => `${root}/${name}`,
  createFile: async (dir: string, name: string) => {
    const path = `${dir}/${name}`
    FILES[path] = ''
    DIRS['/proj/backlog'].push({ name, isDir: false })
    return path
  },
  writefile: async (path: string, content: string) => {
    FILES[path] = content
  },
  updateBacklogTriage: async () => ({ ok: true }),
}

async function main(): Promise<void> {
  const React = (await import('react')).default
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const NewSprintDialog = (await import('./NewSprintDialog')).default
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  const { buildBacklogSelectionSourcePlan } = await import(
    '../../backlog/backlogSelectionSourcePlan'
  )
  const { scanBacklog } = await import('../../../utils/backlog')
  const windowApi = (dom.window as unknown as { api: Record<string, unknown> }).api
  bindSprintEngineIpc(new Proxy(windowApi, {
    get: (target, prop: string) =>
      prop in target
        ? target[prop]
        : prop.startsWith('on')
          ? () => () => undefined
          : async () => ({ ok: false, message: 'not stubbed' }),
  }) as never)
  const api = (dom.window as unknown as {
    api: {
      pathExists(path: string): Promise<boolean>
      readdir(path: string): Promise<Array<{ name: string; isDir: boolean }>>
      readfile(path: string): Promise<string>
      statPath(path: string): Promise<{
        isFile: boolean
        isDirectory: boolean
        sizeBytes: number
        modifiedAt: string
        modifiedAtMs: number
      }>
    }
  }).api

  let failures = 0
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  // Give the dialog's async backlog scan room to land inside act.
  const flush = async (): Promise<void> => {
    await act(async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
  }

  const click = async (element: Element | null | undefined): Promise<void> => {
    assert.ok(element, 'expected the element to exist before clicking it')
    await act(async () => {
      ;(element as HTMLElement).dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
      )
    })
  }

  // The REAL context-action payload: the same builder the "Start a sprint from
  // these N items" action calls, over the same items the real scan produces.
  const scanned = await scanBacklog(ROOT, {
    pathExists: (path) => api.pathExists(path),
    readdir: (path) => api.readdir(path),
    readfile: (path) => api.readfile(path),
    statPath: (path) => api.statPath(path),
  })
  assert.equal(scanned.state, 'ready', 'the fake project scans cleanly')
  const epic = scanned.items.find(
    (item) => item.relativePath === 'backlog/epics/demo-epic.md',
  )
  const loose = scanned.items.find((item) => item.relativePath === 'backlog/loose-item.md')
  assert.ok(epic && loose, 'the fake project has an epic and a loose item')
  const preloadedSource = buildBacklogSelectionSourcePlan({
    workspaceRoot: ROOT,
    items: [epic!, loose!],
    projectItems: scanned.items,
  })
  assert.ok(preloadedSource, 'the multi-selection builds one source plan')
  assert.equal(preloadedSource!.sourcePlanKind, 'selection')

  // A single-epic pick: the source shape with an authored order to fall back on,
  // and so the only one where the Planning-agent row offers None (MC-2129).
  const epicOnlySource = buildBacklogSelectionSourcePlan({
    workspaceRoot: ROOT,
    items: [epic!],
    projectItems: scanned.items,
  })
  assert.ok(epicOnlySource, 'the single-epic pick builds one source plan')
  assert.equal(epicOnlySource!.sourcePlanKind, 'epic')

  // The same shape from an epic that never declared its ordering finished
  // (MC-2137): direct is still reachable, but it is no longer the default.
  const unplannedEpic = scanned.items.find(
    (item) => item.relativePath === 'backlog/epics/unplanned-epic.md',
  )
  assert.ok(unplannedEpic, 'the fake project has an unmarked epic too')
  assert.equal(unplannedEpic!.dependenciesPlanned, undefined, 'the unmarked epic carries no mark')
  assert.equal(epic!.dependenciesPlanned, true, 'the marked epic carries the mark')
  const unplannedEpicSource = buildBacklogSelectionSourcePlan({
    workspaceRoot: ROOT,
    items: [unplannedEpic!],
    projectItems: scanned.items,
  })
  assert.ok(unplannedEpicSource, 'the unmarked-epic pick builds one source plan')

  async function mountDialog(
    initialSource: typeof preloadedSource,
    onClose: () => void = () => {},
  ): Promise<{
    container: HTMLElement
    unmount: () => void
  }> {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <NewSprintDialog
          initialFolderPath={ROOT}
          initialSource={initialSource}
          projectOptions={[{ path: ROOT, label: 'proj' }]}
          workspaceWindowId="test-window"
          onClose={onClose}
        />,
      )
    })
    await flush()
    return {
      container,
      unmount: () => {
        root.unmount()
        container.remove()
      },
    }
  }

  await check('preloaded path: the context-action source arrives with the selection made', async () => {
    const { container, unmount } = await mountDialog(preloadedSource)
    try {

    // The derived run name IS the heading — the source's own teamName, not a field.
    const heading = container.querySelector('h2.font-mono')
    assert.ok(heading, 'the right pane renders a heading')
    assert.equal(
      heading!.textContent,
      preloadedSource!.teamName,
      'the heading is the derived run name from the preloaded source',
    )

    // The picked rows are selected in the list.
    const selected = Array.from(
      container.querySelectorAll('[role="option"][aria-selected="true"]'),
    )
    assert.ok(
      selected.some((row) => row.textContent?.includes('Demo epic title')),
      'the preloaded epic row is selected',
    )
    assert.ok(
      selected.some((row) => row.textContent?.includes('Loose item title')),
      'the preloaded loose item row is selected',
    )

    // The right pane lists both sources; the epic carries its open-child count.
    const text = container.textContent ?? ''
    assert.match(text, /Demo epic title/, 'the epic source chip renders')
    assert.match(text, /Loose item title/, 'the item source chip renders')
    // The epic chip carries the import arithmetic (MC-2129): with no plan gate,
    // this row is where the import is verified, so it states both halves.
    assert.match(text, /1 open item in/, 'the epic chip counts what goes in')

    // Start is armed — the selection is complete without another picker.
    const startButton = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent?.includes('Start sprint'),
    ) as HTMLButtonElement | undefined
    assert.ok(startButton, 'the footer renders Start sprint')
    assert.equal(startButton!.disabled, false, 'Start is enabled with the preloaded selection')

    // None of the old wizard's sprint-page inputs survive in the new flow.
    assert.ok(!text.includes('Workspace name'), 'no workspace-name field')
    assert.ok(!text.includes('Also works in'), 'no "Also works in" repo picker')
    assert.ok(!text.includes('Start a new team'), 'no start trichotomy')
    assert.ok(!text.includes('Load an existing team'), 'no load-existing path')
    } finally {
      unmount()
    }
  })

  await check('screen 2 swaps to the roster editor and back: one aria-modal, focus in and out, picks intact', async () => {
    // A saved roster selected up front, so the summary card's "Configure…" is
    // the stable opener the round trip restores focus to.
    let rosterId: string | null = null
    await act(async () => {
      rosterId = useWorkspaceStore.getState().saveSprintEngineRoster({
        name: 'Dialog crew',
        roleCounts: { developer: 1 },
        roleCliDefaults: {},
        roleModelOverrides: {},
      })
      assert.ok(rosterId, 'the fixture roster saves')
      useWorkspaceStore.getState().setSprintEngineLastSelectedRoster(rosterId)
    })
    const { container, unmount } = await mountDialog(preloadedSource)
    try {
    const doc = dom.window.document

    assert.equal(
      doc.querySelectorAll('[aria-modal="true"]').length,
      1,
      'screen 1: exactly one aria-modal',
    )

    const configure = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === 'Configure…',
    )
    assert.ok(configure, 'the picked roster offers Configure…')
    await act(async () => {
      ;(configure as HTMLButtonElement).focus()
    })
    await click(configure)
    // Screen 2: the bare RosterEditor inside the SAME dialog.
    assert.ok(
      container.querySelector('input[placeholder="New roster name"]'),
      'the roster editor rail renders on screen 2',
    )
    assert.equal(
      doc.querySelectorAll('[aria-modal="true"]').length,
      1,
      'screen 2: still exactly one aria-modal — the editor mounts shell-free',
    )
    const hiddenList = container.querySelector('[aria-label="Backlog items"]')
    assert.ok(
      hiddenList?.closest('.hidden'),
      'the sprint screen is display-swapped out, not stacked under a second modal',
    )
    const backButton = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent?.includes('Back to the sprint'),
    )
    assert.ok(backButton, 'screen 2 has its back affordance')
    assert.equal(
      doc.activeElement,
      backButton,
      'entering screen 2 moves focus into the editor screen',
    )
    await click(backButton)

    // Back on screen 1: picks and the derived name are intact, focus restored.
    assert.equal(
      container.querySelector('h2.font-mono')?.textContent,
      preloadedSource!.teamName,
      'the derived run name survives the round trip',
    )
    const selected = Array.from(
      container.querySelectorAll('[role="option"][aria-selected="true"]'),
    )
    assert.ok(
      selected.some((row) => row.textContent?.includes('Demo epic title'))
        && selected.some((row) => row.textContent?.includes('Loose item title')),
      'the source picks survive the round trip',
    )
    assert.equal(
      doc.activeElement,
      configure,
      'leaving screen 2 restores focus to the opener',
    )
    assert.equal(
      doc.querySelectorAll('[aria-modal="true"]').length,
      1,
      'back on screen 1: still exactly one aria-modal',
    )
    } finally {
      unmount()
    }
  })

  await check('screen 2 edits a roster THROUGH RosterEditor, and the edit + picks + name survive the return', async () => {
    // The T2×T5 seam: the dialog (T5) hands its one useRosterEditor instance to
    // the bare RosterEditor (T2); an edit made inside the editor must be what
    // screen 1 summarises when the user comes back — same instance, no copy.
    const { container, unmount } = await mountDialog(preloadedSource)
    try {
    const type = async (element: Element | null | undefined, value: string): Promise<void> => {
      assert.ok(element, 'expected the field to exist before typing into it')
      const field = element as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        'value',
      )?.set
      await act(async () => {
        setter?.call(field, value)
        field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
    }

    const configure = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === 'Configure…',
    )
    assert.ok(configure, 'the selected roster offers Configure…')
    await click(configure)

    // The edit, driven through RosterEditor's own rail — not through the store.
    await type(container.querySelector('input[placeholder="New roster name"]'), 'Seam crew')
    const createButton = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === 'New roster',
    )
    await click(createButton)
    const saved = useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings
      .savedRosters?.find((entry) => entry.name === 'Seam crew')
    assert.ok(saved, 'the editor rail saved the roster into the shared store')

    const useRosterButton = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === 'Use this roster',
    )
    assert.ok(useRosterButton, 'screen 2 offers the affirmative return')
    await click(useRosterButton)

    // Back on screen 1: the dialog's summary is the roster edited on screen 2,
    // and the sprint half of the dialog kept every pick and the derived name.
    const summaryText = container.textContent ?? ''
    assert.match(summaryText, /Seam crew/, 'screen 1 summarises the roster created in the editor')
    assert.equal(
      container.querySelector('h2.font-mono')?.textContent,
      preloadedSource!.teamName,
      'the derived run name survives the roster edit',
    )
    const selected = Array.from(
      container.querySelectorAll('[role="option"][aria-selected="true"]'),
    )
    assert.ok(
      selected.some((row) => row.textContent?.includes('Demo epic title'))
        && selected.some((row) => row.textContent?.includes('Loose item title')),
      'the source picks survive the roster edit',
    )
    } finally {
      unmount()
    }
  })

  // Escape must peel surfaces in stacking order (T9 / finding F1): the topmost
  // transient surface consumes the press by calling preventDefault, and the
  // dialog's own handler — keyed off event.defaultPrevented — only closes the
  // dialog when nothing above it swallowed the key.
  const pressEscape = async (target: Element): Promise<void> => {
    await act(async () => {
      target.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      )
    })
  }

  await check('Escape closes an open popover first; only the next Escape closes the dialog', async () => {
    let closes = 0
    const { container, unmount } = await mountDialog(preloadedSource, () => {
      closes += 1
    })
    try {
      const doc = dom.window.document
      const filterTrigger = container.querySelector(
        'button[aria-haspopup="menu"][aria-label^="Filter and sort"]',
      )
      await click(filterTrigger)
      const surfaceSelector = '[role="menu"][aria-label="Filter and sort backlog"]'
      assert.ok(doc.querySelector(surfaceSelector), 'the filter popover is open')

      // The popover autofocused one of its options; Escape lands there and must
      // be consumed by the popover before the dialog's window handler sees it.
      await pressEscape(doc.activeElement ?? doc.body)
      assert.equal(doc.querySelector(surfaceSelector), null, 'Escape closed the popover')
      assert.equal(closes, 0, 'the dialog did not close with the popover')
      assert.ok(doc.querySelector('[aria-modal="true"]'), 'the dialog is still mounted')

      await pressEscape(doc.activeElement ?? doc.body)
      assert.equal(closes, 1, 'the second Escape, with nothing open, closes the dialog')
    } finally {
      unmount()
    }
  })

  await check('Escape clears the backlog search before it may close the dialog', async () => {
    let closes = 0
    const { container, unmount } = await mountDialog(preloadedSource, () => {
      closes += 1
    })
    try {
      const search = container.querySelector(
        'input[aria-label="Search backlog items"]',
      ) as HTMLInputElement | null
      assert.ok(search, 'the backlog search input renders')
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        'value',
      )?.set
      await act(async () => {
        setter?.call(search, 'demo')
        search!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      assert.equal(search!.value, 'demo', 'the search holds a query')

      await pressEscape(search!)
      assert.equal(search!.value, '', 'Escape cleared the search')
      assert.equal(closes, 0, 'clearing the search did not close the dialog')

      await pressEscape(search!)
      assert.equal(closes, 1, 'Escape on the empty search closes the dialog')
    } finally {
      unmount()
    }
  })

  // MC-2134 measured this list against the combobox ruling and struck it off:
  // rows toggle rather than commit, the list is multi-selectable and permanently
  // rendered, and Space — the toggle here — cannot coexist with a field that
  // owns focus. What it owed was the link that fits the shape it actually has.
  await check('the backlog search names the list it filters, without claiming to be a combobox', async () => {
    const { container, unmount } = await mountDialog(preloadedSource, () => {})
    try {
      const search = container.querySelector('input[aria-label="Search backlog items"]')
      const list = container.querySelector('[role="listbox"][aria-label="Backlog items"]')
      assert.ok(search && list, 'the search field and the backlog list both render')
      assert.ok(list!.id, 'the list has an id to be named by')
      assert.equal(search!.getAttribute('aria-controls'), list!.id, 'and the field names it')
      assert.equal(search!.getAttribute('role'), null, 'the field is not dressed as a combobox')
      assert.equal(list!.getAttribute('aria-multiselectable'), 'true', 'because the list is multi-selectable')
      assert.equal(
        list!.getAttribute('tabindex'),
        '0',
        'and runs its own cursor as its own tab stop, which a combobox popup never does',
      )
    } finally {
      unmount()
    }
  })

  await check('Escape returns screen 2 to screen 1, and only then closes the dialog', async () => {
    let closes = 0
    const { container, unmount } = await mountDialog(preloadedSource, () => {
      closes += 1
    })
    try {
      const doc = dom.window.document
      const configure = Array.from(container.querySelectorAll('button')).find(
        (element) => element.textContent === 'Configure…',
      )
      assert.ok(configure, 'the selected roster offers Configure…')
      await click(configure)
      assert.ok(
        container.querySelector('input[placeholder="New roster name"]'),
        'screen 2 (roster editor) is open',
      )

      await pressEscape(doc.activeElement ?? doc.body)
      assert.equal(
        container.querySelector('input[placeholder="New roster name"]'),
        null,
        'Escape left screen 2',
      )
      const list = container.querySelector('[aria-label="Backlog items"]')
      assert.ok(list && !list.closest('.hidden'), 'screen 1 is visible again')
      assert.equal(closes, 0, 'returning to screen 1 did not close the dialog')

      await pressEscape(doc.activeElement ?? doc.body)
      assert.equal(closes, 1, 'Escape from screen 1 with nothing open closes the dialog')
    } finally {
      unmount()
    }
  })

  // T11 (finding F3): the mockup's two icon-only actions in the left pane's
  // header — Rescan re-runs the shared scan and the list refreshes from its
  // result; New item opens the shared BacklogCreateDialog scoped to the
  // dialog's project, and the created item lands in the list picked.
  //
  // Clicks here settle their async continuations (the scan, the create IPC
  // chain, the capture modal's focus restore) inside the same act pass, so
  // state landing from those chains stays warning-free.
  const clickAndSettle = async (element: Element | null | undefined): Promise<void> => {
    assert.ok(element, 'expected the element to exist before clicking it')
    await act(async () => {
      ;(element as HTMLElement).dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
      )
      for (let i = 0; i < 40; i += 1) await Promise.resolve()
      await new Promise((resolve) => dom.window.setTimeout(resolve, 30))
      for (let i = 0; i < 40; i += 1) await Promise.resolve()
    })
  }

  // The header carries ONE action (2112): `ui/PanelHeader` takes a single
  // `primaryAction`, and the pair of icon buttons that used to share that slot
  // is what gave every panel a different action cluster. Adding an item is what
  // the left column is for, so the plus keeps the slot; Rescan moved into the
  // overflow menu beside it and is exercised through that menu below.
  await check('the left pane header renders New item as its one icon-only action', async () => {
    const { container, unmount } = await mountDialog(preloadedSource)
    try {
      const newItem = container.querySelector('button[aria-label="New item"]')
      assert.ok(newItem, 'the New item icon button renders')
      assert.equal(newItem!.textContent, '', 'the action is icon-only, no text label')
      assert.match(
        newItem!.closest('header')?.textContent ?? '',
        /Backlog/,
        'the action sits in the left pane header row',
      )
      assert.equal(
        container.querySelector('button[aria-label="Rescan"]'),
        null,
        'Rescan is not a second button in the header — it lives in the overflow menu',
      )
      const overflow = container.querySelector('button[aria-label="Backlog actions"]')
      assert.ok(overflow, 'the header offers the overflow menu that now holds it')
      assert.match(
        overflow!.closest('header')?.textContent ?? '',
        /Backlog/,
        'in the same header row',
      )
    } finally {
      unmount()
    }
  })

  await check('Rescan re-runs the backlog scan and the list refreshes from its result', async () => {
    const { container, unmount } = await mountDialog(preloadedSource)
    try {
      assert.ok(
        !(container.textContent ?? '').includes('Late arrival title'),
        'the late item is not in the first scan',
      )
      FILES['/proj/backlog/late-arrival.md'] = [
        '---',
        'type: feature',
        'status: ready',
        'id: 903',
        '---',
        '',
        '# Late arrival title',
      ].join('\n')
      DIRS['/proj/backlog'].push({ name: 'late-arrival.md', isDir: false })
      // Reached through the overflow menu it moved into (2112) — the point of
      // this check is that a rescan refreshes the list, not where the control
      // sits, so it opens the menu and picks the item.
      await clickAndSettle(container.querySelector('button[aria-label="Backlog actions"]'))
      const rescan = [...dom.window.document.querySelectorAll('[role="menuitem"]')].find(
        (candidate) => candidate.textContent?.trim() === 'Rescan',
      )
      assert.ok(rescan, 'the overflow menu offers Rescan')
      await clickAndSettle(rescan as Element)
      await flush()
      assert.match(
        container.textContent ?? '',
        /Late arrival title/,
        'the rescan picked up the item added on disk',
      )
    } finally {
      delete FILES['/proj/backlog/late-arrival.md']
      DIRS['/proj/backlog'] = DIRS['/proj/backlog'].filter(
        (entry) => entry.name !== 'late-arrival.md',
      )
      unmount()
    }
  })

  await check('New item opens the shared capture dialog; the created item lands in the list picked', async () => {
    const { container, unmount } = await mountDialog(null)
    try {
      const doc = dom.window.document
      await clickAndSettle(container.querySelector('button[aria-label="New item"]'))
      // The shared BacklogCreateDialog, stacked above the dialog.
      // `as Element[]`: jsdom's querySelectorAll is loosely typed here, so the
      // members arrive as `unknown` and every read off them fails to compile.
      const capture = (Array.from(doc.querySelectorAll('[role="dialog"]')) as Element[]).find(
        (node) => node.textContent?.includes('New backlog item'),
      )
      assert.ok(capture, 'the shared New-item capture dialog opens')

      const title = capture!.querySelector('input') as HTMLInputElement | null
      assert.ok(title, 'the capture dialog has its title field')
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        'value',
      )?.set
      await act(async () => {
        setter?.call(title, 'Captured in the dialog')
        title!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      const create = (Array.from(capture!.querySelectorAll('button')) as Element[]).find(
        (element) => element.textContent === 'Create item',
      )
      await clickAndSettle(create)
      await flush()

      assert.ok(
        !doc.body.textContent?.includes('New backlog item'),
        'the capture dialog closed after creating',
      )
      const row = Array.from(
        container.querySelectorAll('[role="option"]'),
      ).find((node) => node.textContent?.includes('Captured in the dialog'))
      assert.ok(row, 'the created item appears in the refreshed list')
      assert.equal(
        row!.getAttribute('aria-selected'),
        'true',
        'the created item is picked, the dialog analog of select-on-create',
      )
    } finally {
      const created = Object.keys(FILES).find((path) => path.includes('captured-in-the-dialog'))
      if (created) {
        delete FILES[created]
        DIRS['/proj/backlog'] = DIRS['/proj/backlog'].filter(
          (entry) => !entry.name.includes('captured-in-the-dialog'),
        )
      }
      unmount()
    }
  })

  await check('Escape closes the New-item capture first; the dialog stays open', async () => {
    let closes = 0
    const { container, unmount } = await mountDialog(preloadedSource, () => {
      closes += 1
    })
    try {
      const doc = dom.window.document
      await clickAndSettle(container.querySelector('button[aria-label="New item"]'))
      assert.ok(
        doc.body.textContent?.includes('New backlog item'),
        'the capture dialog is open',
      )
      await pressEscape(doc.activeElement ?? doc.body)
      await flush()
      assert.ok(
        !doc.body.textContent?.includes('New backlog item'),
        'Escape closed the capture dialog',
      )
      assert.equal(closes, 0, 'the sprint dialog did not close with the capture')
      await pressEscape(doc.activeElement ?? doc.body)
      assert.equal(closes, 1, 'the next Escape closes the sprint dialog')
    } finally {
      unmount()
    }
  })

  await check('MC-2110 the shell is a Modal, and Enter still starts from where focus opens', async () => {
    // The dialog gave up its hand-built shell for `Modal` (scrim, trap, Escape,
    // focus restore, geometry). The seam that creates: Modal lands initial focus
    // on the SHELL, and a keydown there never reaches the region below it that
    // carries Enter-to-start — so the dialog has to land focus itself, on that
    // region. Asserted as the two facts that break together: where focus opens,
    // and that Enter from there starts the sprint.
    const apiRecord = (dom.window as unknown as { api: Record<string, unknown> }).api
    let initCalls = 0
    apiRecord.initializeSprintEngineState = async () => {
      initCalls += 1
      return { ok: true, data: {} }
    }
    apiRecord.addOrUpdateBacklogLink = async () => ({ ok: true })
    const { container, unmount } = await mountDialog(preloadedSource)
    try {
      const doc = dom.window.document
      const shell = doc.querySelector('[role="dialog"][aria-modal="true"]')
      assert.ok(shell, 'the shell is the kit Modal, declaring itself the modal dialog')
      const active = doc.activeElement as HTMLElement | null
      assert.ok(active && shell.contains(active), 'focus opens inside the dialog')
      assert.notEqual(
        active,
        shell,
        'and on the keydown region, not the shell above it — an Enter on the shell reaches no child handler',
      )

      await act(async () => {
        active?.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        )
      })
      await flush()
      assert.equal(initCalls, 1, 'Enter from the opening focus starts the sprint')

      // The scrim is the primitive's, so click-outside closes — the one thing
      // this dialog never had while it carried a shell of its own.
      assert.ok(
        container.querySelector('.overlay-scrim'),
        'the shell brings the shared scrim, and with it a pointer-down way out',
      )
    } finally {
      delete apiRecord.initializeSprintEngineState
      delete apiRecord.addOrUpdateBacklogLink
      unmount()
    }
  })

  await check('Start sprint seeds engine init with planKind selection and the marked bundle', async () => {
    // The last hop of the context-action chain (T12): the dialog's Start must
    // hand the preloaded selection to engine init unchanged — planKind
    // 'selection', the anchor as primary source, and the bundle's
    // epicChild/selectedItem markers intact.
    const apiRecord = (dom.window as unknown as { api: Record<string, unknown> }).api
    const initCalls: Array<{
      source?: { planKind?: string; path?: string }
      sourceBundle?: Array<{
        kind?: string
        path?: string
        epicChild?: boolean
        selectedItem?: boolean
      }>
    }> = []
    apiRecord.initializeSprintEngineState = async (input: (typeof initCalls)[number]) => {
      initCalls.push({ source: input.source, sourceBundle: input.sourceBundle })
      return { ok: true, data: {} }
    }
    const linkedPaths: string[] = []
    apiRecord.addOrUpdateBacklogLink = async (input: { relativePath: string }) => {
      linkedPaths.push(input.relativePath)
      return { ok: true }
    }
    let closes = 0
    const { container, unmount } = await mountDialog(preloadedSource, () => {
      closes += 1
    })
    try {
      const startButton = Array.from(container.querySelectorAll('button')).find(
        (element) => element.textContent?.includes('Start sprint'),
      )
      await click(startButton)
      await flush()

      assert.equal(closes, 1, 'a successful Start closes the dialog')
      assert.equal(initCalls.length, 1, 'Start initializes exactly one run')
      const init = initCalls[0]
      assert.equal(init.source?.planKind, 'selection', 'init seeds planKind selection')
      assert.equal(
        init.source?.path,
        'backlog/epics/demo-epic.md',
        'the anchor row is the primary source',
      )
      const byPath = new Map((init.sourceBundle ?? []).map((item) => [item.path, item]))
      assert.equal(
        byPath.get('backlog/epics/demo-epic.md')?.kind,
        'epic',
        'the selected epic rides the bundle as a membership scope',
      )
      assert.equal(
        byPath.get('backlog/child-item.md')?.epicChild,
        true,
        'the epic child keeps its epicChild marker through init',
      )
      assert.equal(
        byPath.get('backlog/loose-item.md')?.selectedItem,
        true,
        'the directly-selected item keeps its selectedItem marker through init',
      )
      assert.ok(
        linkedPaths.includes('backlog/epics/demo-epic.md'),
        'the execution link lands on the anchor source',
      )
    } finally {
      delete apiRecord.initializeSprintEngineState
      delete apiRecord.addOrUpdateBacklogLink
      unmount()
    }
  })

  // ── the Planning agent row (MC-2129) ──────────────────────────────────────

  await check('an epic source defaults the Planning agent to None and starts direct', async () => {
    const apiRecord = (dom.window as unknown as { api: Record<string, unknown> }).api
    const initCalls: Array<{ intake?: string; source?: { planKind?: string } }> = []
    apiRecord.initializeSprintEngineState = async (input: (typeof initCalls)[number]) => {
      initCalls.push({ intake: input.intake, source: input.source })
      return { ok: true, data: {} }
    }
    apiRecord.addOrUpdateBacklogLink = async () => ({ ok: true })
    const { container, unmount } = await mountDialog(epicOnlySource)
    try {
      const text = container.textContent ?? ''
      // The row's VALUE is the whole control: "None", and nothing else.
      assert.match(text, /Planning agent/, 'the team card carries the Planning agent row')
      const picker = container.querySelector('button[aria-label^="Planning agent"]')
      assert.ok(picker, 'the row renders a picker')
      assert.equal(
        picker?.getAttribute('aria-label'),
        'Planning agent: None',
        'an epic source defaults the row to None',
      )
      // No sub-copy and no badge (ruled 2026-08-04).
      assert.doesNotMatch(text, /planner/i, 'the row carries no planner badge or sub-copy')
      // The footer states the consequence in plain words.
      assert.match(text, /1 task from your epic/, 'the footer counts the tasks the epic mints')

      await click(
        Array.from(container.querySelectorAll('button')).find((element) =>
          element.textContent?.includes('Start sprint'),
        ),
      )
      await flush()
      assert.equal(initCalls.length, 1, 'Start initializes exactly one run')
      assert.equal(initCalls[0]?.source?.planKind, 'epic')
      assert.equal(initCalls[0]?.intake, 'direct', 'an untouched row runs the direct intake')
    } finally {
      delete apiRecord.initializeSprintEngineState
      delete apiRecord.addOrUpdateBacklogLink
      unmount()
    }
  })

  await check('picking an agent from the row restores the planned intake', async () => {
    const apiRecord = (dom.window as unknown as { api: Record<string, unknown> }).api
    const initCalls: Array<{ intake?: string }> = []
    apiRecord.initializeSprintEngineState = async (input: (typeof initCalls)[number]) => {
      initCalls.push({ intake: input.intake })
      return { ok: true, data: {} }
    }
    apiRecord.addOrUpdateBacklogLink = async () => ({ ok: true })
    const { container, unmount } = await mountDialog(epicOnlySource)
    try {
      await clickAndSettle(container.querySelector('button[aria-label^="Planning agent"]'))
      const doc = dom.window.document
      // The picker is the shared CliModelPicker with None pinned first, so the
      // menu's own rows are what restore a planning agent.
      const rows = Array.from(
        doc.body.querySelectorAll('[role="listbox"][aria-label="Planning agent options"] [role="option"]'),
      ) as Element[]
      assert.ok(rows.length > 1, 'the menu offers None plus at least one runtime')
      assert.equal(rows[0]?.textContent?.includes('None'), true, 'None is pinned first')
      const runtimeRow = rows.find((row) => !row.textContent?.includes('None'))
      await clickAndSettle(runtimeRow)

      const text = container.textContent ?? ''
      assert.match(text, /1 item · planned first/, 'the footer flips once an agent is picked')

      await click(
        Array.from(container.querySelectorAll('button')).find((element) =>
          element.textContent?.includes('Start sprint'),
        ),
      )
      await flush()
      assert.equal(initCalls[0]?.intake, 'planned', 'a picked agent runs the planning intake')
    } finally {
      delete apiRecord.initializeSprintEngineState
      delete apiRecord.addOrUpdateBacklogLink
      unmount()
    }
  })

  await check('going BACK to None sends the direct intake, not the stale planned one', async () => {
    // The return leg the suite never walked. Picking a runtime also moves the
    // roster's cli defaults, so `start` was rebuilt and happened to see the
    // fresh intake; picking None moves nothing but `planningNoneOverride`, so
    // with `intake` absent from `start`'s deps the launch kept sending
    // `planned` — the mode the user had just left.
    const apiRecord = (dom.window as unknown as { api: Record<string, unknown> }).api
    const initCalls: Array<{ intake?: string }> = []
    apiRecord.initializeSprintEngineState = async (input: (typeof initCalls)[number]) => {
      initCalls.push({ intake: input.intake })
      return { ok: true, data: {} }
    }
    apiRecord.addOrUpdateBacklogLink = async () => ({ ok: true })
    const { container, unmount } = await mountDialog(epicOnlySource)
    try {
      const openPicker = async (): Promise<Element[]> => {
        await clickAndSettle(container.querySelector('button[aria-label^="Planning agent"]'))
        return Array.from(
          dom.window.document.body.querySelectorAll(
            '[role="listbox"][aria-label="Planning agent options"] [role="option"]',
          ),
        ) as Element[]
      }
      const runtimeRow = (await openPicker()).find((row) => !row.textContent?.includes('None'))
      await clickAndSettle(runtimeRow)
      assert.match(container.textContent ?? '', /planned first/, 'the runtime took')

      const noneRow = (await openPicker()).find((row) => row.textContent?.includes('None'))
      await clickAndSettle(noneRow)
      assert.match(container.textContent ?? '', /from your epic/, 'the footer went back')

      await click(
        Array.from(container.querySelectorAll('button')).find((element) =>
          element.textContent?.includes('Start sprint'),
        ),
      )
      await flush()
      assert.equal(initCalls[0]?.intake, 'direct', 'what the row shows is what init gets')
    } finally {
      delete apiRecord.initializeSprintEngineState
      delete apiRecord.addOrUpdateBacklogLink
      unmount()
    }
  })

  // ── the epic ordering gate (MC-2137) ──────────────────────────────────────

  await check('an epic that never declared its ordering done defaults to a planning agent', async () => {
    const { container, unmount } = await mountDialog(unplannedEpicSource)
    try {
      const picker = container.querySelector('button[aria-label^="Planning agent"]')
      assert.ok(picker, 'the row renders a picker')
      assert.notEqual(
        picker?.getAttribute('aria-label'),
        'Planning agent: None',
        'an unmarked epic does not default to None',
      )
      const text = container.textContent ?? ''
      assert.match(text, /planned first/, 'the footer states the run will plan first')
      // A default flip, never a wall: None is still on offer, and until it is
      // chosen there is no consequence line to show.
      assert.doesNotMatch(text, /Ordering not marked done/, 'the consequence rides the None choice')
    } finally {
      unmount()
    }
  })

  await check('choosing None on an unmarked epic starts direct and states the consequence', async () => {
    const apiRecord = (dom.window as unknown as { api: Record<string, unknown> }).api
    const initCalls: Array<{ intake?: string }> = []
    apiRecord.initializeSprintEngineState = async (input: (typeof initCalls)[number]) => {
      initCalls.push({ intake: input.intake })
      return { ok: true, data: {} }
    }
    apiRecord.addOrUpdateBacklogLink = async () => ({ ok: true })
    const { container, unmount } = await mountDialog(unplannedEpicSource)
    try {
      await clickAndSettle(container.querySelector('button[aria-label^="Planning agent"]'))
      const noneRow = (
        Array.from(
          dom.window.document.body.querySelectorAll(
            '[role="listbox"][aria-label="Planning agent options"] [role="option"]',
          ),
        ) as Element[]
      ).find((row) => row.textContent?.includes('None'))
      await clickAndSettle(noneRow)

      assert.match(
        container.textContent ?? '',
        /Ordering not marked done — items run in parallel/,
        'the epic source row states what running it unordered means',
      )
      await click(
        Array.from(container.querySelectorAll('button')).find((element) =>
          element.textContent?.includes('Start sprint'),
        ),
      )
      await flush()
      assert.equal(initCalls[0]?.intake, 'direct', 'the gate informs, it never blocks the start')
    } finally {
      delete apiRecord.initializeSprintEngineState
      delete apiRecord.addOrUpdateBacklogLink
      unmount()
    }
  })

  await check('a marked epic picking None shows no consequence line', async () => {
    const { container, unmount } = await mountDialog(epicOnlySource)
    try {
      assert.doesNotMatch(
        container.textContent ?? '',
        /Ordering not marked done/,
        'a marked epic running direct is exactly what the mark asked for',
      )
    } finally {
      unmount()
    }
  })

  await check('a non-epic source shows the row with an agent and no None', async () => {
    const { container, unmount } = await mountDialog(preloadedSource)
    try {
      const picker = container.querySelector('button[aria-label^="Planning agent"]')
      assert.ok(picker, 'the row appears for a non-epic source too — never a dead control')
      assert.doesNotMatch(
        picker?.getAttribute('aria-label') ?? '',
        /None/,
        'with no epic there is no authored order to fall back on, so None is not offered',
      )
      await clickAndSettle(picker)
      const rows = Array.from(
        dom.window.document.body.querySelectorAll(
          '[role="listbox"][aria-label="Planning agent options"] [role="option"]',
        ),
      ) as Element[]
      assert.ok(rows.length > 0, 'the menu lists runtimes')
      assert.ok(
        rows.every((row) => !row.textContent?.startsWith('None')),
        'no None row is pinned for a non-epic source',
      )
    } finally {
      unmount()
    }
  })

  // ── the "Runs in" row (MC-2123) ───────────────────────────────────────────
  //
  // The dialog used to hand engine init a hardcoded `useWorktrees: false`, so
  // isolation was unreachable from the only path a person can use. These pin
  // the two halves the acceptance names: the choice exists and defaults to one
  // worktree per sprint, and BOTH of its values reach init — which is also what
  // makes the absence of the literal observable rather than a source read.

  const isolationTrigger = (container: HTMLElement): HTMLElement | null =>
    container.querySelector('button[role="combobox"][aria-label="Runs in"]')

  const { NO_ROLES_ROSTER_ID } = await import('../newWorkspace/savedRosters')
  const selectRoster = async (id: string | null): Promise<void> => {
    await act(async () => {
      useWorkspaceStore.getState().setSprintEngineLastSelectedRoster(id)
    })
  }

  await selectRoster(NO_ROLES_ROSTER_ID)

  await check('the team card offers where the sprint runs, defaulting to one worktree', async () => {
    const apiRecord = (dom.window as unknown as { api: Record<string, unknown> }).api
    const initCalls: Array<{ useWorktrees?: boolean }> = []
    apiRecord.initializeSprintEngineState = async (input: (typeof initCalls)[number]) => {
      initCalls.push({ useWorktrees: input.useWorktrees })
      return { ok: true, data: {} }
    }
    apiRecord.addOrUpdateBacklogLink = async () => ({ ok: true })
    const { container, unmount } = await mountDialog(preloadedSource)
    try {
      const trigger = isolationTrigger(container)
      assert.ok(trigger, 'the team card carries the Runs in row')
      assert.match(
        trigger!.textContent ?? '',
        /One worktree/,
        'a sprint runs in its own worktree unless the operator says otherwise (owner ruling 2026-08-05)',
      )
      // The row's VALUE is the control, exactly like Planning agent above it.
      assert.doesNotMatch(
        container.textContent ?? '',
        /isolated git worktree/i,
        'no sub-copy under the row — the explanation is the label tooltip',
      )

      await click(
        Array.from(container.querySelectorAll('button')).find((element) =>
          element.textContent?.includes('Start sprint'),
        ),
      )
      await flush()
      assert.equal(initCalls.length, 1, 'Start initializes exactly one run')
      assert.equal(
        initCalls[0]?.useWorktrees,
        true,
        'the default reaches engine init, which is what mints the run worktree',
      )
    } finally {
      delete apiRecord.initializeSprintEngineState
      delete apiRecord.addOrUpdateBacklogLink
      unmount()
    }
  })

  await check('choosing the project folder starts the run in the checkout, as before', async () => {
    const apiRecord = (dom.window as unknown as { api: Record<string, unknown> }).api
    const initCalls: Array<{ useWorktrees?: boolean }> = []
    apiRecord.initializeSprintEngineState = async (input: (typeof initCalls)[number]) => {
      initCalls.push({ useWorktrees: input.useWorktrees })
      return { ok: true, data: {} }
    }
    apiRecord.addOrUpdateBacklogLink = async () => ({ ok: true })
    const { container, unmount } = await mountDialog(preloadedSource)
    try {
      await clickAndSettle(isolationTrigger(container))
      const options = Array.from(
        dom.window.document.body.querySelectorAll(
          '[role="listbox"][aria-label="Runs in"] [role="option"]',
        ),
      ) as Element[]
      assert.deepEqual(
        options.map((option) => option.textContent?.trim()),
        ['One worktree', 'A worktree per task', 'The project folder'],
        'the whole isolation ladder, best-first (MC-2136 added the per-task rung)',
      )
      await clickAndSettle(options.find((option) => option.textContent?.includes('project folder')))
      assert.match(
        isolationTrigger(container)?.textContent ?? '',
        /The project folder/,
        'the picked value is what the row shows',
      )

      await click(
        Array.from(container.querySelectorAll('button')).find((element) =>
          element.textContent?.includes('Start sprint'),
        ),
      )
      await flush()
      assert.equal(
        initCalls[0]?.useWorktrees,
        false,
        'the off rung is byte-for-byte the run the dialog made before this row existed',
      )
    } finally {
      delete apiRecord.initializeSprintEngineState
      delete apiRecord.addOrUpdateBacklogLink
      unmount()
    }
  })

  // MC-2136: the per-task rung. The dialog's job is to turn the picked rung into
  // the engine's two flags — worktrees on, isolation on — and nothing else; what
  // those flags then do to the run belongs to the engine's own tests.
  await check('picking a worktree per task asks the engine for per-task isolation', async () => {
    const apiRecord = (dom.window as unknown as { api: Record<string, unknown> }).api
    const initCalls: Array<{ useWorktrees?: boolean; taskIsolation?: boolean }> = []
    apiRecord.initializeSprintEngineState = async (input: (typeof initCalls)[number]) => {
      initCalls.push({ useWorktrees: input.useWorktrees, taskIsolation: input.taskIsolation })
      return { ok: true, data: {} }
    }
    apiRecord.addOrUpdateBacklogLink = async () => ({ ok: true })
    const { container, unmount } = await mountDialog(preloadedSource)
    try {
      await clickAndSettle(isolationTrigger(container))
      const options = Array.from(
        dom.window.document.body.querySelectorAll(
          '[role="listbox"][aria-label="Runs in"] [role="option"]',
        ),
      ) as Element[]
      await clickAndSettle(options.find((option) => option.textContent?.includes('per task')))
      assert.match(
        isolationTrigger(container)?.textContent ?? '',
        /A worktree per task/,
        'the picked value is what the row shows',
      )

      await click(
        Array.from(container.querySelectorAll('button')).find((element) =>
          element.textContent?.includes('Start sprint'),
        ),
      )
      await flush()
      assert.deepEqual(
        initCalls[0],
        { useWorktrees: true, taskIsolation: true },
        'per-task isolation is layered ON run worktrees, never sent alone',
      )
    } finally {
      delete apiRecord.initializeSprintEngineState
      delete apiRecord.addOrUpdateBacklogLink
      unmount()
    }
  })

  // The default rung must stay the run it always made: one shared worktree, and
  // no isolation field at all in the payload (MC-2136 ruling — per-task is a
  // choice, never a silent default).
  await check('the default rung still creates a plain one-worktree run', async () => {
    const apiRecord = (dom.window as unknown as { api: Record<string, unknown> }).api
    const initCalls: Array<Record<string, unknown>> = []
    apiRecord.initializeSprintEngineState = async (input: Record<string, unknown>) => {
      initCalls.push(input)
      return { ok: true, data: {} }
    }
    apiRecord.addOrUpdateBacklogLink = async () => ({ ok: true })
    const { container, unmount } = await mountDialog(preloadedSource)
    try {
      await click(
        Array.from(container.querySelectorAll('button')).find((element) =>
          element.textContent?.includes('Start sprint'),
        ),
      )
      await flush()
      assert.equal(initCalls[0]?.useWorktrees, true, 'one worktree per sprint is the default')
      assert.equal(
        'taskIsolation' in (initCalls[0] ?? {}),
        false,
        'the default payload carries no isolation field at all',
      )
    } finally {
      delete apiRecord.initializeSprintEngineState
      delete apiRecord.addOrUpdateBacklogLink
      unmount()
    }
  })

  await check('a staffed roster carries the same Runs in row — never one world only', async () => {
    let rosterId: string | null = null
    await act(async () => {
      rosterId = useWorkspaceStore.getState().saveSprintEngineRoster({
        name: 'Isolation crew',
        roleCounts: { developer: 1 },
        roleCliDefaults: {},
        roleModelOverrides: {},
      })
    })
    assert.ok(rosterId, 'the fixture roster saves')
    await selectRoster(rosterId)
    const { container, unmount } = await mountDialog(preloadedSource)
    try {
      assert.match(container.textContent ?? '', /Isolation crew/, 'the staffed card is showing')
      const trigger = isolationTrigger(container)
      assert.ok(trigger, 'the staffed roster card carries the row too')
      assert.match(trigger!.textContent ?? '', /One worktree/, 'with the same default')
    } finally {
      await selectRoster(NO_ROLES_ROSTER_ID)
      unmount()
    }
  })

  // ── the "Connectors" row (MC-2124) ────────────────────────────────────────
  //
  // Starting a sprint stopped configuring MCP at all when the wizard's Tools
  // panel was deleted with it. These pin the three halves of the fix: the
  // selection is reachable where a sprint is started, creating a sprint WRITES
  // the enabled servers into the project (on any folder, wizard or not), and a
  // write failure fails closed instead of producing a toolless run.

  const connectorsTrigger = (container: HTMLElement): HTMLElement | null =>
    container.querySelector('button[aria-label^="Connectors"]')

  const setConnectors = async (
    servers: Array<{ id: string; name: string; enabled: boolean }>,
    syncEnabled = true,
  ): Promise<void> => {
    await act(async () => {
      useWorkspaceStore.setState((state) => ({
        appSettings: {
          ...state.appSettings,
          mcp: {
            syncEnabled,
            servers: Object.fromEntries(
              servers.map((entry) => [
                entry.id,
                {
                  id: entry.id,
                  name: entry.name,
                  transport: 'stdio' as const,
                  command: 'node',
                  args: ['server.js'],
                  enabled: entry.enabled,
                  clients: ['claude-code' as const],
                  scope: 'workspace' as const,
                  source: 'bundled' as const,
                  riskLevel: 'low' as const,
                },
              ]),
            ),
          },
        },
      }))
    })
  }

  const clearConnectors = async (): Promise<void> => {
    await act(async () => {
      useWorkspaceStore.setState((state) => ({
        appSettings: { ...state.appSettings, mcp: { syncEnabled: false, servers: {} } },
      }))
    })
  }

  await check('the team card offers the sprint’s connectors, and the picker toggles them', async () => {
    await setConnectors([
      { id: 'github', name: 'GitHub', enabled: true },
      { id: 'linear', name: 'Linear', enabled: false },
    ])
    const { container, unmount } = await mountDialog(preloadedSource)
    try {
      const trigger = connectorsTrigger(container)
      assert.ok(trigger, 'the team card carries the Connectors row')
      assert.match(trigger!.textContent ?? '', /1 active/, 'the row states what the sprint gets')

      await click(trigger)
      const rows = Array.from(
        dom.window.document.body.querySelectorAll('[role="menuitemcheckbox"]'),
      ) as HTMLElement[]
      assert.equal(rows.length, 2, 'the picker lists every installed connector')
      assert.equal(rows[0]?.getAttribute('aria-checked'), 'true', 'the active one leads, ticked')

      // Toggling ON edits the app-level selection (the ruled behaviour) and the
      // picker stays open, because a run picks a SET.
      await click(rows[1])
      assert.equal(
        useWorkspaceStore.getState().appSettings.mcp?.servers.linear?.enabled,
        true,
        'the toggle writes the one app-level selection',
      )
      assert.equal(
        dom.window.document.body.querySelectorAll('[role="menuitemcheckbox"]').length,
        2,
        'a pick does not close the picker',
      )
      assert.match(connectorsTrigger(container)!.textContent ?? '', /2 active/)

      // Toggling OFF keeps the server installed — never a silent uninstall.
      await click(dom.window.document.body.querySelectorAll('[role="menuitemcheckbox"]')[1])
      const linear = useWorkspaceStore.getState().appSettings.mcp?.servers.linear
      assert.ok(linear, 'the server survives being switched off')
      assert.equal(linear!.enabled, false, 'it is simply inactive')
    } finally {
      unmount()
      await clearConnectors()
    }
  })

  await check('starting a sprint writes the enabled connectors into the project', async () => {
    // The regression the acceptance names: a folder that never went through the
    // new-workspace wizard still gets its MCP servers synced at creation.
    const apiRecord = (dom.window as unknown as { api: Record<string, unknown> }).api
    const order: string[] = []
    const syncCalls: Array<{ workspaceRoot: string; enabledIds: string[] }> = []
    apiRecord.mcpSync = async (input: {
      workspaceRoot: string
      settings: { servers: Record<string, { id: string; enabled: boolean }> }
    }) => {
      order.push('mcpSync')
      syncCalls.push({
        workspaceRoot: input.workspaceRoot,
        enabledIds: Object.values(input.settings.servers)
          .filter((server) => server.enabled)
          .map((server) => server.id),
      })
      return { ok: true, targets: [], issues: [] }
    }
    apiRecord.initializeSprintEngineState = async () => {
      order.push('init')
      return { ok: true, data: {} }
    }
    apiRecord.addOrUpdateBacklogLink = async () => ({ ok: true })
    await setConnectors([
      { id: 'github', name: 'GitHub', enabled: true },
      { id: 'linear', name: 'Linear', enabled: false },
    ])
    const { container, unmount } = await mountDialog(preloadedSource)
    try {
      await click(
        Array.from(container.querySelectorAll('button')).find((element) =>
          element.textContent?.includes('Start sprint'),
        ),
      )
      await flush()
      assert.deepEqual(
        syncCalls,
        [{ workspaceRoot: ROOT, enabledIds: ['github'] }],
        'the enabled server is written into the project the sprint runs in',
      )
      assert.deepEqual(order, ['mcpSync', 'init'], 'and written before the run is created')
    } finally {
      delete apiRecord.mcpSync
      delete apiRecord.initializeSprintEngineState
      delete apiRecord.addOrUpdateBacklogLink
      unmount()
      await clearConnectors()
    }
  })

  await check('a connector write that fails aborts the start with its own message', async () => {
    const apiRecord = (dom.window as unknown as { api: Record<string, unknown> }).api
    let initialized = false
    apiRecord.mcpSync = async () => ({ ok: false, message: 'Workspace root does not exist.' })
    apiRecord.initializeSprintEngineState = async () => {
      initialized = true
      return { ok: true, data: {} }
    }
    apiRecord.addOrUpdateBacklogLink = async () => ({ ok: true })
    await setConnectors([{ id: 'github', name: 'GitHub', enabled: true }])
    let closes = 0
    const { container, unmount } = await mountDialog(preloadedSource, () => {
      closes += 1
    })
    try {
      await click(
        Array.from(container.querySelectorAll('button')).find((element) =>
          element.textContent?.includes('Start sprint'),
        ),
      )
      await flush()
      assert.equal(initialized, false, 'no run is created when the tools cannot be written')
      assert.equal(closes, 0, 'the dialog stays open on the failure')
      assert.match(
        container.textContent ?? '',
        /Tool integration setup failed: Workspace root does not exist\./,
        'and shows the actionable message rather than a toolless run',
      )
    } finally {
      delete apiRecord.mcpSync
      delete apiRecord.initializeSprintEngineState
      delete apiRecord.addOrUpdateBacklogLink
      unmount()
      await clearConnectors()
    }
  })

  await check('a staffed roster carries the Connectors row too', async () => {
    let rosterId: string | null = null
    await act(async () => {
      rosterId = useWorkspaceStore.getState().saveSprintEngineRoster({
        name: 'Connector crew',
        roleCounts: { developer: 1 },
        roleCliDefaults: {},
        roleModelOverrides: {},
      })
    })
    assert.ok(rosterId, 'the fixture roster saves')
    await selectRoster(rosterId)
    await setConnectors([{ id: 'github', name: 'GitHub', enabled: true }])
    const { container, unmount } = await mountDialog(preloadedSource)
    try {
      assert.match(container.textContent ?? '', /Connector crew/, 'the staffed card is showing')
      const trigger = connectorsTrigger(container)
      assert.ok(trigger, 'the staffed roster card carries the row too')
      assert.match(trigger!.textContent ?? '', /1 active/, 'with the same value')
    } finally {
      await selectRoster(NO_ROLES_ROSTER_ID)
      unmount()
      await clearConnectors()
    }
  })

  if (failures > 0) {
    console.error(`\n${failures} NewSprintDialog checks failed`)
    process.exit(1)
  }
  console.log('NewSprintDialog.test.tsx: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
