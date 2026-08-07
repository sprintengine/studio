import type { IpcMain } from 'electron'
import {
  AUTOMATION_GET_STATUS_CHANNEL,
  AUTOMATION_SET_ENABLED_CHANNEL,
} from '../../shared/automation'
import type { AutomationService } from '../automation/automation-service'

// Status only: a window reads whether the gateway is up and may turn it off.
// The respond half of the old renderer-delegate pair went with the delegate
// (MC-2161) — no gateway request travels to a window any more.
export function registerAutomationIpc(ipcMain: IpcMain, service: AutomationService): void {
  ipcMain.handle(AUTOMATION_GET_STATUS_CHANNEL, () => service.getStatus())
  ipcMain.handle(AUTOMATION_SET_ENABLED_CHANNEL, (_event, enabled: unknown) =>
    service.setEnabled(enabled === true)
  )
}
