import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import type { ConversationSecretClearResult, ConversationSecretSetResult, ConversationSecretStatus, ConversationSecretStatusResult } from '../shared/electron-api';
import { type CredentialOwner } from './credential-descriptors';
type SafeStorageAdapter = {
    isEncryptionAvailable(): boolean;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
};
type FileAdapter = {
    mkdir: typeof mkdir;
    readFile: typeof readFile;
    unlink: typeof unlink;
    writeFile: typeof writeFile;
};
export type ProviderSecretStoreOptions = {
    resolveAuthOwner?: (id: string) => CredentialOwner | undefined;
    resolveUserDataDir?: () => string;
    safeStorage?: SafeStorageAdapter;
    files?: FileAdapter;
    env?: NodeJS.ProcessEnv;
};
export type ProviderSecretValueResult = {
    ok: true;
    providerId: string;
    value: string;
    source: ConversationSecretStatus['source'];
} | {
    ok: false;
    message: string;
};
export declare class ProviderSecretStore {
    private readonly resolveAuthOwner;
    private readonly resolveUserDataDir;
    private readonly safeStorage;
    private readonly files;
    private readonly env;
    private readonly inMemorySecrets;
    constructor(options?: ProviderSecretStoreOptions);
    getStatus(providerId: string): Promise<ConversationSecretStatusResult>;
    resolveSecret(providerId: string): Promise<ProviderSecretValueResult>;
    setSecret(providerId: string, secretValue: string): Promise<ConversationSecretSetResult>;
    clearSecret(providerId: string): Promise<ConversationSecretClearResult>;
    private buildStatus;
    private readPersistedSecret;
    private resolveDescriptor;
    private secretPath;
}
export declare function getSharedCredentialStore(): ProviderSecretStore;
export {};
