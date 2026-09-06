import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// The Remote band (remote-sessions-in-the-sidebar, decision 1): a chat born
// on a paired machine carries `workspace.remoteOrigin`, and the sidebar files
// it under the Remote band's machine line — never under a local folder's
// header, even when that folder is a clone of the same repository (this
// supersedes MC-2406's filing), and never under "No folder". Local grouping
// stays exactly what it was. This mounts the real sidebar because the band is
// what the ruling is about, and nothing below the component renders one.

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
const identityReads: string[] = []
domWindow.api = {
  platform: 'darwin',
  // The Sprints nav entry subscribes to the run index on mount; a silent
  // subscription keeps the sidebar's later renders (the identity reads
  // resolving) from throwing inside a passive effect.
  onSprintRunsChanged: () => () => {},
  listSprintRuns: async () => [],
  detectProjectLogo: async (folderPath: string) => {
    detected.push(folderPath)
    return null
  },
  // one-project-across-machines: /projA is a clone of acme/multicode; the
  // remote row Foxtrot below is that repository on the Air.
  getGitRepositoryIdentity: async (folderPath: string) => {
    identityReads.push(folderPath)
    return folderPath === '/projA'
      ? { canonicalKey: 'github.com/acme/multicode', remoteUrl: 'git@github.com:acme/multicode.git', name: 'multicode' }
      : null
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
    // The remote clone of acme/multicode comes FIRST in the list: the group
    // it joins must still be headed by the local folder, not by "No folder".
    workspace('w0', 'Zulu', null, {
      remoteOrigin: {
        connectionId: 'c1',
        machineName: 'MacBook Air',
        workspaceId: 'rw3',
        workspaceName: 'multicode',
        workspaceRoot: '/Users/air/multicode',
        repository: { canonicalKey: 'github.com/acme/multicode', remoteUrl: 'git@github.com:acme/multicode.git', name: 'multicode' },
      },
      layoutModel: { layout: { type: 'row', children: [] } },
    }),
    workspace('w1', 'Alpha', '/projA'),
    workspace('w2', 'Bravo', '/projA'),
    // Born on the Air; its pane is open — on a worktree the create minted
    // there (checkout-and-branch-on-remote-create), so its branch is known.
    workspace('w3', 'Charlie', null, {
      remoteOrigin: { ...remoteOrigin, checkout: { mode: 'worktree', branch: 'agent/fix', worktreePath: '/Users/me/wt/fix' } },
      layoutModel: fleetLayout,
    }),
    // Born on the Air; its pane has since closed — the mark must survive.
    workspace('w4', 'Delta', null, { remoteOrigin, layoutModel: { layout: { type: 'row', children: [] } } }),
    // A genuinely folderless local row keeps its old home.
    workspace('w5', 'Echo', null),
    // Born on the Air in ITS clone of acme/multicode — the same repository
    // as /projA (one-project-across-machines): files under projA's header.
    workspace('w6', 'Foxtrot', null, {
      remoteOrigin: {
        ...remoteOrigin,
        workspaceId: 'rw2',
        workspaceName: 'multicode',
        workspaceRoot: '/Users/air/multicode',
        repository: { canonicalKey: 'github.com/acme/multicode', remoteUrl: 'git@github.com:acme/multicode.git', name: 'multicode' },
      },
      layoutModel: { layout: { type: 'row', children: [] } },
    }),
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
  act(() => {
    root.render(React.createElement(WorkspaceSidebar, props))
  })
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  act(() => {})
  // The identity reads resolve off the event loop and their setState lands
  // through the scheduler, so the wait has to yield a macrotask inside act
  // for the grouping to re-render on them.
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
    })
  }

  const headers = [...container.querySelectorAll('button[aria-expanded]')]
  const headerText = headers.map((header) => header.textContent?.trim() ?? '')
  assert.deepEqual(
    headerText,
    ['Remote', 'projA', 'No folder'],
    'the Remote band leads, then the local folder, then the folderless local row — no machine · project folder header'
  )

  const remoteHeader = headers[0]!
  assert.ok(remoteHeader.querySelector('svg'), 'the band header carries the shared machine glyph')
  const remoteSection = remoteHeader.closest('section')!
  // Owner ruling 2026-09-05: one flat list, no machine lines. Every band row
  // leads with the machine glyph, and the machine's name is the glyph's
  // tooltip and accessible name — never the row's own text.
  assert.equal(remoteSection.querySelectorAll('[data-remote-machine]').length, 0, 'no machine line')
  const remoteRowNodes = [...remoteSection.querySelectorAll('[role="treeitem"]')]
  const remoteRows = remoteRowNodes.map((row) => row.textContent ?? '')
  for (const name of ['Zulu', 'Charlie', 'Delta', 'Foxtrot']) {
    assert.ok(remoteRows.some((text) => text.includes(name)), `${name}, born on the Air, is a row of the band`)
  }
  for (const row of remoteRowNodes) {
    assert.equal(row.querySelector('[data-remote-row-glyph]')?.getAttribute('data-remote-row-glyph'), 'MacBook Air',
      'every band row leads with the glyph that names its machine')
    assert.ok(!(row.textContent ?? '').includes('MacBook Air'), 'and the name is not row text')
  }
  assert.doesNotMatch(remoteSection.textContent ?? '', /No sessions open/, 'no empty-state sentence in the band')
  assert.ok(remoteRows.find((text) => text.includes('Charlie'))!.includes('agent/fix'),
    'the live remote row names the branch its create landed on')
  assert.ok(!remoteRows.find((text) => text.includes('Delta'))!.includes('agent/fix'),
    'a parked remote row carries no branch')
  assert.ok(!detected.includes('/Users/me/relay'), 'the remote root is never looked up on the local disk')
  assert.ok(identityReads.includes('/projA'), 'the local folder is still asked which repository it is')
  assert.ok(!identityReads.includes('/Users/air/multicode'), 'a remote root is never asked on this disk')

  const localSection = headers[1]!.closest('section')!
  const localRows = [...localSection.querySelectorAll('[role="treeitem"]')].map((row) => row.textContent ?? '')
  assert.equal(localRows.length, 2, 'only the two local rows are under projA')
  assert.ok(localRows.some((text) => text.includes('Alpha')) && localRows.some((text) => text.includes('Bravo')))
  assert.ok(!localRows.some((text) => text.includes('Foxtrot')),
    "a remote clone of the open repository is a band row, not a folder row (decision 1 supersedes MC-2406's filing)")
  assert.ok(!localSection.querySelector('[data-remote-under-local="true"]'), 'so no row under a local header wears the machine mark')

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
