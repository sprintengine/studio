import { BrowserWindow, type IpcMain } from 'electron'
import { LAUNCH_SETTINGS_CHANNELS, type AgentLaunchSettingsWriteAck } from '../../shared/launch-settings'
import type { AgentLaunchSettingsStore, AgentLaunchSettingsWriteResult } from '../launch-settings-store'

type WindowLike = { isDestroyed: () => boolean; webContents: { send: (channel: string, payload: unknown) => void } }

type LaunchSettingsIpcDependencies = {
  launchSettings: Pick<AgentLaunchSettingsStore, 'getSnapshot' | 'update' | 'migrate' | 'subscribe'>
  /** Every window that follows the record. Defaults to all open windows. */
  getWindows?: () => WindowLike[]
}

function ack(result: AgentLaunchSettingsWriteResult): AgentLaunchSettingsWriteAck {
  return { ok: true, record: result.record, changed: result.changed }
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

  ipcMain.handle(LAUNCH_SETTINGS_CHANNELS.update, (_event, patch: unknown) =>
    ack(deps.launchSettings.update(patch, 'ui')),
  )

  // Answered only once an accepted migration's write has settled: the answer
  // is what tells the window to delete its localStorage copy, so it must not
  // arrive while main's copy exists only in memory.
  ipcMain.handle(LAUNCH_SETTINGS_CHANNELS.migrate, async (_event, payload: unknown) => {
    const result = deps.launchSettings.migrate(payload)
    await result.persisted
    return ack(result)
  })

  const getWindows = deps.getWindows ?? (() => BrowserWindow.getAllWindows())
  return deps.launchSettings.subscribe((record) => {
    for (const win of getWindows()) {
      if (!win.isDestroyed()) win.webContents.send(LAUNCH_SETTINGS_CHANNELS.changed, record)
    }
  })
}
