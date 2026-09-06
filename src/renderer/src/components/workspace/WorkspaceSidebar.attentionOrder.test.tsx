import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// A folder's rows band by what wants you before they order by recency:
// blocked on input, then finished-while-you-were-away, then running, then at
// rest. Recency alone could only ever answer "what did I touch last", which is
// why a row waiting on a permission prompt used to sit five rows down under
// chats nobody was waiting on.
//
// The second half of the contract is the seat the selected row holds. Selecting
// a row is what clears its green mark, so a naive re-sort would drop the row out
// from under the cursor that just clicked it — the reflow ruled against in
// `workspace-row-move-on-click` (id 88). The row keeps its band until you select
// something else, and only then settles.

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
anyGlobal.Node = dom.window.Node
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

// Bravo's agent is alive and hook-reported idle: the "genuinely finished, not
// killed" shape that earns the green mark when its working clock stops.
domWindow.api = {
  platform: 'darwin',
  detectProjectLogo: async () => null,
  terminalList: async () => [
    {
      sessionId: 's2',
      workspaceId: 'w2',
      processAlive: true,
      kind: 'agent',
      cli: 'claude-code',
      activity: { kind: 'idle', since: 1 },
      agentState: { phase: 'idle', since: 1, source: 'hook' },
    },
  ],
  onTerminalSessionsChanged: () => () => {},
  onSprintRunsChanged: () => () => {},
  listSprintRuns: async () => [],
  getWorkspaceChangeSummary: async () => null,
}

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
  type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
  type Workspace = SidebarProps['workspaces'][number]

  // Every row is created at the same instant, so the recency comparator ties
  // them all and stored order alone decides within a band. Any reordering the
  // assertions see is the banding, never a recency accident.
  const createdAt = Date.now()
  const workspace = (id: string, name: string) =>
    ({ id, name, mode: 'standard', folderPath: '/projA', createdAt }) as unknown as Workspace

  const workspaces = [
    workspace('w1', 'Alpha'),
    workspace('w2', 'Bravo'),
    workspace('w3', 'Charlie'),
    workspace('w4', 'Delta'),
  ]

  const recency = (workingSince: number | null) => ({
    hasRunning: workingSince !== null,
    idleSince: workingSince === null ? createdAt : null,
    lastInputAt: createdAt,
    workingSince,
  })

  const noop = () => {}
  const baseProps = {
    workspaces,
    workspaceWindowId: 'win1',
    isDetachedWindow: false,
    sidebarCollapsed: false,
    chromeSlot: null,
    residentWorkspaceIds: new Set<string>(),
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
  }

  // Alpha runs, Bravo runs, Charlie is blocked on a prompt, Delta rests.
  const whileBravoWorks = {
    ...baseProps,
    activeWorkspaceId: 'w4',
    activityByWorkspaceId: { w1: 'working', w2: 'working', w3: 'needs-input', w4: 'idle' },
    terminalRecencyByWorkspaceId: { w1: recency(createdAt), w2: recency(createdAt), w4: recency(null) },
  } as unknown as SidebarProps

  // Bravo's working clock stops against a hook-settled session: it earns the
  // green mark, and its band with it.
  const afterBravoFinishes = {
    ...whileBravoWorks,
    activityByWorkspaceId: { w1: 'working', w2: 'idle', w3: 'needs-input', w4: 'idle' },
    terminalRecencyByWorkspaceId: { w1: recency(createdAt), w2: recency(null), w4: recency(null) },
  } as unknown as SidebarProps

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  const settle = async (): Promise<void> => {
    for (let round = 0; round < 6; round += 1) {
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      act(() => {})
    }
  }

  const render = async (props: SidebarProps): Promise<void> => {
    act(() => {
      root.render(React.createElement(WorkspaceSidebar, props))
    })
    await settle()
  }

  // Rows carry their name as text; reading them in DOM order reads the list
  // exactly as someone scanning the sidebar top to bottom does.
  const rowOrder = (): string[] =>
    [...container.querySelectorAll('[role="treeitem"]')]
      .map((row) => ['Alpha', 'Bravo', 'Charlie', 'Delta'].find((name) => row.textContent?.includes(name)))
      .filter((name): name is string => name !== undefined)

  try {
    await render(whileBravoWorks)
    assert.deepEqual(
      rowOrder(),
      ['Charlie', 'Alpha', 'Bravo', 'Delta'],
      'blocked first, then the two running rows in stored order, then the row at rest'
    )

    await render(afterBravoFinishes)
    assert.deepEqual(
      rowOrder(),
      ['Charlie', 'Bravo', 'Alpha', 'Delta'],
      'the row that just finished lifts above the row still running'
    )

    // Selecting Bravo clears its green mark. The seat must not move with it.
    await render({ ...afterBravoFinishes, activeWorkspaceId: 'w2' } as unknown as SidebarProps)
    assert.deepEqual(
      rowOrder(),
      ['Charlie', 'Bravo', 'Alpha', 'Delta'],
      'the selected row holds the band it was in — nothing reflows under the cursor'
    )

    // Selecting anything else releases the seat, and Bravo settles back among
    // the rows at rest.
    await render({ ...afterBravoFinishes, activeWorkspaceId: 'w4' } as unknown as SidebarProps)
    assert.deepEqual(
      rowOrder(),
      ['Charlie', 'Alpha', 'Bravo', 'Delta'],
      'once you select something else the row settles into its recency seat'
    )
  } finally {
    act(() => {
      root.unmount()
    })
  }
}

main()
  .then(() => console.log('workspace sidebar attention order tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
