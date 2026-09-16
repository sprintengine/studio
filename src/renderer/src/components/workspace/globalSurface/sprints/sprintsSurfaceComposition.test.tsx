import assert from 'node:assert/strict'
import { sprintEngineRunContext } from '../../../../store/slices/workspaceModuleState'

import { JSDOM } from 'jsdom'
import { bindSprintEngineIpc } from '../../../../modules/sprint-engine-ipc'

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

// `root` is a fixture shorthand for the project root, not a RunSummary field, so
// it is destructured out rather than spread onto the summary.
function summary({
  root: rootOverride,
  ...over
}: Partial<RunSummary> & { teamSlug: string; root?: string }): RunSummary {
  const root = rootOverride ?? projectRoot
  return {
    statePath: `${root}/.sprintengine/sprintengine/${over.teamSlug}/run.yaml`,
    teamName: over.teamSlug,
    projectRoot: root,
    projectName: root.slice(root.lastIndexOf('/') + 1),
    runtimeState: 'idle',
    taskCounts: { total: 0, done: 0, inProgress: 0, waiting: 0 },
    repoRollup: { declared: 0, merged: 0, open: 0 },
    needsInputCount: 0,
    branchName: null,
    worktreePath: null,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    sourceLabel: null,
    ...over,
  }
}

function statePathOf(root: string, slug: string): string {
  return `${root}/.sprintengine/sprintengine/${slug}/run.yaml`
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
  tasks: Array<{ id: string; repo: string; dependsOn: string[]; status?: string; role?: string | null }>
  /**
   * The run's legal role set, which the Agents tab reads and enabling a role
   * grows. An EMPTY list is a roleless run — an explicit "no roles", which the
   * app must not read as a run that named no set at all — so this branches on
   * presence, never truthiness.
   */
  configuredRoles?: string[]
  /** Seated workers, keyed by agent id — one roster row each on the Agents tab. */
  roster?: Record<string, { role?: string; status: string; currentTaskId: string | null }>
}): Record<string, unknown> {
  return {
    run: {
      name: input.name,
      goal: 'A goal',
      ...(input.configuredRoles !== undefined
        ? { rosterConfigured: true, configuredRoles: input.configuredRoles }
        : {}),
      vcs: {
        mode: 'run_worktree',
        worktreePath: '.sprintengine/worktree',
        branchName: `sprintengine/${input.name}`,
        baseRef: 'main',
        repos: input.repos.map((repo) => ({
          id: repo.id,
          root: repo.root,
          worktreePath: `.sprintengine/worktree/${repo.id}`,
          branchName: `sprintengine/${input.name}`,
          baseRef: 'main',
          lastCommitSha: 'c0ffee',
          pullRequestUrl: repo.pr === null ? null : `https://github.com/acme/${repo.id}/pull/${repo.pr}`,
          pullRequestState: repo.state,
        })),
        declaredRepoCount: input.repos.length,
      },
    },
    ...(input.roster ? { roster: input.roster } : {}),
    tasks: input.tasks.map((task) => ({
      id: task.id,
      title: `Task ${task.id}`,
      // `role: null` is a ROLELESS task — the key is absent rather than holding
      // a stand-in. Omitted is the ordinary role-based fixture.
      ...(task.role === null ? {} : { role: task.role ?? 'developer' }),
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

// The roster seam (item 1800): enabling a role is an engine mutation on the run,
// keyed by statePath. The stub records every call and grows that run's projected
// `configuredRoles`, so a re-read shows what the write actually did.
type EnableRoleCall = { statePath: string; role: string }
const enableRoleCalls: EnableRoleCall[] = []
// Which project root the board asked for the role registry — the door has no
// workspace folder and must derive it from the run's own state path.
const registryRootReads: string[] = []

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
  // A resident workspace's folder resolves, which is what lets that mount read
  // its role registry. The door has no workspace record, so it never asks.
  checkWorkspaceFolder: async (path: string) => ({
    ok: true,
    status: 'ready',
    path,
    checkedPath: path,
    message: `Workspace folder is ready: ${path}`,
  }),
  enableSprintEngineRole: async (input: { statePath: string; role: string }) => {
    enableRoleCalls.push({ statePath: input.statePath, role: input.role })
    const stored = projections.get(input.statePath)
    const run = stored?.run as Record<string, unknown> | undefined
    if (!stored || !run) return { ok: false, message: 'This run could not be read.' }
    const configured = Array.isArray(run.configuredRoles) ? [...run.configuredRoles as string[]] : []
    if (!configured.includes(input.role)) configured.push(input.role)
    projections.set(input.statePath, { ...stored, run: { ...run, configuredRoles: configured } })
    return { ok: true }
  },
  readSprintEngineRegistryRoles: async ({ workspaceRoot }: { workspaceRoot: string }) => {
    registryRootReads.push(workspaceRoot)
    return {
      ok: true,
      data: {
        roles: [
          { id: 'developer', label: 'Developer', source: { layer: 'workspace' } },
          { id: 'tester', label: 'Tester', source: { layer: 'workspace' } },
          { id: 'security', label: 'Security', source: { layer: 'workspace' } },
        ],
      },
    }
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
domWindow.api = new Proxy(api, {
  get: (target, prop: string) =>
    prop in target
      ? target[prop]
      : prop.startsWith('on')
        ? () => () => {}
        : async () => ({ ok: false, message: 'not stubbed' }),
})
bindSprintEngineIpc(domWindow.api as never)

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
  bindSprintEngineIpc(domWindow.api as never)

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
  // Rail presence is DECLARED, not derived from what the door holds (T19): an
  // empty Sprints door still replaces the projects rail, and the empty state is
  // the canvas's to say. Gating it on `runs.length > 0` is what used to leave a
  // first-run door beside the projects rail as a second navigation column.
  const emptyRail = container.querySelector('aside[aria-label="Sprints list"]')
  assert.ok(emptyRail, 'the rail is declared even with nothing in it')
  assert.ok(
    emptyRail?.textContent?.includes('New sprint'),
    'and it still carries the create affordance',
  )
  console.log('ok - empty index shows the first-run state beside a declared rail')

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
      // Staffed and role-configured: the run the Agents-tab contract below is
      // asserted against, on both mounts.
      configuredRoles: ['developer'],
      roster: { 'developer-1': { role: 'developer', status: 'idle', currentTaskId: null } },
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
  assert.ok(rows[1]?.textContent?.includes('4 of 9 tasks'), 'and its detail line says the progress')
  assert.ok(rows[1]?.querySelector('[aria-label="Agents working"]'), 'and it wears the working dots')

  // Auto-selection opens on content: the leading (needs-input) run fills the
  // canvas — its own projection, not the index row.
  const selected = container.querySelector('li button[aria-current="true"]')
  assert.ok(selected?.textContent?.includes('relay-traffic'), 'rail marks the auto-selection')
  // The bar is the run's NAME and its controls: the run's state is the rail
  // group it sits in and the canvas's own status line, never a chip in the app's
  // top strip repeating both.
  const surfaceBar = container.querySelector('section[aria-label="Sprints"] > div')
  assert.ok(
    !surfaceBar?.textContent?.includes('Waiting on you'),
    'no state chip in the surface bar',
  )
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

  // ── The project lens is an axis inside the rail's filter glyph ────────────
  // Same control, same place, same menu position as the Backlog door: one glyph
  // beside the search field holds every axis that narrows the list, so a person
  // moving between doors reaches for one thing, not two.
  const filterTrigger = (): HTMLElement => {
    const trigger = container.querySelector('button[aria-haspopup="menu"][aria-label^="Filter and sort"]')
    assert.ok(trigger, 'the rail narrows through one filter glyph')
    return trigger as HTMLElement
  }
  // The menu portals to document.body; scope to the Project group, since the
  // same menu also carries Sort.
  const projectOptions = (): HTMLElement[] =>
    [...dom.window.document.querySelectorAll('[role="group"][aria-label="Project"] [role="menuitemradio"]')] as HTMLElement[]
  const openFilter = async (): Promise<void> => {
    if (filterTrigger().getAttribute('aria-expanded') === 'true') return
    await act(async () => {
      filterTrigger().click()
    })
  }
  const pickFilter = async (label: string): Promise<void> => {
    // Picking does not close this menu, so opening is conditional — an
    // unconditional click would toggle an already-open menu shut.
    await openFilter()
    const option = projectOptions().find((candidate) => candidate.textContent?.startsWith(label))
    assert.ok(option, `the filter lists ${label}`)
    await act(async () => {
      ;(option as HTMLElement).click()
    })
    await act(async () => {
      await Promise.resolve()
    })
  }
  // Every project with a run is offered, counted, and no other — a project with
  // nothing to show is never listed.
  await openFilter()
  assert.deepEqual(
    projectOptions().map((option) => option.textContent),
    ['All projects · 5', 'multicode · 4', 'multicode-mobile · 1'],
    'All projects with the total, then one counted option per project with runs',
  )
  await act(async () => {
    filterTrigger().click()
  })
  await act(async () => {
    await Promise.resolve()
  })
  // One control block above the rows: New sprint, then search with the filter
  // glyph beside it, then the list. No second full-width Select stacked over the
  // field it narrows — the shape shared by every list surface.
  const railHtml = container.querySelector('aside[aria-label="Sprints list"]')?.innerHTML ?? ''
  const glyphAt = railHtml.indexOf('aria-haspopup="menu"')
  assert.ok(glyphAt > 0, 'the filter glyph renders inside the rail')
  assert.ok(
    !railHtml.includes('aria-label="Filter by project"'),
    'and no standalone project Select stands above the search',
  )
  assert.ok(
    railHtml.indexOf('New sprint') < railHtml.indexOf('Search sprints…'),
    'New sprint leads the rail, then search',
  )
  assert.ok(railHtml.indexOf('Search sprints…') < glyphAt, 'the glyph sits beside the search field')
  assert.ok(glyphAt < railHtml.indexOf('Sprints: '), 'and the whole block leads the rows')

  // The glyph sits INSIDE the rail's ↑/↓ + j/k handler and its own Arrow contract
  // does not stop propagation. Without a guard, opening it from the keyboard also
  // walked the rail and pulled focus onto a row — the control would be unusable
  // by keyboard. Arrow keys on the menu must move the menu and nothing else.
  const selectedRunName = (): string =>
    container.querySelector('li button[aria-current="true"]')?.textContent ?? ''
  const beforeArrow = selectedRunName()
  await act(async () => {
    filterTrigger().focus()
    filterTrigger().dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    )
  })
  assert.equal(selectedRunName(), beforeArrow, 'ArrowDown on the lens never walks the rail')
  assert.equal(
    dom.window.document.activeElement,
    filterTrigger(),
    'and never pulls focus off the control being used',
  )
  await act(async () => {
    filterTrigger().dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
  })

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
  assert.ok(needsYouList?.textContent?.includes('Waiting on you for'), 'with an honest waiting-for clock')
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
  // The claim lives on the canvas that can substantiate it — the surface bar
  // carries the run's name and its controls, and no state word at all.
  const bar = container.querySelector('h2')?.parentElement
  assert.ok(!bar?.textContent?.includes('Landed'), 'the bar never claims Landed while a branch is out')
  assert.ok(!bar?.textContent?.includes('Completed'), 'and states no run state of its own')
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
  // The run already carries an intent. With no workspace record to read it
  // from, the board must read it where it writes it — otherwise the controls
  // show defaults and a click that "changes nothing" is silently swallowed.
  intentRecords.set(doorStatePath, {
    desiredMode: 'run_agents_and_approve_artifacts',
    cliPermissionPreset: 'bypass',
    revision: 4,
  })
  const selectRailRun = async (teamSlug: string): Promise<void> => {
    const row = [...container.querySelectorAll('ul[role="list"][aria-label^="Sprints:"] > li button')].find(
      (candidate) => candidate.textContent?.includes(teamSlug),
    )
    assert.ok(row, `the rail lists ${teamSlug}`)
    await act(async () => {
      ;(row as HTMLElement).click()
    })
    await settle()
  }
  await selectRailRun('wake-filter-sprint')
  assert.equal(
    useWorkspaceStore.getState().workspaces.some((ws) => sprintEngineRunContext(ws)?.statePath === doorStatePath),
    false,
    'the run has no resident workspace — this is the door mount',
  )

  await openRunConfig()
  assert.equal(
    checkedAutomationMode(),
    'Run agents + approve artifacts',
    'the door reads the run’s own automation intent',
  )
  assert.ok(
    dom.window.document
      .querySelector('button[aria-label="CLI permission preset"]')
      ?.textContent?.includes('Bypass permissions'),
    'and its own CLI permission preset',
  )
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

  await pickCliPreset('Auto')
  assert.deepEqual(
    intentWrites[intentWrites.length - 1],
    { statePath: doorStatePath, preset: 'auto' },
    'the CLI permission preset takes the same statePath route',
  )
  const presetTrigger = dom.window.document.querySelector('button[aria-label="CLI permission preset"]')
  assert.ok(
    presetTrigger?.textContent?.includes('Auto'),
    'and the preset control holds what it wrote',
  )
  assert.equal(
    intentWrites.some((write) => write.workspaceId === ''),
    false,
    'no engine write is ever routed through the empty workspace-id sentinel',
  )

  // Switching runs must drop the previous run's intent: a run with no record of
  // its own reads Manual, never the run before it.
  await selectRailRun('post-merge-hardening')
  await openRunConfig()
  assert.equal(checkedAutomationMode(), 'Manual', 'a run with no intent of its own reads Manual')
  await selectRailRun('wake-filter-sprint')
  console.log('ok - the door mount routes both run-configuration controls by statePath')

  // ── Roster actions on the door mount (item 1800) ─────────────────────────
  // Enabling a role is an engine mutation on the RUN, so it completes by
  // statePath and the run's configured roles grow. Everything that needs the
  // run's workspace — spawning an agent, opening its terminal, adding another
  // agent — is disabled and says why, never a live button that does nothing.
  const openAgentsTab = async (): Promise<void> => {
    const tab = dom.window.document.getElementById('sprintengine-view-tab-roster')
    assert.ok(tab, 'the board carries the Agents tab')
    await act(async () => {
      ;(tab as HTMLElement).click()
    })
    await settle()
  }
  const buttonLabelled = (prefix: string): HTMLButtonElement | undefined =>
    ([...container.querySelectorAll('button')] as HTMLButtonElement[]).find((candidate) =>
      candidate.getAttribute('aria-label')?.startsWith(prefix),
    )
  const buttonSaying = (text: string): HTMLButtonElement | undefined =>
    ([...container.querySelectorAll('button')] as HTMLButtonElement[]).find((candidate) =>
      candidate.textContent?.includes(text),
    )
  // The census rides the Agents header. Found by the header that names itself
  // "Agents" rather than by a tag adjacency: the roster renders its identity row
  // through `ui/PanelHeader` now (2112), so the census is that row's subtitle
  // and the heading is the primitive's `h2` — the old `h3 + span` was reading
  // the hand-rolled band's shape, not the fact under test.
  const agentsCensus = (): string =>
    [...container.querySelectorAll('header')].find((candidate) =>
      candidate.textContent?.trimStart().startsWith('Agents'),
    )?.textContent ?? ''

  await openAgentsTab()
  assert.ok(
    registryRootReads.includes(projectRoot),
    'the door reads the role registry from the project its run lives in',
  )
  const doorSpawn = buttonLabelled('Spawn ')
  assert.ok(doorSpawn, 'the roster row still carries its Spawn action')
  assert.equal(doorSpawn.disabled, true, 'disabled, because the terminal would live in a closed workspace')
  assert.match(
    doorSpawn.getAttribute('aria-label') ?? '',
    /unavailable: this sprint’s workspace is closed/u,
    'and the disabled action explains itself where it sits',
  )
  const doorAddAgent = buttonSaying('Add an agent')
  assert.ok(doorAddAgent, 'the Agents header still offers Add an agent')
  assert.equal(doorAddAgent.disabled, true, 'both halves of it need the workspace, so it is disabled')
  assert.match(
    doorAddAgent.getAttribute('aria-label') ?? '',
    /unavailable: this sprint’s workspace is closed/u,
    'with the same reason',
  )
  assert.equal(
    container.querySelector('button[aria-label$=" actions"]'),
    null,
    'the row menu holds nothing operable without a workspace, so it is not offered',
  )

  // Add a role is engine-level: live on the door, and it reaches the engine by
  // statePath.
  const doorAddRole = buttonSaying('Add a role')
  assert.ok(doorAddRole, 'Add a role stays available — it writes to the run, not the workspace')
  assert.equal(doorAddRole.disabled, false, 'and it is live')
  assert.equal(agentsCensus().includes('1 configured role'), true, 'the run configures one role today')
  await act(async () => {
    doorAddRole.click()
  })
  const testerOption = [...dom.window.document.querySelectorAll('[role="menuitem"]')].find(
    (candidate) => candidate.textContent?.trim() === 'Tester',
  )
  assert.ok(testerOption, 'the menu lists the roles this run does not configure yet')
  await act(async () => {
    ;(testerOption as HTMLElement).click()
  })
  await settle(8)
  assert.deepEqual(
    enableRoleCalls,
    [{ statePath: doorStatePath, role: 'tester' }],
    'the role is enabled on the run by statePath, with no workspace standing in for one',
  )
  assert.ok(
    agentsCensus().includes('2 configured roles'),
    'the run’s configured roles reflect the write',
  )
  assert.ok(
    container.querySelector('section[aria-label="Tester"]'),
    'and the new role has its band on the board',
  )
  assert.ok(
    container.textContent?.includes('No agents yet'),
    'no agent was minted for it — the door enables the role and starts nothing',
  )
  // The board's own overflow carries the same split: reading the plan opens a
  // tab in the run's workspace, so it is disabled here rather than inert.
  const openBoardOverflow = async (): Promise<void> => {
    const trigger = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.getAttribute('aria-label') === 'Sprint overflow',
    )
    assert.ok(trigger, 'the board header carries its overflow menu')
    await act(async () => {
      ;(trigger as HTMLElement).click()
    })
    await settle(2)
  }
  const overflowItem = (label: string): HTMLButtonElement | undefined =>
    ([...dom.window.document.querySelectorAll('[data-overflow-item="true"]')] as HTMLButtonElement[])
      .find((candidate) => candidate.textContent?.includes(label))
  await openBoardOverflow()
  assert.equal(overflowItem('Read plan')?.disabled, true, 'Read plan needs a workspace to open a tab in')
  // …and it SAYS why. A menu item's label is its only copy channel — there is no
  // hover surface and no room for a caption — so a greyed row with no reason
  // reads as a bug. The disposal menu's "Delete sprint (its folder can't be
  // found)" set this shape; the workspace-bound board items follow it.
  assert.match(
    overflowItem('Read plan')?.textContent ?? '',
    /workspace is closed/,
    'a disabled control says what would make it available',
  )
  await act(async () => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await settle(2)
  console.log('ok - the door enables a role by statePath and offers no action it cannot finish')

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
          teamDirectoryPath: `${projectRoot}/.sprintengine/sprintengine/wake-filter-sprint`,
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
  await pickCliPreset('Auto')
  assert.equal(
    residentAutoState()?.cliPermissionPreset,
    'auto',
    'the preset lands in the workspace store the spawn path reads',
  )
  assert.deepEqual(
    intentWrites[intentWrites.length - 1],
    { statePath: doorStatePath, preset: 'auto' },
    'and mirrors into the run’s statePath-keyed record',
  )
  console.log('ok - the resident mount keeps its optimistic store write and reaches the same record')

  // ── And its roster actions are all still live (item 1800) ────────────────
  // Same run, same board, with its workspace resident: nothing is disabled and
  // the row keeps its hover menu.
  await openAgentsTab()
  const residentSpawn = buttonLabelled('Spawn ')
  assert.ok(residentSpawn, 'the roster row carries its Spawn action')
  assert.equal(residentSpawn.disabled, false, 'live, because the terminal has a workspace to run in')
  assert.equal(
    residentSpawn.getAttribute('aria-label')?.includes('unavailable'),
    false,
    'and it claims no unavailability',
  )
  assert.equal(buttonSaying('Add an agent')?.disabled, false, 'Add an agent is live')
  assert.ok(
    container.querySelector('button[aria-label$=" actions"]'),
    'and the row keeps its actions menu',
  )
  const residentAddRole = buttonSaying('Add a role')
  assert.ok(residentAddRole, 'Add a role is offered here too')
  await act(async () => {
    residentAddRole.click()
  })
  // Tester was enabled from the door above, so the run no longer offers it —
  // Security is the role this run still does not configure.
  const residentOption = [...dom.window.document.querySelectorAll('[role="menuitem"]')].find(
    (candidate) => candidate.textContent?.trim() === 'Security',
  )
  assert.ok(residentOption, 'the menu lists the roles this run does not configure yet')
  await act(async () => {
    ;(residentOption as HTMLElement).click()
  })
  await settle(8)
  assert.deepEqual(
    enableRoleCalls[enableRoleCalls.length - 1],
    { statePath: doorStatePath, role: 'security' },
    'and it reaches the engine by the same statePath route',
  )
  await openBoardOverflow()
  assert.equal(overflowItem('Read plan')?.disabled, false, 'and it is live where there is a workspace')
  // The reason is carried by the disabled state, not bolted onto the label for
  // good: a live control is named by what it does and nothing else.
  assert.equal(
    overflowItem('Read plan')?.textContent?.trim(),
    'Read plan',
    'a live control carries no unavailability clause',
  )
  await act(async () => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await settle(2)
  console.log('ok - the resident mount keeps every roster action live')

  // ── A handed-over link path spelled with foreign separators (item 1803) ──
  // The Backlog link builds forward slashes; the index builds native-separator
  // paths. Raw equality drops the link and the door opens the wrong run.
  await act(async () => {
    root3.unmount()
  })
  const windowsRoot = 'C:\\work\\multicode'
  const windowsStatePath = `${windowsRoot}\\.sprintengine\\sprintengine\\win-run\\run.yaml`
  listed = [
    summary({
      teamSlug: 'other-run',
      root: windowsRoot,
      statePath: `${windowsRoot}\\.sprintengine\\sprintengine\\other-run\\run.yaml`,
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

  // ── A roleless run can still be given a role from the door (MC-2057) ─────
  // `configuredRoles: []` is an EXPLICIT empty role set, not a missing one. The
  // door's roster gate used to test its LENGTH, so the sprint kind this epic
  // makes the default offered no roster mutation at all — a user could not add
  // a role to it. Mounted and clicked through, not reasoned about: the run with
  // the empty set reaches the engine, and the legacy run that records no set at
  // all still does not.
  await act(async () => {
    root4.unmount()
  })
  const rolelessStatePath = statePathOf(projectRoot, 'roleless-run')
  const legacyStatePath = statePathOf(projectRoot, 'legacy-run')
  listed = [
    summary({ teamSlug: 'roleless-run', runtimeState: 'running' }),
    summary({ teamSlug: 'legacy-run', runtimeState: 'running' }),
  ]
  projections.set(
    rolelessStatePath,
    projection({
      name: 'roleless-run',
      repos: [{ id: 'primary', root: '.', pr: null, state: null }],
      tasks: [{ id: 'T1', repo: 'primary', dependsOn: [], status: 'in_progress', role: null }],
      configuredRoles: [],
      roster: { coordinator: { status: 'running', currentTaskId: 'T1' } },
    }),
  )
  // The legacy shape: no `configuredRoles` key, no `rosterConfigured` — its team
  // lives in a workspace record the door cannot reach.
  projections.set(
    legacyStatePath,
    projection({
      name: 'legacy-run',
      repos: [{ id: 'primary', root: '.', pr: null, state: null }],
      tasks: [{ id: 'T1', repo: 'primary', dependsOn: [], status: 'in_progress' }],
    }),
  )
  const root5 = createRoot(container)
  await act(async () => {
    root5.render(surface())
  })
  await settle()
  await selectRailRun('roleless-run')
  assert.equal(
    useWorkspaceStore.getState().workspaces.some((ws) => sprintEngineRunContext(ws)?.statePath === rolelessStatePath),
    false,
    'the roleless run has no resident workspace either — this is the door mount',
  )
  await openBoardOverflow()
  const rolelessMoreRoles = overflowItem('More roles')
  assert.ok(rolelessMoreRoles, 'the board overflow carries the add-a-role route')
  assert.equal(
    rolelessMoreRoles.disabled,
    false,
    'a roleless run offers roster mutation: its empty role set is one the engine can grow',
  )
  assert.equal(
    rolelessMoreRoles.textContent?.trim(),
    'More roles',
    'and it claims no unavailability',
  )
  await act(async () => {
    rolelessMoreRoles.click()
  })
  await settle(3)
  const addRoleDialog = dom.window.document.getElementById('add-member-dialog-title')
  assert.equal(addRoleDialog?.textContent, 'Add a role', 'the door adds a role, not an agent it cannot start')
  const rolelessRoleOption = ([...dom.window.document.querySelectorAll('button[aria-pressed]')] as HTMLButtonElement[])
    .find((candidate) => candidate.textContent?.includes('Tester'))
  assert.ok(rolelessRoleOption, 'every role is offered — this run configures none of them yet')
  await act(async () => {
    rolelessRoleOption.click()
  })
  await settle(2)
  const confirmAddRole = ([...dom.window.document.querySelectorAll('button')] as HTMLButtonElement[])
    .find((candidate) => candidate.textContent?.trim() === 'Add Tester')
  assert.ok(confirmAddRole, 'the dialog confirms on the picked role')
  await act(async () => {
    confirmAddRole.click()
  })
  await settle(8)
  assert.deepEqual(
    enableRoleCalls[enableRoleCalls.length - 1],
    { statePath: rolelessStatePath, role: 'tester' },
    'the role reaches the engine on the roleless run’s own state path',
  )

  await selectRailRun('legacy-run')
  await openBoardOverflow()
  const legacyMoreRoles = overflowItem('More roles')
  assert.ok(legacyMoreRoles, 'the legacy run carries the same menu row')
  assert.equal(
    legacyMoreRoles.disabled,
    true,
    'a run that records no role set at all has no engine route — its team is workspace-only',
  )
  assert.match(
    legacyMoreRoles.textContent ?? '',
    /workspace is closed/u,
    'and the disabled row says what would make it available',
  )
  const enableCallsBefore = enableRoleCalls.length
  await act(async () => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await settle(2)
  assert.equal(enableRoleCalls.length, enableCallsBefore, 'and nothing was written for it')
  console.log('ok - a roleless run can be given a role from the door; a legacy run still cannot')

  // ── …and on its own workspace it reads as a configured run (MC-2057) ─────
  // A roleless run seeds one roleless seat, and that seat now crosses the init
  // wire, so the run records `rosterConfigured: true`. The dialog's title is
  // what that flag reaches the user as: "Add an agent", not the pre-roster
  // "Spawn a team agent" a run whose team predates run-level agents gets.
  await act(async () => {
    root5.unmount()
  })
  const residentRolelessStatePath = statePathOf(projectRoot, 'roleless-resident')
  listed = [summary({ teamSlug: 'roleless-resident', runtimeState: 'running' })]
  projections.set(
    residentRolelessStatePath,
    projection({
      name: 'roleless-resident',
      repos: [{ id: 'primary', root: '.', pr: null, state: null }],
      tasks: [{ id: 'T1', repo: 'primary', dependsOn: [], status: 'in_progress', role: null }],
      configuredRoles: [],
      roster: { coordinator: { status: 'running', currentTaskId: 'T1' } },
    }),
  )
  useWorkspaceStore.setState({
    workspaces: [
      { id: 'w1', name: 'multicode', mode: 'standard', folderPath: projectRoot, agents: {}, openFiles: [], createdAt: 1 },
      {
        id: 'w4',
        name: 'roleless-resident',
        mode: 'sprintengine',
        folderPath: projectRoot,
        agents: {},
        openFiles: [],
        createdAt: 4,
        sprintEngineContext: {
          teamName: 'roleless-resident',
          teamSlug: 'roleless-resident',
          teamDirectoryPath: `${projectRoot}/.sprintengine/sprintengine/roleless-resident`,
          statePath: residentRolelessStatePath,
        },
        sprintEngineState: normalizeSprintEngineProjection(
          projections.get(residentRolelessStatePath),
          'roleless-resident',
        ),
      },
    ],
    activeWorkspaceId: 'w1',
    activeGlobalSurface: 'sprints',
  } as never)
  const root6 = createRoot(container)
  await act(async () => {
    root6.render(surface())
  })
  await settle()
  await selectRailRun('roleless-resident')
  await openBoardOverflow()
  const residentMoreRoles = overflowItem('More roles')
  assert.equal(residentMoreRoles?.disabled, false, 'the resident mount offers it too')
  await act(async () => {
    ;(residentMoreRoles as HTMLButtonElement).click()
  })
  await settle(3)
  assert.equal(
    dom.window.document.getElementById('add-member-dialog-title')?.textContent,
    'Add an agent',
    'a roleless run reads as roster-configured, so it adds an agent rather than spawning a team one',
  )
  await act(async () => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await settle(2)
  console.log('ok - a roleless run reads as roster-configured on its own workspace')

  // ── A store this build is too old to read fails permanently (MC-2063) ─────
  // The rail keeps listing it ("details unavailable"); selecting it is where the
  // reason is spelled out — once, with the remedy. What it must NOT say is that
  // the failure is temporary, or offer a "Try again" that can only fail again.
  await act(async () => {
    root6.unmount()
  })
  listed = [
    summary({
      teamSlug: 'ancient-run',
      runtimeState: 'unknown',
      unknownReason: 'This sprint was created by an older version of Multicode (run store v2, this build reads v5) and cannot be opened.',
      unknownKind: 'unsupported_store',
    }),
  ]
  // No projection for it: the read fails, exactly as a rejected store's does.
  useWorkspaceStore.setState({
    workspaces: [
      { id: 'w1', name: 'multicode', mode: 'standard', folderPath: projectRoot, agents: {}, openFiles: [], createdAt: 1 },
    ],
    activeWorkspaceId: 'w1',
    activeGlobalSurface: 'sprints',
  } as never)
  const root7 = createRoot(container)
  await act(async () => {
    root7.render(surface())
  })
  await settle()
  await selectRailRun('ancient-run')
  const tooOldCanvas = container.textContent ?? ''
  assert.ok(tooOldCanvas.includes('can’t be opened by this version'), 'the canvas names it as unopenable, not unread')
  assert.ok(!tooOldCanvas.includes('usually temporary'), 'a permanent rejection is never called temporary')
  assert.ok(!tooOldCanvas.includes('Try again'), 'and is not offered a retry that can only fail')
  console.log('ok - a run store too old to read fails permanently, with its remedy')

  assert.ok(listCalls >= 1, 'the index was actually read over IPC')
  // Tear the surface down so the door's projection-refresh driver (and its
  // interval) is disposed — a leaked driver would keep this process alive.
  await act(async () => {
    root7.unmount()
  })

  // ── The Sprints door lists only sprints (item 2470) ───────────────────────
  // The index is one read for both doors, and the partition is what separates
  // them. A run whose coordinator seat is NAMED is a workflow: it must not be in
  // this rail at all — not greyed, not badged, absent — because the door beside
  // this one is where it lives. The classification reads the seat the summary
  // carries, never a role name (`runDoors.ts`).
  listed = [
    summary({ teamSlug: 'graph-already-written', coordinatorSeat: { agentId: 'coordinator' } }),
    summary({
      teamSlug: 'goal-to-be-planned',
      coordinatorSeat: { role: 'architect', agentId: 'architect' },
    }),
    // A run whose projection could not be read states no kind at all, and must
    // not vanish: it stays in the door every run has always been listed in.
    summary({ teamSlug: 'unreadable-run', runtimeState: 'unknown', coordinatorSeat: null }),
  ]
  const partitionRoot = createRoot(container)
  await act(async () => {
    partitionRoot.render(surface())
  })
  await settle()
  const sprintsRail = container.querySelector('aside[aria-label="Sprints list"]')?.textContent ?? ''
  assert.ok(sprintsRail.includes('graph-already-written'), 'a roleless run is a sprint and lists here')
  assert.ok(sprintsRail.includes('unreadable-run'), 'and so does a run that cannot say what it is')
  assert.ok(
    !sprintsRail.includes('goal-to-be-planned'),
    'a run with a named coordinator seat belongs to Workflows and is absent from this rail',
  )
  console.log('ok - the Sprints door lists only its own runs, and loses none of them')
  await act(async () => {
    partitionRoot.unmount()
  })

  console.log('all Sprints surface composition tests passed')
}

main().catch((error) => {
  console.error('not ok - Sprints surface composition')
  console.error(error)
  process.exit(1)
})
