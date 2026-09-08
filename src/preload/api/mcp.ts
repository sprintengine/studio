import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  McpCatalogResult,
  McpSyncInput,
  McpSyncResult,
} from '../../shared/electron-api'

export const mcpApi = {
  mcpListCatalog: (): Promise<McpCatalogResult> => ipcRenderer.invoke('mcp:catalog'),
  mcpSync: (input: McpSyncInput): Promise<McpSyncResult> => ipcRenderer.invoke('mcp:sync', input),
} satisfies Pick<ElectronApi, 'mcpListCatalog' | 'mcpSync'>
