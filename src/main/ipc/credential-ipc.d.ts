import type { IpcMain } from 'electron';
import type { CredentialSecretClearResult, CredentialSecretSetResult, CredentialSecretStatusResult } from '../../shared/electron-api';
export type CredentialIpcStore = {
    getStatus(id: string): Promise<CredentialSecretStatusResult>;
    setSecret(id: string, value: string): Promise<CredentialSecretSetResult>;
    clearSecret(id: string): Promise<CredentialSecretClearResult>;
};
export declare function registerCredentialIpc(ipcMain: IpcMain, store?: CredentialIpcStore): void;
