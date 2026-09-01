import type { IpcMain } from 'electron';
import type { AppServices } from './app-services';
export declare function registerWorkflowIpc(ipcMain: IpcMain, services: AppServices): void;
