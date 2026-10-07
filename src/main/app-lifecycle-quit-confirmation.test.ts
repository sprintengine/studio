import assert from 'node:assert/strict'
import { beforeAll, beforeEach, test } from 'vitest'

import { standIn } from '../../tests/stand-in'
import type { QuitDecision } from './quit-confirmation'

// The lifecycle's half of the quit question, with Electron replaced: which
// quits are asked, what each answer does, and which quits are never asked.
// The question's own rules are quit-confirmation.test.ts's.

type Handler = (...args: unknown[]) => unknown

const appEvents = new Map<string, Handler[]>()
const exitCalls: number[] = []
let quitCalls = 0

const mockApp = {
  isPackaged: false,
  on(event: string, handler: Handler) {
    appEvents.set(event, [...(appEvents.get(event) ?? []), handler])
    return mockApp
  },
  once(event: string, handler: Handler) {
    return mockApp.on(event, handler)
  },
  whenReady: () => new Promise<void>(() => {}),
  quit: () => {
    quitCalls += 1
  },
  relaunch: () => undefined,
  exit: (code: number) => {
    exitCalls.push(code)
  },
  getPath: () => '/tmp/sprintengine-lifecycle-quit-test',
  getAppPath: () => '/tmp/sprintengine-lifecycle-quit-test',
  setAppLogsPath: () => undefined,
  setAsDefaultProtocolClient: () => true,
}

const mockElectron = {
  app: mockApp,
  BrowserWindow: { getAllWindows: () => [] as unknown[] },
  ipcMain: { on: () => undefined, once: () => undefined, handle: () => undefined },
  Menu: { setApplicationMenu: () => undefined, buildFromTemplate: () => ({}) },
  net: { isOnline: () => false },
  Tray: class {},
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  shell: { openExternal: async () => undefined },
  dialog: {},
  powerMonitor: { on: () => undefined },
  session: { defaultSession: { webRequest: { onHeadersReceived: () => undefined } } },
  nativeTheme: { on: () => undefined, shouldUseDarkColors: false },
  powerSaveBlocker: { start: () => 0, stop: () => undefined, isStarted: () => false },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
}

let registerAppLifecycle: typeof import('./app-lifecycle').registerAppLifecycle

beforeAll(async () => {
  standIn({ electron: mockElectron })
  ;({ registerAppLifecycle } = await import('./app-lifecycle'))
})

beforeEach(() => {
  appEvents.clear()
  exitCalls.length = 0
  quitCalls = 0
})

const settle = async () => {
  for (let pass = 0; pass < 30; pass += 1) await new Promise((resolve) => setImmediate(resolve))
}

function register(decision: QuitDecision) {
  const calls = { confirm: 0, quitWithoutAsking: 0, terminals: 0 }
  let prepareForInstall: (() => Promise<void>) | null = null
  registerAppLifecycle({
    diagnosticsEnabled: false,
    allowMultipleInstances: true,
    terminalRuntime: {
      shutdown: async () => {
        calls.terminals += 1
      },
    },
    quitConfirmation: {
      confirm: async () => {
        calls.confirm += 1
        return decision
      },
      quitWithoutAsking: () => {
        calls.quitWithoutAsking += 1
      },
    },
    updateService: {
      checkForUpdates: async () => undefined,
      setPrepareForInstall: (prepare: () => Promise<void>) => {
        prepareForInstall = prepare
      },
    } as unknown as Parameters<typeof registerAppLifecycle>[0]['updateService'],
    handleAuthCallback: () => undefined,
  })
  const beforeQuit = () => {
    let prevented = false
    appEvents.get('before-quit')?.[0]?.({ preventDefault: () => (prevented = true) })
    return prevented
  }
  return { calls, beforeQuit, prepareForInstall: () => prepareForInstall!() }
}

test('a quit the person confirms runs the shutdown and exits', async () => {
  const { calls, beforeQuit } = register('quit')
  assert.equal(beforeQuit(), true, 'held while the question is up')
  await settle()
  assert.equal(calls.confirm, 1)
  assert.equal(calls.terminals, 1)
  assert.deepEqual(exitCalls, [0])
})

test('Cancel keeps the app: no shutdown, no exit', async () => {
  const { calls, beforeQuit } = register('stay')
  assert.equal(beforeQuit(), true)
  await settle()
  assert.equal(calls.confirm, 1)
  assert.equal(calls.terminals, 0)
  assert.deepEqual(exitCalls, [])
})

test('a second quit while the question is up does nothing of its own', async () => {
  const { calls, beforeQuit } = register('pending')
  beforeQuit()
  await settle()
  assert.equal(calls.terminals, 0)
  assert.deepEqual(exitCalls, [])
})

test('"Restart to update" is never asked: its quit joins the shutdown it already ran', async () => {
  const { calls, beforeQuit, prepareForInstall } = register('stay')
  await prepareForInstall()
  assert.equal(calls.quitWithoutAsking, 1)
  assert.equal(calls.terminals, 1)
  beforeQuit()
  await settle()
  assert.equal(calls.confirm, 0, 'the updater’s own quit is not a question')
  assert.deepEqual(exitCalls, [0])
})

test('a logout or shutdown on Windows marks the quit as the OS’s', () => {
  const { calls } = register('quit')
  const windowEvents = new Map<string, Handler>()
  appEvents.get('browser-window-created')?.[0]?.(
    {},
    { on: (event: string, handler: Handler) => void windowEvents.set(event, handler) },
  )
  windowEvents.get('query-session-end')?.()
  windowEvents.get('session-end')?.()
  assert.equal(calls.quitWithoutAsking, 2)
})

test('closing the last window where that quits asks first, and quits on Quit', async () => {
  // Not macOS and no background mode: the last window closing is a quit.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'linux' })
  let calls: ReturnType<typeof register>['calls']
  try {
    ;({ calls } = register('quit'))
    appEvents.get('window-all-closed')?.[0]?.()
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
  await settle()
  assert.equal(calls.confirm, 1)
  assert.equal(quitCalls, 1)
})
