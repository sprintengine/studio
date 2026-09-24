import { app, BrowserWindow, shell } from 'electron'
import type { AppUpdater, CancellationToken } from 'electron-updater'
import type {
  AppUpdateChannelSetting,
  AppUpdateCheckResult,
  AppUpdateState,
  AppUpdateStatus,
  AppUpdateTrack,
  DiagnosticLogEntry,
  DiagnosticLogInput,
} from '../shared/electron-api'
import { channelForVersion, resolveUpdateTrack, type UpdateChannelStore } from './update-channel-store'

type WriteDiagnosticLog = (input: DiagnosticLogInput) => Promise<DiagnosticLogEntry>

type UpdateServiceOptions = {
  writeDiagnosticLog: WriteDiagnosticLog
  /** The person's saved channel. Without one, the build's version decides. */
  channelStore?: Pick<UpdateChannelStore, 'get' | 'set'>
}

type UpdateInfoLike = {
  version?: string
  releaseName?: string | null
  releaseNotes?: string | Array<{ version?: string | null; note?: string | null }> | null
  releaseDate?: string | null
}

type DownloadProgressLike = {
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
}

// The public releases repo, named once in package.json `build.publish` and
// checked against it at build time. See src/shared/releases-repo.ts.
import { RELEASES_URL } from '../shared/releases-repo'

type UpdaterModule = { autoUpdater: AppUpdater; CancellationToken: typeof CancellationToken }

let updaterModule: Promise<UpdaterModule> | null = null

/**
 * electron-updater, loaded the first time something asks for it. Requiring it
 * costs tens of milliseconds, and at module scope that was paid on the path to
 * `ready` by every launch — dev builds included, which never check at all. The
 * first check runs after the window is up, so that is where the cost now lands.
 */
function loadUpdaterModule(): Promise<UpdaterModule> {
  updaterModule ??= Promise.resolve().then(() => {
    // `require`, not `import()`: the package is CommonJS and defines
    // `autoUpdater` with a getter, which an ES import exposes only on
    // `default` — the named binding would come back undefined.
    const loaded = require('electron-updater') as typeof import('electron-updater')
    return { autoUpdater: loaded.autoUpdater, CancellationToken: loaded.CancellationToken }
  })
  return updaterModule
}

function getAppVersion(): string {
  return typeof app.getVersion === 'function' ? app.getVersion() : '0.0.0'
}

function isAppPackaged(): boolean {
  return app.isPackaged === true
}

/**
 * Point electron-updater at one train.
 *
 * `channel` names the manifests it downloads (`nightly-mac.yml`,
 * `latest-mac.yml`) and, with `allowPrerelease`, which feed entries it will
 * consider: a nightly build takes the first `-nightly.` tag, a stable build
 * asks /releases/latest and never sees a prerelease.
 *
 * Setting `channel` also turns `allowDowngrade` on as a side effect, so it is
 * always set explicitly afterwards. It is on for one case only: a nightly
 * install that switched to stable. Its own version (0.6.0-nightly.…) sorts
 * above the latest stable (0.5.2) until the next promotion, and without the
 * downgrade it would be offered nothing at all.
 */
function applyUpdaterChannel(autoUpdater: AppUpdater, track: AppUpdateTrack, version: string): void {
  autoUpdater.allowPrerelease = track === 'nightly'
  autoUpdater.channel = track === 'nightly' ? 'nightly' : 'latest'
  autoUpdater.allowDowngrade = track === 'stable' && channelForVersion(version) === 'nightly'
}

const STALE_DOWNLOAD_MESSAGE = 'The download was stopped because the update channel changed.'

function getStatusMessage(status: AppUpdateStatus): string {
  switch (status) {
    case 'checking':
      return 'Checking for updates.'
    case 'available':
      return 'Update available.'
    case 'downloading':
      return 'Downloading update.'
    case 'downloaded':
      return 'Update ready to install.'
    case 'not_available':
      return 'SprintEngine is up to date.'
    case 'error':
      return 'Update check failed.'
    default:
      return 'No update check is running.'
  }
}

function normalizeReleaseNotes(notes: UpdateInfoLike['releaseNotes']): string | null {
  if (typeof notes === 'string') return notes.trim() || null
  if (!Array.isArray(notes)) return null
  const joined = notes
    .map((entry) => [entry.version, entry.note].filter(Boolean).join('\n'))
    .join('\n\n')
    .trim()
  return joined || null
}

export class SprintEngineUpdateService {
  private readonly writeDiagnosticLog: WriteDiagnosticLog
  private readonly channelStore: UpdateServiceOptions['channelStore']
  private state: AppUpdateState
  private track: AppUpdateTrack
  /**
   * The download this service started and has not seen finish. `stale` is set
   * when the channel changes under it: its file belongs to the old channel, so
   * nothing it reports (progress, completion) may reach the state, and it is
   * cancelled so the new channel can start its own.
   */
  private download: {
    token: CancellationToken
    stale: boolean
    /** Resolves once electron-updater has let go of this download, however it ended. */
    settled: Promise<void>
    settle: () => void
  } | null = null
  /** The loaded and configured updater; null until the first check or download needs it. */
  private updater: UpdaterModule | null = null
  private updaterLoading: Promise<UpdaterModule> | null = null
  /** The app's own ordered shutdown, run before the installer takes over. */
  private prepareForInstall: (() => Promise<void>) | null = null
  /** Set once "Restart to update" has begun, so a second click is not a second shutdown. */
  private installing: Promise<AppUpdateCheckResult> | null = null

  constructor({ writeDiagnosticLog, channelStore }: UpdateServiceOptions) {
    this.writeDiagnosticLog = writeDiagnosticLog
    this.channelStore = channelStore
    const appVersion = getAppVersion()
    this.track = resolveUpdateTrack(appVersion, channelStore?.get() ?? null)
    this.state = {
      status: 'idle',
      version: appVersion,
      channel: isAppPackaged() ? this.track : 'dev',
      buildChannel: channelForVersion(appVersion),
      packaged: isAppPackaged(),
      updateVersion: null,
      releaseName: null,
      releaseNotes: null,
      releaseNotesUrl: RELEASES_URL,
      downloaded: false,
      progress: null,
      errorMessage: null,
      lastCheckedAt: null,
    }
  }

  /**
   * The updater, loaded and configured on first use. Everything the
   * constructor used to set on it is set here instead, from the service's
   * state at that moment, so a channel chosen before the first check is the
   * one the first check follows.
   */
  private loadUpdater(): Promise<UpdaterModule> {
    this.updaterLoading ??= loadUpdaterModule().then((loaded) => {
      const { autoUpdater } = loaded
      // Updates do download on their own, but checkForUpdates starts them
      // rather than electron-updater: a download it started itself would carry
      // a cancellation token this service never sees, and a channel switch
      // could not stop it.
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = true
      applyUpdaterChannel(autoUpdater, this.track, getAppVersion())
      if (typeof autoUpdater.on === 'function') {
        this.registerAutoUpdaterEvents(autoUpdater)
      }
      this.updater = loaded
      return loaded
    })
    return this.updaterLoading
  }

  getState(): AppUpdateState {
    return { ...this.state, progress: this.state.progress ? { ...this.state.progress } : null }
  }

  getChannel(): AppUpdateChannelSetting {
    return { channel: this.track, chosen: (this.channelStore?.get() ?? null) !== null }
  }

  /**
   * Follow another train from now on, and look at it straight away.
   *
   * Whatever the old channel found is forgotten: an update offered or even
   * downloaded from nightly is not what a person who just picked stable wants
   * installed, so the state goes back to idle before the check, and a
   * download already on disk stops being installed at quit until the new
   * channel downloads one of its own. (On macOS, Squirrel may already have
   * staged it; that is the one case this cannot take back.)
   */
  async setChannel(track: AppUpdateTrack): Promise<AppUpdateCheckResult> {
    this.channelStore?.set(track)
    this.track = track
    // An updater not loaded yet picks the new track up when it loads; nothing
    // can have been downloaded or started without it.
    const updater = this.updater?.autoUpdater
    if (updater) {
      applyUpdaterChannel(updater, track, getAppVersion())
      if (this.state.downloaded) updater.autoInstallOnAppQuit = false
    }
    // A download still running is the old channel's too. Left alone it would
    // finish after the reset below and mark itself ready to install at quit.
    if (this.download) {
      this.download.stale = true
      this.download.token.cancel()
    }
    this.updateState({
      status: 'idle',
      channel: isAppPackaged() ? track : 'dev',
      updateVersion: null,
      releaseName: null,
      releaseNotes: null,
      releaseNotesUrl: RELEASES_URL,
      downloaded: false,
      progress: null,
      errorMessage: null,
    })
    if (!isAppPackaged()) {
      return { ok: true, state: this.getState(), message: getStatusMessage('idle') }
    }
    return this.checkForUpdates(true)
  }

  async checkForUpdates(isManual = true): Promise<AppUpdateCheckResult> {
    if (!isAppPackaged()) {
      this.updateState({
        status: 'error',
        errorMessage: 'Update checks are only available in packaged builds.',
        lastCheckedAt: new Date().toISOString(),
      })
      return { ok: false, state: this.getState(), message: this.state.errorMessage ?? getStatusMessage('error') }
    }

    // A download under way, or one waiting for a restart, already answers the
    // question. Asking the feed again would announce the same version as
    // merely available -- electron-updater emits update-available on every
    // check -- so the state would drop back from ready-to-install, and the
    // four-minute poller would do that to a waiting update all day.
    if (this.state.downloaded || (this.download && !this.download.stale)) {
      return { ok: true, state: this.getState(), message: getStatusMessage(this.state.status) }
    }

    this.updateState({
      status: 'checking',
      errorMessage: null,
      progress: null,
      lastCheckedAt: new Date().toISOString(),
    })

    try {
      const { autoUpdater } = await this.loadUpdater()
      const result = await autoUpdater.checkForUpdates()
      // Found one: fetch it in the background straight away, so the next thing
      // the person hears is that it is ready, not that it is waiting on them.
      // Not awaited -- a check answers in a second and a download takes
      // minutes; its progress and its outcome arrive as state.
      if (this.state.status === 'available') void this.downloadUpdate()
      if (!result?.updateInfo) {
        return { ok: true, state: this.getState(), message: getStatusMessage(this.state.status) }
      }

      const info = result.updateInfo as UpdateInfoLike
      return {
        ok: true,
        state: this.getState(),
        message:
          info.version && info.version !== getAppVersion()
            ? `SprintEngine ${info.version} is available.`
            : getStatusMessage(this.state.status),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to check for updates.'
      this.updateState({
        status: 'error',
        errorMessage: message,
        lastCheckedAt: new Date().toISOString(),
      })
      await this.logUpdateError('Update check failed', message, isManual)
      return { ok: false, state: this.getState(), message }
    }
  }

  async downloadUpdate(): Promise<AppUpdateCheckResult> {
    if (!isAppPackaged()) {
      const message = 'Update downloads are only available in packaged builds.'
      this.updateState({ status: 'error', errorMessage: message })
      return { ok: false, state: this.getState(), message }
    }

    // A download the old channel started, and setChannel cancelled, holds
    // electron-updater's one download slot until it settles; a call made
    // before then would be handed that dying promise instead of a download
    // of its own.
    const updater = await this.loadUpdater()
    while (this.download?.stale) await this.download.settled
    // electron-updater hands a second call the download already running, so
    // only the call that starts one owns its token.
    const download = this.download ?? this.beginDownload(updater)
    const { autoUpdater } = updater
    try {
      this.updateState({ status: 'downloading', errorMessage: null })
      await autoUpdater.downloadUpdate(download.token)
      if (download.stale) {
        return { ok: false, state: this.getState(), message: STALE_DOWNLOAD_MESSAGE }
      }
      return { ok: true, state: this.getState(), message: getStatusMessage(this.state.status) }
    } catch (error) {
      if (download.stale) {
        return { ok: false, state: this.getState(), message: STALE_DOWNLOAD_MESSAGE }
      }
      const message = error instanceof Error ? error.message : 'Unable to download update.'
      this.updateState({ status: 'error', errorMessage: message })
      await this.logUpdateError('Update download failed', message, true)
      return { ok: false, state: this.getState(), message }
    } finally {
      if (this.download === download) this.download = null
      download.settle()
    }
  }

  private beginDownload(updater: UpdaterModule): NonNullable<SprintEngineUpdateService['download']> {
    let settle: () => void = () => undefined
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const download = { token: new updater.CancellationToken(), stale: false, settled, settle }
    this.download = download
    return download
  }

  /**
   * What runs before the installer is started: the app lifecycle's ordered,
   * time-bounded shutdown. Registered by the lifecycle, which owns it.
   */
  setPrepareForInstall(prepare: () => Promise<void>): void {
    this.prepareForInstall = prepare
  }

  quitAndInstall(): Promise<AppUpdateCheckResult> {
    if (this.installing) return this.installing
    const autoUpdater = this.updater?.autoUpdater
    // `downloaded` is only ever set by the loaded updater's own event, so the
    // second half is belt and braces.
    if (!this.state.downloaded || !autoUpdater) {
      return Promise.resolve({
        ok: false,
        state: this.getState(),
        message: 'No downloaded update is ready to install.',
      })
    }
    this.installing = this.installAfterShutdown(autoUpdater)
    return this.installing
  }

  private async installAfterShutdown(autoUpdater: AppUpdater): Promise<AppUpdateCheckResult> {
    // The app's own shutdown first — terminal snapshots, chat transcripts, the
    // workspace registry — while nothing is waiting to kill the process. The
    // Windows installer force-closes a running app a couple of seconds after it
    // starts, which is shorter than a shutdown with many terminals takes, so
    // a shutdown that only began at the updater's quit could lose its later
    // legs. The hook bounds its own wait.
    try {
      await this.prepareForInstall?.()
    } catch (error) {
      void this.writeDiagnosticLog({
        level: 'warning',
        source: 'update',
        title: 'Shutdown before update failed',
        message: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined)
    }
    // A channel switch during the shutdown drops the download it would have
    // installed. The app's services are already down, so restart it as it is
    // rather than leave a window over them.
    if (!this.state.downloaded) {
      this.installing = null
      app.relaunch()
      app.quit()
      return { ok: false, state: this.getState(), message: 'No downloaded update is ready to install.' }
    }
    // Silent, then relaunch. On Windows the first argument runs the NSIS
    // installer with /S, so no installer window appears; the installer is
    // one-click and per-user (package.json `build.nsis`), so it writes under
    // the person's own profile and needs no UAC prompt either. The second
    // relaunches the app once the installer finishes. macOS ignores both:
    // Squirrel swaps the bundle and relaunches on its own.
    autoUpdater.quitAndInstall(true, true)
    return { ok: true, state: this.getState(), message: 'Restarting to install update.' }
  }

  async openReleaseNotes(): Promise<{ opened: true; url: string }> {
    const url = this.state.releaseNotesUrl || RELEASES_URL
    await shell.openExternal(url)
    return { opened: true, url }
  }

  private registerAutoUpdaterEvents(autoUpdater: AppUpdater): void {
    autoUpdater.on('checking-for-update', () => {
      this.updateState({ status: 'checking', errorMessage: null, lastCheckedAt: new Date().toISOString() })
    })

    autoUpdater.on('update-available', (info: UpdateInfoLike) => {
      this.updateState({
        status: 'available',
        updateVersion: info.version ?? null,
        releaseName: info.releaseName ?? null,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        releaseNotesUrl: info.version ? `${RELEASES_URL}/tag/v${info.version}` : RELEASES_URL,
        downloaded: false,
        progress: null,
        errorMessage: null,
      })
    })

    autoUpdater.on('update-not-available', () => {
      this.updateState({
        status: 'not_available',
        updateVersion: null,
        releaseName: null,
        releaseNotes: null,
        releaseNotesUrl: RELEASES_URL,
        downloaded: false,
        progress: null,
        errorMessage: null,
        lastCheckedAt: new Date().toISOString(),
      })
    })

    autoUpdater.on('download-progress', (progress: DownloadProgressLike) => {
      if (this.download?.stale) return
      this.updateState({
        status: 'downloading',
        progress: {
          percent: typeof progress.percent === 'number' ? progress.percent : 0,
          transferred: typeof progress.transferred === 'number' ? progress.transferred : 0,
          total: typeof progress.total === 'number' ? progress.total : 0,
          bytesPerSecond: typeof progress.bytesPerSecond === 'number' ? progress.bytesPerSecond : 0,
        },
      })
    })

    autoUpdater.on('update-downloaded', (info: UpdateInfoLike) => {
      if (this.download?.stale) {
        // The old channel's file, finished before the cancel reached it.
        autoUpdater.autoInstallOnAppQuit = false
        return
      }
      autoUpdater.autoInstallOnAppQuit = true
      this.updateState({
        status: 'downloaded',
        updateVersion: info.version ?? this.state.updateVersion,
        releaseName: info.releaseName ?? this.state.releaseName,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes) ?? this.state.releaseNotes,
        releaseNotesUrl: info.version ? `${RELEASES_URL}/tag/v${info.version}` : this.state.releaseNotesUrl,
        downloaded: true,
        progress: null,
        errorMessage: null,
      })
    })

    autoUpdater.on('error', (error: Error) => {
      const message = error.message || 'Updater failed.'
      this.updateState({ status: 'error', errorMessage: message })
      void this.logUpdateError('Updater error', message, false)
    })
  }

  private updateState(patch: Partial<AppUpdateState>): void {
    this.state = { ...this.state, ...patch }
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.webContents.send('update:state-changed', this.getState())
    })
  }

  private async logUpdateError(title: string, message: string, manual: boolean): Promise<void> {
    try {
      await this.writeDiagnosticLog({
        level: 'error',
        source: 'update',
        title,
        message,
        details: JSON.stringify({
          manual,
          version: this.state.version,
          channel: this.state.channel,
          packaged: this.state.packaged,
          updateVersion: this.state.updateVersion,
          lastCheckedAt: this.state.lastCheckedAt,
        }),
      })
    } catch {
      // Diagnostics must not make update failure handling worse.
    }
  }
}
