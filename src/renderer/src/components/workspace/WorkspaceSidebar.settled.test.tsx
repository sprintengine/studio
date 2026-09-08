import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// Settled chats (2026-09-07). A folder's resting rows leave the active list
// for the folder's Settled shelf: one fold row carrying the count, closed by
// default, over compact rows. The row menu offers Settle on an active row and
// Un-settle on a resting one. This holds the shelf's shape; the rule that
// decides what rests is held by workspaceSettle.test.ts and the store by
// workspacesSlice.test.ts.

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

// Alpha holds a live agent pty; the settled rows hold nothing, which is what
// a chat that came to rest looks like after the kill lands.
const killed: string[] = []
domWindow.api = {
  platform: 'darwin',
  detectProjectLogo: async () => null,
  terminalList: async () => [
    {
      sessionId: 'alpha-pty',
      workspaceId: 'w1',
      processAlive: true,
      kind: 'agent',
      cli: 'claude-code',
      activity: { kind: 'idle', since: 1 },
    },
  ],
  onTerminalSessionsChanged: () => () => {},
  onSprintRunsChanged: () => () => {},
  listSprintRuns: async () => [],
  getWorkspaceChangeSummary: async () => null,
  terminalKill: async (sessionId: string) => {
    killed.push(sessionId)
  },
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

  // Alpha is active; Bravo and Charlie have come to rest, Charlie worked a
  // day more recently than Bravo — outside the sort's 30-minute "just now"
  // tie window, so recency and not stored order decides the shelf's order.
  const workspaces = [
    workspace('w1', 'Alpha', {
      agents: {
        'agent-1': {
          id: 'agent-1',
          name: 'Clod',
          cliSessionId: 'alpha-pty',
          status: 'idle',
          execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
          messages: [],
          streamBuffer: '',
        },
      },
    }),
    workspace('w2', 'Bravo', { createdAt: createdAt - 10 * DAY, settledAt: createdAt - DAY, lastTerminalActivityAt: createdAt - 5 * DAY }),
    workspace('w3', 'Charlie', { createdAt: createdAt - 10 * DAY, settledAt: createdAt - DAY, lastTerminalActivityAt: createdAt - 4 * DAY }),
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
    activityByWorkspaceId: { w1: 'idle', w2: 'idle', w3: 'idle' },
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

  const rowNames = (): string[] =>
    [...container.querySelectorAll('[role="treeitem"]')]
      .map((row) => ['Alpha', 'Bravo', 'Charlie'].find((name) => row.textContent?.includes(name)))
      .filter((name): name is string => name !== undefined)

  const actionLabel = (label: string): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

  const shelfButton = (): HTMLButtonElement | null =>
    [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((button) =>
      button.textContent?.startsWith('Settled')
    ) ?? null

  const openMenuOn = async (name: string): Promise<string[]> => {
    const row = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((el) =>
      el.textContent?.includes(name)
    )
    assert.ok(row, `row ${name} is rendered`)
    act(() => {
      row.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
    })
    await settle()
    const items = [...dom.window.document.querySelectorAll('[role="menu"] [data-menu-item="true"]')].map(
      (el) => el.textContent?.trim() ?? ''
    )
    act(() => {
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await settle()
    return items
  }

  try {
    await render(props)
    assert.deepEqual(rowNames(), ['Alpha'], 'only the active row is in the list at rest')
    const shelf = shelfButton()
    assert.ok(shelf, 'the folder shows its Settled shelf row')
    assert.equal(shelf.getAttribute('aria-expanded'), 'false', 'the shelf is closed by default')
    assert.match(shelf.textContent ?? '', /Settled\s*2/, 'the shelf row carries the count')
    const shelfBody = dom.window.document.getElementById(shelf.getAttribute('aria-controls') ?? '')
    assert.ok(shelfBody, 'the shelf row controls a real node')
    assert.equal(shelfBody.hidden, true, 'and that node is hidden while closed')

    act(() => {
      shelf.click()
    })
    await settle()
    assert.equal(shelfButton()?.getAttribute('aria-expanded'), 'true', 'opening the shelf is a disclosure')
    assert.deepEqual(rowNames(), ['Alpha', 'Charlie', 'Bravo'], 'open, the shelf lists its rows most recently worked first')
    const bravo = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((el) => el.textContent?.includes('Bravo'))
    assert.ok(bravo?.textContent?.includes('(settled)'), 'a resting row says so in words')

    const activeMenu = await openMenuOn('Alpha')
    assert.ok(activeMenu.includes('Settle'), `an active row's menu offers Settle (got ${activeMenu.join(' | ')})`)
    assert.equal(activeMenu.includes('Un-settle'), false)

    const settledMenu = await openMenuOn('Bravo')
    assert.ok(settledMenu.includes('Un-settle'), `a resting row's menu offers Un-settle (got ${settledMenu.join(' | ')})`)
    assert.equal(settledMenu.includes('Settle'), false)

    // The one-click seat is rest, not removal. The ✕ that used to sit here
    // terminates the row's terminals and removes the chat; it keeps its entry
    // in the row menu (asserted below) and gives up the cheap seat to Settle,
    // which the next click can undo.
    assert.ok(actionLabel('Settle Alpha'), 'an active row offers Settle in its hover seat')
    assert.equal(actionLabel('Close Alpha'), null, 'and no longer offers Close there')
    assert.ok(activeMenu.includes('Close workspace'), 'Close keeps its place in the row menu')

    // A resting row's seat is the undo arrow, not a second tick: the action
    // there is "put this back", and a tick would still be saying "done".
    assert.ok(actionLabel('Un-settle Bravo'), 'a resting row offers Un-settle in its hover seat')
    assert.equal(actionLabel('Settle Bravo'), null)

    // Rest means rest (owner ruling 2026-09-07): a chat that has come to rest
    // holds no terminals, so settling takes its ptys with it. Nothing is
    // killed until then — the sweep leaves the selected row and the already
    // resting rows alone, so an idle sidebar kills nothing.
    assert.deepEqual(killed, [], 'no settle, no kill')
    const settleAlpha = actionLabel('Settle Alpha')
    assert.ok(settleAlpha, 'Alpha has a Settle button to click')
    act(() => {
      settleAlpha.click()
    })
    await settle()
    assert.deepEqual(killed, ['alpha-pty'], 'settling a chat kills the terminals it held')

    // The row you are in always has a row: selecting a settled chat keeps it
    // in the active list (still settled) instead of in a closed shelf.
    await render({ ...props, activeWorkspaceId: 'w2' } as unknown as SidebarProps)
    assert.deepEqual(rowNames(), ['Alpha', 'Bravo', 'Charlie'], 'the selected settled row sits in the active list, the other stays shelved')
    assert.match(shelfButton()?.textContent ?? '', /Settled\s*1/, 'the shelf counts only the rows it holds')

    // A folder with nothing resting shows no shelf at all — a heading must
    // separate something from something else.
    await render({ ...props, workspaces: [workspace('w1', 'Alpha')] } as unknown as SidebarProps)
    assert.equal(shelfButton(), null, 'no settled rows, no shelf row')

    // A row born on a paired machine keeps the ✕: the Remote band has no
    // Settled shelf, so there is nothing for a tick to put it into — the same
    // rule the menu's Settle entry already follows.
    await render({
      ...props,
      workspaces: [
        workspace('w1', 'Alpha'),
        workspace('w4', 'Delta', {
          folderPath: null,
          remoteOrigin: {
            connectionId: 'c1',
            machineName: 'MacBook Air',
            workspaceId: 'rw1',
            workspaceName: 'relay',
            workspaceRoot: '/Users/me/relay',
          },
        }),
      ],
      activityByWorkspaceId: { w1: 'idle', w4: 'idle' },
    } as unknown as SidebarProps)
    assert.ok(actionLabel('Close Delta'), 'a remote-band row keeps Close in its seat')
    assert.equal(actionLabel('Settle Delta'), null, 'and is never offered Settle')
  } finally {
    act(() => {
      root.unmount()
    })
  }
}

main()
  .then(() => console.log('workspace sidebar settled shelf tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
