import type { IpcMain } from 'electron'
import type { McpSyncInput, McpSyncResult } from '../../shared/electron-api'
import type { McpConfigService } from '../mcp-config-service'

export function registerMcpIpc(ipcMain: IpcMain, service: McpConfigService): void {
  ipcMain.handle('mcp:sync', (_, input: McpSyncInput): Promise<McpSyncResult> => service.sync(input))
}
