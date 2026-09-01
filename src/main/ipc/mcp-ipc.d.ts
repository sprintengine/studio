import type { IpcMain } from 'electron';
import type { McpConfigService } from '../mcp-config-service';
export declare function registerMcpIpc(ipcMain: IpcMain, service: McpConfigService): void;
