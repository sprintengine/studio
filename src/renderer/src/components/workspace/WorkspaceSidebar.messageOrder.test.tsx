import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// Every list in the sidebar orders by when the person last sent a message into
// each chat, newest first, and by nothing else (owner ruling 2026-09-09:
// "they keep moving up and down in my side panel... they should just stay put
// where they are based on when I send them a message last").
//
// The rows used to band by what wanted you — blocked, then finished-while-you-
// were-away, then running, then at rest — so an agent finishing lifted its row
// over chats the person had spoken in more recently. That lift was the jump the
// owner saw. The tints stayed and the banding went, which also retired the
// "held seat" that froze a selected row's band: with nothing reordering on
// status there is nothing to freeze, and the row that keeps its seat on a click
// (`workspace-row-move-on-click`, id 88) now does so for free.

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
// killed" shape that earns the green mark when its working clock stops. The
// mark is what used to move the row; here it must only recolour it.
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

  const MINUTE = 60 * 1000
  const createdAt = Date.now() - 60 * MINUTE
  // Distinct message stamps, so the order the assertions read is the message
  // order and nothing else. Alpha was spoken in most recently, Delta least.
  const workspace = (id: string, name: string, minutesAgo: number, starred = false) =>
    ({
      id,
      name,
      mode: 'standard',
      folderPath: '/projA',
      createdAt,
      lastUserMessageAt: Date.now() - minutesAgo * MINUTE,
      ...(starred ? { highlight: { starred: true } } : {}),
    }) as unknown as Workspace

  const workspaces = [
    workspace('w1', 'Alpha', 1),
    workspace('w2', 'Bravo', 2, true),
    workspace('w3', 'Charlie', 3),
    workspace('w4', 'Delta', 4, true),
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
  // green mark. The mark is the whole point — the row must not move with it.
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

  const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta']
  const namesIn = (scope: Element | null): string[] =>
    scope === null
      ? []
      : [...scope.querySelectorAll('[role="treeitem"]')]
          .map((row) => NAMES.find((name) => row.textContent?.includes(name)))
          .filter((name): name is string => name !== undefined)

  // The folder's own rows, read top to bottom the way someone scanning the
  // sidebar does. The Starred band renders the same chats again above the
  // folders, so it is scoped out here and asserted on separately.
  const rowOrder = (): string[] => {
    const starredBody = container.querySelector('#ws-starred-body')
    const starred = new Set(starredBody ? [...starredBody.querySelectorAll('[role="treeitem"]')] : [])
    return [...container.querySelectorAll('[role="treeitem"]')]
      .filter((row) => !starred.has(row))
      .map((row) => NAMES.find((name) => row.textContent?.includes(name)))
      .filter((name): name is string => name !== undefined)
  }

  const starredOrder = (): string[] => namesIn(container.querySelector('#ws-starred-body'))

  try {
    await render(whileBravoWorks)
    assert.deepEqual(
      rowOrder(),
      ['Alpha', 'Bravo', 'Charlie', 'Delta'],
      'message order, newest first — a running agent and a blocked one both sit where the person left them'
    )

    await render(afterBravoFinishes)
    assert.deepEqual(
      rowOrder(),
      ['Alpha', 'Bravo', 'Charlie', 'Delta'],
      'the row that just finished goes green in place: same row above it, same row below'
    )

    // Selecting Bravo clears its green mark. Nothing moved when the mark
    // arrived, so nothing may move when it goes.
    await render({ ...afterBravoFinishes, activeWorkspaceId: 'w2' } as unknown as SidebarProps)
    assert.deepEqual(
      rowOrder(),
      ['Alpha', 'Bravo', 'Charlie', 'Delta'],
      'nothing reflows under the cursor that just clicked'
    )

    // Charlie is the blocked row throughout, and stays third throughout: gold
    // tints a row, it never lifts one.
    await render({ ...afterBravoFinishes, activeWorkspaceId: 'w4' } as unknown as SidebarProps)
    assert.deepEqual(
      rowOrder(),
      ['Alpha', 'Bravo', 'Charlie', 'Delta'],
      'a row waiting on you keeps its seat too'
    )

    assert.deepEqual(
      starredOrder(),
      ['Bravo', 'Delta'],
      'the Starred band reads the same clock as the folders'
    )

    // The one event that moves a row: the person sends a message in Delta,
    // which lifts it to the top of its group — and of the Starred band.
    const afterDeltaMessage = {
      ...afterBravoFinishes,
      workspaces: workspaces.map((ws) =>
        ws.id === 'w4' ? ({ ...ws, lastUserMessageAt: Date.now() } as unknown as Workspace) : ws
      ),
    } as unknown as SidebarProps
    await render(afterDeltaMessage)
    assert.deepEqual(
      rowOrder(),
      ['Delta', 'Alpha', 'Bravo', 'Charlie'],
      'sending a message is the only thing that moves a row, and it moves it to the top'
    )
    assert.deepEqual(starredOrder(), ['Delta', 'Bravo'], 'the Starred band moves with it')
  } finally {
    act(() => {
      root.unmount()
    })
  }
}

main()
  .then(() => console.log('workspace sidebar message order tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
