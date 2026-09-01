import type { IpcMain } from 'electron';
import type { AutomationService } from '../automation/automation-service';
export declare function registerAutomationIpc(ipcMain: IpcMain, service: AutomationService): void;
