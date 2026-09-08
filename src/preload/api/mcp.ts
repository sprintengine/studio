import { ipcRenderer } from 'electron'
import type { ElectronApi, McpSyncInput, McpSyncResult } from '../../shared/electron-api'

export const mcpApi = {
  mcpSync: (input: McpSyncInput): Promise<McpSyncResult> => ipcRenderer.invoke('mcp:sync', input),
} satisfies Pick<ElectronApi, 'mcpSync'>
