import type { IpcMain } from 'electron';
import type { AutomationService } from '../automation/automation-service';
export declare function registerFleetIpc(ipcMain: IpcMain, service: AutomationService): void;
