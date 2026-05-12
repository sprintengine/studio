import { app, BrowserWindow, Menu } from 'electron'
import { resolve } from 'path'
import { createAppMenu } from './app-menu'
import { createMainWindow } from './window-factory'
import { knownBackendWorkspaces, stopAllKnownBackendRunners } from './backend-session-bridge'
import { forceTerminateSwitchboardBackend } from './switchboard-python'
import { releaseAllWorkspaceRunnerLocks } from './workspace-runner-lock'
import type { MulticodeUpdateService } from './update-service'

const BACKEND_QUIT_DEADLINE_MS = 5_000
const BACKEND_QUIT_GRACE_SECONDS = 3

type RegisterAppLifecycleOptions = {
  diagnosticsEnabled: boolean
  mobileBridge: {
    shutdown(): void
  }
  updateService: MulticodeUpdateService
  handleAuthCallback(argv: string[]): void
}

export function registerAppLifecycle({
  diagnosticsEnabled,
  mobileBridge,
  updateService,
  handleAuthCallback,
}: RegisterAppLifecycleOptions): void {
  const singleInstanceLock = app.requestSingleInstanceLock()
  if (!singleInstanceLock) {
    app.quit()
  } else {
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
    mobileBridge.shutdown()

    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      for (const root of knownBackendWorkspaces()) {
        forceTerminateSwitchboardBackend(root)
      }
      void releaseAllWorkspaceRunnerLocks().finally(() => {
        app.exit(0)
      })
    }
    const timeout = setTimeout(settle, BACKEND_QUIT_DEADLINE_MS)
    void stopAllKnownBackendRunners(BACKEND_QUIT_GRACE_SECONDS).finally(() => {
      clearTimeout(timeout)
      settle()
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
