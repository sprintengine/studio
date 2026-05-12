import type { IpcMain } from 'electron'
import type {
  McpCatalogResult,
  McpSyncInput,
  McpSyncPreview,
  McpSyncResult,
} from '../../shared/electron-api'
import type { McpConfigService } from '../mcp-config-service'

export function registerMcpIpc(ipcMain: IpcMain, service: McpConfigService): void {
  ipcMain.handle('mcp:catalog', (): McpCatalogResult => service.listCatalog())
  ipcMain.handle('mcp:preview-sync', (_, input: McpSyncInput): McpSyncPreview => service.previewSync(input))
  ipcMain.handle('mcp:sync', (_, input: McpSyncInput): McpSyncResult => service.sync(input))
}
