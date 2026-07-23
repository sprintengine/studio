import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// The Sprints door's composition contract (item 1763), asserted on the rendered
// surface rather than on its parts: the Electron app cannot be driven headlessly,
// so this stands up a real DOM, stubs only the run-index IPC, and mounts the
// actual surface. It covers what unit tests on `railState` cannot — that the hook,
// the ordering, the rail, the chips, the shell, and the canvas are wired to each
// other: runs reach the rail from every project root, a needs-input run leads it,
// the canvas opens on a selection, chips narrow the list, and "New sprint" emits
// the request the shell listens for (never a no-op button).

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

type RunSummary = Record<string, unknown>

const projectRoot = '/work/multicode'
const mobileRoot = '/work/multicode-mobile'

function summary(over: Record<string, unknown> & { teamSlug: string; root?: string }): RunSummary {
  const root = over.root ?? projectRoot
  return {
    statePath: `${root}/.multi-code/sprintengine/${over.teamSlug}/run.yaml`,
    teamSlug: over.teamSlug,
    teamName: over.teamSlug,
    projectRoot: root,
    projectName: root.slice(root.lastIndexOf('/') + 1),
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

let listed: RunSummary[] = []
let listCalls = 0
let lastRoots: string[] = []

anyGlobal.window.api = {
  platform: 'darwin',
  listSprintRuns: async (roots: string[]) => {
    listCalls += 1
    lastRoots = roots
    return listed
  },
  onSprintRunsChanged: () => () => {},
}

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { useWorkspaceStore } = await import(
    '../../../../store/workspaceStore'
  )
  const { default: SprintsGlobalSurface } = await import(
    './SprintsGlobalSurface'
  )

  // Two projects open, so the run index gets two roots and the chip strip appears.
  useWorkspaceStore.setState({
    workspaces: [
      { id: 'w1', name: 'multicode', mode: 'standard', folderPath: projectRoot, agents: {}, openFiles: [], createdAt: 1 },
      { id: 'w2', name: 'mobile', mode: 'standard', folderPath: mobileRoot, agents: {}, openFiles: [], createdAt: 2 },
    ],
    activeWorkspaceId: 'w1',
    activeGlobalSurface: 'sprints',
  } as never)

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(React.createElement(SprintsGlobalSurface))
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  // ── Empty index → the first-run empty state, no rail ──────────────────────
  listed = []
  await mount()
  assert.ok(container.textContent?.includes('Run your first sprint'), 'empty state copy')
  assert.ok(container.textContent?.includes('New sprint'), 'empty state offers the create path')
  assert.equal(container.querySelector('aside[aria-label="Sprints list"]'), null, 'no rail when empty')
  console.log('ok - empty index shows the first-run state with no rail')

  // ── Populated index → rail, ordering, chips, auto-selected canvas ─────────
  listed = [
    summary({ teamSlug: 'runner-hardening', runtimeState: 'completed', updatedAt: '2026-07-22T10:00:00Z' }),
    summary({
      teamSlug: 'wake-filter-sprint',
      runtimeState: 'running',
      taskCounts: { total: 9, done: 4, inProgress: 1, waiting: 4 },
    }),
    summary({
      teamSlug: 'relay-traffic',
      root: mobileRoot,
      runtimeState: 'needs_input',
      needsInputCount: 2,
      repoRollup: { declared: 2, merged: 0, open: 1 },
    }),
  ]
  await act(async () => {
    root.unmount()
  })
  const root2 = createRoot(container)
  await act(async () => {
    root2.render(React.createElement(SprintsGlobalSurface))
  })
  await act(async () => {
    await Promise.resolve()
  })

  assert.deepEqual(lastRoots, [projectRoot, mobileRoot], 'both project roots reach the index IPC')

  const rail = container.querySelector('aside[aria-label="Sprints list"]')
  assert.ok(rail, 'rail is present once runs load')

  const rows = [...container.querySelectorAll('ul[role="list"][aria-label="Sprints"] > li')]
  assert.equal(rows.length, 3, 'every run lists')
  // needs_input outranks everything, including the newer completed run.
  assert.ok(rows[0]?.textContent?.includes('relay-traffic'), 'needs-input run leads the rail')
  assert.ok(rows[0]?.textContent?.includes('needs your input'), 'and flags why')
  assert.ok(rows[1]?.textContent?.includes('wake-filter-sprint'), 'running run is second')
  assert.ok(rows[1]?.textContent?.includes('running · 4 of 9 tasks'))

  // Auto-selection opens on content: the leading (needs-input) run fills the canvas.
  assert.ok(container.textContent?.includes('2 tasks need an answer'), 'canvas shows the selected run')
  assert.ok(container.textContent?.includes('Waiting on you'), 'bar status chip')
  const selected = container.querySelector('li button[aria-current="true"]')
  assert.ok(selected?.textContent?.includes('relay-traffic'), 'rail marks the auto-selection')
  console.log('ok - runs load, needs-input leads, and the canvas opens on the selected run')

  // ── Project chips filter ─────────────────────────────────────────────────
  const chips = [...container.querySelectorAll('div[role="group"][aria-label="Filter sprints by project"] button')]
  assert.deepEqual(
    chips.map((c) => c.textContent),
    ['All projects', 'multicode', 'multicode-mobile'],
    'All projects + one chip per project with a run',
  )
  await act(async () => {
    ;(chips[1] as HTMLElement).click()
  })
  const filteredRows = [...container.querySelectorAll('ul[role="list"][aria-label="Sprints"] > li')]
  assert.equal(filteredRows.length, 2, 'multicode chip narrows to that project')
  assert.ok(!container.textContent?.includes('relay-traffic'), 'the mobile run drops out')
  console.log('ok - project chips filter the rail')

  // ── "New sprint" really signals the shell ────────────────────────────────
  let newSprintRequests = 0
  dom.window.addEventListener('multicode:new-sprint', () => {
    newSprintRequests += 1
  })
  const newSprintButton = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'New sprint',
  )
  assert.ok(newSprintButton, 'the rail carries New sprint')
  await act(async () => {
    ;(newSprintButton as HTMLElement).click()
  })
  assert.equal(newSprintRequests, 1, 'New sprint dispatches the creation request the shell listens for')
  console.log('ok - New sprint dispatches a real creation request')

  assert.ok(listCalls >= 1, 'the index was actually read over IPC')
  console.log('all Sprints surface composition tests passed')
}

main().catch((error) => {
  console.error('not ok - Sprints surface composition')
  console.error(error)
  process.exit(1)
})
