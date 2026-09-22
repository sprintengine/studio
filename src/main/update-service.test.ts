import assert from 'node:assert/strict'
import { beforeEach, test, vi } from 'vitest'

import type { AppUpdateTrack } from '../shared/electron-api'

// The two things the service configures and reads: Electron's app identity and
// electron-updater's singleton. The updater stand-in copies the one side effect
// that matters here -- setting `channel` turns `allowDowngrade` on -- so a
// service that forgets to set it back fails this suite rather than offering
// every stable install a downgrade.
const hoisted = vi.hoisted(() => {
  const app = { version: '0.5.2', packaged: true }
  class CancellationToken {
    cancelled = false
    cancel() {
      this.cancelled = true
    }
  }
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    _channel: null as string | null,
    get channel(): string | null {
      return this._channel
    },
    set channel(value: string | null) {
      this._channel = value
      this.allowDowngrade = true
    },
    checks: [] as Array<{ channel: string | null; allowPrerelease: boolean; allowDowngrade: boolean }>,
    listeners: new Map<string, (...args: unknown[]) => void>(),
    on(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(event, listener)
      return this
    },
    // A download the test finishes by hand, as the network would.
    downloads: [] as Array<{ token: CancellationToken; finish: () => void }>,
    downloadUpdate(token: CancellationToken) {
      return new Promise<string[]>((resolve) => {
        this.downloads.push({ token, finish: () => resolve([]) })
      })
    },
    async checkForUpdates() {
      this.checks.push({
        channel: this._channel,
        allowPrerelease: this.allowPrerelease,
        allowDowngrade: this.allowDowngrade,
      })
      this.listeners.get('update-not-available')?.({})
      return { updateInfo: { version: app.version } }
    },
  }
  return { app, updater, CancellationToken }
})

vi.mock('electron', () => ({
  app: {
    getVersion: () => hoisted.app.version,
    get isPackaged() {
      return hoisted.app.packaged
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: async () => undefined },
}))
vi.mock('electron-updater', () => ({ autoUpdater: hoisted.updater, CancellationToken: hoisted.CancellationToken }))

const { SprintEngineUpdateService } = await import('./update-service')

function memoryStore(initial: AppUpdateTrack | null = null) {
  let value = initial
  const writes: AppUpdateTrack[] = []
  return {
    writes,
    get: () => value,
    set: (next: AppUpdateTrack) => {
      value = next
      writes.push(next)
    },
  }
}

function service(store = memoryStore()) {
  return new SprintEngineUpdateService({ writeDiagnosticLog: async () => ({}) as never, channelStore: store })
}

beforeEach(() => {
  hoisted.app.version = '0.5.2'
  hoisted.app.packaged = true
  Object.assign(hoisted.updater, {
    _channel: null,
    allowPrerelease: false,
    allowDowngrade: false,
    checks: [],
    downloads: [],
  })
  hoisted.updater.listeners.clear()
})

test('a stable build follows latest, sees no prerelease and is never offered a downgrade', () => {
  const s = service()
  assert.equal(s.getState().channel, 'stable')
  assert.deepEqual(s.getChannel(), { channel: 'stable', chosen: false })
  assert.equal(hoisted.updater.channel, 'latest')
  assert.equal(hoisted.updater.allowPrerelease, false)
  assert.equal(hoisted.updater.allowDowngrade, false)
})

test('a nightly build follows nightly', () => {
  hoisted.app.version = '0.6.0-nightly.20260923.41'
  const s = service()
  assert.equal(s.getState().channel, 'nightly')
  assert.equal(hoisted.updater.channel, 'nightly')
  assert.equal(hoisted.updater.allowPrerelease, true)
  assert.equal(hoisted.updater.allowDowngrade, false)
})

test('a saved choice overrides the version at startup', () => {
  const s = service(memoryStore('nightly'))
  assert.equal(s.getState().channel, 'nightly')
  assert.deepEqual(s.getChannel(), { channel: 'nightly', chosen: true })
  assert.equal(hoisted.updater.allowPrerelease, true)

  hoisted.app.version = '0.6.0-nightly.20260923.41'
  service(memoryStore('stable'))
  assert.equal(hoisted.updater.channel, 'latest')
  assert.equal(hoisted.updater.allowPrerelease, false)
  // Its own version sorts above the latest stable until the next promotion.
  assert.equal(hoisted.updater.allowDowngrade, true)
})

test('switching channel saves it, re-points the updater, and checks the new channel', async () => {
  hoisted.app.version = '0.6.0-nightly.20260923.41'
  const store = memoryStore()
  const s = service(store)
  const result = await s.setChannel('stable')
  assert.deepEqual(store.writes, ['stable'])
  assert.equal(result.ok, true)
  assert.equal(result.state.channel, 'stable')
  assert.equal(result.state.status, 'not_available')
  assert.deepEqual(hoisted.updater.checks, [{ channel: 'latest', allowPrerelease: false, allowDowngrade: true }])
  assert.deepEqual(s.getChannel(), { channel: 'stable', chosen: true })

  await s.setChannel('nightly')
  assert.deepEqual(hoisted.updater.checks.at(-1), { channel: 'nightly', allowPrerelease: true, allowDowngrade: false })
})

test('an update found on the old channel is forgotten when the channel changes', async () => {
  const s = service()
  hoisted.updater.listeners.get('update-downloaded')?.({ version: '0.5.3' })
  assert.equal(s.getState().downloaded, true)
  assert.equal(hoisted.updater.autoInstallOnAppQuit, true)
  // A check that fires no event, so what is asserted is the reset itself.
  const check = hoisted.updater.checkForUpdates
  hoisted.updater.checkForUpdates = async () => ({ updateInfo: { version: '0.5.2' } }) as never
  try {
    await s.setChannel('nightly')
  } finally {
    hoisted.updater.checkForUpdates = check
  }
  assert.equal(s.getState().downloaded, false)
  assert.equal(s.getState().updateVersion, null)
  assert.equal(hoisted.updater.autoInstallOnAppQuit, false)
})

test('a download still running on the old channel is cancelled and never becomes the update to install', async () => {
  const s = service()
  hoisted.updater.listeners.get('update-available')?.({ version: '0.5.3' })
  const pending = s.downloadUpdate()
  const running = hoisted.updater.downloads[0]
  assert.ok(running, 'the service started a download')
  const check = hoisted.updater.checkForUpdates
  hoisted.updater.checkForUpdates = async () => ({ updateInfo: { version: '0.5.2' } }) as never
  try {
    await s.setChannel('nightly')
  } finally {
    hoisted.updater.checkForUpdates = check
  }
  assert.equal(running.token.cancelled, true, 'the old channel download is cancelled')

  // It finished anyway, before the cancel reached it.
  hoisted.updater.listeners.get('download-progress')?.({ percent: 100, transferred: 1, total: 1, bytesPerSecond: 1 })
  hoisted.updater.listeners.get('update-downloaded')?.({ version: '0.5.3' })
  running.finish()
  const result = await pending

  assert.equal(result.ok, false)
  assert.equal(s.getState().downloaded, false, 'nothing from the old channel is ready to install')
  assert.notEqual(s.getState().status, 'downloading', 'the old download no longer drives the state')
  assert.equal(s.getState().progress, null)
  assert.equal(hoisted.updater.autoInstallOnAppQuit, false)

  // The next download is the new channel's own, and completes normally.
  hoisted.updater.listeners.get('update-available')?.({ version: '0.6.0-nightly.20260923.41' })
  const next = s.downloadUpdate()
  hoisted.updater.listeners.get('update-downloaded')?.({ version: '0.6.0-nightly.20260923.41' })
  hoisted.updater.downloads[1]?.finish()
  assert.equal((await next).ok, true)
  assert.equal(s.getState().downloaded, true)
  assert.equal(hoisted.updater.autoInstallOnAppQuit, true)
})

test('an unpackaged build reports dev and does not check when the channel changes', async () => {
  hoisted.app.packaged = false
  const store = memoryStore()
  const s = service(store)
  assert.equal(s.getState().channel, 'dev')
  const result = await s.setChannel('nightly')
  assert.equal(result.state.channel, 'dev')
  assert.deepEqual(s.getChannel(), { channel: 'nightly', chosen: true })
  assert.deepEqual(store.writes, ['nightly'])
})
