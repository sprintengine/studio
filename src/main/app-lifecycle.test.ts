import assert from 'node:assert/strict'
import Module from 'node:module'
import { test } from 'vitest'

test('app-lifecycle', async () => {
  // The quit path, with Electron replaced. Nothing here opens a window or reaches
  // the app's `ready` event: `whenReady()` never resolves, so only the legs
  // registered before it run — which is all the shutdown ordering needs.

  type Handler = (...args: unknown[]) => unknown

  const appEvents = new Map<string, Handler[]>()
  let exitCalls: number[] = []

  const mockApp = {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    on(event: string, handler: Handler) {
      const handlers = appEvents.get(event) ?? []
      handlers.push(handler)
      appEvents.set(event, handlers)
      return mockApp
    },
    once(event: string, handler: Handler) {
      return mockApp.on(event, handler)
    },
    // Never resolves: the ready leg creates windows and pollers, and none of that
    // is what this test is about.
    whenReady: () => new Promise<void>(() => {}),
    quit: () => undefined,
    exit: (code: number) => {
      exitCalls.push(code)
    },
    getPath: () => '/tmp/multicode-lifecycle-test',
    getAppPath: () => '/tmp/multicode-lifecycle-test',
    setAppLogsPath: () => undefined,
    setAppUserModelId: () => undefined,
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
    session: { defaultSession: { webRequest: { onHeadersReceived: () => undefined } } },
    nativeTheme: { on: () => undefined, shouldUseDarkColors: false },
    powerSaveBlocker: { start: () => 0, stop: () => undefined, isStarted: () => false },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
  }

  const moduleWithLoad = Module as typeof Module & {
    _load(request: string, parent: NodeModule | null, isMain: boolean): unknown
  }
  const originalLoad = moduleWithLoad._load
  moduleWithLoad._load = function loadWithElectronMock(
    request: string,
    parent: NodeModule | null,
    isMain: boolean,
  ): unknown {
    if (request === 'electron') return mockElectron
    return originalLoad.call(this, request, parent, isMain)
  }

  async function main(): Promise<void> {
    const { registerAppLifecycle } = require('./app-lifecycle') as typeof import('./app-lifecycle')

    const order: string[] = []
    let disposed = 0
    registerAppLifecycle({
      diagnosticsEnabled: false,
      allowMultipleInstances: true,
      terminalRuntime: {
        shutdown: async () => {
          order.push('terminal.shutdown')
        },
      },
      // REVIEW FIX (finding 8). The record was created with the app and never
      // flushed or disposed: a pull request captured in the last seconds before
      // quit was lost with the unwritten store, and its watch timers outlived
      // every service they were armed for.
      pullRequestRecord: {
        flush: async () => {
          order.push('pullRequests.flush')
        },
        dispose: () => {
          disposed += 1
          order.push('pullRequests.dispose')
        },
      },
      workspaceSyncService: {
        flush: async () => {
          order.push('workspaceSync.flush')
        },
      },
      updateService: {
        checkForUpdates: async () => undefined,
      } as unknown as Parameters<typeof registerAppLifecycle>[0]['updateService'],
      handleAuthCallback: () => undefined,
    })

    const beforeQuit = appEvents.get('before-quit') ?? []
    assert.equal(beforeQuit.length, 1, 'quit is handled exactly once')

    let prevented = 0
    beforeQuit[0]({
      preventDefault: () => {
        prevented += 1
      },
    })
    assert.equal(prevented, 1, 'the quit is held while the shutdown legs run')

    // The legs are promises; let them settle.
    for (let pass = 0; pass < 50 && exitCalls.length === 0; pass += 1)
      await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(exitCalls, [0], 'the app still exits once every leg has run')
    assert.ok(order.includes('pullRequests.flush'), 'the record is flushed at quit')
    assert.ok(order.includes('pullRequests.dispose'), 'and disposed, so no watch timer outlives it')
    assert.equal(disposed, 1)
    assert.ok(
      order.indexOf('terminal.shutdown') < order.indexOf('pullRequests.flush'),
      'after the terminal service: its last frames can still file a capture',
    )
    assert.ok(
      order.indexOf('pullRequests.flush') < order.indexOf('pullRequests.dispose'),
      'the write lands before the timers are torn down',
    )

    // A second quit is not a second shutdown.
    beforeQuit[0]({
      preventDefault: () => {
        prevented += 1
      },
    })
    for (let pass = 0; pass < 20; pass += 1) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(disposed, 1, 'a second before-quit does not run the legs again')
  }

  const suiteRun = main()
    .then(() => console.log('app-lifecycle: all assertions passed'))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(() => {
      moduleWithLoad._load = originalLoad
    })

  await suiteRun
})
