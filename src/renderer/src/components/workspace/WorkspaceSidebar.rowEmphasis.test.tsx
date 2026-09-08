import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// Row contrast (contrast-for-quiet-chats, 2026-09-07). A sidebar where every
// chat is drawn at full ink has no foreground: weight goes to every chat
// someone is using, dim ink to the ones nobody is.
// `workspaceRowEmphasis.test.ts` holds which tier a row is in; this holds how
// the row draws it.

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

domWindow.api = {
  platform: 'darwin',
  detectProjectLogo: async () => null,
  terminalList: async () => [],
  onTerminalSessionsChanged: () => () => {},
  onSprintRunsChanged: () => () => {},
  listSprintRuns: async () => [],
  getWorkspaceChangeSummary: async () => null,
  terminalKill: async () => {},
}

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
  type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
  type Workspace = SidebarProps['workspaces'][number]

  const MINUTE = 60 * 1000
  const HOUR = 60 * MINUTE
  const now = Date.now()
  // Created just now, all of them: the rest sweep reads the record's clocks,
  // and a chat born minutes ago never settles. What separates these rows is
  // the terminal recency below — the same clock the row's idle label reads.
  const workspace = (id: string, name: string): Workspace =>
    ({ id, name, mode: 'standard', folderPath: '/projA', createdAt: now }) as unknown as Workspace

  const workspaces = [
    workspace('w1', 'Selected'),
    workspace('w2', 'Working'),
    workspace('w3', 'Waiting'),
    workspace('w4', 'Recent'),
    workspace('w5', 'Quiet'),
  ]

  const noop = () => {}
  const props = {
    workspaces,
    workspaceWindowId: 'win1',
    isDetachedWindow: false,
    sidebarCollapsed: false,
    chromeSlot: null,
    // Every row is resident: residency used to be what bolded a row, and the
    // point of the assertions below is that it no longer is.
    residentWorkspaceIds: new Set<string>(['w1', 'w2', 'w3', 'w4', 'w5']),
    activeWorkspaceId: 'w1',
    activityByWorkspaceId: {
      w1: 'idle',
      w2: 'working',
      w3: 'needs-input',
      w4: 'idle',
      w5: 'idle',
    },
    terminalRecencyByWorkspaceId: {
      // The selected row has been sitting for a day; selection outranks the
      // clock, so it still leads.
      w1: { hasRunning: false, idleSince: now - 24 * HOUR, lastInputAt: now - 24 * HOUR, workingSince: null },
      w2: { hasRunning: true, idleSince: null, lastInputAt: now - 3 * HOUR, workingSince: now - MINUTE },
      w3: { hasRunning: false, idleSince: now - 5 * HOUR, lastInputAt: now - 5 * HOUR, workingSince: null },
      w4: { hasRunning: false, idleSince: now - 22 * MINUTE, lastInputAt: now - 22 * MINUTE, workingSince: null },
      w5: { hasRunning: false, idleSince: now - 2 * HOUR, lastInputAt: now - 2 * HOUR, workingSince: null },
    },
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

  // The row's title element: the one node inside the row whose whole text is
  // the chat's name. That is where weight and ink land.
  const titleOf = (name: string): HTMLElement => {
    const row = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((el) =>
      el.textContent?.includes(name)
    )
    assert.ok(row, `row ${name} is rendered`)
    const title = [...row.querySelectorAll<HTMLElement>('span')].find(
      (el) => el.textContent?.trim() === name
    )
    assert.ok(title, `row ${name} has a title element`)
    return title
  }

  const bold = (name: string): boolean => titleOf(name).className.includes('font-semibold')
  const dim = (name: string): boolean => titleOf(name).className.includes('--text-subtle')

  try {
    act(() => {
      root.render(React.createElement(WorkspaceSidebar, props))
    })
    await settle()

    // One tier for every chat someone is using — no middle step.
    assert.equal(bold('Selected'), true, 'the selected row is bold')
    assert.equal(bold('Working'), true, 'a working agent bolds its row')
    assert.equal(bold('Waiting'), true, 'so does a row blocked on you')
    assert.equal(bold('Recent'), true, 'and one touched inside the hour')

    // And the background tier, which is where residency stopped mattering:
    // every row here is resident, and the untouched one is still dim.
    assert.equal(bold('Quiet'), false, 'two hours untouched is not bold, resident or not')

    // Ink: the hour line, and only the background tier moves off the row's own
    // ink. Selection's lift lives on the row class, not here.
    assert.equal(dim('Quiet'), true, 'two hours untouched drops to the dim ink')
    assert.equal(dim('Recent'), false, 'touched 22 minutes ago keeps full ink')
    assert.equal(dim('Waiting'), false, 'a waiting row never dims, however long it has been waiting')
    assert.equal(dim('Selected'), false, 'the row you are in never dims, whatever its clock says')

    // A dim row lifts back on hover, so reaching for one is never reading dim
    // text.
    assert.ok(
      titleOf('Quiet').className.includes('group-hover:text-[color:var(--text-default)]'),
      'a background row lifts to normal ink on hover'
    )
  } finally {
    act(() => {
      root.unmount()
    })
  }
}

main()
  .then(() => console.log('workspace sidebar row emphasis tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
