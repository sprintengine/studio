import { app, BrowserWindow, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
const RELEASES_URL = 'https://github.com/sprintengine/studio/releases';
function getAppVersion() {
    return typeof app.getVersion === 'function' ? app.getVersion() : '0.0.0';
}
function isAppPackaged() {
    return app.isPackaged === true;
}
function getUpdateChannel(version = getAppVersion()) {
    if (!isAppPackaged())
        return 'dev';
    return version.includes('-') ? 'preview' : 'stable';
}
function getStatusMessage(status) {
    switch (status) {
        case 'checking':
            return 'Checking for updates.';
        case 'available':
            return 'Update available.';
        case 'downloading':
            return 'Downloading update.';
        case 'downloaded':
            return 'Update ready to install.';
        case 'not_available':
            return 'Multicode is up to date.';
        case 'error':
            return 'Update check failed.';
        default:
            return 'No update check is running.';
    }
}
function normalizeReleaseNotes(notes) {
    if (typeof notes === 'string')
        return notes.trim() || null;
    if (!Array.isArray(notes))
        return null;
    const joined = notes
        .map((entry) => [entry.version, entry.note].filter(Boolean).join('\n'))
        .join('\n\n')
        .trim();
    return joined || null;
}
export class MulticodeUpdateService {
    writeDiagnosticLog;
    state;
    constructor({ writeDiagnosticLog }) {
        this.writeDiagnosticLog = writeDiagnosticLog;
        const appVersion = getAppVersion();
        const channel = getUpdateChannel(appVersion);
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
        };
        autoUpdater.autoDownload = false;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.allowPrerelease = channel === 'preview';
        if (channel === 'preview') {
            autoUpdater.channel = 'preview';
        }
        if (typeof autoUpdater.on === 'function') {
            this.registerAutoUpdaterEvents();
        }
    }
    getState() {
        return { ...this.state, progress: this.state.progress ? { ...this.state.progress } : null };
    }
    async checkForUpdates(isManual = true) {
        if (!isAppPackaged()) {
            this.updateState({
                status: 'error',
                errorMessage: 'Update checks are only available in packaged builds.',
                lastCheckedAt: new Date().toISOString(),
            });
            return { ok: false, state: this.getState(), message: this.state.errorMessage ?? getStatusMessage('error') };
        }
        this.updateState({
            status: 'checking',
            errorMessage: null,
            progress: null,
            lastCheckedAt: new Date().toISOString(),
        });
        try {
            const result = await autoUpdater.checkForUpdates();
            if (!result?.updateInfo) {
                return { ok: true, state: this.getState(), message: getStatusMessage(this.state.status) };
            }
            const info = result.updateInfo;
            return {
                ok: true,
                state: this.getState(),
                message: info.version && info.version !== getAppVersion()
                    ? `Multicode ${info.version} is available.`
                    : getStatusMessage(this.state.status),
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to check for updates.';
            this.updateState({
                status: 'error',
                errorMessage: message,
                lastCheckedAt: new Date().toISOString(),
            });
            await this.logUpdateError('Update check failed', message, isManual);
            return { ok: false, state: this.getState(), message };
        }
    }
    async downloadUpdate() {
        if (!isAppPackaged()) {
            const message = 'Update downloads are only available in packaged builds.';
            this.updateState({ status: 'error', errorMessage: message });
            return { ok: false, state: this.getState(), message };
        }
        try {
            this.updateState({ status: 'downloading', errorMessage: null });
            await autoUpdater.downloadUpdate();
            return { ok: true, state: this.getState(), message: getStatusMessage(this.state.status) };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to download update.';
            this.updateState({ status: 'error', errorMessage: message });
            await this.logUpdateError('Update download failed', message, true);
            return { ok: false, state: this.getState(), message };
        }
    }
    quitAndInstall() {
        if (!this.state.downloaded) {
            return { ok: false, state: this.getState(), message: 'No downloaded update is ready to install.' };
        }
        autoUpdater.quitAndInstall(false, true);
        return { ok: true, state: this.getState(), message: 'Restarting to install update.' };
    }
    async openReleaseNotes() {
        const url = this.state.releaseNotesUrl || RELEASES_URL;
        await shell.openExternal(url);
        return { opened: true, url };
    }
    registerAutoUpdaterEvents() {
        autoUpdater.on('checking-for-update', () => {
            this.updateState({ status: 'checking', errorMessage: null, lastCheckedAt: new Date().toISOString() });
        });
        autoUpdater.on('update-available', (info) => {
            this.updateState({
                status: 'available',
                updateVersion: info.version ?? null,
                releaseName: info.releaseName ?? null,
                releaseNotes: normalizeReleaseNotes(info.releaseNotes),
                releaseNotesUrl: info.version ? `${RELEASES_URL}/tag/v${info.version}` : RELEASES_URL,
                downloaded: false,
                progress: null,
                errorMessage: null,
            });
        });
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
            });
        });
        autoUpdater.on('download-progress', (progress) => {
            this.updateState({
                status: 'downloading',
                progress: {
                    percent: typeof progress.percent === 'number' ? progress.percent : 0,
                    transferred: typeof progress.transferred === 'number' ? progress.transferred : 0,
                    total: typeof progress.total === 'number' ? progress.total : 0,
                    bytesPerSecond: typeof progress.bytesPerSecond === 'number' ? progress.bytesPerSecond : 0,
                },
            });
        });
        autoUpdater.on('update-downloaded', (info) => {
            this.updateState({
                status: 'downloaded',
                updateVersion: info.version ?? this.state.updateVersion,
                releaseName: info.releaseName ?? this.state.releaseName,
                releaseNotes: normalizeReleaseNotes(info.releaseNotes) ?? this.state.releaseNotes,
                releaseNotesUrl: info.version ? `${RELEASES_URL}/tag/v${info.version}` : this.state.releaseNotesUrl,
                downloaded: true,
                progress: null,
                errorMessage: null,
            });
        });
        autoUpdater.on('error', (error) => {
            const message = error.message || 'Updater failed.';
            this.updateState({ status: 'error', errorMessage: message });
            void this.logUpdateError('Updater error', message, false);
        });
    }
    updateState(patch) {
        this.state = { ...this.state, ...patch };
        BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed())
                win.webContents.send('update:state-changed', this.getState());
        });
    }
    async logUpdateError(title, message, manual) {
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
            });
        }
        catch {
            // Diagnostics must not make update failure handling worse.
        }
    }
}
