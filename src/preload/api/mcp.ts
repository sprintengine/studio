import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  McpCatalogResult,
  McpSyncInput,
  McpSyncPreview,
  McpSyncResult,
} from '../../shared/electron-api'

export const mcpApi = {
  mcpListCatalog: (): Promise<McpCatalogResult> => ipcRenderer.invoke('mcp:catalog'),
  mcpPreviewSync: (input: McpSyncInput): Promise<McpSyncPreview> => ipcRenderer.invoke('mcp:preview-sync', input),
  mcpSync: (input: McpSyncInput): Promise<McpSyncResult> => ipcRenderer.invoke('mcp:sync', input),
} satisfies Pick<ElectronApi, 'mcpListCatalog' | 'mcpPreviewSync' | 'mcpSync'>
