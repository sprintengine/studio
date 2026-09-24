import { BrowserWindow, type IpcMain } from 'electron'

import { HOSTS_CHANNELS, isWslHostId, type HostHomeResult } from '../../shared/execution-host'
import type { HostListing, HostRegistry } from '../hosts/host-registry'

type WindowLike = { isDestroyed: () => boolean; webContents: { send: (channel: string, payload: unknown) => void } }

type HostsIpcDependencies = {
  hosts: Pick<HostRegistry, 'list' | 'get' | 'subscribe'>
  getWindows?: () => WindowLike[]
}

function readListOptions(payload: unknown): { refresh: boolean; all: boolean } {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  return { refresh: record.refresh === true, all: record.all === true }
}

/**
 * The machines this computer offers, for the New chat picker and Settings ▸
 * Machines. `list` reads WSL's distributions only when asked with `refresh`
 * (Settings opening, its Refresh button) or when nothing has been read yet;
 * `changed` tells every window to ask again, carrying nothing. `home` answers
 * a WSL machine's home folder, as the UNC path the folder picker opens at.
 */
export function registerHostsIpc(ipcMain: IpcMain, deps: HostsIpcDependencies): () => void {
  ipcMain.handle(HOSTS_CHANNELS.list, (_event, payload: unknown): Promise<HostListing> =>
    deps.hosts.list(readListOptions(payload)),
  )

  ipcMain.handle(HOSTS_CHANNELS.home, async (_event, hostId: unknown): Promise<HostHomeResult> => {
    if (typeof hostId !== 'string' || !isWslHostId(hostId)) {
      return { ok: false, message: 'Only a WSL machine has a home to open.' }
    }
    const home = await deps.hosts
      .get(hostId)
      .homeDir()
      .catch(() => null)
    return home
      ? { ok: true, home: home.host, native: home.native }
      : { ok: false, message: 'Could not read the home folder in that distribution.' }
  })

  const getWindows = deps.getWindows ?? (() => BrowserWindow.getAllWindows())
  return deps.hosts.subscribe(() => {
    for (const win of getWindows()) {
      if (!win.isDestroyed()) win.webContents.send(HOSTS_CHANNELS.changed, null)
    }
  })
}
