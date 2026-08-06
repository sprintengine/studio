import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// MC-2135, owner ruling C (2026-08-06): every project row in the sidebar tree
// carries an identity slot again — the project's own logo when its repo has
// one, the workspace-type glyph when it does not. This suite mounts the real
// sidebar and asserts the rendered row, because the thing the ruling decided is
// what the row renders and at what indent, and nothing below the component can
// prove that.

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

// Only `/projA` has a logo, so one mount renders both halves of the ruling:
// logo rows and glyph rows adjacent, which is the case the ruling was about.
const LOGO_DATA_URL = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4='
// A deliberately minimal bridge, the same shape the sibling sidebar suites
// use: unrelated nav entries touch methods that are not here, throw inside
// their own effects, and are contained there — which is exactly why this suite
// does NOT await `act` (an async act flushes those effects into the test).
const detected: string[] = []
domWindow.api = {
  platform: 'darwin',
  detectProjectLogo: async (folderPath: string) => {
    detected.push(folderPath)
    return folderPath === '/projA'
      ? { path: '/projA/logo.svg', mtimeMs: 1, dataUrl: LOGO_DATA_URL }
      : null
  },
}

// The generic standard glyph's distinctive path, so "the glyph rendered" is
// pinned to the real mark rather than to "some svg is present".
const STANDARD_GLYPH_PATH = 'M7.25 10L10 12.5L7.25 15'

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
  const { resetProjectLogos } = await import('../../utils/projectLogos')

  resetProjectLogos()

  type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
  const workspace = (id: string, name: string, folderPath: string) =>
    ({ id, name, mode: 'standard', folderPath }) as unknown

  const workspaces = [
    workspace('w1', 'Alpha', '/projA'),
    workspace('w2', 'Bravo', '/projB'),
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
  // Detection is asynchronous, so drain the microtasks it settles over outside
  // `act`, then re-enter to commit the resulting store update.
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  act(() => {})

  const rows = [...container.querySelectorAll('[role="treeitem"]')]
  assert.ok(rows.length >= 2, 'both project rows rendered')

  const rowFor = (name: string) => {
    const row = rows.find((candidate) => candidate.textContent?.includes(name))
    assert.ok(row, `row for ${name} rendered`)
    return row!
  }

  // The ruling: EVERY row carries the slot. That is exactly what separates C
  // from the logo-only variant, so it is asserted on the glyph row too.
  for (const name of ['Alpha', 'Bravo']) {
    const first = rowFor(name).firstElementChild
    assert.ok(
      first?.classList.contains('icon-sm'),
      `${name}'s row opens with the 16px identity slot`,
    )
  }

  const alpha = rowFor('Alpha')
  const alphaImage = alpha.querySelector('img')
  assert.ok(alphaImage, 'a project whose repo has a logo renders it in the slot')
  assert.equal(alphaImage!.getAttribute('src'), LOGO_DATA_URL, 'the slot shows that project own logo')
  assert.equal(alphaImage!.getAttribute('aria-hidden'), 'true', 'the logo is decorative, like the glyph')
  assert.ok(!alpha.innerHTML.includes(STANDARD_GLYPH_PATH), 'the glyph steps aside for the logo')

  const bravo = rowFor('Bravo')
  assert.equal(bravo.querySelector('img'), null, 'a project with no logo renders no image')
  assert.ok(
    bravo.innerHTML.includes(STANDARD_GLYPH_PATH),
    'a project with no logo keeps the workspace-type glyph — the ruling C half',
  )

  assert.ok(detected.includes('/projA') && detected.includes('/projB'), 'each project folder is scanned once')

  act(() => {
    root.unmount()
  })
}

main()
  .then(() => console.log('workspace sidebar identity icon tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
