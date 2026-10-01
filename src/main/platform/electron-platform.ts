import type { App, BrowserWindow, Notification, NotificationConstructorOptions, SafeStorage } from 'electron'

import type { StudioPlatform } from '../../server/platform/platform'

// The platform while the server's code still runs inside Electron main. Each
// member does exactly what the code it replaced did, read at call time: the
// paths are `app.getPath` and friends (asked when wanted, so the dev profile
// `configureDevUserData` moves to is the one every store sees), the cipher is
// `safeStorage` byte for byte (so everything sealed before still opens), a
// broadcast is the all-windows loop, and a notice is an OS notification.
//
// Electron is handed in rather than imported, so the entry decides when it is
// touched and a test can build the platform over a stand-in.

export type ElectronPlatformDeps = {
  app: Pick<App, 'getPath' | 'getAppPath' | 'getVersion' | 'isPackaged'>
  safeStorage: Pick<SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>
  BrowserWindow: { getAllWindows(): Array<Pick<BrowserWindow, 'isDestroyed' | 'webContents'>> }
  Notification: {
    isSupported(): boolean
    new (options: NotificationConstructorOptions): Pick<Notification, 'on' | 'close' | 'show'>
  }
  /** `process.resourcesPath`, where electron-builder's extraResources land. */
  resourcesPath?: () => string | undefined
}

export function createElectronPlatform(deps: ElectronPlatformDeps): StudioPlatform {
  const { app, safeStorage, BrowserWindow, Notification } = deps
  const resourcesPath = deps.resourcesPath ?? (() => process.resourcesPath)
  // A later notice with the same key replaces the banner rather than stacking
  // under it.
  const shown = new Map<string, Pick<Notification, 'on' | 'close' | 'show'>>()
  return {
    paths: {
      dataDir: () => app.getPath('userData'),
      logsDir: () => app.getPath('logs'),
      isPackaged: () => app.isPackaged,
      resourcesDir: () => resourcesPath() ?? null,
      appRoot: () => app.getAppPath(),
    },
    secrets: {
      available: () => safeStorage.isEncryptionAvailable(),
      seal: (plaintext) => safeStorage.encryptString(plaintext),
      open: (sealed) => safeStorage.decryptString(sealed),
    },
    clients: {
      publish(topic, payload) {
        for (const window of BrowserWindow.getAllWindows()) {
          if (window.isDestroyed() || window.webContents.isDestroyed()) continue
          try {
            window.webContents.send(topic, payload)
          } catch {
            // Best-effort per window.
          }
        }
      },
    },
    notifier: {
      notify(notice) {
        if (!Notification.isSupported()) return
        shown.get(notice.key)?.close()
        const banner = new Notification({ title: notice.title, body: notice.body, silent: false })
        if (notice.onActivate) banner.on('click', notice.onActivate)
        banner.on('close', () => {
          if (shown.get(notice.key) === banner) shown.delete(notice.key)
        })
        shown.set(notice.key, banner)
        banner.show()
      },
    },
    identity: {
      version: () => app.getVersion(),
    },
  }
}
