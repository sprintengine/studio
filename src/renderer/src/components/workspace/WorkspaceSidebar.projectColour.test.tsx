import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// One colour per project, on the folder glyph (owner ruling 2026-09-09;
// backlog/unfiled/2026-09-09-one-colour-per-project-on-the-folder-glyph.md).
//
// Everything here is about the SIDEBAR's half of that item, and it mounts the
// real component because every claim the ruling makes is about what the rail
// renders: that two open projects are never handed one hue, that the hue is on
// the glyph and keyed by REPOSITORY (so a paired machine's clone wears it too),
// that "No folder" is not a project and gets the dashed outline instead, that
// the header menu changes it everywhere at once, and that a restart keeps it.
// The allocator and the palette have their own unit suite
// (utils/projectColor.test.ts); this is the surface's.

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

// A gate on the repository reads, so the suite can hold a folder's identity
// unanswered and watch what the rail does in the meantime — the phantom-key
// case below, which is the whole reason allocation waits.
let releaseIdentities: () => void = () => {}
let identityGate: Promise<void> = Promise.resolve()
function holdIdentities(): void {
  identityGate = new Promise<void>((resolve) => {
    releaseIdentities = resolve
  })
}

// No logos anywhere: a project with a detected logo shows its logo instead of a
// hue, which is a different case and belongs to the identity-icon suite.
domWindow.api = {
  platform: 'darwin',
  onSprintRunsChanged: () => () => {},
  listSprintRuns: async () => [],
  detectProjectLogo: async () => null,
  // /projA is a clone of acme/multicode; the remote row below is the same
  // repository on a paired machine, so both must resolve to one colour key.
  // /projB is a folder with no remote at all — a real project, keyed by path.
  getGitRepositoryIdentity: async (folderPath: string) => {
    await identityGate
    return folderPath === '/projA'
      ? { canonicalKey: 'github.com/acme/multicode', remoteUrl: 'git@github.com:acme/multicode.git', name: 'multicode' }
      : null
  },
}

/** The `project-mark-*` class an svg wears, or null when it wears none. */
function markClassOf(node: Element | null | undefined): string | null {
  const className = node?.getAttribute('class') ?? ''
  return /project-mark-[a-z]+/.exec(className)?.[0] ?? null
}

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
  const { useWorkspaceStore } = await import('../../store/workspaceStore')
  const { resetProjectLogos } = await import('../../utils/projectLogos')

  resetProjectLogos()

  type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
  const workspace = (id: string, name: string, folderPath: string | null, extra?: Record<string, unknown>) =>
    ({ id, name, mode: 'standard', folderPath, ...extra }) as unknown

  const workspaces = [
    workspace('w1', 'Alpha', '/projA'),
    workspace('w2', 'Bravo', '/projA'),
    workspace('w3', 'Charlie', '/projB'),
    // No folder is not a project (decision 6).
    workspace('w4', 'Echo', null),
    // Born on a paired machine, in ITS clone of acme/multicode. One project
    // across machines: the machine is a glyph, never a second colour.
    workspace('w5', 'Foxtrot', null, {
      remoteOrigin: {
        connectionId: 'c1',
        machineName: 'MacBook Air',
        workspaceId: 'rw1',
        workspaceName: 'multicode',
        workspaceRoot: '/Users/air/multicode',
        repository: {
          canonicalKey: 'github.com/acme/multicode',
          remoteUrl: 'git@github.com:acme/multicode.git',
          name: 'multicode',
        },
      },
      layoutModel: { layout: { type: 'row', children: [] } },
    }),
  ] as SidebarProps['workspaces']

  const noop = () => {}
  const propsFor = (rows: SidebarProps['workspaces']) => ({
    workspaces: rows,
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
  } as unknown as SidebarProps)
  const props = propsFor(workspaces)

  const settle = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
    act(() => {})
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
    }
  }

  const mount = async (mountProps: SidebarProps = props) => {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(React.createElement(WorkspaceSidebar, mountProps))
    })
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
    act(() => {})
    // The repository reads settle off the event loop, and the colour is only
    // allocated once they have — see `settled` in the sidebar. Yielding a
    // macrotask inside `act` is what lets that second pass commit.
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
    }
    return { container, root }
  }

  const rowFor = (container: Element, name: string) => {
    const row = [...container.querySelectorAll('[role="treeitem"]')].find((candidate) =>
      candidate.textContent?.includes(name)
    )
    assert.ok(row, `row for ${name} rendered`)
    return row!
  }

  // The flat stream is where the project line — glyph plus name — lives, so
  // that is the shape this suite reads.
  act(() => {
    useWorkspaceStore.getState().setChatListView('all')
  })

  // ── A hue is allocated only once the repository question is ANSWERED ────
  //
  // The bug this guards: a folder keyed by its PATH while its identity read is
  // still in flight would be given a hue one frame before the key becomes the
  // repository's. The phantom `folder:` entry then keeps that hue for good —
  // three repositories would exhaust a six-hue palette — and the glyph would
  // visibly change colour a moment after the window opened, which decision 4
  // ("it never changes behind the person's back") forbids.
  holdIdentities()
  const pending = await mount(propsFor(workspaces.slice(0, 3)))
  const colorsWhilePending = useWorkspaceStore.getState().appSettings.projectColors
  assert.deepEqual(colorsWhilePending, {}, 'nothing is allocated while the repository reads are in flight')
  assert.equal(
    markClassOf(rowFor(pending.container, 'Alpha').firstElementChild!.querySelector('svg')),
    null,
    'and the glyph is the plain outline for that beat, not a hue it would have to give back'
  )

  releaseIdentities()
  await settle()
  const colorsAfterRead = useWorkspaceStore.getState().appSettings.projectColors
  assert.deepEqual(
    Object.keys(colorsAfterRead).sort(),
    ['folder:/projb', 'repo:github.com/acme/multicode'],
    'the answer allocates exactly one key per project: the repository for the folder that has one, '
      + 'and — the case a `has()` check must not swallow — the PATH for the folder whose read said "no remote"'
  )
  assert.ok(!('folder:/proja' in colorsAfterRead), 'no phantom path key survives for a folder that is a repository')

  act(() => {
    pending.root.unmount()
  })

  const first = await mount()

  // ── Assigned on first sight, and never the same hue twice ───────────────
  //
  // The project line is the row's first child in the stream, and its glyph is
  // the first svg in it: the ONE element the colour is allowed on.
  const glyphOf = (container: Element, name: string) =>
    rowFor(container, name).firstElementChild!.querySelector('svg')

  const markA = markClassOf(glyphOf(first.container, 'Alpha'))
  const markB = markClassOf(glyphOf(first.container, 'Charlie'))
  assert.ok(markA, 'an open project is given a hue the first time it is seen')
  assert.ok(markB, 'and so is the second one')
  assert.notEqual(markA, markB, 'two open projects never receive the same hue')
  assert.equal(
    markClassOf(glyphOf(first.container, 'Bravo')),
    markA,
    'every chat of one project shows that project one hue'
  )

  // The name beside the glyph is not tinted, and neither is the row: the hue
  // identifies, it never grades (design system, "Identity colour").
  const alphaLine = rowFor(first.container, 'Alpha').firstElementChild!
  assert.equal(
    markClassOf(alphaLine.querySelector('span')),
    null,
    'the project name stays in the row ink — the colour is on the glyph and nowhere else'
  )

  // ── No folder is not a project ──────────────────────────────────────────
  const echoGlyph = glyphOf(first.container, 'Echo')
  assert.equal(markClassOf(echoGlyph), null, 'an unfiled chat is given no hue at all')
  assert.equal(
    echoGlyph!.querySelector('path')?.getAttribute('stroke-dasharray'),
    '2 1.6',
    'it wears the dashed outline instead, so unfiled reads as its own thing'
  )

  // ── A project is a repository, so a paired machine's clone is the same one ──
  const foxtrotGlyph = rowFor(first.container, 'Foxtrot').querySelector('[data-project-glyph] svg')
  assert.equal(
    markClassOf(foxtrotGlyph),
    markA,
    'a remote row for the repository /projA is a clone of wears that project hue'
  )
  assert.ok(
    rowFor(first.container, 'Foxtrot').querySelector('[data-remote-row-glyph]'),
    'and it still leads with the machine glyph — the machine is a glyph, not a second colour'
  )

  // ── Changed by the person, from the project header's menu ───────────────
  //
  // The header only exists in the project tree, so this half reads that shape.
  act(() => {
    useWorkspaceStore.getState().setChatListView('projects')
  })
  await act(async () => {
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
  })

  const headerButton = [...first.container.querySelectorAll('button[aria-label^="Folder actions"]')].find(
    (button) => button.getAttribute('aria-label')?.includes('projA')
  )
  assert.ok(headerButton, "projA's header offers its folder menu")
  act(() => {
    headerButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })

  const swatch = [...dom.window.document.querySelectorAll('button[aria-label="Project colour Violet"]')][0]
  assert.ok(swatch, '"Project colour" is on the folder header menu, with the six hues')
  act(() => {
    swatch!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
  })

  const headerGlyphOf = (container: Element, name: string) => {
    const header = [...container.querySelectorAll('button[aria-expanded]')].find((candidate) =>
      candidate.textContent?.includes(name)
    )
    assert.ok(header, `folder header for ${name} rendered`)
    return header!.querySelector('svg')
  }
  assert.equal(
    markClassOf(headerGlyphOf(first.container, 'projA')),
    'project-mark-violet',
    "the header's own glyph takes the colour the person picked"
  )
  assert.equal(
    markClassOf(rowFor(first.container, 'Foxtrot').querySelector('[data-project-glyph] svg')),
    'project-mark-violet',
    'and so does the remote row for the same repository, at the same moment'
  )
  assert.equal(
    markClassOf(headerGlyphOf(first.container, 'projB')),
    markB,
    'the other project is untouched'
  )

  act(() => {
    first.root.unmount()
  })

  // ── Restarting the app keeps every project's colour ─────────────────────
  //
  // A second mount over the same persisted `appSettings.projectColors` is what
  // the next launch is: the allocator must find nothing missing and write
  // nothing, so every glyph comes back the colour it was left.
  act(() => {
    useWorkspaceStore.getState().setChatListView('all')
  })
  const second = await mount()
  assert.equal(
    markClassOf(glyphOf(second.container, 'Alpha')),
    'project-mark-violet',
    'a re-mount over the stored map keeps the colour the person chose'
  )
  assert.equal(
    markClassOf(glyphOf(second.container, 'Charlie')),
    markB,
    'and the hue the allocator chose, rather than allocating a fresh one'
  )
  assert.equal(
    markClassOf(glyphOf(second.container, 'Echo')),
    null,
    'the unfiled row is still no project'
  )

  act(() => {
    second.root.unmount()
  })
}

main()
  .then(() => console.log('workspace sidebar project colour tests passed'))
  .catch((error) => {
    console.error(error)
    // Exit rather than fall off the end: a failure leaves a React root mounted,
    // and the row clocks it owns are intervals that would hold the process open
    // until the runner's own timeout instead of reporting the assertion.
    process.exit(1)
  })
