import type { IpcMain } from 'electron';
import type { MulticodeUpdateService } from '../update-service';
type UpdateIpcDependencies = {
    updateService: MulticodeUpdateService;
};
export declare function registerUpdateIpc(ipcMain: IpcMain, { updateService }: UpdateIpcDependencies): void;
export {};
