import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createElectronPlatform, type ElectronPlatformDeps } from './electron-platform'
import { createSafeStorageStandIn } from '../../../tests/stubs/safe-storage'

type FakeWindow = { destroyed: boolean; sent: Array<[string, unknown]>; throws?: boolean }

function harness(options: { packaged?: boolean; notifications?: boolean } = {}) {
  const paths: Record<string, string> = {
    userData: '/Users/dev/Library/Application Support/Studio',
    logs: '/Users/dev/Library/Logs/Studio',
  }
  const windows: FakeWindow[] = []
  const banners: Array<{ title: string; body?: string; closed: boolean; shown: boolean; click?: () => void }> = []
  const safeStorage = createSafeStorageStandIn()
  class FakeNotification {
    private readonly record: (typeof banners)[number]
    private readonly closeListeners: Array<() => void> = []
    static isSupported(): boolean {
      return options.notifications ?? true
    }
    constructor(init: { title?: string; body?: string }) {
      this.record = { title: init.title ?? '', body: init.body, closed: false, shown: false }
      banners.push(this.record)
    }
    on(event: string, listener: () => void) {
      if (event === 'click') this.record.click = listener
      if (event === 'close') this.closeListeners.push(listener)
      return this
    }
    close() {
      this.record.closed = true
      for (const listener of this.closeListeners) listener()
    }
    show() {
      this.record.shown = true
    }
  }
  const deps = {
    app: {
      getPath: (name: string) => paths[name],
      getAppPath: () => '/Applications/Studio.app/Contents/Resources/app.asar',
      getVersion: () => '0.4.0',
      isPackaged: options.packaged ?? true,
    },
    safeStorage,
    BrowserWindow: {
      getAllWindows: () =>
        windows.map((window) => ({
          isDestroyed: () => window.destroyed,
          webContents: {
            isDestroyed: () => false,
            send: (channel: string, payload: unknown) => {
              if (window.throws) throw new Error('render frame disposed')
              window.sent.push([channel, payload])
            },
          },
        })),
    },
    Notification: FakeNotification,
    resourcesPath: () => '/Applications/Studio.app/Contents/Resources',
  } as unknown as ElectronPlatformDeps
  return { platform: createElectronPlatform(deps), paths, windows, banners, safeStorage }
}

test('paths are read from Electron when asked, so a moved profile is the one every store sees', () => {
  const { platform, paths } = harness()
  assert.equal(platform.paths.dataDir(), '/Users/dev/Library/Application Support/Studio')
  paths.userData = '/Users/dev/studio-dev-profile'
  assert.equal(platform.paths.dataDir(), '/Users/dev/studio-dev-profile')
  assert.equal(platform.paths.logsDir(), '/Users/dev/Library/Logs/Studio')
  assert.equal(platform.paths.isPackaged(), true)
  assert.equal(platform.paths.resourcesDir(), '/Applications/Studio.app/Contents/Resources')
  assert.equal(platform.paths.appRoot(), '/Applications/Studio.app/Contents/Resources/app.asar')
  assert.equal(platform.identity.version(), '0.4.0')
})

test('the cipher is safeStorage byte for byte, so a file an earlier build sealed still opens', () => {
  const { platform, safeStorage } = harness()
  const sealedBefore = safeStorage.encryptString('sk-test-value')
  assert.equal(platform.secrets.open(sealedBefore), 'sk-test-value')
  assert.deepEqual(platform.secrets.seal('sk-test-value'), sealedBefore)
  assert.equal(platform.secrets.available(), true)
})

test('a broadcast reaches every live window and survives one that throws', () => {
  const { platform, windows } = harness()
  windows.push(
    { destroyed: false, sent: [] },
    { destroyed: true, sent: [] },
    { destroyed: false, sent: [], throws: true },
  )
  windows.push({ destroyed: false, sent: [] })
  platform.clients.publish('scheduled-agents:changed', [{ id: 'a' }])
  assert.deepEqual(
    windows.map((window) => window.sent.length),
    [1, 0, 0, 1],
  )
  assert.deepEqual(windows[0].sent[0], ['scheduled-agents:changed', [{ id: 'a' }]])
})

test('a notice with the same key replaces the banner, and a click runs its action', () => {
  const { platform, banners } = harness()
  let opened = 0
  platform.notifier.notify({ key: 'pair', title: 'Waiting', body: 'build-box', onActivate: () => (opened += 1) })
  platform.notifier.notify({ key: 'pair', title: 'Paired', body: 'build-box', onActivate: () => (opened += 1) })
  assert.deepEqual(
    banners.map((banner) => [banner.title, banner.shown, banner.closed]),
    [
      ['Waiting', true, true],
      ['Paired', true, false],
    ],
  )
  banners[1].click?.()
  assert.equal(opened, 1)

  const unsupported = harness({ notifications: false })
  unsupported.platform.notifier.notify({ key: 'pair', title: 'Waiting' })
  assert.equal(unsupported.banners.length, 0)
})
