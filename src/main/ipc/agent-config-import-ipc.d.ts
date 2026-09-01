import type { IpcMain } from 'electron';
import type { AgentConfigImportService } from '../agent-config-import';
export declare function registerAgentConfigImportIpc(ipcMain: IpcMain, service: AgentConfigImportService): void;
