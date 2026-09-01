import { type IpcMain } from 'electron';
import type { AppServices } from '../app-services';
export declare function registerMarketplacePluginIpc(ipcMain: IpcMain, services: Pick<AppServices, 'mcpConfigService' | 'getAutomationsAppFrontDoor'>): void;
