import assert from 'node:assert/strict'
import { beforeEach, test, vi } from 'vitest'

import type { AppUpdateTrack } from '../shared/electron-api'
import { standIn } from '../../tests/stand-in'

// The two things the service configures and reads: Electron's app identity and
// electron-updater's singleton. The updater stand-in copies the one side effect
// that matters here -- setting `channel` turns `allowDowngrade` on -- so a
// service that forgets to set it back fails this suite rather than offering
// every stable install a downgrade.
const hoisted = vi.hoisted(() => {
  const app = { version: '0.5.2', packaged: true }
  // How many times the updater module was loaded; it is loaded lazily, on the
  // first check, rather than when the service is built.
  const loads = { count: 0 }
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
    // A download the test finishes (or fails) by hand, as the network would.
    downloads: [] as Array<{ token: CancellationToken; finish: () => void; fail: (error: Error) => void }>,
    downloadUpdate(token: CancellationToken) {
      return new Promise<string[]>((resolve, reject) => {
        this.downloads.push({ token, finish: () => resolve([]), fail: reject })
      })
    },
    // The version the feed offers; null means the build is already current.
    offered: null as string | null,
    async checkForUpdates() {
      this.checks.push({
        channel: this._channel,
        allowPrerelease: this.allowPrerelease,
        allowDowngrade: this.allowDowngrade,
      })
      if (this.offered) {
        this.listeners.get('update-available')?.({ version: this.offered })
        return { updateInfo: { version: this.offered } }
      }
      this.listeners.get('update-not-available')?.({})
      return { updateInfo: { version: app.version } }
    },
    installs: [] as Array<{ isSilent: boolean; isForceRunAfter: boolean }>,
    quitAndInstall(isSilent: boolean, isForceRunAfter: boolean) {
      this.installs.push({ isSilent, isForceRunAfter })
    },
  }
  return { app, updater, CancellationToken, loads }
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
// Stood in at `require`, which is how the service loads it (lazily, on the
// first check). Reading `autoUpdater` is what counts as a load.
standIn({
  'electron-updater': {
    get autoUpdater() {
      hoisted.loads.count += 1
      return hoisted.updater
    },
    CancellationToken: hoisted.CancellationToken,
  },
})

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

/**
 * A service whose updater has been loaded and configured, which happens on the
 * first check. The check is forgotten again, so a test sees only its own.
 */
async function readyService(store = memoryStore()) {
  const s = service(store)
  await s.checkForUpdates(false)
  hoisted.updater.checks = []
  return s
}

/** The configuration the updater had when it was last asked for an update. */
function lastCheck() {
  return hoisted.updater.checks.at(-1)
}

async function settle(): Promise<void> {
  for (let pass = 0; pass < 5; pass += 1) await new Promise((resolve) => setImmediate(resolve))
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
    offered: null,
    installs: [],
  })
  hoisted.updater.listeners.clear()
})

test('electron-updater is not loaded until the first check needs it', async () => {
  // First in the file on purpose: the module is loaded once per suite.
  const s = service()
  assert.equal(s.getState().channel, 'stable')
  assert.equal(hoisted.loads.count, 0, 'building the service loads nothing')
  await s.checkForUpdates(false)
  assert.equal(hoisted.loads.count, 1, 'the first check loads it')
})

test('a stable build follows latest, sees no prerelease and is never offered a downgrade', async () => {
  const s = service()
  assert.equal(s.getState().channel, 'stable')
  assert.deepEqual(s.getChannel(), { channel: 'stable', chosen: false })
  await s.checkForUpdates(false)
  assert.deepEqual(lastCheck(), { channel: 'latest', allowPrerelease: false, allowDowngrade: false })
})

test('a nightly build follows nightly', async () => {
  hoisted.app.version = '0.6.0-nightly.20260923.41'
  const s = service()
  assert.equal(s.getState().channel, 'nightly')
  await s.checkForUpdates(false)
  assert.deepEqual(lastCheck(), { channel: 'nightly', allowPrerelease: true, allowDowngrade: false })
})

test('a saved choice overrides the version at startup', async () => {
  const s = service(memoryStore('nightly'))
  assert.equal(s.getState().channel, 'nightly')
  assert.deepEqual(s.getChannel(), { channel: 'nightly', chosen: true })
  await s.checkForUpdates(false)
  assert.equal(lastCheck()?.allowPrerelease, true)

  hoisted.app.version = '0.6.0-nightly.20260923.41'
  await service(memoryStore('stable')).checkForUpdates(false)
  // Its own version sorts above the latest stable until the next promotion.
  assert.deepEqual(lastCheck(), { channel: 'latest', allowPrerelease: false, allowDowngrade: true })
})

test('a channel chosen before the first check is the one the first check follows', async () => {
  const s = service()
  await s.setChannel('nightly')
  assert.deepEqual(hoisted.updater.checks, [{ channel: 'nightly', allowPrerelease: true, allowDowngrade: false }])
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

test('the build channel is what the version was cut for, whatever the updater follows', async () => {
  hoisted.app.version = '0.6.0-nightly.20260923.41'
  const s = service(memoryStore('stable'))
  // A nightly build that follows stable is still a nightly until stable
  // installs over it: the Nightly chip and the splash plate key off this.
  assert.equal(s.getState().buildChannel, 'nightly')
  assert.equal(s.getState().channel, 'stable')
  await s.setChannel('nightly')
  assert.equal(s.getState().buildChannel, 'nightly')

  hoisted.app.version = '0.5.2'
  const stable = service(memoryStore('nightly'))
  assert.equal(stable.getState().buildChannel, 'stable')
  assert.equal(stable.getState().channel, 'nightly')

  // Unpackaged builds follow no channel, but still know what they were cut for.
  hoisted.app.packaged = false
  hoisted.app.version = '0.6.0-nightly.20260923.41'
  const dev = service()
  assert.equal(dev.getState().channel, 'dev')
  assert.equal(dev.getState().buildChannel, 'nightly')
})

test('an update found on the old channel is forgotten when the channel changes', async () => {
  const s = await readyService()
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
  const s = await readyService()
  hoisted.updater.listeners.get('update-available')?.({ version: '0.5.3' })
  const pending = s.downloadUpdate()
  await settle()
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
  await settle()
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

// What electron-updater emits as a download runs and lands.
function progress(percent: number) {
  hoisted.updater.listeners.get('download-progress')?.({ percent, transferred: percent, total: 100, bytesPerSecond: 1 })
}
function downloaded(version: string) {
  hoisted.updater.listeners.get('update-downloaded')?.({ version })
}

test('a check that finds an update downloads it in the background, reporting progress', async () => {
  const s = service()
  hoisted.updater.offered = '0.5.3'
  const result = await s.checkForUpdates(false)
  assert.equal(result.ok, true)
  assert.equal(hoisted.updater.downloads.length, 1, 'the download started without being asked')
  assert.equal(s.getState().status, 'downloading')
  assert.equal(s.getState().updateVersion, '0.5.3')

  progress(40)
  assert.equal(s.getState().status, 'downloading')
  assert.equal(s.getState().progress?.percent, 40)

  downloaded('0.5.3')
  hoisted.updater.downloads[0]?.finish()
  await Promise.resolve()
  assert.equal(s.getState().status, 'downloaded')
  assert.equal(s.getState().downloaded, true)
  assert.equal(s.getState().progress, null)
  assert.equal(hoisted.updater.autoInstallOnAppQuit, true, 'Later still installs it at the next quit')
})

test('a check that finds nothing downloads nothing', async () => {
  const s = service()
  await s.checkForUpdates(false)
  assert.equal(s.getState().status, 'not_available')
  assert.equal(hoisted.updater.downloads.length, 0)
})

test('checks while an update downloads or waits for a restart leave it alone', async () => {
  const s = service()
  hoisted.updater.offered = '0.5.3'
  await s.checkForUpdates(false)
  assert.equal(hoisted.updater.checks.length, 1)

  // The poller comes round mid-download: no second check, no second download.
  await s.checkForUpdates(false)
  assert.equal(hoisted.updater.checks.length, 1)
  assert.equal(hoisted.updater.downloads.length, 1)
  assert.equal(s.getState().status, 'downloading')

  downloaded('0.5.3')
  hoisted.updater.downloads[0]?.finish()
  await Promise.resolve()

  // And again once it is ready: the feed would call it merely available.
  const result = await s.checkForUpdates(true)
  assert.equal(result.ok, true)
  assert.equal(hoisted.updater.checks.length, 1)
  assert.equal(s.getState().status, 'downloaded')
  assert.equal(s.getState().downloaded, true)
})

test('a background download that fails reports the error and the next check tries again', async () => {
  const s = service()
  hoisted.updater.offered = '0.5.3'
  await s.checkForUpdates(false)
  hoisted.updater.downloads[0]?.fail(new Error('socket hang up'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(s.getState().status, 'error')
  assert.equal(s.getState().errorMessage, 'socket hang up')
  assert.equal(s.getState().downloaded, false)

  await s.checkForUpdates(false)
  assert.equal(hoisted.updater.checks.length, 2)
  assert.equal(hoisted.updater.downloads.length, 2)
  assert.equal(s.getState().status, 'downloading')
})

test('restart to update installs silently and relaunches, and only once an update is ready', async () => {
  const s = service()
  const early = s.quitAndInstall()
  assert.equal(early.ok, false)
  assert.deepEqual(hoisted.updater.installs, [])

  hoisted.updater.offered = '0.5.3'
  await s.checkForUpdates(false)
  downloaded('0.5.3')
  hoisted.updater.downloads[0]?.finish()
  await Promise.resolve()

  const result = s.quitAndInstall()
  assert.equal(result.ok, true)
  // Silent: the Windows installer runs with /S and shows no wizard.
  assert.deepEqual(hoisted.updater.installs, [{ isSilent: true, isForceRunAfter: true }])
})

test('a channel switch mid-download fetches the new channel only after the old download lets go', async () => {
  const s = service()
  hoisted.updater.offered = '0.5.3'
  await s.checkForUpdates(false)
  const old = hoisted.updater.downloads[0]
  assert.ok(old)

  hoisted.updater.offered = '0.6.0-nightly.20260923.41'
  const switched = await s.setChannel('nightly')
  assert.equal(switched.ok, true)
  assert.equal(old.token.cancelled, true)
  assert.equal(hoisted.updater.checks.length, 2, 'the new channel was checked')
  assert.equal(hoisted.updater.downloads.length, 1, 'its download waits for the old one to settle')

  old.fail(new Error('cancelled'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(hoisted.updater.downloads.length, 2, 'then starts with a token of its own')
  const next = hoisted.updater.downloads[1]
  assert.ok(next)
  assert.notEqual(next.token, old.token)
  assert.equal(s.getState().status, 'downloading')
  assert.equal(s.getState().updateVersion, '0.6.0-nightly.20260923.41')

  downloaded('0.6.0-nightly.20260923.41')
  next.finish()
  await Promise.resolve()
  assert.equal(s.getState().downloaded, true)
  assert.equal(s.getState().updateVersion, '0.6.0-nightly.20260923.41')
})
