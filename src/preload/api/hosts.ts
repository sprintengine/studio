import { ipcRenderer } from 'electron'
import type { ElectronApi } from '../../shared/electron-api'
import {
  HOSTS_CHANNELS,
  type ExecutionHostId,
  type HostHomeResult,
  type HostsListResult,
} from '../../shared/execution-host'

// The machines this computer offers (this one, and on Windows its WSL
// distributions). `onHostsChanged` carries nothing: a window asks again.
export const hostsApi = {
  hostsList: (options?: { refresh?: boolean; all?: boolean }): Promise<HostsListResult> =>
    ipcRenderer.invoke(HOSTS_CHANNELS.list, options ?? {}),
  hostsHome: (hostId: ExecutionHostId): Promise<HostHomeResult> => ipcRenderer.invoke(HOSTS_CHANNELS.home, hostId),
  onHostsChanged: (cb: () => void): (() => void) => {
    const handler = () => cb()
    ipcRenderer.on(HOSTS_CHANNELS.changed, handler)
    return () => ipcRenderer.removeListener(HOSTS_CHANNELS.changed, handler)
  },
} satisfies Pick<ElectronApi, 'hostsList' | 'hostsHome' | 'onHostsChanged'>
