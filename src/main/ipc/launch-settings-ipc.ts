import { BrowserWindow, type IpcMain } from 'electron'
import { LAUNCH_SETTINGS_CHANNELS, type AgentLaunchSettingsWriteAck } from '../../shared/launch-settings'
import type { AgentLaunchSettingsStore, AgentLaunchSettingsWriteResult } from '../launch-settings-store'

type WindowLike = { isDestroyed: () => boolean; webContents: { send: (channel: string, payload: unknown) => void } }

type LaunchSettingsIpcDependencies = {
  launchSettings: Pick<AgentLaunchSettingsStore, 'getSnapshot' | 'update' | 'migrate' | 'subscribe'>
  /** Every window that follows the record. Defaults to all open windows. */
  getWindows?: () => WindowLike[]
}

async function ack(result: AgentLaunchSettingsWriteResult): Promise<AgentLaunchSettingsWriteAck> {
  return { ok: true, record: result.record, changed: result.changed, persisted: await result.persisted }
}

/**
 * The window side of main's launch-settings store. A window reads the record
 * at boot (`get`), writes to it only through partial patches (`update`), and
 * offers its old localStorage values once through `migrate`, which main
 * accepts only while it holds no record. Every write that changes the record
 * — whichever window, or main itself, made it — is broadcast to every window
 * on `changed`, carrying the new record, so windows never push copies at one
 * another. Payloads are normalized fail-soft in the store.
 *
 * Returns the unsubscribe for the broadcast, for a caller that tears down.
 */
export function registerLaunchSettingsIpc(ipcMain: IpcMain, deps: LaunchSettingsIpcDependencies): () => void {
  ipcMain.handle(LAUNCH_SETTINGS_CHANNELS.get, () => deps.launchSettings.getSnapshot())

  // Every answer waits for its write to settle and says whether the record is
  // on disk: the window deletes its localStorage copy of these settings only
  // on an answer that says so, so a quit or a failed write never loses both.
  ipcMain.handle(LAUNCH_SETTINGS_CHANNELS.update, (_event, patch: unknown) =>
    ack(deps.launchSettings.update(patch, 'ui')),
  )

  ipcMain.handle(LAUNCH_SETTINGS_CHANNELS.migrate, (_event, payload: unknown) =>
    ack(deps.launchSettings.migrate(payload)),
  )

  const getWindows = deps.getWindows ?? (() => BrowserWindow.getAllWindows())
  return deps.launchSettings.subscribe((record) => {
    for (const win of getWindows()) {
      if (!win.isDestroyed()) win.webContents.send(LAUNCH_SETTINGS_CHANNELS.changed, record)
    }
  })
}
