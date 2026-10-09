import type { IpcMain } from 'electron'

import type { AgentNotificationMode } from '../../shared/agent-notifications'
import type { AgentNotificationsStore } from '../agent-notifications-store'

/**
 * Settings' read and write of the chat banners. Main owns the value
 * (agent-notifications-store.ts), so both answer with what main now holds.
 */
export function registerAgentNotificationsIpc(ipcMain: IpcMain, store: AgentNotificationsStore): void {
  ipcMain.handle('app:get-agent-notifications', (): AgentNotificationMode => store.mode())
  ipcMain.handle('app:set-agent-notifications', (_event, mode: unknown): AgentNotificationMode => {
    store.set(mode)
    return store.mode()
  })
}
