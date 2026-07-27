import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// The Sprints door's composition contract (items 1763 + 1764), asserted on the
// rendered surface rather than on its parts: the Electron app cannot be driven
// headlessly, so this stands up a real DOM, stubs the run-index and projection
// IPC, and mounts the actual surface. It covers what unit tests on `railState`
// cannot — that the hooks, the ordering, the rail, the chips, the shell, the
// waiting strip, and the run canvas are wired to each other: runs reach the rail
// from every project root, a needs-input run leads it, chips narrow the list,
// "New sprint" emits the request the shell listens for, the multi-repo canvas
// renders one card per declared repository with its merge order, and the
// waiting strip jumps the rail to a DIFFERENT run than the selected one.

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
// JSDOM has no scrollIntoView; the filter Select's open effect scrolls its
// active option into view, so give it a no-op.
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
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

function statePathOf(root: string, slug: string): string {
  return `${root}/.multi-code/sprintengine/${slug}/run.yaml`
}

type RepoSpec = {
  id: string
  root: string
  pr: number | null
  state: 'merged' | 'open' | null
}

// A projection as `sprintengine:projection:read` hands it back: the run's declared
// repositories and the tasks routed to each, which is all the canvas reads.
function projection(input: {
  name: string
  repos: RepoSpec[]
  /** taskId → [repo id, dependsOn] — the cross-repo edges merge order derives from. */
  tasks: Array<{ id: string; repo: string; dependsOn: string[]; status?: string }>
}): Record<string, unknown> {
  return {
    run: {
      name: input.name,
      goal: 'A goal',
      vcs: {
        mode: 'run_worktree',
        worktreePath: '.multi-code/worktree',
        branchName: `sprintengine/${input.name}`,
        baseRef: 'main',
        repos: input.repos.map((repo) => ({
          id: repo.id,
          root: repo.root,
          worktreePath: `.multi-code/worktree/${repo.id}`,
          branchName: `sprintengine/${input.name}`,
          baseRef: 'main',
          lastCommitSha: 'c0ffee',
          pullRequestUrl: repo.pr === null ? null : `https://github.com/acme/${repo.id}/pull/${repo.pr}`,
          pullRequestState: repo.state,
        })),
        declaredRepoCount: input.repos.length,
      },
    },
    tasks: input.tasks.map((task) => ({
      id: task.id,
      title: `Task ${task.id}`,
      role: 'developer',
      status: task.status ?? 'done',
      repo: task.repo,
      dependsOn: task.dependsOn,
    })),
  }
}

let listed: RunSummary[] = []
let listCalls = 0
let lastRoots: string[] = []
// statePath → the run's projection, as `sprintengine:projection:read` returns it.
const projections = new Map<string, Record<string, unknown>>()
const mergeCalls: Array<{ statePath: string; repo?: string }> = []

// The run-configuration seam (item 1799): both engine-level controls write the
// statePath-keyed automation intent through main. The stub is a real store — it
// records every write, answers reads from what it recorded, and can refuse.
type IntentWrite = { statePath: string; mode?: string; preset?: string; workspaceId?: string }
const intentWrites: IntentWrite[] = []
const intentRecords = new Map<string, { desiredMode: string; cliPermissionPreset?: string; revision: number }>()
let intentWritesRefused = false

function writeIntent(statePath: string, patch: { mode?: string; preset?: string }): unknown {
  if (intentWritesRefused) return { ok: false, message: 'The run store could not be written.' }
  const previous = intentRecords.get(statePath) ?? { desiredMode: 'manual', revision: 0 }
  const record = {
    ...previous,
    ...(patch.mode ? { desiredMode: patch.mode } : {}),
    ...(patch.preset ? { cliPermissionPreset: patch.preset } : {}),
    revision: previous.revision + 1,
  }
  intentRecords.set(statePath, record)
  return { ok: true, record, changed: true }
}

const notifications: Array<Record<string, unknown>> = []

const api: Record<string, unknown> = {
  platform: 'darwin',
  listSprintRuns: async (roots: string[]) => {
    listCalls += 1
    lastRoots = roots
    return listed
  },
  onSprintRunsChanged: () => () => {},
  readSprintEngineProjection: async (statePath: string) => {
    const data = projections.get(statePath)
    return data
      ? { ok: true, data, token: 'token-1' }
      : { ok: false, message: 'This run’s projection could not be read.' }
  },
  mergeSprintEnginePullRequest: async (statePath: string, repo?: string) => {
    mergeCalls.push({ statePath, repo })
    return { ok: true }
  },
  pathExists: async () => true,
  readSprintEngineAutomationMode: async ({ statePath }: { statePath: string }) => ({
    ok: true,
    record: intentRecords.get(statePath) ?? null,
  }),
  setSprintEngineAutomationMode: async (input: { statePath: string; mode: string; workspaceId?: string }) => {
    intentWrites.push({ statePath: input.statePath, mode: input.mode, ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}) })
    return writeIntent(input.statePath, { mode: input.mode })
  },
  setSprintEngineCliPermissionPreset: async (input: { statePath: string; preset: string }) => {
    intentWrites.push({ statePath: input.statePath, preset: input.preset })
    return writeIntent(input.statePath, { preset: input.preset })
  },
  logDiagnostic: async (input: Record<string, unknown>) => {
    const entry = { ...input, id: `diag-${notifications.length + 1}`, timestamp: '2026-07-26T12:00:00.000Z' }
    notifications.push(entry)
    return entry
  },
}

// The board mounts inside the canvas and reaches for a wide slice of the preload
// API. Unstubbed members answer inertly rather than throwing, so this test stays
// about the door's composition — subscriptions hand back an unsubscribe, calls
// resolve to a refusal (never a fake success).
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
  const { useWorkspaceStore } = await import(
    '../../../../store/workspaceStore'
  )
  const { default: SprintsGlobalSurface } = await import(
    './SprintsGlobalSurface'
  )
  const { noteSprintDoorSelection } = await import('./sprintDoorRequests')
  const { normalizeSprintEngineProjection } = await import(
    '../../../../../../shared/sprintengine/state'
  )
  const { ConfirmDialogProvider } = await import('../../../ui/ConfirmDialog')
  const { getTimerRegistrations } = await import('../../../../utils/diagnostics/timerRegistry')

  // Let React.lazy resolve the board chunk and any follow-up effects settle.
  async function settle(times = 6): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await act(async () => {
        await Promise.resolve()
      })
    }
  }
  const projectionDrivers = (): number =>
    getTimerRegistrations().filter((timer) => timer.label === 'SprintEngine projection poll').length

  // The surface is mounted inside the app's confirm-dialog provider (merging is
  // confirmed, never silent), so the test tree carries it too.
  const surface = (): React.ReactElement =>
    React.createElement(ConfirmDialogProvider, null, React.createElement(SprintsGlobalSurface))

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
      root.render(surface())
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
    // Still working, with branches out by design — never a waiting row.
    summary({
      teamSlug: 'wake-filter-sprint',
      runtimeState: 'running',
      taskCounts: { total: 9, done: 4, inProgress: 1, waiting: 4 },
      repoRollup: { declared: 2, merged: 0, open: 2 },
    }),
    summary({
      teamSlug: 'relay-traffic',
      root: mobileRoot,
      runtimeState: 'needs_input',
      needsInputCount: 2,
      // A run that has genuinely waited: the rail row carries the since-date.
      updatedAt: '2026-07-16T10:00:00Z',
      repoRollup: { declared: 1, merged: 0, open: 1 },
    }),
    // The post-merge-hardening shape: three repositories, two landed, one still
    // out — completed, but NOT landed.
    summary({
      teamSlug: 'post-merge-hardening',
      runtimeState: 'completed',
      updatedAt: '2026-07-23T10:00:00Z',
      taskCounts: { total: 30, done: 30, inProgress: 0, waiting: 0 },
      repoRollup: { declared: 3, merged: 2, open: 1 },
    }),
    // The same span, but the sibling that must land first is still open — so the
    // last leg is blocked rather than merge-ready.
    summary({
      teamSlug: 'chained-auth',
      runtimeState: 'completed',
      updatedAt: '2026-07-21T10:00:00Z',
      repoRollup: { declared: 3, merged: 1, open: 2 },
    }),
  ]
  projections.set(
    statePathOf(projectRoot, 'wake-filter-sprint'),
    projection({
      name: 'wake-filter-sprint',
      repos: [{ id: 'primary', root: '.', pr: null, state: null }],
      tasks: [{ id: 'T1', repo: 'primary', dependsOn: [], status: 'in_progress' }],
    }),
  )
  // One repository, no merge order to speak of.
  projections.set(
    statePathOf(mobileRoot, 'relay-traffic'),
    projection({
      name: 'relay-traffic',
      repos: [{ id: 'primary', root: '.', pr: 12, state: 'open' }],
      tasks: [{ id: 'T1', repo: 'primary', dependsOn: [], status: 'needs_input' }],
    }),
  )
  projections.set(
    statePathOf(projectRoot, 'post-merge-hardening'),
    projection({
      name: 'post-merge-hardening',
      repos: [
        { id: 'primary', root: '.', pr: 204, state: 'merged' },
        { id: 'multiauth', root: '/work/multiauth', pr: 48, state: 'merged' },
        { id: 'multicode-mobile', root: mobileRoot, pr: 61, state: 'open' },
      ],
      tasks: [
        { id: 'T1', repo: 'primary', dependsOn: [] },
        { id: 'T2', repo: 'multiauth', dependsOn: ['T1'] },
        { id: 'T3', repo: 'multicode-mobile', dependsOn: ['T2'] },
      ],
    }),
  )
  projections.set(
    statePathOf(projectRoot, 'chained-auth'),
    projection({
      name: 'chained-auth',
      repos: [
        { id: 'primary', root: '.', pr: 300, state: 'merged' },
        { id: 'multiauth', root: '/work/multiauth', pr: 51, state: 'open' },
        { id: 'multicode-mobile', root: mobileRoot, pr: 70, state: 'open' },
      ],
      tasks: [
        { id: 'T1', repo: 'primary', dependsOn: [] },
        { id: 'T2', repo: 'multiauth', dependsOn: ['T1'] },
        { id: 'T3', repo: 'multicode-mobile', dependsOn: ['T2'] },
      ],
    }),
  )
  await act(async () => {
    root.unmount()
  })
  const root2 = createRoot(container)
  await act(async () => {
    root2.render(surface())
  })
  await act(async () => {
    await Promise.resolve()
  })

  assert.deepEqual(lastRoots, [projectRoot, mobileRoot], 'both project roots reach the index IPC')

  const rail = container.querySelector('aside[aria-label="Sprints list"]')
  assert.ok(rail, 'rail is present once runs load')

  const rows = [...container.querySelectorAll('ul[role="list"][aria-label^="Sprints:"] > li')]
  assert.equal(rows.length, 5, 'every run lists')
  // needs_input outranks everything, including the newer completed run.
  assert.ok(rows[0]?.textContent?.includes('relay-traffic'), 'needs-input run leads the rail')
  assert.ok(rows[0]?.textContent?.includes('needs your input'), 'and flags why')
  assert.ok(rows[1]?.textContent?.includes('wake-filter-sprint'), 'running run is second')
  assert.ok(rows[1]?.textContent?.includes('running · 4 of 9 tasks'))

  // Auto-selection opens on content: the leading (needs-input) run fills the
  // canvas — its own projection, not the index row.
  const selected = container.querySelector('li button[aria-current="true"]')
  assert.ok(selected?.textContent?.includes('relay-traffic'), 'rail marks the auto-selection')
  assert.ok(container.textContent?.includes('Waiting on you'), 'bar status chip')
  console.log('ok - runs load, needs-input leads, and the canvas opens on the selected run')


  // Repositories are a TAB on the board now (MC-1838), not a strip above it —
  // open it for the currently selected run before reading the cards.
  const openReposTab = async (): Promise<void> => {
    const tab = [...container.querySelectorAll('[role="tab"]')].find((candidate) =>
      candidate.textContent?.includes('Repositories'),
    )
    assert.ok(tab, 'the board offers a Repositories tab at the door')
    await act(async () => {
      ;(tab as HTMLElement).click()
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  // ── A single-repo run renders one Primary card and no merge order ─────────
  await openReposTab()
  const soloCards = [...container.querySelectorAll('section[aria-label="Repositories"] li')]
  assert.equal(soloCards.length, 1, 'one card for a one-repository run')
  assert.ok(soloCards[0]?.textContent?.includes('Primary'), 'entry zero is tagged Primary')
  assert.ok(
    !container.textContent?.includes('Merges after'),
    'a single-repo run never renders a degenerate merge-order note',
  )
  assert.ok(
    !container.textContent?.includes('merge order enforced'),
    'nor the merge-order qualifier',
  )
  console.log('ok - single-repo run renders one Primary card with no merge order')

  // ── The project lens sits behind the filter glyph beside search ──────────
  const filterTrigger = (): HTMLElement => {
    const trigger = container.querySelector('button[aria-haspopup="menu"][aria-label^="Filter and sort sprints"]')
    assert.ok(trigger, 'the project lens is one filter control beside search')
    return trigger as HTMLElement
  }
  const pickFilter = async (label: string): Promise<void> => {
    await act(async () => {
      filterTrigger().click()
    })
    const option = [...dom.window.document.querySelectorAll('[role="menuitemradio"]')].find(
      (candidate) => candidate.textContent?.startsWith(label),
    )
    assert.ok(option, `the filter lists ${label}`)
    await act(async () => {
      ;(option as HTMLElement).click()
    })
    // Picking keeps the menu open (multi-axis in one visit) — close it so the
    // rail below is queryable again.
    await act(async () => {
      filterTrigger().click()
    })
    await act(async () => {
      await Promise.resolve()
    })
  }
  await pickFilter('multicode ·')
  const railRowsNow = (): string =>
    [...container.querySelectorAll('ul[role="list"][aria-label^="Sprints:"] > li')]
      .map((row) => row.textContent ?? '')
      .join('')
  assert.equal(
    container.querySelectorAll('ul[role="list"][aria-label^="Sprints:"] > li').length,
    4,
    'the filter narrows the rail to that project',
  )
  assert.ok(!railRowsNow().includes('relay-traffic'), 'the mobile run drops out of the rail')
  console.log('ok - the compact project filter narrows the rail')

  await pickFilter('All projects')

  // ── The rail groups carry the signal (MC-1838): no waiting strip ─────────
  // "Needs you" leads with the waiting run and an honest since-date; completed
  // runs age into "Recent" — nothing is pinned above the page.
  assert.ok(
    !container.textContent?.includes('Waiting on you 2'),
    'no standing waiting strip above the canvas',
  )
  const needsYouList = container.querySelector('ul[role="list"][aria-label="Sprints: Needs you"]')
  assert.ok(needsYouList, 'the rail leads with a Needs you group')
  assert.ok(needsYouList?.textContent?.includes('relay-traffic'), 'holding the waiting run')
  assert.ok(needsYouList?.textContent?.includes('since Jul'), 'with an honest waiting-since date')
  const activeList = container.querySelector('ul[role="list"][aria-label="Sprints: Active"]')
  assert.ok(activeList?.textContent?.includes('wake-filter-sprint'), 'live work sits under Active')
  const recentList = container.querySelector('ul[role="list"][aria-label="Sprints: Recent"]')
  assert.ok(recentList?.textContent?.includes('post-merge-hardening'), 'finished runs age into Recent')
  assert.ok(recentList?.textContent?.includes('1 merge left'), 'with their remaining-merge state line')
  console.log('ok - the rail groups Needs you / Active / Recent replace the waiting strip')

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

  // ── A Recent row selects its run like any other ──────────────────────────
  const postMergeRow = [...container.querySelectorAll('ul[role="list"][aria-label="Sprints: Recent"] > li button')].find(
    (candidate) => candidate.textContent?.includes('post-merge-hardening'),
  )
  assert.ok(postMergeRow, 'the merge-ready run has a rail row')
  await act(async () => {
    ;(postMergeRow as HTMLElement).click()
  })
  await act(async () => {
    await Promise.resolve()
  })
  const nowSelected = container.querySelector('li button[aria-current="true"]')
  assert.ok(
    nowSelected?.textContent?.includes('post-merge-hardening'),
    'clicking a rail row selects that run',
  )
  console.log('ok - rail rows select their run from any group')

  // ── The multi-repo canvas (mockup §2 anatomy) ────────────────────────────
  await openReposTab()
  const cards = [...container.querySelectorAll('section[aria-label="Repositories"] li')]
  assert.equal(cards.length, 3, 'one card per declared repository')
  assert.ok(cards[0]?.textContent?.includes('Primary'), 'entry zero carries the Primary tag')
  assert.ok(!cards[1]?.textContent?.includes('Primary'), 'and only entry zero')
  // design-tokens-allow: a rendered pull-request number, not a colour literal
  assert.ok(cards[0]?.textContent?.includes('PR #204 · Merged'), 'the primary landed')
  assert.ok(cards[1]?.textContent?.includes('PR #48 · Merged'), 'so did multiauth')
  assert.ok(cards[2]?.textContent?.includes('PR #61 · Open'), 'the last leg is still out')
  assert.ok(container.textContent?.includes('merge order enforced'), 'the strip names the rule')
  // Completed, but not landed: the rollup, not the flat PR state, decides (D10).
  const bar = container.querySelector('h2')?.parentElement
  assert.ok(bar?.textContent?.includes('Completed'), 'the run reads Completed')
  assert.ok(!bar?.textContent?.includes('Landed'), 'and never Landed while a branch is out')
  assert.ok(container.textContent?.includes('1 leg open'), 'the rollup names the open leg')
  assert.ok(
    container.textContent?.includes('Lands when multicode-mobile merges'),
    'and names the project landing waits on',
  )
  const primaryAction = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith('Merge remaining'),
  )
  assert.ok(primaryAction, 'the bar carries one truthful next step')
  assert.equal(primaryAction?.textContent, 'Merge remaining · 1', 'counting what is actually left')
  console.log('ok - the multi-repo canvas renders the post-merge-hardening shape')

  // ── A blocked repo is pre-disabled and names its blocker ─────────────────
  const chainedRow = [...container.querySelectorAll('ul[role="list"][aria-label^="Sprints:"] > li button')].find(
    (b) => b.textContent?.includes('chained-auth'),
  )
  assert.ok(chainedRow, 'the chained run is in the rail')
  await act(async () => {
    ;(chainedRow as HTMLElement).click()
  })
  await act(async () => {
    await Promise.resolve()
  })
  await openReposTab()
  const chainedCards = [...container.querySelectorAll('section[aria-label="Repositories"] li')]
  assert.equal(chainedCards.length, 3, 'three repositories again')
  const blockedCard = chainedCards[2]
  assert.ok(blockedCard?.textContent?.includes('Merges after multiauth'), 'the blocker is named')
  const blockedButton = [...(blockedCard?.querySelectorAll('button') ?? [])].find((b) =>
    b.textContent?.includes('Merges after'),
  ) as HTMLButtonElement | undefined
  assert.ok(blockedButton, 'the blocked repo still shows its merge affordance')
  assert.equal(blockedButton?.disabled, true, 'pre-disabled until its blocker merges')
  // The unblocked sibling can merge — and merging goes through the engine, per repo.
  const mergeButton = [...(chainedCards[1]?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent === 'Merge',
  ) as HTMLButtonElement | undefined
  assert.ok(mergeButton, 'the unblocked repo offers Merge')
  assert.equal(mergeButton?.disabled, false, 'and it is live')

  // Merging is confirmed, then handed to the engine for THAT repo — the surface
  // never merges anything itself and never force-merges.
  await act(async () => {
    ;(mergeButton as HTMLElement).click()
  })
  const confirmButton = [...dom.window.document.querySelectorAll('button')].find(
    (b) => b.textContent === 'Merge' && b !== mergeButton,
  )
  assert.ok(confirmButton, 'merging asks first')
  await act(async () => {
    ;(confirmButton as HTMLElement).click()
  })
  await act(async () => {
    await Promise.resolve()
  })
  assert.deepEqual(
    mergeCalls,
    [{ statePath: statePathOf(projectRoot, 'chained-auth'), repo: 'multiauth' }],
    'the engine merges that one repo, by id',
  )
  console.log('ok - merge order is pre-enforced, and merging goes through the engine per repo')

  // ── The board mounts from the door, on the run's own handle ──────────────
  await settle()
  assert.ok(
    container.querySelector('[role="tablist"]'),
    'the run board fills the rest of the canvas, mounted by run identity',
  )
  // An all-done historical run reads clean and read-only from the door: the board
  // names the missing workspace instead of offering terminals it cannot open.
  assert.ok(
    container.textContent?.includes('This sprint’s workspace was removed'),
    'the board degrades its workspace-only actions with a plain-word reason',
  )
  console.log('ok - the board mounts from the door')

  // ── Exactly one projection-refresh driver, and only for a live handle-only run ─
  // chained-auth is COMPLETED — terminal, so nothing polls it.
  assert.equal(projectionDrivers(), 0, 'a completed run is terminal: no driver')
  const liveRow = [...container.querySelectorAll('ul[role="list"][aria-label^="Sprints:"] > li button')].find(
    (b) => b.textContent?.includes('wake-filter-sprint'),
  )
  await act(async () => {
    ;(liveRow as HTMLElement).click()
  })
  await settle()
  assert.equal(projectionDrivers(), 1, 'a live run with no resident workspace gets exactly one driver')
  console.log('ok - one refresh driver per live handle-only run, none for a terminal one')

  // ── An unreadable projection is a first-class degraded state ─────────────
  // runner-hardening has no projection stubbed — the read refuses.
  const unreadableRow = [
    ...container.querySelectorAll('ul[role="list"][aria-label^="Sprints:"] > li button'),
  ].find((b) => b.textContent?.includes('runner-hardening'))
  await act(async () => {
    ;(unreadableRow as HTMLElement).click()
  })
  await settle()
  assert.ok(container.textContent?.includes('Couldn’t open this sprint.'), 'the canvas says what failed')
  assert.ok(
    container.textContent?.includes('this is usually temporary'),
    'and what it means, in plain words',
  )
  const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Try again')
  assert.ok(retry, 'never a dead end: the error card offers a retry')
  const rawDetail = container.querySelector('details')
  assert.equal(rawDetail?.open, false, 'the raw failure stays behind a collapsed "Show details"')
  assert.ok(
    rawDetail?.textContent?.includes('projection could not be read.'),
    'and it is the real message, not a swallowed one',
  )
  assert.equal(projectionDrivers(), 0, 'and nothing loops against a projection that cannot be read')
  console.log('ok - an unreadable projection degrades with a reason and a retry')

  // ── Run configuration on a door mount routes by statePath (item 1799) ────
  // The board is mounted on a run with no resident workspace. Both engine-level
  // controls must still reach the engine — and must never claim a change they
  // did not make.
  const openRunConfig = async (): Promise<void> => {
    const trigger = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.getAttribute('aria-label')?.startsWith('Run configuration'),
    )
    assert.ok(trigger, 'the board header carries the run-configuration chip')
    await act(async () => {
      ;(trigger as HTMLElement).click()
    })
    await settle(2)
  }
  // Each mode radio renders its label and its hint as sibling spans; the label
  // alone identifies the option ('Run agents' is a prefix of another label).
  const automationModeLabel = (radio: Element): string =>
    radio.querySelector('span span')?.textContent?.trim() ?? ''
  const pickAutomationMode = async (label: string): Promise<void> => {
    const option = [...dom.window.document.querySelectorAll('[role="radio"]')].find(
      (candidate) => automationModeLabel(candidate) === label,
    )
    assert.ok(option, `the run-configuration popover offers ${label}`)
    await act(async () => {
      ;(option as HTMLElement).click()
    })
    await settle(3)
  }
  const checkedAutomationMode = (): string => {
    const checked = [...dom.window.document.querySelectorAll('[role="radio"]')].find(
      (candidate) => candidate.getAttribute('aria-checked') === 'true',
    )
    return checked ? automationModeLabel(checked) : ''
  }
  const pickCliPreset = async (label: string): Promise<void> => {
    const trigger = dom.window.document.querySelector('button[aria-label="CLI permission preset"]')
    assert.ok(trigger, 'the popover carries the CLI permission preset control')
    await act(async () => {
      ;(trigger as HTMLElement).click()
    })
    const option = [...dom.window.document.querySelectorAll('li[role="option"]')].find(
      (candidate) => candidate.textContent?.startsWith(label),
    )
    assert.ok(option, `the preset list offers ${label}`)
    await act(async () => {
      ;(option as HTMLElement).click()
    })
    await settle(3)
  }
  const modeNotifications = (): Array<Record<string, unknown>> =>
    notifications.filter((entry) => entry.title === 'Auto-run mode changed')

  const doorStatePath = statePathOf(projectRoot, 'wake-filter-sprint')
  const doorRow = [...container.querySelectorAll('ul[role="list"][aria-label^="Sprints:"] > li button')].find(
    (candidate) => candidate.textContent?.includes('wake-filter-sprint'),
  )
  await act(async () => {
    ;(doorRow as HTMLElement).click()
  })
  await settle()
  assert.equal(
    useWorkspaceStore.getState().workspaces.some((ws) => ws.sprintEngineContext?.statePath === doorStatePath),
    false,
    'the run has no resident workspace — this is the door mount',
  )

  await openRunConfig()
  await pickAutomationMode('Run agents')
  // Compared as a copy: `assert.deepEqual` narrows its first argument to the
  // shape of the second, which would erase the optional fields asserted below.
  assert.deepEqual(
    [...intentWrites],
    [{ statePath: doorStatePath, mode: 'run_agents' }],
    'the mode reaches the engine by statePath, with no workspace id standing in for one',
  )
  assert.equal(modeNotifications().length, 1, 'the confirmed write announces itself once')
  assert.equal(checkedAutomationMode(), 'Run agents', 'and the control holds the mode it wrote')

  // A refused write changes nothing and claims nothing.
  intentWritesRefused = true
  await pickAutomationMode('Run agents + approve artifacts')
  assert.equal(intentWrites.length, 2, 'the refused write was still attempted')
  assert.equal(modeNotifications().length, 1, 'a refused write publishes no success notification')
  assert.equal(checkedAutomationMode(), 'Run agents', 'and the control stays where it was')
  intentWritesRefused = false

  await pickCliPreset('Auto in workspace')
  assert.deepEqual(
    intentWrites[intentWrites.length - 1],
    { statePath: doorStatePath, preset: 'auto_workspace' },
    'the CLI permission preset takes the same statePath route',
  )
  const presetTrigger = dom.window.document.querySelector('button[aria-label="CLI permission preset"]')
  assert.ok(
    presetTrigger?.textContent?.includes('Auto in workspace'),
    'and the preset control holds what it wrote',
  )
  assert.equal(
    intentWrites.some((write) => write.workspaceId === ''),
    false,
    'no engine write is ever routed through the empty workspace-id sentinel',
  )
  console.log('ok - the door mount routes both run-configuration controls by statePath')

  // ── The same controls on a resident mount are unchanged ──────────────────
  // The optimistic workspace-store write still happens; the authoritative
  // statePath write rides along, so both mounts agree on the run's intent.
  await act(async () => {
    root2.unmount()
  })
  intentWrites.length = 0
  useWorkspaceStore.setState({
    workspaces: [
      { id: 'w1', name: 'multicode', mode: 'standard', folderPath: projectRoot, agents: {}, openFiles: [], createdAt: 1 },
      { id: 'w2', name: 'mobile', mode: 'standard', folderPath: mobileRoot, agents: {}, openFiles: [], createdAt: 2 },
      {
        id: 'w3',
        name: 'wake-filter-sprint',
        mode: 'sprintengine',
        folderPath: projectRoot,
        agents: {},
        openFiles: [],
        createdAt: 3,
        sprintEngineContext: {
          teamName: 'wake-filter-sprint',
          teamSlug: 'wake-filter-sprint',
          teamDirectoryPath: `${projectRoot}/.multi-code/sprintengine/wake-filter-sprint`,
          statePath: doorStatePath,
        },
        sprintEngineState: normalizeSprintEngineProjection(
          projections.get(doorStatePath),
          'wake-filter-sprint',
        ),
      },
    ],
    activeWorkspaceId: 'w1',
    activeGlobalSurface: 'sprints',
  } as never)
  const root3 = createRoot(container)
  await act(async () => {
    root3.render(surface())
  })
  await settle()
  const residentRow = [...container.querySelectorAll('ul[role="list"][aria-label^="Sprints:"] > li button')].find(
    (candidate) => candidate.textContent?.includes('wake-filter-sprint'),
  )
  await act(async () => {
    ;(residentRow as HTMLElement).click()
  })
  await settle()

  const residentAutoState = (): Record<string, unknown> | undefined =>
    useWorkspaceStore.getState().workspaces.find((ws) => ws.id === 'w3')?.sprintEngineAutoState as
      | Record<string, unknown>
      | undefined
  await openRunConfig()
  await pickAutomationMode('Run agents')
  assert.equal(residentAutoState()?.desiredMode, 'run_agents', 'the optimistic store write still happens')
  assert.deepEqual(
    intentWrites[0],
    { statePath: doorStatePath, mode: 'run_agents', workspaceId: 'w3' },
    'and the authoritative write still names the run and its real workspace',
  )
  await pickCliPreset('Auto in workspace')
  assert.equal(
    residentAutoState()?.cliPermissionPreset,
    'auto_workspace',
    'the preset lands in the workspace store the spawn path reads',
  )
  assert.deepEqual(
    intentWrites[intentWrites.length - 1],
    { statePath: doorStatePath, preset: 'auto_workspace' },
    'and mirrors into the run’s statePath-keyed record',
  )
  console.log('ok - the resident mount keeps its optimistic store write and reaches the same record')

  // ── A handed-over link path spelled with foreign separators (item 1803) ──
  // The Backlog link builds forward slashes; the index builds native-separator
  // paths. Raw equality drops the link and the door opens the wrong run.
  await act(async () => {
    root3.unmount()
  })
  const windowsRoot = 'C:\\work\\multicode'
  const windowsStatePath = `${windowsRoot}\\.multi-code\\sprintengine\\win-run\\run.yaml`
  listed = [
    summary({
      teamSlug: 'other-run',
      root: windowsRoot,
      statePath: `${windowsRoot}\\.multi-code\\sprintengine\\other-run\\run.yaml`,
      runtimeState: 'needs_input',
      needsInputCount: 1,
    }),
    summary({
      teamSlug: 'win-run',
      root: windowsRoot,
      statePath: windowsStatePath,
      runtimeState: 'completed',
    }),
  ]
  noteSprintDoorSelection(windowsStatePath.replace(/\\/g, '/'))
  const root4 = createRoot(container)
  await act(async () => {
    root4.render(surface())
  })
  await settle()
  const handedOverSelection = container.querySelector('li button[aria-current="true"]')
  assert.ok(
    handedOverSelection?.textContent?.includes('win-run'),
    'the forward-slash link path selects the run whose index row carries the native-separator path',
  )
  console.log('ok - a link path spelled with foreign separators still opens its own run')

  assert.ok(listCalls >= 1, 'the index was actually read over IPC')
  // Tear the surface down so the door's projection-refresh driver (and its
  // interval) is disposed — a leaked driver would keep this process alive.
  await act(async () => {
    root4.unmount()
  })
  console.log('all Sprints surface composition tests passed')
}

main().catch((error) => {
  console.error('not ok - Sprints surface composition')
  console.error(error)
  process.exit(1)
})
