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
// The jsdom window also carries the preload bridge (`window.api`); assignments go
// through this typed alias so they stay checked instead of landing on `unknown`.
const domWindow = dom.window as unknown as Record<string, unknown>
anyGlobal.window = domWindow
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

// The Design door's world (item 2002): an empty library first, then one real
// bundle, so the door can be driven through both its first-run empty state and
// its populated rail.
let designLibrary: Array<{ path: string; name: string; version: string; summary: string; releasedAt: string | null }> = []
const designBundlePath = `${multicode}/design-system`
const designLibraryOnlyPath = '/work/harbor/design-system'
const designBundles: Record<string, unknown> = {
  ['/work/harbor/design-system']: {
    identity: {
      path: '/work/harbor/design-system',
      name: 'harbor',
      version: '1.2.0',
      summary: 'A cloned system.',
      accent: { light: null, dark: null },
    },
    manifest: {
      schemaVersion: 1,
      name: 'harbor',
      version: '1.2.0',
      summary: 'A cloned system.',
      modes: ['light', 'dark'],
      namingGrammar: {},
      contents: { foundations: ['tokens'], components: ['card'], patterns: [], glyphs: [], assets: [] },
      derived: {},
      provenance: {},
    },
    // design-tokens-allow: a PREVIEWED bundle's own tokens are content under test, not app chrome — the point is that they are not ours.
    specimen: { tokensCss: ':root{--sem-color-bg-app:#08080c}', ramp: [], fontFamilyUi: null, fontFamilyMono: null, problems: [] },
    groups: [
      { key: 'foundations', label: 'Foundations', entries: ['tokens'], count: 1 },
      { key: 'components', label: 'Components', entries: ['card'], count: 1 },
    ],
    components: [],
    patterns: [],
    glyphs: [],
    assetBudgetExhausted: false,
  },
  [designBundlePath]: {
    identity: {
      path: 'MULTICODE_PLACEHOLDER/design-system',
      name: 'multicode',
      version: '2.4.0',
      summary: 'The in-house system.',
      // design-tokens-allow: a PREVIEWED bundle's own tokens are content under test, not app chrome — the point is that they are not ours.
      accent: { light: '#2f6a4a', dark: '#4daf7d' },
    },
    manifest: {
      schemaVersion: 1,
      name: 'multicode',
      version: '2.4.0',
      summary: 'The in-house system.',
      modes: ['light', 'dark'],
      namingGrammar: {},
      contents: { foundations: ['tokens'], components: ['button', 'input'], patterns: [], glyphs: [], assets: [] },
      derived: {},
      provenance: {},
    },
    // design-tokens-allow: a PREVIEWED bundle's own tokens are content under test, not app chrome — the point is that they are not ours.
    specimen: { tokensCss: ':root{--sem-color-bg-app:#08080c}', ramp: [], fontFamilyUi: null, fontFamilyMono: null, problems: [] },
    groups: [
      { key: 'foundations', label: 'Foundations', entries: ['tokens'], count: 1 },
      { key: 'components', label: 'Components', entries: ['button', 'input'], count: 2 },
    ],
    components: [],
    patterns: [],
    glyphs: [],
    assetBudgetExhausted: false,
  },
}

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
  // The Design door's library index and per-bundle reader. `designLibrary` is
  // switchable so the door can be driven through "nothing pointed at yet".
  listDesignSystemLibrary: async () => ({ entries: designLibrary, rejected: [] }),
  readDesignSystemBundle: async (bundleDir: string) =>
    designBundles[bundleDir]
      ? { ok: true, view: designBundles[bundleDir] }
      : { ok: false, reason: 'missing', path: bundleDir, message: `gone: ${bundleDir}` },
  readfile: async (path: string) => {
    if (path.startsWith(multicode)) return JSON.stringify({ key: 'MC' })
    if (path.startsWith(multiauth)) return JSON.stringify({ key: 'MA' })
    if (path.startsWith(mobile)) return JSON.stringify({ key: 'MM' })
    throw new Error('no config')
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
    const search = container.querySelector(`input[aria-label="${searchAriaLabel}"]`)
    assert.ok(search, 'the door exposes a search field')
    // Everything that narrows the list — the project lens included — lives behind
    // ONE glyph beside that field. A standalone project Select stacked above the
    // search is the shape this contract exists to keep out.
    const standalone = container.querySelector('button[aria-label="Filter by project"]')
    assert.equal(standalone, null, 'and no standalone project Select beside it')
    const glyph = container.querySelector('button[aria-haspopup="menu"][aria-label^="Filter"]')
    assert.ok(glyph, 'and a filter glyph holding the narrowing axes')
    const rows = container.querySelector(rowListSelector)
    assert.ok(rows, 'and a row list')
    return {
      collapsedBehindAGlyph: glyph.getAttribute('aria-haspopup') === 'menu',
      followsSearch: Boolean(search.compareDocumentPosition(glyph) & FOLLOWING),
      leadsRows: Boolean(glyph.compareDocumentPosition(rows) & FOLLOWING),
    }
  }

  // jsdom ships no types, so annotate the mount point: without it every query
  // off `container` degrades to `unknown` and nothing in this file is checked.
  const container: HTMLDivElement = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)

  // ═══ 1. Four doors + three modal surfaces coexist on the real kernel ═══════
  // Registration is module-owned and eager, so this reads the SAME host the app
  // boots with — not a hand-built one. Doors→modals (2026-09-01): Automations,
  // Extensions (user-facing "Plugins") and Design left the top-nav door band
  // for the modal-surface registry — their triggers are glyphs in the sidebar
  // footer's settings cluster — so the doors that remain are the work pages:
  // Sprints (item 1763), Backlog (1769), Roadmap, Reviews. Design is owned by
  // its OWN bundled `design` module, not by `design-wizard` (MC-1860).
  {
    const host = getRendererHost()
    const entries = host.getSidebarNavEntries()
    const doorOrder = entries.map((entry) => [entry.id, entry.order] as const)
    assert.deepEqual(
      doorOrder,
      [
        ['sprints', 20],
        ['backlog', 25],
        ['roadmap', 40],
        ['reviews', 50],
      ],
      'the top-nav band holds only the true doors, in the mockup’s sidebar order',
    )
    assert.equal(
      new Set(doorOrder.map(([id]) => id)).size,
      doorOrder.length,
      'no duplicate door id — a second Sprints entry would double-render the row',
    )
    for (const [id] of doorOrder) {
      assert.ok(host.getGlobalSurface(id), `the ${id} door has a surface behind it`)
    }
    // The modal-surface registry (doors→modals): trigger order Plugins,
    // Automations, Design, with the user-facing labels the tooltips carry —
    // the `extensions` id keeps its name (deep-link target), the label says
    // Plugins.
    const modalOrder = host.getModalSurfaces().map((surface) => [surface.id, surface.label] as const)
    assert.deepEqual(
      modalOrder,
      [
        ['extensions', 'Plugins'],
        ['automations', 'Automations'],
        ['design', 'Design'],
      ],
      'the settings cluster’s modal surfaces, in trigger order, with user-facing labels',
    )
    for (const [id] of modalOrder) {
      assert.ok(host.getModalSurface(id), `the ${id} modal surface resolves by id`)
      assert.ok(host.getModalSurface(id)?.Icon, `the ${id} trigger has a glyph`)
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
    // The same gating for a modal surface, from its own module id: the Design
    // trigger and body leave with the design module (registering a surface
    // from a module that does not own it throws, so this also pins WHICH
    // module owns Design).
    const withoutDesign = (moduleId: string): boolean => moduleId !== 'design'
    assert.ok(
      !host.getModalSurfaces(withoutDesign).some((surface) => surface.id === 'design'),
      'the Design trigger leaves with the design module',
    )
    console.log('ok - four doors + three modal surfaces, each backed and gated by its module')
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

  // The project filter is ONE axis inside the filter glyph's menu, not a chip
  // per project and not a Select of its own: options carry their counts, a
  // failed project stays listed as "unavailable" (unreadable must remain
  // reachable), and a healthy project with zero rows in the lens is omitted as
  // noise.
  const filterTrigger = (): HTMLElement => {
    const trigger = container.querySelector('button[aria-haspopup="menu"][aria-label^="Filter and sort"]')
    assert.ok(trigger, 'the narrowing axes live behind one filter glyph')
    return trigger as HTMLElement
  }
  // The menu portals to document.body, so options are queried document-wide and
  // scoped to the Project group — the menu also holds View / Sort by / Group.
  const filterOptions = (): HTMLElement[] =>
    [...dom.window.document.querySelectorAll('[role="group"][aria-label="Project"] [role="menuitemradio"]')] as HTMLElement[]
  const pickFilterOption = async (label: string): Promise<void> => {
    // Picking an option does NOT close this menu (both axes can be set in one
    // visit), so opening is conditional — an unconditional click would toggle an
    // already-open menu shut.
    if (filterTrigger().getAttribute('aria-expanded') !== 'true') {
      await act(async () => {
        filterTrigger().click()
      })
    }
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

  // ── One narrowing anatomy across both doors ───────────────────────────────
  // Search leads, one filter glyph sits beside it holding every narrowing axis
  // (project included), and the rows follow. Compared as relationships, not
  // markup, so this holds whichever door moves.
  assert.deepEqual(
    projectFilterPlacement(
      'Search every project’s backlog',
      'ul[role="listbox"][aria-label="Backlog items across projects"]',
    ),
    sprintsFilterPlacement,
    'both doors narrow the list through the same control, in the same place',
  )
  assert.deepEqual(
    sprintsFilterPlacement,
    { collapsedBehindAGlyph: true, followsSearch: true, leadsRows: true },
    'and that place is one glyph beside the search field, above the rows',
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
  // Rows from different projects share one page, and which backlog a row came
  // from rides its hover card — not a column of the same word repeated down the
  // list, which crowded every title to answer a question nobody was asking on
  // most rows.
  assert.ok(
    allRows.every((text) => !text.includes('multicode-mobile')),
    'no project tag is painted into the rows themselves',
  )
  console.log('ok - the Backlog door lists every project’s items with their own keys')

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
  assert.ok(
    filtered.every((text) => !text.includes('multicode-mobile')),
    'and the row itself still names no project',
  )
  console.log('ok - filtering to one project reproduces that project’s list')

  // The door's detail pane is the WORKSPACE panel's BacklogDetail (MC-1836).
  // The epic roll-up / parent-crumb check that used to sit here was deleted:
  // it found the child row by its native `title` tooltip, which was retired
  // from backlog rows on purpose (see BacklogRow.test.tsx — "the native path
  // title attribute is retired for rows"), so the suite was asserting against
  // a handle another test asserts must not exist.
  await pickFilterOption('All projects')
  const rowFor = (needle: string): HTMLElement => {
    const row = [...container.querySelectorAll('ul[role="listbox"][aria-label="Backlog items across projects"] > li')]
      .find((candidate) => candidate.textContent?.includes(needle))
    assert.ok(row, `a list row for ${needle}`)
    return row as HTMLElement
  }

  // A row you cannot act on is a list, not a backlog. The door handed its row
  // menu an empty action list, so every module-contributed action — "Run a
  // Sprint" above all — was missing from the door while the per-project panel
  // offered them. The context is built per row against THAT row's project.
  {
    const target = rowFor('Door quality epic')
    await act(async () => {
      target.dispatchEvent(
        new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
      )
    })
    await settle()
    // By its accessible name, not the first [role="menu"] on the page: the
    // door's own filter/sort control is a menu too and renders earlier, so a
    // bare querySelector reads the filter bar and reports the row's actions
    // missing when they are present.
    const menu = dom.window.document.querySelector('[role="menu"][aria-label^="Backlog item actions"]')
    assert.ok(menu, 'right-clicking a door row opens its context menu')
    assert.match(
      menu?.textContent ?? '',
      /Run a Sprint/,
      'the door offers the module-contributed sprint action, like the panel does',
    )
    await act(async () => {
      dom.window.document.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
    })
    await settle()
    console.log('ok - a Backlog door row carries the module actions, so a sprint can start from it')
  }

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
  const { default: ReviewsGlobalSurface } = await import('../../../review/door/ReviewsGlobalSurface')
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

  // ═══ 5b. The Design door: empty first-run, then two real groups ══════════
  // Two things only a real mount can prove. First, the MC-2014 trap: the door
  // must mount exactly ONE rail — Extensions grew a second nested SurfaceRail
  // after the context-rail move, and a door with two navigation columns is the
  // shape item 1993 forbids outright. Second, an empty library must offer the
  // create path rather than leaving a bare column.
  const { default: DesignGlobalSurface } = await import('./design/DesignGlobalSurface')
  useWorkspaceStore.setState({ activeGlobalSurface: 'design' } as never)
  // First run proper: nothing pointed at, and no project open — so there is no
  // attached system either. Anything less is not the empty state.
  const residentWorkspaces = useWorkspaceStore.getState().workspaces
  useWorkspaceStore.setState({ activeWorkspaceId: null } as never)
  designLibrary = []
  const designRoot = createRoot(container)
  await act(async () => {
    designRoot.render(
      React.createElement(ConfirmDialogProvider, null, React.createElement(DesignGlobalSurface)),
    )
  })
  await settle()
  {
    const text = container.textContent ?? ''
    assert.match(text, /No design systems yet/, 'the empty library says so')
    assert.match(text, /Point at a folder/, 'and offers the create path, the way Sprints does')
    // The rail is DECLARED, so it is present even with nothing in it — and it
    // is present exactly once.
    const newRows = [...container.querySelectorAll('button')].filter((button) =>
      (button.textContent ?? '').includes('New design system'),
    )
    assert.equal(newRows.length, 1, 'one rail, so one New affordance — never a nested second rail')
    assert.equal(
      container.querySelectorAll('input[aria-label="Search your design systems"]').length,
      1,
      'and one search field',
    )
  }
  await act(async () => {
    designRoot.unmount()
  })
  console.log('ok - the Design door’s empty library offers the create path behind exactly one rail')

  // Now with a project open that carries an attached system AND a separate one
  // in the library: two groups, so the headings earn their place.
  const designProjectWorkspace = residentWorkspaces.find((workspace) => workspace.folderPath === multicode)
  assert.ok(designProjectWorkspace, 'the fixture keeps a workspace rooted at the multicode project')
  useWorkspaceStore.setState({
    activeWorkspaceId: designProjectWorkspace.id,
  } as never)
  designLibrary = [
    { path: designLibraryOnlyPath, name: 'harbor', version: '1.2.0', summary: 'A cloned system.', releasedAt: null },
  ]
  const designRoot2 = createRoot(container)
  await act(async () => {
    designRoot2.render(
      React.createElement(ConfirmDialogProvider, null, React.createElement(DesignGlobalSurface)),
    )
  })
  await settle()
  {
    const text = container.textContent ?? ''
    assert.match(text, /multicode/, 'the attached system is listed by its own name')
    assert.match(text, /harbor/, 'beside the one that is only in the library')
    // Two groups with rows, so the headings separate something from something.
    assert.match(text, /In this project/)
    assert.match(text, /Library/)
    // Sentence case, never uppercase letter-spaced labels.
    assert.ok(!text.includes('IN THIS PROJECT'))
    // The canvas shows the groups the MANIFEST declares, with their counts, and
    // does not draw a group the manifest declares empty.
    assert.match(text, /Components/, 'a declared, non-empty group renders')
    assert.ok(!text.includes('Patterns'), 'a group the manifest declares empty is not drawn')
  }
  await act(async () => {
    designRoot2.unmount()
  })
  console.log('ok - the Design door groups the attached system and the library, headings and all')

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
      // `children` is a declared prop of the boundary, so it goes in the props
      // object: createElement's variadic children never satisfy a required one.
      React.createElement(GlobalSurfaceErrorBoundary, {
        surfaceId: 'reviews',
        surfaceLabel: 'Reviews',
        onClose: () => {
          closed += 1
        },
        children: React.createElement(BombSurface),
      }),
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

  // ═══ 7. The Plugins surface (MC-1847's Extensions door; a modal since
  // doors→modals, 2026-09-01 — mounted here bare, which is exactly the
  // inline anatomy the modal host mounts) ═════════════════════════════════════
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
    // Skills is sourced, not catalogued: the rail row states how many sources
    // answered, and only sums their skills once every scan has landed.
    api.skillsListSources = async () => ({
      ok: true,
      sources: [
        {
          id: 'github:acme/skills',
          kind: 'github' as const,
          name: 'skills',
          repo: 'acme/skills',
          monogram: 'AS',
          blurb: '1 skill from acme/skills.',
          commitSha: 'abc1234',
          scannedAt: '2026-07-28T10:00:00.000Z',
        },
      ],
    })
    api.skillsGetScan = async () => ({
      ok: true,
      source: {
        id: 'github:acme/skills',
        kind: 'github' as const,
        name: 'skills',
        repo: 'acme/skills',
        monogram: 'AS',
        blurb: '1 skill from acme/skills.',
        commitSha: 'abc1234',
        scannedAt: '2026-07-28T10:00:00.000Z',
      },
      scan: {
        skills: [
          {
            id: 'release-runbook',
            name: 'Release runbook',
            description: 'Cut, verify, and publish a release.',
            group: '',
            files: [{ path: 'SKILL.md', size: 120, blobSha: 'def5678', isEntry: true }],
            allowedTools: [],
            hasExecutables: false,
          },
        ],
        groups: [],
        groupingSignal: 'none' as const,
        fileCount: 1,
        commitSha: 'abc1234',
      },
    })
    api.workspaceSkillsList = async () => ({ ok: true, skills: [] })
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
      'Skills',
      'Modules',
      'Agent CLIs',
      'Installed',
      'Automation server',
      'Add a custom MCP',
    ]) {
      assert.ok(railText.includes(label), `the rail carries "${label}"`)
    }
    // Honest counts, pinned to the element that claims them: the RAIL row is
    // where a count lives now — the bar is the door's name and nothing else, so
    // the counts it used to repeat can no longer drift from these. Each kind row
    // carries its own real count (a zeroed count on one row can't hide behind
    // another's).
    const railRow = (label: string): string => {
      const row = Array.from(container.querySelectorAll('button')).find((button) =>
        (button.textContent ?? '').includes(label),
      )
      assert.ok(row, `the ${label} rail row renders`)
      return row.textContent ?? ''
    }
    const barText = container.querySelector('section > div')?.textContent ?? ''
    assert.ok(!barText.includes('in marketplace'), 'the bar carries no counts line')
    assert.ok(railRow('Featured').includes('1 ready to launch'), 'the Featured row counts launchables')
    assert.ok(railRow('MCP servers').includes('2 available'), 'the MCP servers row counts the grid')
    assert.ok(railRow('Skills').includes('1 source'), 'the Skills row counts its sources')
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
      // The custom-MCP affordance is the manage view's own control; bundled
      // skills left this canvas for the Skills surface (they were a duplicate
      // of the Multicode source's list).
      (container.textContent ?? '').includes('sync MCPs to terminal agents')
        || (container.textContent ?? '').includes('Existing terminals keep their current config'),
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

    console.log('ok - the Plugins surface: catalog rail, facet projection, deep-links, degradation')
  }

  // ═══ 8. Every door replaces the projects rail — in EVERY load state ═══════
  // Item 1993's first rule is absolute: no app state shows two navigation
  // columns left of content. The host can only honour it for a door that hands
  // over a rail, so this walks all six and asserts each one declares its rail
  // both on its very first paint (still loading, nothing resolved) and once it
  // has resolved to nothing (no project open, no runs, unstubbed IPC).
  //
  // This is the leg that regressed silently: three doors gated the prop on
  // having data (`runs.length > 0`, `entries.length > 0`, `hasRoadmaps`) and one
  // withheld it while loading, so "drilling in replaces the sidebar" held only
  // once a door had something in it — and an empty or slow door sat beside the
  // projects rail as a second column of things to choose. Reading the presence
  // the surface REPORTS is what makes that provable: it is the exact signal the
  // host derives `contextRailActive` from, so a false here is two columns on
  // screen. Asserted per door, never rolled up, because the failure is per door.
  //
  // Doors→modals (2026-09-01): Automations, Plugins and Design left this walk
  // with the door band — the modal host provides no rail slot, so the
  // two-columns rule has nothing to say about them; GlobalSurfaceShell's
  // inline fallback is their modal-interior anatomy.
  {
    const { ContextRailSlotContext } = await import('./contextRail')
    const { default: RoadmapGlobalSurface } = await import('./RoadmapGlobalSurface')

    // The emptiest world there is: no project open, so every door resolves to
    // nothing rather than to content. Every IPC these doors reach that is not
    // stubbed above answers `{ ok: false }` through the proxy, which puts them in
    // their degraded/empty states — the states that used to lose the rail.
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      activeGlobalSurface: null,
    } as never)
    indexFails = false
    api.listSprintRuns = async () => []

    const doors: Array<[string, React.ComponentType]> = [
      ['sprints', SprintsGlobalSurface],
      ['backlog', BacklogGlobalSurface],
      ['roadmap', RoadmapGlobalSurface],
      ['reviews', ReviewsGlobalSurface],
    ]
    for (const [id, Surface] of doors) {
      const slot = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(slot)
      const presence: boolean[] = []
      const host = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(host)
      const doorRoot = createRoot(host)
      // Sync act: effects flush, pending promises do NOT — so the first reported
      // value is the door's answer while it is still loading.
      act(() => {
        doorRoot.render(
          React.createElement(
            ContextRailSlotContext.Provider,
            { value: { el: slot as unknown as HTMLElement, onRailPresence: (p: boolean) => presence.push(p) } },
            React.createElement(ConfirmDialogProvider, null, React.createElement(Surface)),
          ),
        )
      })
      assert.equal(
        presence[0],
        true,
        `the ${id} door declares its rail on first paint — a loading door must not leave the projects rail up`,
      )
      await settle(12)
      assert.equal(
        presence[presence.length - 1],
        true,
        `the ${id} door still declares its rail with nothing in it — an empty door must not leave the projects rail up`,
      )
      // And the rail really is in the host's column, not a second aside of the
      // door's own: reporting presence without portaling would read identical to
      // the host and still paint two columns.
      assert.ok(slot.childElementCount > 0, `the ${id} door's rail rendered into the host's column`)
      assert.equal(
        host.querySelector('aside'),
        null,
        `and the ${id} door mounts no inline aside beside it`,
      )
      await act(async () => {
        doorRoot.unmount()
      })
      host.remove()
      slot.remove()
    }
    console.log('ok - all four doors declare a rail while loading and while empty')
  }

  // ═══ 9. The absent door and the workspace-less door (MC-1854) ═════════════
  // Two halves of the published global-surface contract. First: a persisted
  // `activeGlobalSurface` naming a surface that never registered resolves to
  // the explicit not-installed door — named, one sentence, one CTA into
  // Plugins — and the persisted id survives the visit untouched, so
  // reinstalling the module lands the user back where they were. Second: a
  // module that registers ONLY a nav entry + a global surface (no workspace
  // type, no panel) gets a door that mounts, renders, and still resolves
  // after a simulated reload — nothing in the mount path may assume a door
  // has an owning workspace.
  {
    const { resolveActiveDoorSurface } = await import('./absentDoorSurface')
    const host = getRendererHost()
    const getSurface = (id: string): ReturnType<typeof host.getGlobalSurface> => host.getGlobalSurface(id)

    // — The absent door —
    useWorkspaceStore.setState({ activeGlobalSurface: 'atlas' } as never)
    const extensionsOpens: string[] = []
    const absent = resolveActiveDoorSurface(
      useWorkspaceStore.getState().activeGlobalSurface as string,
      getSurface,
      () => true,
      (view) => extensionsOpens.push(view),
    )
    const absentHost = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(absentHost)
    const absentRoot = createRoot(absentHost)
    await act(async () => {
      absentRoot.render(React.createElement(absent.Component))
    })
    assert.match(absentHost.textContent ?? '', /Atlas/, 'the door is named')
    assert.match(
      absentHost.textContent ?? '',
      /The Atlas module isn’t installed\./,
      'and says its module is not installed',
    )
    const cta = [...absentHost.querySelectorAll('button')].find(
      (button) => button.textContent === 'Find it in Plugins',
    )
    assert.ok(cta, 'one CTA into Plugins')
    await act(async () => {
      cta.click()
    })
    assert.deepEqual(extensionsOpens, ['browse'], 'an uninstalled module deep-links to Browse')
    assert.equal(
      useWorkspaceStore.getState().activeGlobalSurface,
      'atlas',
      'rendering the absent door never clears the persisted id',
    )
    await act(async () => {
      absentRoot.unmount()
    })
    absentHost.remove()

    // — The workspace-less door —
    host.hostFor('tide-tables').registerGlobalSurface({
      id: 'tide-tables',
      Component: () => React.createElement('div', null, 'Tide tables'),
    })
    useWorkspaceStore.setState({ activeGlobalSurface: 'tide-tables' } as never)
    for (const visit of ['first open', 'after reload']) {
      const resolved = resolveActiveDoorSurface(
        useWorkspaceStore.getState().activeGlobalSurface as string,
        getSurface,
        () => true,
        () => {},
      )
      assert.equal(resolved.moduleId, 'tide-tables', `the door resolves to its module (${visit})`)
      const doorHost = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(doorHost)
      const doorRoot = createRoot(doorHost)
      await act(async () => {
        doorRoot.render(React.createElement(resolved.Component))
      })
      assert.match(doorHost.textContent ?? '', /Tide tables/, `the workspace-less door renders (${visit})`)
      await act(async () => {
        doorRoot.unmount()
      })
      doorHost.remove()
    }

    // — Disabled, not uninstalled — the copy stays honest and the CTA lands
    // on Installed, where the module's toggle lives.
    const disabledOpens: string[] = []
    const disabled = resolveActiveDoorSurface('tide-tables', getSurface, () => false, (view) =>
      disabledOpens.push(view),
    )
    const disabledHost = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(disabledHost)
    const disabledRoot = createRoot(disabledHost)
    await act(async () => {
      disabledRoot.render(React.createElement(disabled.Component))
    })
    assert.match(disabledHost.textContent ?? '', /The Tide-tables module is turned off\./)
    const disabledCta = [...disabledHost.querySelectorAll('button')].find(
      (button) => button.textContent === 'Find it in Plugins',
    )
    assert.ok(disabledCta)
    await act(async () => {
      disabledCta.click()
    })
    assert.deepEqual(disabledOpens, ['installed'], 'a disabled module deep-links to Installed')
    await act(async () => {
      disabledRoot.unmount()
    })
    disabledHost.remove()

    console.log('ok - the absent door says so and keeps the id; a workspace-less door mounts and survives reload')
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
