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
    type LegReport = { name: string; done: number; total: number; failed: boolean }
    let prepareForInstall: ((report?: (leg: LegReport) => void) => Promise<void>) | null = null
    registerAppLifecycle({
      diagnosticsEnabled: false,
      allowMultipleInstances: true,
      terminalRuntime: {
        shutdown: async () => {
          order.push('terminal.shutdown')
        },
      },
      conversationOwner: {
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
      // A recording an agent started is saved, with its length, before the
      // canvas and the registry's last write.
      browserRecorder: {
        stopAll: async () => {
          order.push('browserRecorder.stopAll')
        },
      },
      analytics: {
        shutdown: async () => {
          order.push('analytics.shutdown')
        },
      },
      // A plain quit's, once no agent the app launched is left to run what it
      // takes out; never an update's.
      removeSessionIntegrations: async () => {
        order.push('integrations.remove')
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
        setPrepareForInstall: (prepare: (report?: (leg: LegReport) => void) => Promise<void>) => {
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
    const reports: LegReport[] = []
    await (prepareForInstall as (report?: (leg: LegReport) => void) => Promise<void>)((leg) => reports.push(leg))
    assert.deepEqual(exitCalls, [], 'the installer, not the shutdown, ends the process')
    // Every leg reports as it finishes, in order, which is what moves the
    // update progress window's bar; a leg that throws still reports, as failed.
    assert.deepEqual(
      reports.map((leg) => leg.done),
      reports.map((_, index) => index + 1),
    )
    assert.ok(reports.every((leg) => leg.total === reports.length))
    assert.deepEqual(
      reports.filter((leg) => leg.failed).map((leg) => leg.name),
      ['canvas'],
    )
    assert.ok(reports.some((leg) => leg.name === 'terminals'))
    assert.deepEqual(order, [
      'workspaceSync.flush',
      'conversation.flushTranscripts',
      'terminal.shutdown',
      'pullRequests.flush',
      'pullRequests.dispose',
      'conversation.shutdown',
      'browserRecorder.stopAll',
      'canvas.dispose',
      'workspaceSync.flush',
      // Not the integrations' removal: the new build writes them straight back.
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

    // ── Out of process (phase 6): the shell's client closes before the server
    // drains, the shell's own legs run while it drains, and the integrations
    // wait for the server to be gone.
    appEvents.clear()
    exitCalls = []
    const split: string[] = []
    let drainBudgetMs = -1
    let serverGone: () => void = () => undefined
    registerAppLifecycle({
      diagnosticsEnabled: false,
      allowMultipleInstances: true,
      terminalRuntime: {
        shutdown: async () => {
          split.push('terminal.shutdown')
        },
      },
      desktopShell: {
        stop: () => {
          split.push('desktopShell.stop')
        },
      },
      removeSessionIntegrations: async () => {
        split.push('integrations.remove')
      },
      server: {
        start: () => undefined,
        log: { note: () => undefined },
        onAttentionPhase: () => undefined,
        shutdown: (options: { budgetMs: number }) => {
          split.push('server.shutdown')
          drainBudgetMs = options.budgetMs
          return new Promise<'exited'>((resolve) => {
            serverGone = () => {
              split.push('server.exited')
              resolve('exited')
            }
          })
        },
      },
      updateService: {
        checkForUpdates: async () => undefined,
        setPrepareForInstall: () => undefined,
      } as unknown as Parameters<typeof registerAppLifecycle>[0]['updateService'],
      handleAuthCallback: () => undefined,
    } as unknown as Parameters<typeof registerAppLifecycle>[0])
    const splitQuit = appEvents.get('before-quit') ?? []
    splitQuit[0]({ preventDefault: () => undefined })
    for (let pass = 0; pass < 50 && !split.includes('terminal.shutdown'); pass += 1)
      await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(split, ['desktopShell.stop', 'server.shutdown', 'terminal.shutdown'])
    assert.equal(drainBudgetMs, 8_000)
    assert.deepEqual(exitCalls, [], 'the app waits for the server')
    serverGone()
    for (let pass = 0; pass < 50 && exitCalls.length === 0; pass += 1)
      await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(split.slice(3), ['server.exited', 'integrations.remove'])
    assert.deepEqual(exitCalls, [0])

    // Leaving for an update, the drain's budget counts from the shutdown's
    // start, so its kill lands inside the update's 10 s.
    const { serverUpdateDrainBudgetMs } = await import('./app-lifecycle')
    assert.equal(serverUpdateDrainBudgetMs(0), 6_000)
    assert.equal(serverUpdateDrainBudgetMs(4_000), 4_500)
    assert.equal(serverUpdateDrainBudgetMs(30_000), 500)
  }

  const suiteRun = main()
    .then(() => console.log('app-lifecycle: all assertions passed'))
    .finally(() => {
      restoreModules()
    })

  await suiteRun
})
