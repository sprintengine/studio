import type { IpcMain } from 'electron';
import { type ModuleEnablementLiveApplier } from './ipc/module-enablement-ipc';
import type { AppServices } from './app-services';
export type CoreIpcOptions = {
    includeDevModules?: boolean;
    applyModuleEnablementLive?: ModuleEnablementLiveApplier;
};
export declare function registerCoreIpc(ipcMain: IpcMain, services: AppServices, diagnosticsEnabled: boolean, options?: CoreIpcOptions): void;
