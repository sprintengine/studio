import { ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  AUTOMATION_GET_STATUS_CHANNEL,
  AUTOMATION_REQUEST_CHANNEL,
  AUTOMATION_RESPOND_CHANNEL,
  AUTOMATION_SET_ENABLED_CHANNEL,
  type AutomationRendererRequest,
  type AutomationRendererResponse,
  type AutomationServerStatus,
} from '../../shared/automation'
import type { ElectronApi } from '../../shared/electron-api'

export const automationApi = {
  automationGetStatus: (): Promise<AutomationServerStatus> =>
    ipcRenderer.invoke(AUTOMATION_GET_STATUS_CHANNEL) as Promise<AutomationServerStatus>,
  automationSetEnabled: (enabled: boolean): Promise<AutomationServerStatus> =>
    ipcRenderer.invoke(AUTOMATION_SET_ENABLED_CHANNEL, enabled) as Promise<AutomationServerStatus>,
  onAutomationRequest: (
    cb: (requestId: string, request: AutomationRendererRequest) => void
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, requestId: unknown, request: unknown) => {
      if (typeof requestId !== 'string') return
      cb(requestId, request as AutomationRendererRequest)
    }
    ipcRenderer.on(AUTOMATION_REQUEST_CHANNEL, handler)
    return () => ipcRenderer.removeListener(AUTOMATION_REQUEST_CHANNEL, handler)
  },
  automationRespond: (requestId: string, response: AutomationRendererResponse): Promise<void> =>
    ipcRenderer.invoke(AUTOMATION_RESPOND_CHANNEL, requestId, response) as Promise<void>,
} satisfies Pick<
  ElectronApi,
  'automationGetStatus' | 'automationSetEnabled' | 'onAutomationRequest' | 'automationRespond'
>
