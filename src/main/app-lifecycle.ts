import { app, BrowserWindow, Menu } from 'electron'
import { resolve } from 'path'
import { createAppMenu } from './app-menu'
import { createMainWindow, markAppQuitInProgressForWindowClose } from './window-factory'
import { beginSwitchboardPythonRuntimeShutdown, shutdownSwitchboardPythonRuntime } from './switchboard-runtime-service'
import { releaseAllWorkspaceRunnerLocks } from './workspace-runner-lock'
import type { MulticodeUpdateService } from './update-service'

type RegisterAppLifecycleOptions = {
  diagnosticsEnabled: boolean
  allowMultipleInstances?: boolean
  terminalRuntime: {
    shutdown(): Promise<void>
  }
  automationService?: {
    initialize(): Promise<unknown>
    shutdown(): Promise<void>
  }
  workspaceSyncService?: {
    flushRoutingSnapshot(): Promise<void>
  }
  // Capability-module kernel: runs module startup hooks on ready and shutdown
  // hooks on quit. Module-owned lifecycle runs here — including kernel-owned
  // sidecar stops (e.g. the Sprint Engine MCP hub via its module's sidecar
  // registration), in reverse registration order.
  moduleKernel?: {
    runStartup(): Promise<void>
    runShutdown(): Promise<void>
  }
  updateService: MulticodeUpdateService
  handleAuthCallback(argv: string[]): void
}

export function registerAppLifecycle({
  diagnosticsEnabled,
  allowMultipleInstances = false,
  terminalRuntime,
  automationService,
  workspaceSyncService,
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
    beginSwitchboardPythonRuntimeShutdown()
    const shutdown = async () => {
      await automationService?.shutdown()
      await terminalRuntime.shutdown()
      await workspaceSyncService?.flushRoutingSnapshot()
      await shutdownSwitchboardPythonRuntime()
      await releaseAllWorkspaceRunnerLocks()
      // Module-owned shutdown runs here: the mobile relay bridge via its
      // onShutdown hook, and kernel-owned sidecar stops (e.g. the Sprint
      // Engine MCP hub) in reverse registration order.
      await moduleKernel?.runShutdown()
    }

    void shutdown().finally(() => {
      app.exit(0)
    })
  })
}

function registerMulticodeProtocol(): void {
  if (process.defaultApp) {
    const appEntry = process.argv[1] ? resolve(process.argv[1]) : app.getAppPath()
    app.setAsDefaultProtocolClient('multicode', process.execPath, [appEntry])
    return
  }

  app.setAsDefaultProtocolClient('multicode')
}
