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
  workspaceSyncService?: {
    flushRoutingSnapshot(): Promise<void>
  }
  sprintEngineMcpHub?: {
    stop(): Promise<void>
  }
  // Capability-module kernel: runs module startup hooks on ready and shutdown
  // hooks on quit. Currently no bundled module registers hooks, so these are
  // no-ops, but this is the integration point for module-owned lifecycle.
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
  workspaceSyncService,
  sprintEngineMcpHub,
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
      await terminalRuntime.shutdown()
      await workspaceSyncService?.flushRoutingSnapshot()
      await sprintEngineMcpHub?.stop()
      await shutdownSwitchboardPythonRuntime()
      await releaseAllWorkspaceRunnerLocks()
      // The mobile relay bridge's shutdown runs here, via its module's
      // onShutdown hook (it owns the bridge now).
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
