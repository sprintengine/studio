import { app, BrowserWindow, Menu } from 'electron'
import { resolve } from 'path'
import { autoUpdater } from 'electron-updater'
import { createAppMenu } from './app-menu'
import { createMainWindow } from './window-factory'

type RegisterAppLifecycleOptions = {
  diagnosticsEnabled: boolean
  mobileBridge: {
    shutdown(): void
  }
  handleAuthCallback(argv: string[]): void
}

export function registerAppLifecycle({
  diagnosticsEnabled,
  mobileBridge,
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

    // Check for updates in production only (no update server configured = silent no-op)
    if (!process.env['ELECTRON_RENDERER_URL']) {
      autoUpdater.checkForUpdatesAndNotify().catch(() => {
        // No update server configured yet - ignore silently
      })
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow({ diagnosticsEnabled })
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    mobileBridge.shutdown()
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
