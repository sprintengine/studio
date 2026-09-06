// One read for the catalogue's built-in row: what this build ships, and what
// the open workspace actually holds.
//
// Read-only on purpose. Install and Remove are not offered for this plugin —
// the app puts it into every workspace it opens and puts it back when someone
// deletes it — so there is nothing here for a renderer to press.

import type { IpcMain } from 'electron'

import type { StudioPluginStatus } from '../../shared/electron-api'
import type { StudioPluginService } from '../studio-plugin-service'

export const STUDIO_PLUGIN_STATUS_CHANNEL = 'studio-plugin:status'

export function registerStudioPluginIpc(ipcMain: IpcMain, service: StudioPluginService): void {
  ipcMain.handle(
    STUDIO_PLUGIN_STATUS_CHANNEL,
    async (_, input: { workspaceRoot?: string | null }): Promise<StudioPluginStatus> => {
      const workspaceRoot = input?.workspaceRoot?.trim() ?? ''
      const [bundledVersion, hooksAcknowledgedAt] = await Promise.all([
        service.bundledVersion(),
        service.hooksAcknowledgedAt(),
      ])
      const record = workspaceRoot === '' ? null : service.installed(workspaceRoot)
      return {
        bundledVersion,
        hooksAcknowledgedAt,
        installedVersion: record?.version ?? '',
        skillDirNames: record?.skillDirNames ?? [],
        claudePluginKey: record?.claudePluginKey ?? '',
      }
    }
  )
}
