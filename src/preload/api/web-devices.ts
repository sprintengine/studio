import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'

import type { ElectronApi } from '../../shared/electron-api'
import {
  WEB_DEVICES_APPROVE_CHANNEL,
  WEB_DEVICES_CHANGED_CHANNEL,
  WEB_DEVICES_DECLINE_CHANNEL,
  WEB_DEVICES_LINK_CHANNEL,
  WEB_DEVICES_RENAME_CHANNEL,
  WEB_DEVICES_REVOKE_CHANNEL,
  WEB_DEVICES_STATUS_CHANNEL,
  type WebDevicesStatus,
} from '../../shared/web-client'

// The browsers paired with a Studio server's web listener (phase 9 spec,
// 6.2). A web tab's server answers these over the tab's tunnel; a desktop
// window's server runs no web listener, so there the calls fail and Settings
// draws nothing for them.
export const webDevicesApi = {
  webDevicesStatus: () => ipcRenderer.invoke(WEB_DEVICES_STATUS_CHANNEL),
  webDevicesRevoke: (id: string) => ipcRenderer.invoke(WEB_DEVICES_REVOKE_CHANNEL, { id }),
  webDevicesRename: (id: string, name: string) => ipcRenderer.invoke(WEB_DEVICES_RENAME_CHANNEL, { id, name }),
  webDevicesLink: (origin?: string) => ipcRenderer.invoke(WEB_DEVICES_LINK_CHANNEL, origin ? { origin } : {}),
  webDevicesApprove: (requestId: string, code: string) =>
    ipcRenderer.invoke(WEB_DEVICES_APPROVE_CHANNEL, { requestId, code }),
  webDevicesDecline: (requestId: string) => ipcRenderer.invoke(WEB_DEVICES_DECLINE_CHANNEL, { requestId }),
  onWebDevicesChanged: (cb: (status: WebDevicesStatus) => void) => {
    const listener = (_event: IpcRendererEvent, status: WebDevicesStatus) => cb(status)
    ipcRenderer.on(WEB_DEVICES_CHANGED_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(WEB_DEVICES_CHANGED_CHANNEL, listener)
    }
  },
} satisfies Pick<
  ElectronApi,
  | 'webDevicesStatus'
  | 'webDevicesRevoke'
  | 'webDevicesRename'
  | 'webDevicesLink'
  | 'webDevicesApprove'
  | 'webDevicesDecline'
  | 'onWebDevicesChanged'
>
