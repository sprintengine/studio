import { app, BrowserWindow, Menu } from 'electron'
import { resolve } from 'path'
import { createAppMenu } from './app-menu'
import { createMainWindow } from './window-factory'
import { stopAllKnownBackendRunners } from './backend-session-bridge'
import type { MulticodeUpdateService } from './update-service'

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
    if (KNOWN_BACKEND_DEADLINE_MS <= 0) {
      mobileBridge.shutdown()
      return
    }
    event.preventDefault()
    isShuttingDown = true
    mobileBridge.shutdown()
    const settle = (): void => {
      app.exit(0)
    }
    const timeout = setTimeout(settle, KNOWN_BACKEND_DEADLINE_MS)
    void stopAllKnownBackendRunners(3).finally(() => {
      clearTimeout(timeout)
      settle()
    })
  })
}

const KNOWN_BACKEND_DEADLINE_MS = 5_000

function registerMulticodeProtocol(): void {
  if (process.defaultApp) {
    const appEntry = process.argv[1] ? resolve(process.argv[1]) : app.getAppPath()
    app.setAsDefaultProtocolClient('multicode', process.execPath, [appEntry])
    return
  }

  app.setAsDefaultProtocolClient('multicode')
}
