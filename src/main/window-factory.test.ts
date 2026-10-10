import assert from 'node:assert/strict'
import { beforeEach, test, vi } from 'vitest'

// The aux windows' focus rule: a person's click brings the window forward; an
// agent's reveal (`focus: false`) never takes the keyboard or raises a window.
// A BrowserWindow that records what was done to it stands in for Electron's.

type Call = string

const created: FakeWindow[] = []

class FakeWindow {
  calls: Call[] = []
  minimized = false
  private listeners = new Map<string, Array<() => void>>()
  webContentsEvents: string[] = []
  webContents = {
    send: (channel: string) => this.calls.push(`send:${channel}`),
    on: (event: string) => this.webContentsEvents.push(event),
    setWindowOpenHandler: () => undefined,
  }
  constructor(public options: Record<string, unknown>) {
    created.push(this)
  }
  on(event: string, listener: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }
  isDestroyed = () => false
  isMinimized = () => this.minimized
  restore = () => this.calls.push('restore')
  focus = () => this.calls.push('focus')
  show = () => this.calls.push('show')
  showInactive = () => this.calls.push('showInactive')
  loadURL = () => this.calls.push('loadURL')
  loadFile = () => this.calls.push('loadFile')
  getTitle = () => 'Diff'
  setTitle = () => undefined
}

vi.mock('electron', () => ({
  BrowserWindow: FakeWindow,
  screen: {
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 4000, height: 4000 } }),
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 4000, height: 4000 } }),
  },
  shell: { openExternal: () => undefined },
  app: { getPath: () => '/tmp', isPackaged: false },
  ipcMain: { handle: () => undefined, on: () => undefined },
}))
vi.mock('./browser/browser-manager', () => ({ guestPreloadPath: () => '/tmp/guest.js' }))
vi.mock('./window-material-store', () => ({ getWindowMaterial: () => 'solid', getWindowCanvasColor: () => '#000' }))

const { isBrowserHostWebContents, openAuxWindow, openPanePopOutWindow } = await import('./window-factory')

beforeEach(() => {
  created.length = 0
})

test('a new aux window opened for an agent is shown inactive, never focused', () => {
  const result = openAuxWindow({
    kind: 'file',
    singletonKey: 'agent-new',
    params: { filePath: '/Users/dev/a.ts' },
    focus: false,
  })
  assert.deepEqual(result, { retargeted: false })
  const [win] = created
  win.emit('ready-to-show')
  assert.ok(win.calls.includes('showInactive'))
  assert.ok(!win.calls.includes('show'))
  assert.ok(!win.calls.includes('focus'))
})

test('an open aux window is retargeted where it stands: not restored, not focused', () => {
  openAuxWindow({ kind: 'diff', singletonKey: 'agent-existing', params: { repoRoot: '/Users/dev/repo' } })
  const [win] = created
  win.minimized = true
  win.calls.length = 0
  const result = openAuxWindow({
    kind: 'diff',
    singletonKey: 'agent-existing',
    params: { repoRoot: '/Users/dev/repo' },
    focus: false,
  })
  assert.deepEqual(result, { retargeted: true })
  assert.deepEqual(win.calls, ['send:aux:retarget'])
})

test("the person's own open still brings the window forward", () => {
  openAuxWindow({ kind: 'file', singletonKey: 'person', params: { filePath: '/Users/dev/a.ts' } })
  const [win] = created
  win.emit('ready-to-show')
  assert.ok(win.calls.includes('show'))
  assert.ok(win.calls.includes('focus'))
  win.minimized = true
  win.calls.length = 0
  openAuxWindow({ kind: 'file', singletonKey: 'person', params: { filePath: '/Users/dev/b.ts' } })
  assert.deepEqual(win.calls, ['restore', 'send:aux:retarget', 'focus'])
})

// A pane popped out of its window mounts the pane's own tabs, a browser tab
// among them, so it is the one aux window that hosts the embedded browser — and
// it hosts it under the guest policy a workspace window applies.
test('a pane pop-out window hosts the embedded browser, under the guest policy', () => {
  const win = openPanePopOutWindow({ popOutId: 'pop-1', workspaceId: 'ws-1', bounds: null }) as unknown as FakeWindow
  const preferences = win.options.webPreferences as Record<string, unknown>
  assert.equal(preferences.webviewTag, true)
  assert.ok(win.webContentsEvents.includes('will-attach-webview'), 'every guest it attaches is vetted')
  assert.equal(isBrowserHostWebContents(win.webContents as never), true)
  assert.equal(
    openPanePopOutWindow({ popOutId: 'pop-1', workspaceId: 'ws-1', bounds: null }) as unknown,
    win,
    'one window per pop-out id',
  )
})

test("a browser page's fullscreen in a popped-out pane fills its webview, not the window", () => {
  const win = openPanePopOutWindow({ popOutId: 'pop-fs', workspaceId: 'ws-1', bounds: null }) as unknown as FakeWindow
  const preferences = win.options.webPreferences as Record<string, unknown>
  assert.equal(preferences.disableHtmlFullscreenWindowResize, true)
})

test('no other aux window is given the webview tag', () => {
  openAuxWindow({ kind: 'diff', singletonKey: 'no-webview', params: { repoRoot: '/Users/dev/repo' } })
  const [win] = created
  const preferences = win.options.webPreferences as Record<string, unknown>
  assert.equal(preferences.webviewTag, undefined)
  assert.equal(win.webContentsEvents.includes('will-attach-webview'), false)
  assert.equal(isBrowserHostWebContents(win.webContents as never), false)
})
