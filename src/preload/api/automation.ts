import { ipcRenderer } from 'electron'
import {
  AUTOMATION_GET_STATUS_CHANNEL,
  AUTOMATION_SET_ENABLED_CHANNEL,
  type AutomationServerStatus,
} from '../../shared/automation'
import type { ElectronApi } from '../../shared/electron-api'

// Status only. The gateway's mutations are main services, so nothing asks a
// window to perform one and there is no request/respond pair here (MC-2161).
export const automationApi = {
  automationGetStatus: (): Promise<AutomationServerStatus> =>
    ipcRenderer.invoke(AUTOMATION_GET_STATUS_CHANNEL) as Promise<AutomationServerStatus>,
  automationSetEnabled: (enabled: boolean): Promise<AutomationServerStatus> =>
    ipcRenderer.invoke(AUTOMATION_SET_ENABLED_CHANNEL, enabled) as Promise<AutomationServerStatus>,
} satisfies Pick<ElectronApi, 'automationGetStatus' | 'automationSetEnabled'>
