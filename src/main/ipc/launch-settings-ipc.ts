import type { IpcMain } from 'electron'
import { LAUNCH_SETTINGS_CHANNELS } from '../../shared/launch-settings'
import type { AgentLaunchSettingsMirror } from '../launch-settings-mirror'

type LaunchSettingsIpcDependencies = {
  launchSettings: Pick<AgentLaunchSettingsMirror, 'set' | 'hydrate'>
}

/**
 * The renderer authors the settings a launch is composed from (cliRuntimes,
 * mcp, knowledge roots, last-selected CLI, spawn permission preset) in
 * `appSettings`, and pushes them here so main can compose a launch with no
 * window open. Payloads are normalized fail-soft; the returned revision is what
 * the pusher reconciles against.
 */
export function registerLaunchSettingsIpc(ipcMain: IpcMain, deps: LaunchSettingsIpcDependencies): void {
  ipcMain.handle(LAUNCH_SETTINGS_CHANNELS.sync, (_event, payload: unknown) => {
    const result = deps.launchSettings.set(payload)
    return { ok: true as const, record: result.record, changed: result.changed }
  })

  // First-boot seed: adopted only when main holds no record yet, so a restart
  // never lets a window re-assert settings over main's own.
  ipcMain.handle(LAUNCH_SETTINGS_CHANNELS.hydrate, (_event, payload: unknown) => {
    const result = deps.launchSettings.hydrate(payload)
    return { ok: true as const, record: result.record, changed: result.changed }
  })
}
