import { type IpcMain } from 'electron';
import { type ModuleEnablementOverrides } from '../../shared/modules/manifest';
import { type ModuleEnablementWriteResult } from '../module-host/enablement-store';
export type ModuleEnablementLiveApplier = (overrides: ModuleEnablementOverrides) => void | ModuleEnablementWriteResult | Promise<void | ModuleEnablementWriteResult>;
export declare function registerModuleEnablementIpc(ipcMain: IpcMain, options?: {
    applyLive?: ModuleEnablementLiveApplier;
}): void;
