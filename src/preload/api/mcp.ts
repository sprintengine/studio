import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi, McpSyncInput, McpSyncResult } from '../../shared/electron-api'

export const mcpApi = {
  mcpSync: (input: McpSyncInput): Promise<McpSyncResult> => ipcRenderer.invoke('mcp:sync', input),
} satisfies Pick<ElectronApi, 'mcpSync'>
