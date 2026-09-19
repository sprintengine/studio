import { app, BrowserWindow, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type {
  AppUpdateCheckResult,
  AppUpdateState,
  AppUpdateStatus,
  DiagnosticLogEntry,
  DiagnosticLogInput,
} from '../shared/electron-api'

type WriteDiagnosticLog = (input: DiagnosticLogInput) => Promise<DiagnosticLogEntry>

type UpdateServiceOptions = {
  writeDiagnosticLog: WriteDiagnosticLog
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

function getAppVersion(): string {
  return typeof app.getVersion === 'function' ? app.getVersion() : '0.0.0'
}

function isAppPackaged(): boolean {
  return app.isPackaged === true
}

function getUpdateChannel(version = getAppVersion()): 'dev' | 'preview' | 'stable' {
  if (!isAppPackaged()) return 'dev'
  return version.includes('-') ? 'preview' : 'stable'
}

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
  private state: AppUpdateState

  constructor({ writeDiagnosticLog }: UpdateServiceOptions) {
    this.writeDiagnosticLog = writeDiagnosticLog
    const appVersion = getAppVersion()
    const channel = getUpdateChannel(appVersion)
    this.state = {
      status: 'idle',
      version: appVersion,
      channel,
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

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = channel === 'preview'
    if (channel === 'preview') {
      autoUpdater.channel = 'preview'
    }
    if (typeof autoUpdater.on === 'function') {
      this.registerAutoUpdaterEvents()
    }
  }

  getState(): AppUpdateState {
    return { ...this.state, progress: this.state.progress ? { ...this.state.progress } : null }
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

    this.updateState({
      status: 'checking',
      errorMessage: null,
      progress: null,
      lastCheckedAt: new Date().toISOString(),
    })

    try {
      const result = await autoUpdater.checkForUpdates()
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

    try {
      this.updateState({ status: 'downloading', errorMessage: null })
      await autoUpdater.downloadUpdate()
      return { ok: true, state: this.getState(), message: getStatusMessage(this.state.status) }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to download update.'
      this.updateState({ status: 'error', errorMessage: message })
      await this.logUpdateError('Update download failed', message, true)
      return { ok: false, state: this.getState(), message }
    }
  }

  quitAndInstall(): AppUpdateCheckResult {
    if (!this.state.downloaded) {
      return { ok: false, state: this.getState(), message: 'No downloaded update is ready to install.' }
    }
    autoUpdater.quitAndInstall(false, true)
    return { ok: true, state: this.getState(), message: 'Restarting to install update.' }
  }

  async openReleaseNotes(): Promise<{ opened: true; url: string }> {
    const url = this.state.releaseNotesUrl || RELEASES_URL
    await shell.openExternal(url)
    return { opened: true, url }
  }

  private registerAutoUpdaterEvents(): void {
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
