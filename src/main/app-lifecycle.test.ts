import assert from 'node:assert/strict'
import { standIn } from '../../tests/stand-in'
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
    // The update path's fallback, should the installer never quit the app.
    relaunch: () => undefined,
    exit: (code: number) => {
      exitCalls.push(code)
    },
    getPath: () => '/tmp/sprintengine-lifecycle-test',
    getAppPath: () => '/tmp/sprintengine-lifecycle-test',
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

  const restoreModules = standIn({ electron: mockElectron })

  async function main(): Promise<void> {
    const { registerAppLifecycle } = await import('./app-lifecycle')

    const order: string[] = []
    let disposed = 0
    let prepareForInstall: (() => Promise<void>) | null = null
    registerAppLifecycle({
      diagnosticsEnabled: false,
      allowMultipleInstances: true,
      terminalRuntime: {
        shutdown: async () => {
          order.push('terminal.shutdown')
        },
      },
      conversationRuntime: {
        flushTranscripts: async () => {
          order.push('conversation.flushTranscripts')
        },
        shutdown: async () => {
          order.push('conversation.shutdown')
        },
      },
      // A leg that fails must not cost the legs after it.
      canvasService: {
        dispose: async () => {
          order.push('canvas.dispose')
          throw new Error('canvas worker gone')
        },
      },
      analytics: {
        shutdown: async () => {
          order.push('analytics.shutdown')
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
        setPrepareForInstall: (prepare: () => Promise<void>) => {
          prepareForInstall = prepare
        },
      } as unknown as Parameters<typeof registerAppLifecycle>[0]['updateService'],
      handleAuthCallback: () => undefined,
    })

    const beforeQuit = appEvents.get('before-quit') ?? []
    assert.equal(beforeQuit.length, 1, 'quit is handled exactly once')

    // "Restart to update": the whole ordered shutdown runs before the installer
    // is started, and the app is not exited yet — the updater's quit does that.
    assert.ok(prepareForInstall, 'the lifecycle hands the update service its shutdown')
    await (prepareForInstall as () => Promise<void>)()
    assert.deepEqual(exitCalls, [], 'the installer, not the shutdown, ends the process')
    assert.deepEqual(order, [
      'workspaceSync.flush',
      'conversation.flushTranscripts',
      'terminal.shutdown',
      'pullRequests.flush',
      'pullRequests.dispose',
      'conversation.shutdown',
      'canvas.dispose',
      'workspaceSync.flush',
      'analytics.shutdown',
    ])

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
    assert.equal(
      order.filter((entry) => entry === 'terminal.shutdown').length,
      1,
      'the updater’s quit joins the shutdown already run instead of running it again',
    )
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
      restoreModules()
    })

  await suiteRun
})
