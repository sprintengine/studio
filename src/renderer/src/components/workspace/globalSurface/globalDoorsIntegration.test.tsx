import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

import type { BacklogItem, BacklogScanResult } from '../../../utils/backlog'

// Epic 1760's integration review (item T10): the pieces T1–T9 built, exercised
// TOGETHER rather than one surface at a time. The per-item suites each prove
// their own contract; this one covers the seams between them, which is where an
// epic assembled by six agents actually breaks:
//
//  1. The five doors coexist on the REAL renderer kernel — Sprints and Backlog
//     joined Automations/Roadmap/Reviews at the orders the mockup's sidebar
//     shows, each with a surface behind it, and both vanish with their module.
//  2. The Sprints door survives an unreadable run index and RECOVERS from it —
//     the degraded state is a way back, not a dead end (the leg the composition
//     suite could not reach: its index IPC always resolves).
//  3. A run whose workspace is still resident opens from the door with its
//     workspace-only actions LIVE, next to the same door showing a
//     workspace-deleted run degraded. Both mounts, one surface, one assertion.
//  4. The Backlog door renders the aggregate: project-tagged rows with their own
//     display keys, a project filter that reproduces one project's list, and one
//     project's scan failing without taking the other two down.
//
// The Electron app is not drivable headlessly (SprintEngine E2E headless
// blocker), so this stands up a real DOM, stubs only the preload boundary, and
// mounts the actual surfaces against one real store.

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
anyGlobal.CustomEvent = dom.window.CustomEvent
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
// JSDOM has no scrollIntoView; the Select's open effect scrolls its active
// option into view, so give it a no-op.
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
anyGlobal.ResizeObserver = NoopResizeObserver
dom.window.ResizeObserver = NoopResizeObserver as unknown as typeof dom.window.ResizeObserver

const multicode = '/work/multicode'
const multiauth = '/work/multiauth'
const mobile = '/work/multicode-mobile'

const residentStatePath = `${multicode}/.multi-code/sprintengine/live-run/run.yaml`
const orphanStatePath = `${mobile}/.multi-code/sprintengine/old-run/run.yaml`

function summary(over: Record<string, unknown>): Record<string, unknown> {
  return {
    statePath: '',
    teamSlug: '',
    teamName: '',
    projectRoot: multicode,
    projectName: 'multicode',
    runtimeState: 'idle',
    taskCounts: { total: 0, done: 0, inProgress: 0, waiting: 0 },
    repoRollup: { declared: 0, merged: 0, open: 0 },
    needsInputCount: 0,
    startedAt: null,
    updatedAt: null,
    sourceLabel: null,
    ...over,
  }
}

// Two runs in the index: one whose sprint workspace is still open in this
// Multicode, one whose workspace is long gone.
const runs = [
  summary({
    statePath: residentStatePath,
    teamSlug: 'live-run',
    teamName: 'live-run',
    runtimeState: 'running',
    taskCounts: { total: 4, done: 1, inProgress: 1, waiting: 2 },
    updatedAt: '2026-07-23T10:00:00Z',
  }),
  summary({
    statePath: orphanStatePath,
    teamSlug: 'old-run',
    teamName: 'old-run',
    projectRoot: mobile,
    projectName: 'multicode-mobile',
    runtimeState: 'completed',
    taskCounts: { total: 3, done: 3, inProgress: 0, waiting: 0 },
    updatedAt: '2026-07-20T10:00:00Z',
  }),
]

function projectionFor(name: string): Record<string, unknown> {
  return {
    run: { name, goal: 'A goal', vcs: null },
    tasks: [{ id: 'T1', title: 'Task T1', role: 'developer', status: 'done', dependsOn: [] }],
  }
}

// The run-index IPC is switchable so the surface can be driven through failure
// and back — the recovery leg is the point.
let indexFails = false
let indexCalls = 0

const api: Record<string, unknown> = {
  platform: 'darwin',
  listSprintRuns: async () => {
    indexCalls += 1
    if (indexFails) throw new Error('EACCES: permission denied, scandir /work/multicode/.multi-code')
    return runs
  },
  onSprintRunsChanged: () => () => {},
  // The shared backlog scan watches each project's `backlog/`; the preload
  // contract hands back the watcher's disposer, so the stub must too.
  watchPath: async () => async () => {},
  readSprintEngineProjection: async (target: string) =>
    target === orphanStatePath
      ? { ok: true, data: projectionFor('old-run'), token: 'token-1' }
      : { ok: false, message: 'This run’s projection could not be read.' },
  // Each project's Backlog display key, as the door reads it from disk.
  readfile: async (path: string) => {
    if (path.startsWith(multicode)) return JSON.stringify({ key: 'MC' })
    if (path.startsWith(multiauth)) return JSON.stringify({ key: 'MA' })
    if (path.startsWith(mobile)) return JSON.stringify({ key: 'MM' })
    throw new Error('no config')
  },
}

anyGlobal.window.api = new Proxy(api, {
  get: (target, prop: string) =>
    prop in target
      ? target[prop]
      : prop.startsWith('on')
        ? () => () => {}
        : async () => ({ ok: false, message: 'not stubbed' }),
})

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  const { getRendererHost } = await import('../../../modules')
  const { default: SprintsGlobalSurface } = await import('./sprints/SprintsGlobalSurface')
  const { default: BacklogGlobalSurface } = await import('./backlog/BacklogGlobalSurface')
  const { ConfirmDialogProvider } = await import('../../ui/ConfirmDialog')
  const { createBacklogItem } = await import('../../../utils/backlog')
  const { normalizeSprintEngineProjection } = await import('../../../../../shared/sprintengine/state')
  const {
    __setBacklogScanRunnerForTests: setScanRunner,
    __resetBacklogScanSubscriptionsForTests: resetScans,
  } = await import('../../../hooks/useSharedBacklogScan')

  async function settle(times = 8): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await act(async () => {
        await Promise.resolve()
      })
    }
  }

  // Where a door puts its project filter (MC-1816). Read off the rendered DOM as
  // relationships — which control it is, what it is called, and what it comes
  // BEFORE — so the two doors can be compared without either one's markup
  // standing in for the other's.
  const FOLLOWING = 4 // Node.DOCUMENT_POSITION_FOLLOWING
  function projectFilterPlacement(searchAriaLabel: string, rowListSelector: string): unknown {
    const lens = container.querySelector('button[aria-label="Filter by project"]')
    assert.ok(lens, 'the door exposes a project filter named "Filter by project"')
    const search = container.querySelector(`input[aria-label="${searchAriaLabel}"]`)
    assert.ok(search, 'and a search field')
    const rows = container.querySelector(rowListSelector)
    assert.ok(rows, 'and a row list')
    return {
      control: lens.getAttribute('role'),
      // Collapsed behind a glyph, the lens would be a menu trigger, not a Select.
      collapsedBehindAGlyph: lens.getAttribute('aria-haspopup') === 'menu',
      leadsSearch: Boolean(lens.compareDocumentPosition(search) & FOLLOWING),
      leadsRows: Boolean(lens.compareDocumentPosition(rows) & FOLLOWING),
    }
  }

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)

  // ═══ 1. The six doors coexist on the real kernel ══════════════════════════
  // Registration is module-owned and eager, so this reads the SAME host the app
  // boots with — not a hand-built one. Sprints (item 1763) and Backlog (1769)
  // had to join a rail Automations/Roadmap/Reviews already occupied, at the
  // orders mockup §4's sidebar shows, without colliding with each other;
  // Extensions (MC-1847) took the retired hardcoded Connectors slot at 30.
  {
    const host = getRendererHost()
    const entries = host.getSidebarNavEntries()
    const doorOrder = entries.map((entry) => [entry.id, entry.order] as const)
    assert.deepEqual(
      doorOrder,
      [
        ['automations', 10],
        ['sprints', 20],
        ['backlog', 25],
        ['extensions', 30],
        ['roadmap', 40],
        ['reviews', 50],
      ],
      'every orchestration surface is a door, in the mockup’s sidebar order',
    )
    assert.equal(
      new Set(doorOrder.map(([id]) => id)).size,
      doorOrder.length,
      'no duplicate door id — a second Sprints entry would double-render the row',
    )
    for (const [id] of doorOrder) {
      assert.ok(host.getGlobalSurface(id), `the ${id} door has a surface behind it`)
    }
    // A door is only as present as its module: turning the module off must take
    // BOTH the row and the page, or the row routes to a page that cannot mount.
    const withoutSprintEngine = (moduleId: string): boolean => moduleId !== 'sprint-engine'
    assert.ok(
      !host.getSidebarNavEntries(withoutSprintEngine).some((entry) => entry.id === 'sprints'),
      'the Sprints row leaves with its module',
    )
    assert.ok(
      !host.getGlobalSurfaces(withoutSprintEngine).some((surface) => surface.id === 'sprints'),
      'and so does the Sprints surface',
    )
    console.log('ok - six doors, mockup order, each backed by a surface and gated by its module')
  }

  // ═══ 2. The Sprints door survives an unreadable index — and recovers ══════
  useWorkspaceStore.setState({
    workspaces: [
      { id: 'w-mc', name: 'multicode', mode: 'standard', folderPath: multicode, agents: {}, openFiles: [], createdAt: 1 },
      { id: 'w-ma', name: 'multiauth', mode: 'standard', folderPath: multiauth, agents: {}, openFiles: [], createdAt: 2 },
      { id: 'w-mm', name: 'mobile', mode: 'standard', folderPath: mobile, agents: {}, openFiles: [], createdAt: 3 },
      // The live run's own workspace: hidden from the Projects list since item
      // 1767, but still the execution residency the door reaches through.
      {
        id: 'w-run',
        name: 'live-run',
        mode: 'sprintengine',
        folderPath: multicode,
        agents: {},
        openFiles: [],
        createdAt: 4,
        sprintEngineContext: {
          statePath: residentStatePath,
          teamDir: `${multicode}/.multi-code/sprintengine/live-run`,
          teamSlug: 'live-run',
          rootPath: multicode,
        },
        // The resident workspace holds the run's state exactly as its own
        // projection supervisor left it — normalized through the same reader the
        // door uses for a run it opens from disk.
        sprintEngineState: normalizeSprintEngineProjection(projectionFor('live-run'), 'live-run'),
      },
    ],
    activeWorkspaceId: 'w-mc',
    activeGlobalSurface: 'sprints',
  } as never)

  indexFails = true
  const sprintsRoot = createRoot(container)
  const sprints = (): React.ReactElement =>
    React.createElement(ConfirmDialogProvider, null, React.createElement(SprintsGlobalSurface))
  await act(async () => {
    sprintsRoot.render(sprints())
  })
  await settle()

  assert.ok(
    container.textContent?.includes('Couldn’t load your sprints.'),
    'an unreadable index says so in plain words',
  )
  const indexRetry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Try again')
  assert.ok(indexRetry, 'and offers a way back, never a dead end')
  const indexDetail = container.querySelector('details')
  assert.equal(indexDetail?.open, false, 'the raw failure stays behind a collapsed disclosure')
  assert.ok(
    indexDetail?.textContent?.includes('EACCES'),
    'and it is the real cause, not a swallowed one',
  )
  assert.ok(
    !container.textContent?.includes('Run your first sprint'),
    'a failed read never masquerades as "you have no sprints"',
  )
  console.log('ok - an unreadable run index degrades with the reason and a retry')

  // The retry is real: with the index readable again the surface recovers in
  // place, without the door being closed and reopened.
  indexFails = false
  const callsBeforeRetry = indexCalls
  await act(async () => {
    ;(indexRetry as HTMLElement).click()
  })
  await settle()
  assert.ok(indexCalls > callsBeforeRetry, 'the retry re-reads the index')
  assert.ok(
    !container.textContent?.includes('Couldn’t load your sprints.'),
    'and the error clears rather than sticking',
  )
  // Rail rows group under Needs you / Active / Recent (MC-1838).
  const railRows = [...container.querySelectorAll('ul[role="list"][aria-label^="Sprints:"] > li')]
  assert.equal(railRows.length, 2, 'both runs list once the index reads')
  console.log('ok - retrying an unreadable index recovers the surface in place')

  // Held for the cross-door comparison in section 4: the two doors must place
  // their project filter identically, and only one of them is mounted at a time.
  const sprintsFilterPlacement = projectFilterPlacement(
    'Search sprints across every project',
    'ul[role="list"][aria-label^="Sprints:"]',
  )

  // ═══ 3. Resident vs workspace-deleted, on the same door ═══════════════════
  // The live run's workspace is open, so its workspace-only actions are live and
  // the canvas reads the workspace's own state rather than re-reading disk.
  const liveRow = [
    ...container.querySelectorAll('ul[role="list"][aria-label^="Sprints:"] > li button'),
  ].find((b) => b.textContent?.includes('live-run'))
  assert.ok(liveRow, 'the live run is in the rail')
  await act(async () => {
    ;(liveRow as HTMLElement).click()
  })
  await settle()

  const openAgentsLive = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Open agents',
  ) as HTMLButtonElement | undefined
  assert.ok(openAgentsLive, 'a resident run offers Open agents')
  assert.equal(openAgentsLive?.disabled, false, 'and it is live, because the workspace is still open')
  // Asserted only once the board is actually up — otherwise "the notice is
  // absent" would pass on a canvas that never rendered the board at all.
  assert.ok(container.querySelector('[role="tablist"]'), 'its board mounts from the door')
  assert.ok(
    !container.textContent?.includes('This sprint’s workspace was removed'),
    'a resident run never claims its workspace is gone',
  )
  console.log('ok - a run with a resident workspace opens from the door with its actions live')

  // The same door, the run whose workspace was deleted: it still opens — the
  // board mounts by run identity (item 1762) — and only the workspace-bound
  // action degrades, naming why.
  const orphanRow = [
    ...container.querySelectorAll('ul[role="list"][aria-label^="Sprints:"] > li button'),
  ].find((b) => b.textContent?.includes('old-run'))
  assert.ok(orphanRow, 'the historical run is in the rail')
  await act(async () => {
    ;(orphanRow as HTMLElement).click()
  })
  await settle()

  assert.ok(
    container.querySelector('[role="tablist"]'),
    'a workspace-deleted run still mounts its board',
  )
  const openAgentsOrphan = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Open agents',
  ) as HTMLButtonElement | undefined
  assert.equal(openAgentsOrphan?.disabled, true, 'but cannot open terminals it does not have')
  // The reason rides the accessible name, so it is not hover-only.
  assert.match(
    openAgentsOrphan?.getAttribute('aria-label') ?? '',
    /workspace is closed, so its agent terminals aren’t running/,
    'and names why in plain words rather than failing silently',
  )
  assert.ok(
    container.textContent?.includes('This sprint’s workspace was removed'),
    'the board itself degrades its workspace-only reads too',
  )
  assert.ok(
    !container.textContent?.includes('Couldn’t open this sprint.'),
    'a missing workspace is not an error — the run opens read-only-clean',
  )
  console.log('ok - a workspace-deleted run opens read-only-clean beside a resident one')

  await act(async () => {
    sprintsRoot.unmount()
  })

  // ═══ 4. The Backlog door: three projects, one page ════════════════════════
  function item(root: string, key: string, id: number, relativePath: string, status: string): BacklogItem {
    const built = createBacklogItem({
      path: `${root}/${relativePath}`,
      relativePath,
      sourceContent: `---\nstatus: ${status}\n---\n# ${relativePath}`,
      stats: { modifiedAtMs: 1, sizeBytes: 1 },
    })
    // The scan mints the display id from the project's own key (MC-/MA-/MM-),
    // which is exactly what must not collide across projects on one page.
    return { ...built, numericId: id, displayId: `${key}-${id}` }
  }

  // One epic with a member, so the door's DETAIL pane can be proven to render
  // the workspace panel's epic linkage (MC-1836): the child's parent crumb and
  // the epic's children roll-up.
  const doorEpic: BacklogItem = {
    ...createBacklogItem({
      path: `${multicode}/backlog/epics/door-quality.md`,
      relativePath: 'backlog/epics/door-quality.md',
      sourceContent: '---\ntype: epic\nstatus: in_progress\n---\n# Door quality epic',
      stats: { modifiedAtMs: 1, sizeBytes: 1 },
    }),
    numericId: 1832,
    displayId: 'MC-1832',
  }
  const doorEpicChild: BacklogItem = {
    ...createBacklogItem({
      path: `${multicode}/backlog/lockin.md`,
      relativePath: 'backlog/lockin.md',
      sourceContent: '---\nstatus: ready\nepic: door-quality\n---\n# Door lock-in child item',
      stats: { modifiedAtMs: 1, sizeBytes: 1 },
    }),
    numericId: 1833,
    displayId: 'MC-1833',
  }

  const backlogByRoot = new Map<string, BacklogItem[]>([
    [multicode, [item(multicode, 'MC', 1758, 'backlog/wake-filter.md', 'in_progress'), item(multicode, 'MC', 1745, 'backlog/minimap.md', 'ready'), doorEpic, doorEpicChild]],
    [multiauth, [item(multiauth, 'MA', 112, 'backlog/token-refresh.md', 'needs_input')]],
    [mobile, [item(mobile, 'MM', 87, 'backlog/catch-up-brief.md', 'ready')]],
  ])

  // multiauth's folder is unreadable; the other two scan normally. A per-project
  // failure must cost that project's rows and nothing else.
  setScanRunner(async (folderPath: string): Promise<BacklogScanResult> => {
    if (folderPath === multiauth) {
      return { state: 'error', items: [], errors: [{ relativePath: 'backlog', message: 'EACCES: permission denied' }] }
    }
    return { state: 'ready', items: backlogByRoot.get(folderPath) ?? [], errors: [] }
  })

  useWorkspaceStore.setState({ activeGlobalSurface: 'backlog' } as never)
  const backlogRoot = createRoot(container)
  await act(async () => {
    backlogRoot.render(
      React.createElement(ConfirmDialogProvider, null, React.createElement(BacklogGlobalSurface)),
    )
  })
  await settle(12)

  // The project filter is ONE compact control (MC-1837), not a chip per
  // project: options carry their counts, a failed project stays listed as
  // "unavailable" (unreadable must remain reachable), and a healthy project
  // with zero rows in the lens is omitted as noise.
  const filterTrigger = (): HTMLElement => {
    const trigger = container.querySelector('button[role="combobox"][aria-label="Filter by project"]')
    assert.ok(trigger, 'the project filter renders as one compact select')
    return trigger as HTMLElement
  }
  // The Select's listbox portals to document.body, so options are queried
  // document-wide, excluding the row list (whose rows are options too).
  const filterOptions = (): HTMLElement[] =>
    [...dom.window.document.querySelectorAll('[role="listbox"]:not([aria-label="Backlog items across projects"]) [role="option"]')] as HTMLElement[]
  const pickFilterOption = async (label: string): Promise<void> => {
    await act(async () => {
      filterTrigger().click()
    })
    const option = filterOptions().find(
      (candidate) => candidate.textContent?.startsWith(label),
    )
    assert.ok(option, `the filter lists ${label}`)
    await act(async () => {
      ;(option as HTMLElement).click()
    })
    await settle()
  }
  await act(async () => {
    filterTrigger().click()
  })
  assert.deepEqual(
    filterOptions().map((option) => option.textContent),
    // Path-sorted, not workspace-order: the aggregate derives its roots as
    // sorted descriptors so the option order is stable across sessions.
    ['All projects · 5', 'multiauth · unavailable', 'multicode · 4', 'multicode-mobile · 1'],
    'All projects with the total, then one counted option per project with rows (mockup §4 toolbar)',
  )
  await act(async () => {
    filterTrigger().click()
  })
  await settle()

  // ── One project-filter placement across both doors (MC-1816) ──────────────
  // The two doors used to disagree: Backlog led its toolbar with the project
  // Select while Sprints tucked the same lens behind the rail's filter glyph.
  // Compared as relationships, not markup, so this holds whichever door moves.
  assert.deepEqual(
    projectFilterPlacement(
      'Search every project’s backlog',
      'ul[role="listbox"][aria-label="Backlog items across projects"]',
    ),
    sprintsFilterPlacement,
    'both doors expose the project filter as the same control, in the same place',
  )
  assert.deepEqual(
    sprintsFilterPlacement,
    { control: 'combobox', collapsedBehindAGlyph: false, leadsSearch: true, leadsRows: true },
    'and that place is leading the door’s controls, never behind a filter glyph',
  )
  console.log('ok - the Backlog and Sprints doors place their project filter identically')

  const rowText = (): string[] =>
    [...container.querySelectorAll('ul[role="listbox"][aria-label="Backlog items across projects"] > li')].map(
      (row) => row.textContent ?? '',
    )

  const allRows = rowText()
  assert.ok(allRows.some((text) => text.includes('MC-1758')), 'multicode’s items list')
  assert.ok(allRows.some((text) => text.includes('MM-87')), 'so do the mobile project’s')
  assert.ok(
    allRows.every((text) => !text.includes('MA-112')),
    'the unreadable project contributes no rows',
  )
  // Rows from different projects share one page, so each says which backlog it
  // came from — the ids alone are not a promise (two projects can share a key).
  assert.ok(allRows.some((text) => text.includes('multicode-mobile')), 'rows carry their project tag')
  console.log('ok - the Backlog door lists every project’s items with their own keys and tags')

  // A failed project names itself and offers a retry, while the rest of the page
  // stays a working backlog — never an all-or-nothing blank.
  assert.ok(
    container.textContent?.includes('Couldn’t read multiauth’s backlog.'),
    'the failing project is named',
  )
  const backlogRetry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Try again')
  assert.ok(backlogRetry, 'and offers Try again')
  assert.equal(rowText().length, 5, 'the other two projects contribute all of their rows')
  // Still a working backlog, not a frozen one: every surviving row is a
  // selectable option, so the failure cost rows and nothing else.
  assert.equal(
    container.querySelectorAll(
      'ul[role="listbox"][aria-label="Backlog items across projects"] > li[role="option"]',
    ).length,
    5,
    'and they stay interactive',
  )
  console.log('ok - one project’s scan failing costs only that project’s rows')

  // Filtering to one project is exactly that project's list — the door narrowed
  // to a single project must not show more, less, or a different order than the
  // project's own panel would.
  await pickFilterOption('multicode-mobile')
  const filtered = rowText()
  assert.equal(filtered.length, 1, 'only the filtered project’s items remain')
  assert.ok(filtered[0]?.includes('MM-87'), 'and they are that project’s')
  assert.ok(
    filtered.every((text) => !/\b(MC|MA)-\d+/.test(text)),
    'a single-project view carries no other project’s ids',
  )
  // Narrowed to one project, the page IS that project's backlog — so the tag
  // that only exists to disambiguate an aggregate drops away.
  assert.ok(
    filtered.every((text) => !text.includes('multicode-mobile')),
    'and drops the project tag it no longer needs',
  )
  console.log('ok - filtering to one project reproduces that project’s list')

  // The door's detail pane is the WORKSPACE panel's BacklogDetail (MC-1836):
  // opening an epic shows the navigable children roll-up, opening a child shows
  // the parent-epic crumb — the two sections the old door fork dropped.
  await pickFilterOption('All projects')
  const rowFor = (needle: string): HTMLElement => {
    const row = [...container.querySelectorAll('ul[role="listbox"][aria-label="Backlog items across projects"] > li')]
      .find((candidate) => candidate.textContent?.includes(needle))
    assert.ok(row, `a list row for ${needle}`)
    return row as HTMLElement
  }
  await act(async () => {
    rowFor('Door quality epic').click()
  })
  await settle()
  assert.ok(
    container.textContent?.includes('0 of 1 done'),
    'the epic detail rolls up its children with the panel’s done fraction',
  )
  const childRollupRow = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.title === 'backlog/lockin.md',
  )
  assert.ok(childRollupRow, 'the epic’s member renders as a navigable roll-up row')
  await act(async () => {
    ;(childRollupRow as HTMLElement).click()
  })
  await settle()
  const crumb = container.querySelector('button[aria-label="Open epic Door quality epic"]')
  assert.ok(crumb, 'navigating to the child shows the parent-epic crumb (fork never had one)')
  await act(async () => {
    ;(crumb as HTMLElement).click()
  })
  await settle()
  assert.ok(
    container.textContent?.includes('0 of 1 done'),
    'the crumb navigates back up to the epic detail',
  )
  console.log('ok - the door detail is the workspace BacklogDetail: crumb and children link both ways')

  await act(async () => {
    backlogRoot.unmount()
  })

  // ═══ 5. The Reviews door MOUNTS ═══════════════════════════════════════════
  // Regression for MC-1834: the guide-terminal hook selected workspaces by
  // mapping to fresh objects inside useShallow, so every render produced a new
  // snapshot — an infinite re-render loop ("Maximum update depth exceeded")
  // that tore down the renderer the moment the door opened. Mounting against
  // the real store with several workspaces resident is the exact trigger; the
  // unstubbed review IPC resolving `{ ok: false }` is fine — a degraded pane
  // is a pass, a render loop is the failure.
  const { default: ReviewsGlobalSurface } = await import('./reviews/ReviewsGlobalSurface')
  useWorkspaceStore.setState({ activeGlobalSurface: 'reviews' } as never)
  const reviewsRoot = createRoot(container)
  await act(async () => {
    reviewsRoot.render(
      React.createElement(ConfirmDialogProvider, null, React.createElement(ReviewsGlobalSurface)),
    )
  })
  await settle()
  assert.ok(
    (container.textContent ?? '').length > 0,
    'the Reviews door mounts and renders content instead of crashing the tree',
  )
  await act(async () => {
    reviewsRoot.unmount()
  })
  console.log('ok - the Reviews door mounts without a re-render storm')

  // ═══ 6. A door failure is contained to the door (MC-1835) ═════════════════
  // A surface that throws during render must land in the boundary's fallback —
  // with both recoveries working — instead of white-screening the renderer.
  const { GlobalSurfaceErrorBoundary } = await import('./surfaceSubstrate')
  let closed = 0
  let bombArmed = true
  function BombSurface(): React.ReactElement {
    if (bombArmed) throw new Error('deliberate door failure')
    return React.createElement('div', null, 'door content restored')
  }
  const boundaryRoot = createRoot(container)
  await act(async () => {
    boundaryRoot.render(
      React.createElement(
        GlobalSurfaceErrorBoundary,
        {
          surfaceId: 'reviews',
          surfaceLabel: 'Reviews',
          onClose: () => {
            closed += 1
          },
        },
        React.createElement(BombSurface),
      ),
    )
  })
  assert.ok(
    container.textContent?.includes('Reviews hit a problem and stopped.'),
    'the fallback names the failed surface',
  )
  const fallbackButtons = Array.from(container.querySelectorAll('button'))
  const closeButton = fallbackButtons.find((b) => b.textContent === 'Close')
  const reloadButton = fallbackButtons.find((b) => b.textContent === 'Reload surface')
  assert.ok(closeButton && reloadButton, 'the fallback offers Close and Reload surface')
  await act(async () => {
    ;(closeButton as HTMLElement).click()
  })
  assert.equal(closed, 1, 'Close hands off to closeGlobalSurface')
  bombArmed = false
  await act(async () => {
    ;(reloadButton as HTMLElement).click()
  })
  assert.ok(
    container.textContent?.includes('door content restored'),
    'Reload surface remounts the children once the failure is gone',
  )
  await act(async () => {
    boundaryRoot.unmount()
  })
  console.log('ok - a door failure is contained: named fallback, Close and Reload both work')

  // ═══ 7. The Extensions door (MC-1847) ═════════════════════════════════════
  // The catalog rail over the shared connector canvases: rail groups and
  // honest counts, the facet ↔ rail-row projection, the deep-link latch, and
  // the one-source-down degradation (a failed marketplace must never read as
  // an empty one).
  {
    const { default: ExtensionsGlobalSurface } = await import('./extensions/ExtensionsGlobalSurface')
    const { dispatchExtensionsSurfaceTarget, consumePendingExtensionsSurfaceTarget } = await import(
      './extensions/extensionsSurfaceTarget'
    )

    // Latch semantics are load-bearing for every deep-link entry point:
    // the latest dispatch wins, and the latch drains exactly once.
    dispatchExtensionsSurfaceTarget('browse')
    dispatchExtensionsSurfaceTarget('installed')
    assert.equal(consumePendingExtensionsSurfaceTarget(), 'installed', 'latest dispatch wins')
    assert.equal(consumePendingExtensionsSurfaceTarget(), null, 'the latch drains once')

    api.mcpListCatalog = async () => ({
      ok: true,
      servers: [
        {
          id: 'railway',
          name: 'Railway',
          category: 'Deployments',
          description: 'Deploys, services, logs',
          transport: 'http',
          clients: [],
          required: false,
          riskLevel: 'low',
          skill: 'use-railway',
        },
      ],
    })
    api.readMarketplaceRegistry = async () => ({
      ok: true,
      registryUrl: null,
      marketplace: {
        plugins: [
          {
            id: 'stripe-mcp',
            name: 'Stripe',
            publisher: { name: 'Stripe', verified: true },
            summary: 'Payments, billing, customers',
            category: 'Payments',
            icon: 'stripe.svg',
            latest: 1,
            provides: ['mcp', 'skills'],
          },
          {
            id: 'roadmap-module',
            name: 'Roadmap',
            publisher: { name: 'Multicode', verified: true },
            summary: 'Plan multi-sprint arcs.',
            category: 'Planning',
            icon: 'roadmap.svg',
            latest: 1,
            provides: ['module'],
          },
          {
            id: 'cursor-cli',
            name: 'Cursor',
            publisher: { name: 'Cursor', verified: true },
            summary: 'Drive the Cursor agent.',
            category: 'Development',
            icon: 'cursor.svg',
            latest: 1,
            provides: ['cli'],
          },
        ],
      },
    })
    api.skillPackListCatalog = async () => ({
      ok: true,
      packs: [
        {
          id: 'release-runbook',
          slug: 'release-runbook',
          name: 'Release runbook',
          category: 'Operations',
          description: 'Cut, verify, and publish a release.',
          harnesses: [],
        },
      ],
    })
    // The Installed canvas's inventory sources. Modules resolves the real
    // list shape; the proxy's not-stubbed {ok:false} answers exercise the
    // remaining sources' error notices.
    api.listThirdPartyModules = async () => ({ modules: [], rejected: [] })
    api.builtinSkillsList = async () => []

    const extRoot = createRoot(container)
    await act(async () => {
      extRoot.render(React.createElement(ExtensionsGlobalSurface))
    })
    await settle()

    // The catalog rail: both groups, all seven rows, the dashed affordance.
    const railText = container.textContent ?? ''
    for (const label of [
      'Marketplace',
      'On this machine',
      'Featured',
      'MCP servers',
      'Skill packs',
      'Modules',
      'Agent CLIs',
      'Installed',
      'Automation server',
      'Add a custom MCP',
    ]) {
      assert.ok(railText.includes(label), `the rail carries "${label}"`)
    }
    // Honest counts, pinned to the element that claims them: 1 launchable
    // connector on the bar chip AND the Featured row; catalog(1) + mcp/skills
    // plugin(1) in the connector marketplace; each kind row carries its own
    // real count (a zeroed count on one row can't hide behind another's).
    const railRow = (label: string): string => {
      const row = Array.from(container.querySelectorAll('button')).find((button) =>
        (button.textContent ?? '').includes(label),
      )
      assert.ok(row, `the ${label} rail row renders`)
      return row.textContent ?? ''
    }
    const barText = container.querySelector('section > div')?.textContent ?? ''
    assert.ok(barText.includes('1 ready to launch'), 'the bar chip counts launchables')
    assert.ok(barText.includes('2 in marketplace'), 'the bar counts the connector marketplace')
    assert.ok(railRow('Featured').includes('1 ready to launch'), 'the Featured row counts launchables')
    assert.ok(railRow('MCP servers').includes('2 available'), 'the MCP servers row counts the grid')
    assert.ok(railRow('Skill packs').includes('1 available'), 'the Skill packs row counts its catalog')
    assert.ok(railRow('Modules').includes('1 available'), 'the Modules row counts module plugins')
    assert.ok(railRow('Agent CLIs').includes('1 available'), 'the Agent CLIs row counts cli plugins')
    // The door lands on Featured; the Ready-to-launch rail leads the canvas.
    const currentRow = () =>
      Array.from(container.querySelectorAll('button[aria-current="true"]')).map((b) => b.textContent ?? '').join(' ')
    assert.ok(currentRow().includes('Featured'), 'a plain open lands on Featured')
    assert.ok(railText.includes('Ready to launch'), 'the launchable rail renders')
    assert.ok(railText.includes('Railway'), 'the launchable connector renders')

    // Facet ↔ rail projection: picking the All facet moves the rail highlight
    // to MCP servers — the two can never contradict each other.
    const allTab = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (tab) => tab.textContent?.trim().startsWith('All'),
    )
    assert.ok(allTab, 'the facet tabs render inside the door')
    await act(async () => {
      ;(allTab as HTMLElement).click()
    })
    assert.ok(currentRow().includes('MCP servers'), 'the All facet projects onto the MCP servers row')

    // A live deep-link lands on Installed (the agent "Manage skills" route).
    await act(async () => {
      dispatchExtensionsSurfaceTarget('installed')
    })
    await settle()
    assert.ok(currentRow().includes('Installed'), 'a live installed deep-link selects the Installed row')
    assert.ok(
      (container.textContent ?? '').includes('Get more skill packs'),
      'the Installed canvas is the manage view',
    )

    await act(async () => {
      extRoot.unmount()
    })

    // One source down: the marketplace registry fails, the catalog stays up.
    // The browse canvas discloses the failure and the kind rows say
    // unavailable — never a silent zero.
    api.readMarketplaceRegistry = async () => ({ ok: false, message: 'registry down.' })
    const degradedRoot = createRoot(container)
    await act(async () => {
      degradedRoot.render(React.createElement(ExtensionsGlobalSurface))
    })
    await settle()
    const degradedText = container.textContent ?? ''
    assert.ok(
      degradedText.includes('Marketplace connectors are unavailable'),
      'the one-source-down notice names the failed source',
    )
    assert.ok(degradedText.includes('Marketplace unavailable'), 'kind rows read unavailable, not 0')
    assert.ok(degradedText.includes('Railway'), 'the healthy catalog still renders its connectors')
    await act(async () => {
      degradedRoot.unmount()
    })

    console.log('ok - the Extensions door: catalog rail, facet projection, deep-links, degradation')
  }

  // Drop the shared scans (and their watchers) so this process can exit.
  resetScans()
  console.log('all global-door integration checks passed')
}

main().catch((error) => {
  console.error('not ok - global doors integration')
  console.error(error)
  process.exit(1)
})
