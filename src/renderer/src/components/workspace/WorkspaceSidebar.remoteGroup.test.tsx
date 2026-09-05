import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// 2026-09-04 review of the two-line rows (remote-sessions-ux): a chat born on
// a paired machine carries `workspace.remoteOrigin`, and the sidebar groups it
// under a header naming the machine and the remote workspace — epic decision 6
// puts project identity on the folder header, and a remote row's project is on
// another machine — rather than filing it under "No folder". Local grouping
// stays exactly what it was. This mounts the real sidebar because the header
// is what the ruling is about, and nothing below the component renders one.

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

const detected: string[] = []
domWindow.api = {
  platform: 'darwin',
  detectProjectLogo: async (folderPath: string) => {
    detected.push(folderPath)
    return null
  },
}

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')

  type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
  const workspace = (id: string, name: string, folderPath: string | null, extra?: Record<string, unknown>) =>
    ({ id, name, mode: 'standard', folderPath, ...extra }) as unknown

  const fleetLayout = {
    layout: {
      type: 'tabset',
      children: [
        {
          type: 'tab',
          id: 'fleet-terminal:c1:s1',
          component: 'fleet-terminal',
          config: { connectionId: 'c1', machineName: 'MacBook Air', remoteSessionId: 's1' },
        },
      ],
    },
  }
  const remoteOrigin = {
    connectionId: 'c1',
    machineName: 'MacBook Air',
    workspaceId: 'rw1',
    workspaceName: 'relay',
    workspaceRoot: '/Users/me/relay',
  }
  const workspaces = [
    workspace('w1', 'Alpha', '/projA'),
    workspace('w2', 'Bravo', '/projA'),
    // Born on the Air; its pane is open.
    workspace('w3', 'Charlie', null, { remoteOrigin, layoutModel: fleetLayout }),
    // Born on the Air; its pane has since closed — the mark must survive.
    workspace('w4', 'Delta', null, { remoteOrigin, layoutModel: { layout: { type: 'row', children: [] } } }),
    // A genuinely folderless local row keeps its old home.
    workspace('w5', 'Echo', null),
  ] as SidebarProps['workspaces']

  const noop = () => {}
  const props = {
    workspaces,
    activeWorkspaceId: 'w1',
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
    onNewWorkspace: noop,
    onNewWorkspaceInFolder: noop,
    onNewChat: noop,
    onNewWorkspaceMode: noop,
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
  act(() => {
    root.render(React.createElement(WorkspaceSidebar, props))
  })
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  act(() => {})

  const headers = [...container.querySelectorAll('button[aria-expanded]')]
  const headerText = headers.map((header) => header.textContent?.trim() ?? '')
  assert.deepEqual(
    headerText,
    ['projA', 'MacBook Air · relay', 'No folder'],
    'local folder first as before, then the machine · project header, then the folderless local row'
  )

  const remoteHeader = headers[1]!
  const remoteSection = remoteHeader.closest('section')!
  const remoteRows = [...remoteSection.querySelectorAll('[role="treeitem"]')].map((row) => row.textContent ?? '')
  assert.ok(remoteRows.some((text) => text.includes('Charlie')) && remoteRows.some((text) => text.includes('Delta')),
    'both remote-born rows file under the machine header')
  assert.ok(remoteRows.every((text) => text.includes('MacBook Air')),
    'each row still wears the provenance mark — including the one whose pane closed')
  assert.ok(remoteHeader.querySelector('svg'), 'the header carries the shared machine glyph')
  assert.ok(!detected.includes('/Users/me/relay'), 'the remote root is never looked up on the local disk')

  const noFolderSection = headers[2]!.closest('section')!
  const noFolderRows = [...noFolderSection.querySelectorAll('[role="treeitem"]')].map((row) => row.textContent ?? '')
  assert.equal(noFolderRows.length, 1, 'only the genuinely folderless local row is under No folder')
  assert.ok(noFolderRows[0]!.includes('Echo'))

  act(() => {
    root.unmount()
  })
}

main()
  .then(() => console.log('workspace sidebar remote group tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
