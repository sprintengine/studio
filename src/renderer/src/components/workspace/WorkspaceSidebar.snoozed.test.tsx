import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// Snoozed chats (2026-09-10). A sleeping row leaves the active list for its
// folder's Snoozed shelf — one fold row carrying the count, closed by default,
// over compact rows wearing the countdown to their wake. The row menu offers
// Snooze on an active row and Wake now on a sleeping one, and a row that came
// back wears a Woke mark until it is opened.
//
// This holds the SHELF's shape and the menu's. The rules that decide what
// sleeps, when it wakes and what the countdown reads live in
// workspaceSnooze.test.ts; the store's writes live in workspacesSlice.test.ts.

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

// No live ptys anywhere. A sleeping chat KEEPS its terminals — that is the
// whole difference from Settle — so any kill recorded here is a bug, and the
// list is asserted empty at the end.
const killed: string[] = []
domWindow.api = {
  platform: 'darwin',
  detectProjectLogo: async () => null,
  terminalList: async () => [],
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

  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR
  const createdAt = Date.now()
  const workspace = (id: string, name: string, fields: Partial<Workspace> = {}) =>
    ({ id, name, mode: 'standard', folderPath: '/projA', createdAt, ...fields }) as unknown as Workspace

  // Alpha is the active row. Bravo sleeps for another two hours; Charlie sleeps
  // for another day, so the shelf can be checked for soonest-first order.
  // Delta's wake time has passed and nobody has opened it: it is back in the
  // active list wearing Woke.
  const workspaces = [
    workspace('w1', 'Alpha'),
    workspace('w2', 'Bravo', { snoozedUntil: createdAt + 2 * HOUR, snoozedAt: createdAt - HOUR }),
    workspace('w3', 'Charlie', { snoozedUntil: createdAt + DAY, snoozedAt: createdAt - HOUR }),
    workspace('w4', 'Delta', { snoozedUntil: createdAt - HOUR, snoozedAt: createdAt - 3 * HOUR }),
  ]

  const noop = () => {}
  // What the rail's Home badge is told to skip. The badge counts what the
  // sidebar SHOWS, so a chat taken off screen has to be named here or its
  // count outlives the gesture that hid it.
  let reportedSnoozed: ReadonlySet<string> = new Set()
  const baseProps = {
    onSnoozedWorkspacesChange: (ids: ReadonlySet<string>) => {
      reportedSnoozed = ids
    },
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

  const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta']
  const rowNames = (): string[] =>
    [...container.querySelectorAll('[role="treeitem"]')]
      .map((row) => NAMES.find((name) => row.textContent?.includes(name)))
      .filter((name): name is string => name !== undefined)

  const rowFor = (name: string): HTMLElement | undefined =>
    [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((el) =>
      el.textContent?.includes(name)
    )

  const foldRow = (label: string): HTMLButtonElement | null =>
    [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((button) =>
      button.textContent?.startsWith(label)
    ) ?? null

  const openMenuOn = async (name: string): Promise<string[]> => {
    const row = rowFor(name)
    assert.ok(row, `row ${name} is rendered`)
    act(() => {
      row.dispatchEvent(
        new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      )
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
    await render(baseProps)

    // --- the shelf -------------------------------------------------------
    assert.deepEqual(
      rowNames(),
      ['Alpha', 'Delta'],
      'sleeping rows leave the active list; a woken one is back in it'
    )
    const shelf = foldRow('Snoozed')
    assert.ok(shelf, 'the folder shows its Snoozed shelf row')
    assert.equal(shelf.getAttribute('aria-expanded'), 'false', 'the shelf is closed by default')
    assert.match(shelf.textContent ?? '', /Snoozed\s*2/, 'the shelf row carries the count')
    const shelfBody = dom.window.document.getElementById(shelf.getAttribute('aria-controls') ?? '')
    assert.ok(shelfBody, 'the shelf row controls a real node')
    assert.equal(shelfBody.hidden, true, 'and that node is hidden while closed')
    assert.equal(foldRow('Settled'), null, 'a folder with nothing at rest grows no Settled shelf')

    act(() => {
      shelf.click()
    })
    await settle()
    assert.equal(foldRow('Snoozed')?.getAttribute('aria-expanded'), 'true', 'opening the shelf is a disclosure')
    assert.deepEqual(
      rowNames(),
      ['Alpha', 'Delta', 'Bravo', 'Charlie'],
      'open, the shelf lists its rows by wake time, soonest first'
    )

    // --- what a sleeping row says ---------------------------------------
    const bravo = rowFor('Bravo')
    assert.ok(bravo?.textContent?.includes('(snoozed)'), 'a sleeping row says so in words')
    assert.match(bravo!.textContent ?? '', /\b2h\b/, 'and wears the countdown to its wake')
    assert.ok(
      container.querySelector('button[aria-label="Wake Bravo"]'),
      'its one-click seat is Wake, not Settle'
    )
    assert.equal(
      container.querySelector('button[aria-label="Settle Bravo"]'),
      null,
      'Settle does not take the seat on a row that is only waiting on a clock'
    )

    assert.deepEqual(
      [...reportedSnoozed].sort(),
      ['w2', 'w3'],
      'the sleeping rows are reported up so the rail badge skips them'
    )

    // --- what a woken row says -------------------------------------------
    const delta = rowFor('Delta')
    assert.ok(delta?.textContent?.includes('Woke'), 'a row whose wake time passed comes back wearing Woke')
    assert.equal(rowFor('Alpha')?.textContent?.includes('Woke'), false, 'a row that never slept does not')

    // --- the menu ---------------------------------------------------------
    const activeMenu = await openMenuOn('Alpha')
    assert.ok(activeMenu.includes('Snooze'), `an active row's menu offers Snooze (got ${activeMenu.join(' | ')})`)
    assert.equal(activeMenu.includes('Wake now'), false, 'and not Wake')

    const sleepingMenu = await openMenuOn('Bravo')
    assert.ok(
      sleepingMenu.includes('Wake now'),
      `a sleeping row's menu offers Wake now (got ${sleepingMenu.join(' | ')})`
    )
    assert.equal(sleepingMenu.includes('Snooze'), false, 'and not a second Snooze')

    // The presets are a flyout under Snooze, and every one of them names both
    // the choice and the time it lands on.
    const alphaRow = rowFor('Alpha')
    act(() => {
      alphaRow!.dispatchEvent(
        new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      )
    })
    await settle()
    const snoozeItem = [...dom.window.document.querySelectorAll<HTMLElement>('[role="menu"] [data-menu-item="true"]')]
      .find((el) => el.textContent?.trim() === 'Snooze')
    assert.ok(snoozeItem, 'Snooze is a menu item')
    assert.equal(snoozeItem.getAttribute('aria-haspopup'), 'menu', 'and it opens a submenu of wake times')
    // Opened by click; hover opens it too, but a raw non-bubbling `mouseenter`
    // is not what React synthesises onMouseEnter from.
    act(() => {
      snoozeItem.click()
    })
    await settle()
    const presetLabels = [...dom.window.document.querySelectorAll('[role="menu"][aria-label="Snooze chat"] [data-menu-item="true"]')]
      .map((el) => el.textContent?.trim() ?? '')
    assert.ok(presetLabels.length >= 3, `the flyout offers wake times (got ${presetLabels.join(' | ')})`)
    assert.ok(
      presetLabels.some((label) => label.startsWith('In 1 hour')),
      `the nearest choice is first (got ${presetLabels.join(' | ')})`
    )
    assert.ok(
      presetLabels.some((label) => label.startsWith('Tomorrow')),
      `and the calendar choices follow (got ${presetLabels.join(' | ')})`
    )
    act(() => {
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await settle()

    // --- a raised hand outranks the snooze --------------------------------
    // Bravo's agent starts asking. Its wake time has not moved, but a question
    // the person cannot see is a question that defeats itself, so the row
    // returns to the active list at once.
    await render({
      ...baseProps,
      activityByWorkspaceId: { w1: 'idle', w2: 'needs-input', w3: 'idle', w4: 'idle' },
    } as unknown as SidebarProps)
    assert.ok(rowNames().includes('Bravo'), 'a sleeping row whose agent is asking comes back')
    assert.match(foldRow('Snoozed')?.textContent ?? '', /Snoozed\s*1/, 'and the shelf count drops with it')
    assert.deepEqual(
      [...reportedSnoozed],
      ['w3'],
      'and the badge is told about it again, so the question it is asking gets counted'
    )
    const askingMenu = await openMenuOn('Charlie')
    assert.ok(askingMenu.includes('Wake now'), 'the other sleeper is untouched')

    // A row that is asking may not be snoozed at all — the entry is there and
    // disabled, so the reason is visible rather than the action silently absent.
    await render({
      ...baseProps,
      activityByWorkspaceId: { w1: 'needs-input', w2: 'idle', w3: 'idle', w4: 'idle' },
    } as unknown as SidebarProps)
    act(() => {
      rowFor('Alpha')!.dispatchEvent(
        new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      )
    })
    await settle()
    const disabled = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="menu"] [data-menu-item="true"]')]
      .find((el) => el.textContent?.trim() === 'Snooze')
    assert.ok(disabled, 'Snooze is still listed on a row whose agent is asking')
    assert.equal(disabled.disabled, true, 'but it cannot be chosen: hiding the question defeats it')
    act(() => {
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await settle()

    // Snooze is visibility, never lifecycle: nothing here killed a terminal.
    assert.deepEqual(killed, [], 'a sleeping chat keeps its agent')

  } finally {
    act(() => {
      root.unmount()
    })
  }
}

main()
  .then(() => console.log('workspace sidebar snoozed shelf tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
