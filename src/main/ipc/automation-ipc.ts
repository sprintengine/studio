import type { IpcMain } from 'electron'
import {
  AUTOMATION_GET_STATUS_CHANNEL,
  AUTOMATION_RESPOND_CHANNEL,
  AUTOMATION_SET_ENABLED_CHANNEL,
} from '../../shared/automation'
import type { AutomationService } from '../automation/automation-service'
import type { RendererAutomationDelegate } from '../automation/renderer-delegate'

export function registerAutomationIpc(
  ipcMain: IpcMain,
  service: AutomationService,
  delegate: RendererAutomationDelegate
): void {
  ipcMain.handle(AUTOMATION_GET_STATUS_CHANNEL, () => service.getStatus())
  ipcMain.handle(AUTOMATION_SET_ENABLED_CHANNEL, (_event, enabled: unknown) =>
    service.setEnabled(enabled === true)
  )
  ipcMain.handle(AUTOMATION_RESPOND_CHANNEL, (_event, requestId: unknown, response: unknown) => {
    delegate.handleResponse(requestId, response)
  })
}
