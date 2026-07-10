import { app, BrowserWindow, Menu } from 'electron'
import { createAppMenu } from './app-menu'
import { createMainWindow, markAppQuitInProgressForWindowClose } from './window-factory'
import { releaseAllWorkspaceRunnerLocks } from './workspace-runner-lock'
import { currentRuntimeEnv, getManagedPython, reportManagedPythonResolution } from './managed-runtime'
import type { MulticodeUpdateService } from './update-service'

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
    flushRoutingSnapshot(): Promise<void>
  }
  // The main-process sprint scheduler (sprint-runtime-ownership Phase 2):
  // stopped before the terminal runtime tears down so no tick spawns into a
  // dying process table; its shutdown also releases the power-save blocker.
  sprintRuntime?: {
    shutdown(): void
  }
  // Capability-module kernel: runs module startup hooks on ready and shutdown
  // hooks on quit. Module-owned lifecycle runs here — the early begin phase
  // (runShutdownBegin, registration order) stops self-scheduled loops before
  // shared infrastructure tears down, and the late phase (runShutdown, reverse
  // registration order) drains in-flight work and stops kernel-owned sidecars
  // (e.g. the Sprint Engine MCP hub via its module's sidecar registration).
  moduleKernel?: {
    runStartup(): Promise<void>
    runShutdownBegin(): Promise<void>
    runShutdown(): Promise<void>
  }
  updateService: MulticodeUpdateService
  handleAuthCallback(argv: string[]): void
}

export function registerAppLifecycle({
  diagnosticsEnabled,
  allowMultipleInstances = false,
  terminalRuntime,
  conversationRuntime,
  automationService,
  agentStateService,
  workspaceSyncService,
  sprintRuntime,
  moduleKernel,
  updateService,
  handleAuthCallback,
}: RegisterAppLifecycleOptions): void {
  if (!allowMultipleInstances) {
    const singleInstanceLock = app.requestSingleInstanceLock()
    if (!singleInstanceLock) {
      app.quit()
      return
    }

    app.on('second-instance', (_, argv) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        if (win.isMinimized()) win.restore()
        win.focus()
      }
      handleAuthCallback(argv)
    })
  }

  app.on('open-url', (event, callbackUrl) => {
    event.preventDefault()
    handleAuthCallback([callbackUrl])
  })

  app.whenReady().then(() => {
    app.setAppLogsPath()

    // Surface which Python the app resolved; warns when a packaged build missed
    // the bundled CPython instead of silently falling back to system python3.
    reportManagedPythonResolution(getManagedPython(), currentRuntimeEnv())

    if (process.platform === 'win32') {
      app.setAppUserModelId(
        process.env['ELECTRON_RENDERER_URL'] ? process.execPath : 'com.multicode'
      )
    }
    registerMulticodeProtocol()

    Menu.setApplicationMenu(createAppMenu())
    createMainWindow({ diagnosticsEnabled })
    // Off by default: initialize() only starts the local automation socket
    // when the persisted setting enables it.
    void automationService?.initialize()
    // Always-on: start the agent-state reporter socket so launches that follow
    // can install the hook against a live endpoint.
    void agentStateService?.initialize()
    void moduleKernel?.runStartup()
    handleAuthCallback(process.argv)

    if (app.isPackaged) {
      void updateService.checkForUpdates(false)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow({ diagnosticsEnabled })
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  let isShuttingDown = false
  app.on('before-quit', (event) => {
    if (isShuttingDown) return
    event.preventDefault()
    isShuttingDown = true
    markAppQuitInProgressForWindowClose()
    const shutdown = async () => {
      // Module begin hooks run first (registration order): they stop
      // self-scheduled loops and flip shutting-down flags so no new work is
      // dispatched while shared infrastructure tears down.
      await moduleKernel?.runShutdownBegin()
      sprintRuntime?.shutdown()
      await automationService?.shutdown()
      await agentStateService?.shutdown()
      await terminalRuntime.shutdown()
      await conversationRuntime?.shutdown()
      await workspaceSyncService?.flushRoutingSnapshot()
      await releaseAllWorkspaceRunnerLocks()
      // Module-owned shutdown runs here via each module's onShutdown hook —
      // draining in-flight work and stopping kernel-owned sidecars (e.g. the
      // Sprint Engine MCP hub) in reverse registration order.
      await moduleKernel?.runShutdown()
    }

    void shutdown().finally(() => {
      app.exit(0)
    })
  })
}

function registerMulticodeProtocol(): void {
  if (!app.isPackaged) {
    const appEntry = app.getAppPath()
    app.setAsDefaultProtocolClient('multicode', process.execPath, [appEntry])
    return
  }

  app.setAsDefaultProtocolClient('multicode')
}
