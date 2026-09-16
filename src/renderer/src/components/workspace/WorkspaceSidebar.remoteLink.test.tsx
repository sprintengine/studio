import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { bindSprintEngineIpc } from '../../modules/sprint-engine-ipc'

// What the sidebar shows of another machine once THIS one is off the tailnet
// (owner, 2026-09-13: "when studio has disconnected from the tailnet, it
// should no longer show the remote conversations in the side panel — I can
// still see them even though I have disconnected").
//
// `unattachedConversations` already withheld the rows read from a browse. The
// rows that stayed are the other half: real `Workspace`s here, stamped with
// `remoteOrigin`, whose whole content is a pane onto a machine that can no
// longer be reached. They are gated on the LINK — is Tailscale up on this
// machine — rather than on the listener, which is the inbound half and says
// nothing about whether the fleet can be reached.
//
// This mounts the real sidebar because the gate sits in the grouping, and the
// two rows it has to tell apart (a local chat, a remote-born one) only exist
// once the tree is built.

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

/** This machine's Tailscale address, or null once it has disconnected. */
let tailnetAddress: string | null = '100.64.0.5'

const connection = {
  id: 'c1',
  machineName: 'mac-mini',
  endpoint: '100.64.0.9:8471',
  deviceId: 'tnd_1',
  deviceName: 'mini',
  scopes: ['workspace:read', 'terminal:control'],
  pairedAt: '2026-09-13T00:00:00.000Z',
  lastConnectedAt: null,
  pairedVia: 'request',
}

// Two agents in ONE chat over there — the shape that used to draw a single
// nameless line here the moment the chat was opened.
const remoteTerminal = (sessionId: string, agentName: string, over: Record<string, unknown> = {}) => ({
  sessionId,
  kind: 'agent',
  workspaceId: 'rw1',
  agentName,
  cli: 'claude-code',
  cwd: '/Users/mini/multicode',
  processAlive: true,
  suspended: false,
  phase: 'working',
  phaseSince: 1_000,
  workspaceName: 'multicode',
  git: null,
  ...over,
})

domWindow.api = {
  platform: 'darwin',
  onSprintRunsChanged: () => () => {},
  listSprintRuns: async () => [],
  detectProjectLogo: async () => null,
  getGitRepositoryIdentity: async () => null,
  // The tailnet presence bridge, complete — without every one of these the
  // hook stays quiet and the link reads `unknown`, which is a different case.
  onTailnetEvent: () => () => {},
  onFleetEvent: () => () => {},
  tailnetGetStatus: async () => ({
    enabled: true,
    running: tailnetAddress !== null,
    endpoint: null,
    port: 8471,
    tailnetAddress,
    lastError: null,
    notifications: true,
    devices: [],
    pairing: null,
    pairRequests: [],
  }),
  tailnetGetLiveState: async () => ({ revision: 1, devices: [] }),
  fleetListConnections: async () => [connection],
  fleetGetLiveState: async () => ({ revision: 1, attachments: [], requests: [], reachability: [] }),
  fleetBrowse: async () => ({
    connectionId: 'c1',
    reachable: true,
    unreachableReason: null,
    unauthorized: false,
    scopes: connection.scopes,
    terminalAccess: 'control',
    workspaces: [{ id: 'rw1', name: 'multicode', mode: 'standard', folderPath: '/Users/mini/multicode', repository: null }],
    terminals: [remoteTerminal('s1', 'Tara Boyle'), remoteTerminal('s2', 'Gael Corry', { phase: 'awaiting_input' })],
    gaps: [],
  }),
}

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
  bindSprintEngineIpc(domWindow.api as never)

  type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
  const workspaces = [
    { id: 'w1', name: 'Alpha', mode: 'standard', folderPath: '/projA' },
    // A chat opened from the Mini, stored under the OLD naming rule: the
    // agent's name in front of the chat's. Its pane is closed, so nothing but
    // the browse can say what is standing in it.
    {
      id: 'w2',
      name: 'Tara Boyle · multicode',
      mode: 'standard',
      folderPath: null,
      // Starred, so the pass below also covers the Starred section: it renders
      // its own copy of the row under a `starred-` key prefix, and a gate that
      // only reached the project tree would leave the chat standing up there.
      highlight: { starred: true },
      remoteOrigin: {
        connectionId: 'c1',
        machineName: 'mac-mini',
        workspaceId: 'rw1',
        workspaceName: 'multicode',
        workspaceRoot: '/Users/mini/multicode',
        sessionId: 's1',
      },
      layoutModel: { layout: { type: 'row', children: [] } },
    },
  ] as unknown as SidebarProps['workspaces']

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

  // A fresh tree per pass. The link is read once at mount through the presence
  // bridge, and this test changes what that bridge answers between passes —
  // mounting again is how the sidebar asks again, and it keeps each assertion
  // reading a tree built entirely under one answer.
  let container = dom.window.document.createElement('div')
  // Every root this test mounts, so the last act of the run can take them all
  // down: the sidebar arms interval timers (the remote band's slow fallback
  // read among them) and a root left mounted keeps the event loop — and the
  // test process — alive forever.
  const roots: Array<ReturnType<typeof createRoot>> = []
  const render = async (): Promise<void> => {
    container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => {
      root.render(React.createElement(WorkspaceSidebar, props))
    })
    // The reads (status, connections, browse) resolve off the event loop and
    // their setState lands through the scheduler, so settling has to yield a
    // macrotask inside `act` for the rows to render on them.
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
    }
  }

  const rowKeys = (): string[] =>
    [...container.querySelectorAll('[data-row-key]')].map((row) => row.getAttribute('data-row-key') ?? '')
  /** Every row drawn for a workspace, wherever it was drawn — the project tree AND Starred. */
  const rowsFor = (id: string): string[] => rowKeys().filter((key) => key === id || key.endsWith(`-${id}`))

  // Unconditional teardown. The sidebar arms interval timers, so a root left
  // mounted keeps the event loop alive: without this a FAILED assertion hangs
  // the run forever instead of printing what went wrong.
  try {
    // ── On the tailnet ─────────────────────────────────────────────────────
    await render()
    assert.deepEqual(
      rowsFor('w2').sort(),
      ['starred-w2', 'w2'],
      'on the tailnet the chat opened from the Mini is a row, and a starred one too',
    )

    // Titled with the CHAT, not with an agent standing in it — even though the
    // stored name still carries the agent from the old rule.
    const remoteRow = container.querySelector('[data-row-key="w2"]')!
    assert.ok(
      !(remoteRow.textContent ?? '').includes('Tara Boyle'),
      `the agent's name is not the row's title: ${remoteRow.textContent}`,
    )
    assert.ok((remoteRow.textContent ?? '').includes('multicode'), 'the chat over there is what the row is called')

    // …and it draws a line per agent in the conversation, the way a local chat
    // running two terminals does — not the one pane this window attached.
    const agentMarks = remoteRow.querySelectorAll('[aria-label*="Claude Code"]')
    assert.equal(agentMarks.length, 2, 'both agents standing in the chat get a line')
    const markLabels = [...agentMarks].map((mark) => mark.getAttribute('aria-label') ?? '')
    assert.ok(markLabels.some((label) => label.startsWith('Tara Boyle ·')), `Tara's line: ${markLabels.join(' | ')}`)
    assert.ok(markLabels.some((label) => label.startsWith('Gael Corry ·')), `Gael's line: ${markLabels.join(' | ')}`)

    // ── Off the tailnet ────────────────────────────────────────────────────
    tailnetAddress = null
    await render()
    assert.ok(rowKeys().includes('w1'), 'a local chat is untouched by the tailnet going away')
    assert.deepEqual(
      rowsFor('w2'),
      [],
      `off the tailnet the remote chat is nowhere — not in its project, not in Starred: ${rowKeys().join(', ')}`,
    )
    // Nothing was closed or forgotten — the workspace is still in the props the
    // sidebar was handed, and comes back when the link does.
    assert.equal(workspaces.length, 2)

    tailnetAddress = '100.64.0.5'
    await render()
    assert.deepEqual(rowsFor('w2').sort(), ['starred-w2', 'w2'], 'and it returns, in both places, with the link')

  } finally {
    act(() => {
      for (const mounted of roots) mounted.unmount()
    })
  }
}

main()
  .then(() => console.log('sidebar remote link tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
