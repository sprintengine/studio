import type { IpcMain } from 'electron';
import type { AgentLaunchPreviewInput, AgentLaunchPreviewResult, PluginAvailabilityResult, PluginDetectAvailabilityInput, PluginInstallResult, PluginRegistryListResult } from '../../shared/electron-api';
export type PluginIpcHandlers = {
    list(): PluginRegistryListResult;
    detectAvailability(input: PluginDetectAvailabilityInput | undefined): Promise<PluginAvailabilityResult>;
    installFolder(srcDir: unknown): Promise<PluginInstallResult>;
    reload(): PluginRegistryListResult;
    launchPreview(input: AgentLaunchPreviewInput | undefined): AgentLaunchPreviewResult;
};
export declare function createPluginIpcHandlers(): PluginIpcHandlers;
export declare function registerPluginIpc(ipcMain: IpcMain, overrides?: Partial<PluginIpcHandlers>): void;
