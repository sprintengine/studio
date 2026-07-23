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

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)

  // ═══ 1. The five doors coexist on the real kernel ═════════════════════════
  // Registration is module-owned and eager, so this reads the SAME host the app
  // boots with — not a hand-built one. Sprints (item 1763) and Backlog (1769)
  // had to join a rail Automations/Roadmap/Reviews already occupied, at the
  // orders mockup §4's sidebar shows, without colliding with each other.
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
    console.log('ok - five doors, mockup order, each backed by a surface and gated by its module')
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
  const railRows = [...container.querySelectorAll('ul[role="list"][aria-label="Sprints"] > li')]
  assert.equal(railRows.length, 2, 'both runs list once the index reads')
  console.log('ok - retrying an unreadable index recovers the surface in place')

  // ═══ 3. Resident vs workspace-deleted, on the same door ═══════════════════
  // The live run's workspace is open, so its workspace-only actions are live and
  // the canvas reads the workspace's own state rather than re-reading disk.
  const liveRow = [
    ...container.querySelectorAll('ul[role="list"][aria-label="Sprints"] > li button'),
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
    ...container.querySelectorAll('ul[role="list"][aria-label="Sprints"] > li button'),
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

  const backlogByRoot = new Map<string, BacklogItem[]>([
    [multicode, [item(multicode, 'MC', 1758, 'backlog/wake-filter.md', 'in_progress'), item(multicode, 'MC', 1745, 'backlog/minimap.md', 'ready')]],
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

  const chips = [...container.querySelectorAll('div[role="group"][aria-label="Filter by project"] button')]
  assert.deepEqual(
    chips.map((chip) => chip.querySelector('span')?.textContent),
    // Path-sorted, not workspace-order: the aggregate derives its roots as
    // sorted descriptors so the chip strip is stable across sessions.
    ['All projects', 'multiauth', 'multicode', 'multicode-mobile'],
    'All projects, then one chip per open project (mockup §4 toolbar)',
  )

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
  assert.equal(rowText().length, 3, 'the other two projects contribute all of their rows')
  // Still a working backlog, not a frozen one: every surviving row is a
  // selectable option, so the failure cost rows and nothing else.
  assert.equal(
    container.querySelectorAll(
      'ul[role="listbox"][aria-label="Backlog items across projects"] > li[role="option"]',
    ).length,
    3,
    'and they stay interactive',
  )
  console.log('ok - one project’s scan failing costs only that project’s rows')

  // Filtering to one project is exactly that project's list — the door narrowed
  // to a single project must not show more, less, or a different order than the
  // project's own panel would.
  const mobileChip = chips.find((chip) => chip.querySelector('span')?.textContent === 'multicode-mobile')
  await act(async () => {
    ;(mobileChip as HTMLElement).click()
  })
  await settle()
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

  // Drop the shared scans (and their watchers) so this process can exit.
  resetScans()
  console.log('all global-door integration checks passed')
}

main().catch((error) => {
  console.error('not ok - global doors integration')
  console.error(error)
  process.exit(1)
})
