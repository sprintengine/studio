import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// Empty folders (settled-chats follow-up, 2026-09-07). A project whose every
// chat has settled leaves the tree and folds into the Resting band at its
// foot: one line carrying the count, closed by default, and inside it each
// project's header over its resting chats — no second Settled fold, because the band already said that.
// The folder comes back the moment anything in it is active, selected, or
// un-settled. The settle rule itself is workspaceSettle.test.ts's; the shelf a
// half-resting folder shows is WorkspaceSidebar.settled.test.tsx's.

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

  const DAY = 24 * 60 * 60 * 1000
  const createdAt = Date.now()
  const workspace = (id: string, name: string, fields: Partial<Workspace> = {}) =>
    ({ id, name, mode: 'standard', folderPath: '/projA', createdAt, ...fields }) as unknown as Workspace

  // Relay is a live project: Alpha is its active chat, Bravo has come to rest
  // beside it. Attic is a project that has gone quiet altogether — both its
  // chats rest.
  const workspaces = [
    workspace('w1', 'Alpha'),
    workspace('w2', 'Bravo', { settledAt: createdAt - DAY, lastTerminalActivityAt: createdAt - 5 * DAY }),
    workspace('w3', 'Charlie', { folderPath: '/attic', settledAt: createdAt - DAY, lastTerminalActivityAt: createdAt - 5 * DAY }),
    workspace('w4', 'Delta', { folderPath: '/attic', settledAt: createdAt - DAY, lastTerminalActivityAt: createdAt - 4 * DAY }),
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

  const render = async (next: SidebarProps): Promise<void> => {
    act(() => {
      root.render(React.createElement(WorkspaceSidebar, next))
    })
    await settle()
  }

  /** Folder headers, split by where they are drawn: the tree, or inside the band. */
  const folderHeaders = (inBand: boolean): string[] => {
    const band = dom.window.document.getElementById('ws-resting-body')
    return [...container.querySelectorAll<HTMLElement>('button[aria-controls^="ws-folder-body-"]')]
      .filter((button) => (band !== null && band.contains(button)) === inBand)
      .map((button) => button.textContent?.trim() ?? '')
  }

  const folderNames = (): string[] => folderHeaders(false)
  const bandFolderNames = (): string[] => folderHeaders(true)

  const rowNames = (): string[] =>
    [...container.querySelectorAll('[role="treeitem"]')]
      .map((row) => ['Alpha', 'Bravo', 'Charlie', 'Delta'].find((name) => row.textContent?.includes(name)))
      .filter((name): name is string => name !== undefined)

  const bandButton = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('button[aria-controls="ws-resting-body"]')

  const shelfButton = (): HTMLButtonElement | null =>
    [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((button) =>
      button.textContent?.startsWith('Settled')
    ) ?? null

  try {
    await render(props)
    assert.deepEqual(folderNames(), ['projA'], 'the all-settled project is not a folder in the tree')
    assert.deepEqual(rowNames(), ['Alpha'], 'and none of its chats are rows there')
    assert.ok(shelfButton(), 'the live project still shows its own Settled shelf')

    const band = bandButton()
    assert.ok(band, 'the tree ends with the Resting band')
    assert.equal(band.getAttribute('aria-expanded'), 'false', 'closed by default')
    assert.match(band.textContent ?? '', /Resting\s*1/, 'the band carries how many projects it holds')
    const bandBody = dom.window.document.getElementById('ws-resting-body')
    assert.ok(bandBody, 'the band controls a real node')
    assert.equal(bandBody.hidden, true, 'hidden while closed')

    act(() => {
      band.click()
    })
    await settle()
    assert.equal(bandButton()?.getAttribute('aria-expanded'), 'true', 'opening the band is a disclosure')
    assert.deepEqual(folderNames(), ['projA'], 'the tree still lists only the live project')
    assert.deepEqual(bandFolderNames(), ['attic'], 'open, the resting project is a header of its own inside the band')
    assert.deepEqual(
      rowNames(),
      ['Alpha', 'Charlie', 'Delta'],
      'with its resting chats straight underneath, most recently worked first'
    )
    const shelves = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].filter((button) =>
      button.textContent?.startsWith('Settled')
    )
    assert.equal(shelves.length, 1, 'the band holds no second Settled fold — only the live folder has one')
    const charlie = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((el) =>
      el.textContent?.includes('Charlie')
    )
    assert.ok(charlie?.textContent?.includes('(settled)'), 'a row in the band still says it is resting')

    // Selecting a resting chat brings its project back: the row you are in is
    // never shelved, so the folder has an active row again.
    await render({ ...props, activeWorkspaceId: 'w3' } as unknown as SidebarProps)
    assert.deepEqual(folderNames(), ['projA', 'attic'], 'the selected chat puts its project back in the tree')
    assert.equal(bandButton(), null, 'and with nothing resting whole, the band is gone')
    assert.deepEqual(rowNames(), ['Alpha', 'Charlie'], 'Delta stays in its folder’s shelf')

    // Waking a chat by hand does the same.
    await render({
      ...props,
      workspaces: [workspaces[0], workspaces[1], { ...workspaces[2], settledAt: null }, workspaces[3]],
    } as unknown as SidebarProps)
    assert.deepEqual(folderNames(), ['projA', 'attic'], 'un-settling a chat wakes its project too')
    assert.equal(bandButton(), null)

    // Every project resting: the tree is only the band.
    await render({
      ...props,
      activeWorkspaceId: null,
      workspaces: [{ ...workspaces[0], settledAt: createdAt - DAY }, workspaces[1], workspaces[2], workspaces[3]],
    } as unknown as SidebarProps)
    assert.deepEqual(folderNames(), [], 'no folder headers left in the tree')
    assert.match(bandButton()?.textContent ?? '', /Resting\s*2/, 'the band counts both projects')
  } finally {
    act(() => {
      root.unmount()
    })
  }
}

main()
  .then(() => console.log('workspace sidebar resting folder tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
