import { type IpcMain } from 'electron';
import type { MarketplaceRegistryReadInput, MarketplaceRegistryReadResult } from '../../shared/electron-api';
import { MarketplaceRegistryClient } from '../marketplace/registry-client';
export type MarketplaceRegistryReader = {
    read(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult>;
};
export type MarketplaceRegistryIpcHandlers = {
    read(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult>;
};
export declare function createMarketplaceRegistryIpcHandlers(reader?: MarketplaceRegistryReader): MarketplaceRegistryIpcHandlers;
export declare function registerMarketplaceRegistryIpc(ipcMain: IpcMain, overrides?: Partial<MarketplaceRegistryIpcHandlers>): void;
export declare function createDefaultMarketplaceRegistryClient(): MarketplaceRegistryClient;
