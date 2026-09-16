import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// The flat stream (all-chats-view, 2026-09-07). "All chats" drops the folder
// headers and lists every chat in one list, most recently active first with an
// agent's turn counted as activity, each row naming the project it files
// under. Which shape it draws is a persisted setting (Settings → Appearance),
// so this drives it through the store the way that panel does.
// `workspaceRecency.test.ts` holds the order; this holds the rail.

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
anyGlobal.requestAnimationFrame = (callback: FrameRequestCallback) =>
  dom.window.setTimeout(() => callback(Date.now()), 0) as unknown as number
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

domWindow.api = {
  platform: 'darwin',
  detectProjectLogo: async () => null,
  terminalList: async () => [],
  onTerminalSessionsChanged: () => () => {},
  getWorkspaceChangeSummary: async () => null,
  terminalKill: async () => {},
}

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
  const { useWorkspaceStore } = await import('../../store/workspaceStore')
  type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
  type Workspace = SidebarProps['workspaces'][number]

  const MINUTE = 60 * 1000
  const HOUR = 60 * MINUTE
  const now = Date.now()
  const workspace = (
    id: string,
    name: string,
    folderPath: string,
    fields: Partial<Workspace> = {}
  ): Workspace =>
    ({ id, name, mode: 'standard', folderPath, createdAt: now - 2 * HOUR, ...fields }) as unknown as Workspace

  // Three projects, ordered by when the PERSON last messaged each. Bravo is the
  // control: its agent finished a minute ago and a keystroke landed in it a
  // minute ago, but the person has not said anything there since yesterday, so
  // it must stay at the bottom rather than jump the row you were reaching for.
  const workspaces = [
    workspace('w1', 'Alpha', '/repo/apples', { lastUserMessageAt: now - 3 * HOUR }),
    workspace('w2', 'Bravo', '/repo/pears', {
      createdAt: now - 30 * HOUR,
      lastUserMessageAt: now - 26 * HOUR,
      lastTerminalActivityAt: now - MINUTE,
      lastTurnEndedAt: now - MINUTE,
    }),
    workspace('w3', 'Charlie', '/repo/apples', { lastUserMessageAt: now - 20 * MINUTE }),
    workspace('w4', 'Delta', '/repo/pears', {
      lastUserMessageAt: now - 10 * HOUR,
      settledAt: now - HOUR,
    }),
  ]

  const noop = () => {}
  const props = {
    workspaces,
    workspaceWindowId: 'win1',
    isDetachedWindow: false,
    sidebarCollapsed: false,
    chromeSlot: null,
    residentWorkspaceIds: new Set<string>(),
    activeWorkspaceId: 'w1',
    activityByWorkspaceId: { w1: 'idle', w2: 'idle', w3: 'idle', w4: 'idle' },
    terminalRecencyByWorkspaceId: {},
    onSelectWorkspace: noop,
    onMoveWorkspaceToNewWindow: noop,
    onMoveWorkspaceToMainWindow: noop,
    onCloseWorkspace: noop,
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

  const rowNames = (): string[] =>
    [...container.querySelectorAll('[role="treeitem"]')]
      .map((row) => ['Alpha', 'Bravo', 'Charlie', 'Delta'].find((name) => row.textContent?.includes(name)))
      .filter((name): name is string => name !== undefined)

  const rowFor = (name: string): HTMLElement => {
    const row = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((el) =>
      el.textContent?.includes(name)
    )
    assert.ok(row, `row ${name} is rendered`)
    return row
  }

  // The setting the Appearance panel writes. The rail reads it and draws the
  // shape; it has no control of its own to click (owner, 2026-09-07).
  const chooseView = (view: 'projects' | 'all') => {
    act(() => {
      useWorkspaceStore.getState().setChatListView(view)
    })
  }

  const folderHeadings = (): string[] =>
    [...container.querySelectorAll<HTMLElement>('nav header')].map((el) => el.textContent?.trim() ?? '')

  try {
    act(() => {
      root.render(React.createElement(WorkspaceSidebar, props))
    })
    await settle()

    // The tree is what the rail opens on.
    assert.equal(useWorkspaceStore.getState().chatListView, 'projects', 'the tree is the default shape')
    assert.ok(
      folderHeadings().some((heading) => heading.includes('apples')),
      `the tree draws a header per project (got ${folderHeadings().join(' | ')})`
    )
    assert.equal(
      container.querySelector('[role="radio"]'),
      null,
      'and the rail carries no view control of its own — the switch lives in Settings'
    )

    chooseView('all')
    await settle()

    assert.equal(useWorkspaceStore.getState().chatListView, 'all')
    assert.deepEqual(folderHeadings(), [], 'the stream has no folder headers')

    // Order: the chat the person messaged twenty minutes ago leads. Bravo's
    // agent finishing and the keystroke in it move nothing. Delta is resting
    // and is not in the stream.
    assert.deepEqual(
      rowNames(),
      ['Charlie', 'Alpha', 'Bravo'],
      'most recently messaged first; an agent turn and a keystroke are not the person speaking'
    )

    // Each row names the project it files under — the same name its folder
    // header carried a moment ago.
    assert.ok(rowFor('Bravo').textContent?.includes('pears'), 'a stream row names its project')
    assert.ok(rowFor('Charlie').textContent?.includes('apples'))

    // And gives back the indent it had under that header.
    assert.ok(rowFor('Bravo').className.includes('pl-1.5'), 'a stream row starts on the column edge')
    assert.equal(rowFor('Bravo').className.includes('pl-[26px]'), false)

    // Order is the clock's here, so there is no order to drag a row into.
    assert.equal(rowFor('Bravo').getAttribute('draggable'), 'false', 'no drag-to-reorder in the stream')

    // One shelf for the whole stream, not one per project.
    const shelf = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].filter((button) =>
      button.textContent?.startsWith('Settled')
    )
    assert.equal(shelf.length, 1, 'one Settled shelf at the foot of the stream')
    assert.match(shelf[0].textContent ?? '', /Settled\s*1/, 'holding the resting chats of every project')
    act(() => {
      shelf[0].click()
    })
    await settle()
    assert.ok(rowNames().includes('Delta'), 'opening it shows them')

    // Back to the tree, and the headers come back.
    chooseView('projects')
    await settle()
    assert.equal(useWorkspaceStore.getState().chatListView, 'projects')
    assert.ok(folderHeadings().some((heading) => heading.includes('pears')), 'the headers come back')
  } finally {
    act(() => {
      root.unmount()
    })
    useWorkspaceStore.setState({ chatListView: 'projects' })
  }
}

main()
  .then(() => console.log('workspace sidebar all-chats view tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
