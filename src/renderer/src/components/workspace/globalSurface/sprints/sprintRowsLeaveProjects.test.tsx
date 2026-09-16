import assert from 'node:assert/strict'
import { sprintEngineRunContext } from '../../../../store/slices/workspaceModuleState'

import { JSDOM } from 'jsdom'
import { bindSprintEngineIpc } from '../../../../modules/sprint-engine-ipc'

// Item 1767, end to end on the rendered surfaces: a sprint run is no longer a
// Projects-list row, and everything the row carried still has a way in. The
// Electron app cannot be driven headlessly, so this stands up a real DOM, stubs
// the run-index and projection IPC, and mounts the actual sidebar, the actual
// Sprints door, and the actual door nav entry against one shared store.
//
// The walk: a run exists → the Projects list does not show it → the door lists it
// → "Open agents" activates its workspace → the sidebar still has exactly one
// selected thing (the Sprints door, holding the context the row used to) → and
// the workspace renders whole rather than being treated as closed.

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
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
anyGlobal.ResizeObserver = NoopResizeObserver
dom.window.ResizeObserver = NoopResizeObserver as unknown as typeof dom.window.ResizeObserver

const projectRoot = '/work/multicode'
const runSlug = 'july-hardening'
const runName = 'july-hardening'
const statePath = `${projectRoot}/.sprintengine/sprintengine/${runSlug}/run.yaml`

const runSummary = {
  statePath,
  teamSlug: runSlug,
  teamName: runName,
  projectRoot,
  projectName: 'multicode',
  runtimeState: 'running',
  taskCounts: { total: 4, done: 1, inProgress: 1, waiting: 2 },
  repoRollup: { declared: 1, merged: 0, open: 1 },
  needsInputCount: 0,
  branchName: null,
  worktreePath: null,
  startedAt: '2026-07-22T09:00:00Z',
  updatedAt: '2026-07-22T10:00:00Z',
  finishedAt: null,
  sourceLabel: null,
}

// The run's projection, as `sprintengine:projection:read` hands it back. Enough
// for the canvas to reach `ready` and render its bar actions.
const runProjection = {
  run: { name: runName, goal: 'Harden the runner', vcs: null },
  tasks: [{ id: 'T1', title: 'Task T1', role: 'developer', status: 'in_progress', dependsOn: [] }],
}

const api: Record<string, unknown> = {
  platform: 'darwin',
  listSprintRuns: async () => [runSummary],
  onSprintRunsChanged: () => () => {},
  readSprintEngineProjection: async (target: string) =>
    target === statePath
      ? { ok: true, data: runProjection, token: 'token-1' }
      : { ok: false, message: 'This run’s projection could not be read.' },
}

// The tailnet/fleet presence bridge is ABSENT here, deliberately, rather than
// stubbed. `hasTailnetPresenceBridge` (useTailnetPresence.ts) requires all six
// of these to be functions and otherwise leaves the sidebar's Remote band empty
// — the path every other WorkspaceSidebar harness takes, because none of them
// hand `window.api` a fleet at all. This is the only one with a catch-all
// Proxy, so it alone answered `fleetListConnections()` with the Proxy's
// `{ ok: false, message: 'not stubbed' }`; `buildRemoteBand` called `.map` on
// that object and the sidebar threw at mount with "connections.map is not a
// function" (added by the remote-band sidebar work, 2026-09-05, which landed
// after this harness and was never seen because the verify chain halted
// earlier). Naming them undefined keeps `prop in target` true, so the Proxy
// hands back undefined and the guard reads the bridge as missing — which it
// is. This test says nothing about the Remote band; stubbing a fleet here
// would be inventing a shape no assertion reads.
for (const absent of [
  'onTailnetEvent',
  'onFleetEvent',
  'tailnetGetStatus',
  'tailnetGetLiveState',
  'fleetListConnections',
  'fleetGetLiveState',
]) {
  api[absent] = undefined
}

// The board mounts inside the canvas and reaches a wide slice of the preload API.
// Unstubbed members answer inertly rather than throwing: subscriptions hand back
// an unsubscribe, calls resolve to a refusal — never a fake success.
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
  const { useWorkspaceStore } = await import('../../../../store/workspaceStore')
  const { default: WorkspaceSidebar } = await import('../../WorkspaceSidebar')
  const { default: SprintsGlobalSurface } = await import('./SprintsGlobalSurface')
  const { SprintsNavEntry } = await import('./SprintsNavEntry')
  const { subscribeCloseSprintWorkspaceRequests } = await import('./sprintDoorRequests')
  const { ConfirmDialogProvider } = await import('../../../ui/ConfirmDialog')
  bindSprintEngineIpc(domWindow.api as never)

  async function settle(times = 6): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await act(async () => {
        await Promise.resolve()
      })
    }
  }

  // One project workspace and the run's own workspace, in the same folder —
  // exactly the shape the old nesting produced.
  const projectWorkspace = {
    id: 'w-project',
    name: 'multicode',
    mode: 'standard',
    folderPath: projectRoot,
    agents: {},
    openFiles: [],
    createdAt: 1,
  }
  const sprintWorkspace = {
    id: 'w-sprint',
    name: runName,
    mode: 'sprintengine',
    folderPath: projectRoot,
    agents: {},
    openFiles: [],
    createdAt: 2,
    moduleState: {
      sprintengine: {
        context: {
          teamName: runName,
          teamSlug: runSlug,
          teamDirectoryPath: `${projectRoot}/.sprintengine/sprintengine/${runSlug}`,
          statePath,
        },
      },
    },
  }
  useWorkspaceStore.setState({
    workspaces: [projectWorkspace, sprintWorkspace],
    activeWorkspaceId: 'w-project',
    activeGlobalSurface: null,
    workspaceWindows: [
      {
        id: 'win1',
        kind: 'primary',
        workspaceIds: ['w-project', 'w-sprint'],
        activeWorkspaceId: 'w-project',
        lastFocusedAt: 1,
      },
    ],
    primaryWorkspaceWindowId: 'win1',
  } as never)

  // ── The Projects list ─────────────────────────────────────────────────────
  const noop = (): void => {}
  const sidebarProps = {
    workspaces: [projectWorkspace, sprintWorkspace],
    activeWorkspaceId: 'w-project',
    workspaceWindowId: 'win1',
    isDetachedWindow: false,
    sidebarCollapsed: false,
    chromeSlot: null,
    activityByWorkspaceId: {},
    residentWorkspaceIds: new Set<string>(),
    terminalRecencyByWorkspaceId: {},
    onSelectWorkspace: noop,
    onMoveWorkspaceToNewWindow: noop,
    onMoveWorkspaceToMainWindow: noop,
    onCloseWorkspace: noop,
    onDeleteWorkspaceWithState: noop,
    onForgetFolder: noop,
    onNewChat: noop,
    onNewChatInFolder: noop,
    onRevealFolder: noop,
    onSetSidebarCollapsed: noop,
    sidebarWidth: 260,
    onSetSidebarWidth: noop,
    authState: { authenticated: false },
    authMessage: null,
    accountOpen: false,
    setAccountOpen: noop,
    startLogin: noop,
    refreshAuthState: noop,
    logout: noop,
    openSettings: noop,
    settingsOpen: false,
  } as unknown as Parameters<typeof WorkspaceSidebar>[0]

  const sidebarHost = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(sidebarHost)
  const sidebarRoot = createRoot(sidebarHost)
  await act(async () => {
    sidebarRoot.render(React.createElement(WorkspaceSidebar, sidebarProps))
  })
  await settle()

  const rowTitles = (): string[] =>
    [...sidebarHost.querySelectorAll('nav[role="tree"] [role="treeitem"]')].map(
      (row) => (row.textContent ?? '').trim(),
    )
  assert.ok(
    rowTitles().some((title) => title.includes('multicode')),
    'the project keeps its row',
  )
  assert.ok(
    !rowTitles().some((title) => title.includes(runName)),
    'the run is not a row under its project',
  )
  console.log('ok - the Projects list holds projects only; the run has no row')

  // ── The door ──────────────────────────────────────────────────────────────
  await act(async () => {
    useWorkspaceStore.setState({ activeGlobalSurface: 'sprints' } as never)
  })
  const surfaceHost = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(surfaceHost)
  const surfaceRoot = createRoot(surfaceHost)
  await act(async () => {
    surfaceRoot.render(
      React.createElement(ConfirmDialogProvider, null, React.createElement(SprintsGlobalSurface)),
    )
  })
  await settle()

  // Rail rows group under Needs you / Active / Recent (MC-1838); any group list
  // proves the rail rendered.
  const rail = surfaceHost.querySelector('ul[aria-label^="Sprints:"]')
  assert.ok(rail, 'the door renders its rail')
  assert.ok((rail!.textContent ?? '').includes(runName), 'the door lists the run the rail dropped')
  console.log('ok - the door lists the run, from the index rather than the rail')

  // ── Open agents ───────────────────────────────────────────────────────────
  const openAgents = [...surfaceHost.querySelectorAll('button')].find(
    (button) => (button.textContent ?? '').trim() === 'Open agents',
  ) as HTMLButtonElement | undefined
  assert.ok(openAgents, 'the canvas offers "Open agents"')
  assert.equal(openAgents!.disabled, false, 'a resident workspace makes it live')
  await act(async () => {
    openAgents!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await settle()

  assert.equal(
    useWorkspaceStore.getState().activeWorkspaceId,
    'w-sprint',
    'the run’s workspace is activated',
  )
  assert.equal(
    useWorkspaceStore.getState().activeGlobalSurface,
    null,
    'and the door steps aside so the terminals show',
  )
  console.log('ok - "Open agents" activates the run’s workspace and leaves the door')

  // ── Remove: the workflows the row's context menu carried ──────────────────
  // "Close workspace" and "Delete workspace…" left the Projects list with the
  // rows; the door's overflow is where they live now, and closing still goes
  // through the shell so the run's terminals are terminated rather than orphaned.
  const overflow = surfaceHost.querySelector(
    `button[aria-label="More actions for ${runName}"]`,
  ) as HTMLButtonElement | null
  assert.ok(overflow, 'the bar carries the run’s overflow')
  await act(async () => {
    overflow!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await settle(2)

  const menuItem = (label: string): HTMLButtonElement => {
    const found = [...dom.window.document.querySelectorAll('[role="menu"] button')].find((button) =>
      (button.textContent ?? '').trim().startsWith(label),
    )
    assert.ok(found, `the overflow offers "${label}"`)
    return found as HTMLButtonElement
  }
  assert.equal(menuItem('Close workspace').disabled, false, 'a resident workspace can be closed')
  assert.equal(menuItem('Delete sprint').disabled, false, 'the run can be deleted')

  const closeRequests: string[] = []
  const stopListening = subscribeCloseSprintWorkspaceRequests((id) => {
    closeRequests.push(id)
  })
  await act(async () => {
    menuItem('Close workspace').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await settle(2)
  const confirmButton = [...dom.window.document.querySelectorAll('button')].find(
    (button) => (button.textContent ?? '').trim() === 'Close workspace' && !button.closest('[role="menu"]'),
  ) as HTMLButtonElement | undefined
  assert.ok(confirmButton, 'closing is confirmed, never silent')
  await act(async () => {
    confirmButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await settle(2)
  assert.deepEqual(
    closeRequests,
    ['w-sprint'],
    'the shell is asked to close the run’s workspace, so its terminals stop',
  )
  stopListening()
  console.log('ok - the door carries "close workspace", confirmed and routed through the shell')

  // ── The delete is visible while it runs (T15) ─────────────────────────────
  // Deleting waits for the run's terminals to die before the folder is trashed
  // (item 1812), so it is a real wait — and selecting a menu item closes the
  // menu, which is the only place the "Deleting…" label lives. Without a signal
  // on the bar the operator types a sprint name, confirms an irreversible
  // action, and watches nothing happen.
  let releaseDelete = (): void => {}
  const trashed: string[] = []
  api.deletePath = (target: string) =>
    new Promise<void>((resolve) => {
      trashed.push(target)
      releaseDelete = () => resolve()
    })
  // Re-query the trigger: the bar re-rendered while the close was confirmed, so
  // the node captured above may no longer be the one on screen.
  const overflowNow = surfaceHost.querySelector(
    `button[aria-label="More actions for ${runName}"]`,
  ) as HTMLButtonElement | null
  assert.ok(overflowNow, 'the bar still carries the run’s overflow')
  await act(async () => {
    overflowNow!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await settle(2)
  await act(async () => {
    menuItem('Delete sprint').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await settle(2)
  const nameField = dom.window.document.querySelector('form input') as HTMLInputElement | null
  assert.ok(nameField, 'deleting a run is type-to-confirm, never one click')
  const setInputValue = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    'value',
  )?.set
  await act(async () => {
    setInputValue?.call(nameField, runName)
    nameField!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await settle(2)
  const confirmDelete = [...dom.window.document.querySelectorAll('button')].find(
    (button) => (button.textContent ?? '').trim() === 'Delete sprint',
  ) as HTMLButtonElement | undefined
  assert.ok(confirmDelete && !confirmDelete.disabled, 'the typed name unlocks the delete')
  await act(async () => {
    confirmDelete!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await settle(2)
  assert.deepEqual(
    trashed,
    [`${projectRoot}/.sprintengine/sprintengine/${runSlug}`],
    'the run’s own folder is what moves to the trash, never the state file alone',
  )
  assert.equal(
    dom.window.document.querySelector('[role="menu"]'),
    null,
    'the menu holding the "Deleting…" item closed the moment it was selected',
  )
  assert.match(
    surfaceHost.textContent ?? '',
    /Deleting…/,
    'so the bar itself carries the delete in flight',
  )
  await act(async () => {
    releaseDelete()
  })
  await settle(4)
  assert.doesNotMatch(
    surfaceHost.textContent ?? '',
    /Deleting…/,
    'and the signal goes when the delete lands',
  )
  console.log('ok - a delete in flight is visible on the bar, not in the menu it closed')

  // ── The sidebar still has exactly one selected thing ──────────────────────
  const navHost = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(navHost)
  const navRoot = createRoot(navHost)
  const renderNav = async (): Promise<void> => {
    await act(async () => {
      navRoot.render(React.createElement(SprintsNavEntry, { collapsed: false }))
    })
    await settle(2)
  }
  await renderNav()
  assert.equal(
    navHost.querySelector('button')?.getAttribute('aria-current'),
    'true',
    'inside a sprint’s terminals, the Sprints door holds the selected context',
  )

  // Re-render the sidebar in that state: no row claims the selection, which is
  // exactly why the door has to.
  await act(async () => {
    sidebarRoot.render(
      React.createElement(WorkspaceSidebar, { ...sidebarProps, activeWorkspaceId: 'w-sprint' }),
    )
  })
  await settle(2)
  assert.equal(
    sidebarHost.querySelector('nav[role="tree"] [role="treeitem"][aria-current="true"]'),
    null,
    'no Projects row pretends to be the active sprint',
  )
  console.log('ok - the Sprints door carries the selection while a run’s workspace is active')

  // Another door open: Sprints is no longer the context.
  await act(async () => {
    useWorkspaceStore.setState({ activeGlobalSurface: 'another-door' } as never)
  })
  await renderNav()
  assert.equal(
    navHost.querySelector('button')?.getAttribute('aria-current'),
    null,
    'another open door owns the selection instead',
  )
  console.log('ok - the context rule yields to whichever door is actually open')

  // ── Nothing was migrated away ─────────────────────────────────────────────
  const stored = useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === 'w-sprint')
  assert.ok(stored, 'the sprint workspace is still in the store')
  assert.equal(
    sprintEngineRunContext(stored)?.statePath,
    statePath,
    'with its run binding intact — hiding the row migrates nothing',
  )
  console.log('ok - the workspace object survives hidden, ids and binding intact')

  // Teardown, best-effort: unrelated sidebar tenants unsubscribe against the
  // stubbed preload API and can throw on the way out. That is the stub's limit,
  // not a finding, so it must not turn a green run red.
  try {
    await act(async () => {
      sidebarRoot.unmount()
      surfaceRoot.unmount()
      navRoot.unmount()
    })
  } catch {
    // ignored — see above
  }
  console.log('all sprint-rows-leave-Projects tests passed')
  // The mounted shell registers app-lifetime subscriptions (run-index change
  // listeners, poll drivers) that outlive unmount here; exit rather than wait on
  // an event loop nothing will drain.
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
