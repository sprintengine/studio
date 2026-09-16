import { app, BrowserWindow, ipcMain, Menu, net } from 'electron'
import { createAppMenu } from './app-menu'
import { sweepRetiredCheckpoints } from './checkpoint-sweep'
import { createBootReveal } from './boot-reveal'
import { DEEP_LINK_SCHEMES } from './deep-link-scheme'
import { runBootDiscovery } from './boot-discovery'
import { closeSplashWindow, createSplashWindow, sendSplashProgress } from './splash-window'
import { createMainWindow, markAppQuitInProgressForWindowClose, revealMainWindow } from './window-factory'
import { markStartup } from './startup-timeline'
import { createBackgroundPresence } from './background-presence'
import { buildElectronBackgroundMenu, createElectronBackgroundTray } from './background-tray-electron'
import { emptyBackgroundStatus, type BackgroundStatus } from '../shared/background-mode'
import { writeDiagnosticLog } from './diagnostics-service'
import type { MulticodeUpdateService } from './update-service'
import { createHostedFeedPoller, type HostedFeedPoller } from './hosted-feed/poller'
import { readHostedModelFeed } from './hosted-feed/hosted-feed-service'
import { readHostedCardFeed } from './hosted-feed/card-feed-service'
import { readHostedSourcesFeed } from './hosted-feed/sources-feed-service'
import { readCliVersionAdvisories } from './cli-version-advisory-service'

type RegisterAppLifecycleOptions = {
  diagnosticsEnabled: boolean
  allowMultipleInstances?: boolean
  terminalRuntime: {
    shutdown(): Promise<void>
  }
  // Conversation-agent runtime: quit must dispose its headless child
  // processes too — they live outside the PTY reaper's sight.
  conversationRuntime?: {
    shutdown(): Promise<void>
  }
  automationService?: {
    initialize(): Promise<unknown>
    shutdown(): Promise<void>
  }
  // Always-on (no setting gate): the reporter socket must be listening before
  // any agent launches so the first lifecycle frame is captured.
  agentStateService?: {
    initialize(): Promise<void>
    shutdown(): Promise<void>
  }
  workspaceSyncService?: {
    /** Persist the debounced workspace registry write before the app exits. */
    flush(): Promise<void>
  }
  // The conversation pull request record (epic `pull-request-marks`). It holds
  // a chained write per repository and a watch timer per open pull request, so
  // quit has to settle the writes — a capture in the last seconds before quit
  // is otherwise lost — and tear the timers down with the runtime that owns the
  // sessions they were armed for.
  pullRequestRecord?: {
    flush(): Promise<void>
    dispose(): void
  }
  // Product telemetry. Given a shutdown leg of its own because everything above
  // it can emit a final event, and the buffer is in memory, so a quit that does
  // not drain it loses the whole session's tail.
  analytics?: {
    shutdown(): Promise<void>
  }
  // Capability-module kernel: runs module startup hooks on ready and shutdown
  // hooks on quit. Module-owned lifecycle runs here — the early begin phase
  // (runShutdownBegin, registration order) stops self-scheduled loops before
  // shared infrastructure tears down, and the late phase (runShutdown, reverse
  // registration order) drains in-flight work and stops kernel-owned sidecars.
  moduleKernel?: {
    runStartup(): Promise<void>
    runShutdownBegin(): Promise<void>
    runShutdown(): Promise<void>
  }
  updateService: MulticodeUpdateService
  handleAuthCallback(argv: string[]): void
  // Background mode (MC-2156). Absent means the setting can never read on, so
  // the last-window-close rule collapses to exactly its pre-MC-2156 form.
  backgroundMode?: {
    isEnabled(): boolean
    readStatus(): BackgroundStatus
  }
  /** The plugin-source update check (skills service); rides the hourly feed leg. */
  checkPluginSourceUpdates?: () => Promise<unknown>
}

export function registerAppLifecycle({
  diagnosticsEnabled,
  allowMultipleInstances = false,
  terminalRuntime,
  conversationRuntime,
  automationService,
  agentStateService,
  workspaceSyncService,
  pullRequestRecord,
  analytics,
  moduleKernel,
  updateService,
  handleAuthCallback,
  backgroundMode,
  checkPluginSourceUpdates,
}: RegisterAppLifecycleOptions): void {
  // Background mode (MC-2156): the last window closing stops being the end of
  // the process. Everything below the window layer — the scheduler, the Studio
  // gateway, the automations engine, the mobile bridge, the power-save blocker
  // held for active runs — is untouched by any of this on purpose; window close
  // is a presentation event.
  const backgroundPresence = createBackgroundPresence({
    platform: process.platform,
    isBackgroundModeEnabled: () => backgroundMode?.isEnabled() ?? false,
    readStatus: () => backgroundMode?.readStatus() ?? emptyBackgroundStatus(),
    createTray: createElectronBackgroundTray,
    buildMenu: buildElectronBackgroundMenu,
    actions: {
      open: () => openWindowFromBackground(),
      quit: () => app.quit(),
    },
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  // Reopening from the tray (or a second launch of the app) has to work on
  // Windows and Linux, where there is no `activate` event to fall back on.
  function openWindowFromBackground(): void {
    const existing = BrowserWindow.getAllWindows()[0]
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    } else {
      createMainWindow({ diagnosticsEnabled })
    }
    backgroundPresence.onWindowOpened()
  }

  if (!allowMultipleInstances) {
    const singleInstanceLock = app.requestSingleInstanceLock()
    if (!singleInstanceLock) {
      app.quit()
      return
    }

    app.on('second-instance', (_, argv) => {
      // Relaunching the app while it is backgrounded must produce a window:
      // without this the second launch silently did nothing, which on Windows
      // and Linux left the tray as the only way back in.
      openWindowFromBackground()
      handleAuthCallback(argv)
    })
  }

  app.on('open-url', (event, callbackUrl) => {
    event.preventDefault()
    handleAuthCallback([callbackUrl])
  })

  let hostedFeedPoller: HostedFeedPoller | null = null

  app.whenReady().then(async () => {
    markStartup('main.app-ready')
    app.setAppLogsPath()

    if (process.platform === 'win32') {
      app.setAppUserModelId(
        process.env['ELECTRON_RENDERER_URL'] ? process.execPath : 'com.sprintengine.studio'
      )
    }
    registerDeepLinkProtocols()

    Menu.setApplicationMenu(createAppMenu())
    // Always-on: one local SprintEngine Studio MCP gateway per app instance.
    await automationService?.initialize()

    // The plate goes up BEFORE the main window is created: from here until the
    // reveal there is always something on screen.
    createSplashWindow()
    markStartup('main.splash-shown')
    const mainWindow = createMainWindow({ diagnosticsEnabled, deferShow: true })
    markStartup('main.window-created')

    const bootReveal = createBootReveal({
      reveal: () => {
        // Order matters: close the plate first, then show the app. Reversed,
        // both are briefly on screen — the one thing the transition must never
        // do.
        closeSplashWindow()
        revealMainWindow(mainWindow)
        markStartup('main.reveal')
      },
    })
    // `once`: a renderer that reloads mid-boot (dev HMR) must not re-arm a
    // reveal that has already happened.
    ipcMain.once('app:boot-complete', () => bootReveal.trigger())
    // A renderer that dies before its first frame never sends the signal, and
    // the window it was going to reveal is hidden. The timeout inside
    // createBootReveal is the only thing between that and a Force Quit, so cover
    // outright destruction here too rather than making the user wait it out.
    mainWindow.webContents.on('render-process-gone', () => bootReveal.trigger())

    // Discovery runs while the plate is up. Deliberately not awaited: the reveal
    // is driven by the renderer's first frame, not by these legs, so a slow CLI
    // probe delays a warmed cache and never the app.
    void runBootDiscovery({
      onProgress: sendSplashProgress,
      // Not awaited, so this mark can (and usually does) land after the reveal —
      // which is the point: it shows how much of the boot the user never waits
      // for, and how much of the CLI probe the splash actually covered.
      // The one update check at boot. It MOVED here rather than being
      // duplicated; the packaged guard rides with it, since checkForUpdates
      // records an error state in an unpackaged build.
      checkUpdates: async () => {
        if (!app.isPackaged) return
        await updateService.checkForUpdates(false)
      },
    }).finally(() => markStartup('main.discovery-settled'))

    // What the studio pulls on its own after boot: the hosted model feed, the
    // hosted card feed and the CLI version advisories 15 s after the window is
    // up and then hourly, app updates every four minutes — often enough that a
    // session left open all day still learns about a same-day release.
    // The boot leg above keeps the one immediate update check; the poller's
    // first update check waits a full interval so it is not repeated. Skipped
    // while offline.
    hostedFeedPoller = createHostedFeedPoller({
      checkUpdates: async () => {
        if (!app.isPackaged) return
        await updateService.checkForUpdates(false)
      },
      // Four riders on one hour. The plugin-source update check rides the feed
      // leg for the cadence it wants and one fewer timer
      // (backlog/2026-09-05-plugin-sources.md), and the card feed rides it for
      // the same reason — this is the ONLY thing in the app that ever fetches
      // the card feed, and without it a shipped machine serves the bundled seed
      // until the next release, which is the whole point of hosting the file.
      // The sources feed (MC-2519) rides it for the same reason again: its IPC
      // only ever reads disk, so this leg is the only thing that refreshes the
      // recommended list a machine offers.
      //
      // The tick is a heartbeat and not a schedule: every rider owns its own
      // window, so an hourly knock on a feed fetched forty minutes ago costs
      // nothing and an offline machine is not made to pay a timeout. The feeds
      // own a TTL and a retry gap; the plugin-source check owns a per-source
      // cadence window that widens to a day when no GitHub token is configured
      // (MC-2519), which is why the ruling changed no timer here — the leg
      // still knocks hourly and simply finds nothing due 23 times out of 24.
      //
      // Each rider is awaited on its own so one feed that cannot be read does
      // not take the others' hour with it; the first failure is rethrown so the
      // poller still reports the leg as failed.
      refreshFeed: async () => {
        const failures: unknown[] = []
        await readHostedModelFeed().catch((error) => void failures.push(error))
        await readHostedCardFeed().catch((error) => void failures.push(error))
        await readHostedSourcesFeed().catch((error) => void failures.push(error))
        await checkPluginSourceUpdates?.().catch(() => undefined)
        if (failures.length > 0) throw failures[0]
      },
      refreshVersions: () => readCliVersionAdvisories(),
      isOnline: () => net.isOnline(),
    })
    hostedFeedPoller.start()

    // One-shot cleanup of the retired checkpoint machinery
    // (the-diff-an-agent-made / remove-checkpoint-machinery). Deliberately not
    // awaited and deliberately after the window exists: it walks repos with
    // `git update-ref -d`, and a cleanup that cannot finish must never be
    // something a launch waits on. With no checkpoint index on disk it returns
    // immediately, which is every machine that never ran those builds.
    // MIGRATION — remove this call and src/main/checkpoint-sweep.ts one release
    // after it ships (target: 2026-10).
    void sweepRetiredCheckpoints(app.getPath('userData'))
      .then((result) => {
        if (result.refsDeleted > 0 || result.indexRemoved) {
          void writeDiagnosticLog({
            level: 'info',
            source: 'workspace',
            title: 'Retired checkpoint refs swept',
            message: `Removed ${result.refsDeleted} ref(s) across ${result.reposVisited} repo(s)`,
          }).catch(() => undefined)
        }
      })
      .catch(() => {
        // The index survives a failure, so the next launch tries again.
      })

    // Always-on: start the agent-state reporter socket so launches that follow
    // can install the hook against a live endpoint.
    void agentStateService?.initialize()
    void moduleKernel?.runStartup()
    handleAuthCallback(process.argv)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow({ diagnosticsEnabled })
      // The tray stands in for a window; with one on screen it goes away, so a
      // backgrounded app never shows two ways in at once.
      backgroundPresence.onWindowOpened()
    })
  })

  app.on('window-all-closed', () => {
    if (backgroundPresence.onWindowAllClosed() === 'quit') app.quit()
  })

  let isShuttingDown = false
  app.on('before-quit', (event) => {
    if (isShuttingDown) return
    event.preventDefault()
    isShuttingDown = true
    // Drop the tray before the shutdown legs run: quit from the tray is the
    // same graceful path as any other quit (sidecar snapshots, gateway
    // discovery file removed), and the icon must not outlive the decision.
    backgroundPresence.onBeforeQuit()
    markAppQuitInProgressForWindowClose()
    const shutdown = async () => {
      // Module begin hooks run first (registration order): they stop
      // self-scheduled loops and flip shutting-down flags so no new work is
      // dispatched while shared infrastructure tears down.
      await moduleKernel?.runShutdownBegin()
      hostedFeedPoller?.stop()
      await automationService?.shutdown()
      await agentStateService?.shutdown()
      await terminalRuntime.shutdown()
      // In the same leg as the terminal service, and after it: the last frames
      // it ingests can still file a captured pull request, and this is what
      // gets that write to disk and stops the watch timers.
      await pullRequestRecord?.flush()
      pullRequestRecord?.dispose()
      await conversationRuntime?.shutdown()
      await workspaceSyncService?.flush()
      // Last of the app-owned legs: every service above has had its chance to
      // record, and a network round trip must not sit in front of anything
      // that still has state to persist.
      await analytics?.shutdown()
      // Module-owned shutdown runs here via each module's onShutdown hook —
      // draining in-flight work and stopping kernel-owned sidecars in reverse
      // registration order.
      await moduleKernel?.runShutdown()
    }

    void shutdown().finally(() => {
      app.exit(0)
    })
  })
}

// Both schemes, current and legacy — see `deep-link-scheme.ts` for why the old
// one is still claimed. Registering is cheap and idempotent; an unclaimed
// scheme is a dead link with nowhere to report itself.
function registerDeepLinkProtocols(): void {
  for (const scheme of DEEP_LINK_SCHEMES) {
    if (!app.isPackaged) {
      // A dev build is `electron <app-dir>`, so the OS has to be handed both
      // halves; a packaged bundle describes its own entry point.
      app.setAsDefaultProtocolClient(scheme, process.execPath, [app.getAppPath()])
    } else {
      app.setAsDefaultProtocolClient(scheme)
    }
  }
}
