import { dirname, join } from 'path';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { resolveCredentialOwner } from './credential-descriptors';
export class ProviderSecretStore {
    resolveAuthOwner;
    resolveUserDataDir;
    safeStorage;
    files;
    env;
    inMemorySecrets = new Map();
    constructor(options = {}) {
        this.resolveAuthOwner = options.resolveAuthOwner ?? resolveCredentialOwner;
        this.resolveUserDataDir = options.resolveUserDataDir ?? (() => loadElectron().app.getPath('userData'));
        this.safeStorage = options.safeStorage ?? loadElectron().safeStorage;
        this.files = options.files ?? { mkdir, readFile, unlink, writeFile };
        this.env = options.env ?? process.env;
    }
    async getStatus(providerId) {
        const descriptor = this.resolveDescriptor(providerId);
        if (!descriptor.ok)
            return { ok: false, message: descriptor.message };
        return { ok: true, status: await this.buildStatus(descriptor) };
    }
    async resolveSecret(providerId) {
        const descriptor = this.resolveDescriptor(providerId);
        if (!descriptor.ok)
            return { ok: false, message: descriptor.message };
        if (this.inMemorySecrets.has(descriptor.storageKey)) {
            return {
                ok: true,
                providerId: descriptor.providerId,
                value: this.inMemorySecrets.get(descriptor.storageKey) ?? '',
                source: this.safeStorage.isEncryptionAvailable() ? 'settings' : 'session',
            };
        }
        const savedSecret = await this.readPersistedSecret(descriptor.storageKey);
        if (savedSecret) {
            return { ok: true, providerId: descriptor.providerId, value: savedSecret, source: 'settings' };
        }
        if (descriptor.envName) {
            const envValue = this.env[descriptor.envName]?.trim() ?? '';
            if (envValue)
                return { ok: true, providerId: descriptor.providerId, value: envValue, source: 'environment' };
        }
        return { ok: false, message: 'Conversation provider secret is not configured.' };
    }
    async setSecret(providerId, secretValue) {
        const descriptor = this.resolveDescriptor(providerId);
        if (!descriptor.ok)
            return { ok: false, message: descriptor.message };
        const trimmed = secretValue.trim();
        if (!trimmed)
            return { ok: false, message: 'Provider secret value is required.' };
        this.inMemorySecrets.set(descriptor.storageKey, trimmed);
        if (this.safeStorage.isEncryptionAvailable()) {
            try {
                await this.files.mkdir(dirname(this.secretPath(descriptor.storageKey)), { recursive: true });
                await this.files.writeFile(this.secretPath(descriptor.storageKey), this.safeStorage.encryptString(trimmed), {
                    mode: 0o600,
                });
            }
            catch {
                this.inMemorySecrets.delete(descriptor.storageKey);
                return { ok: false, message: 'Could not store provider secret.' };
            }
        }
        return { ok: true, status: await this.buildStatus(descriptor) };
    }
    async clearSecret(providerId) {
        const descriptor = this.resolveDescriptor(providerId);
        if (!descriptor.ok)
            return { ok: false, message: descriptor.message };
        this.inMemorySecrets.delete(descriptor.storageKey);
        await this.files.unlink(this.secretPath(descriptor.storageKey)).catch(() => { });
        return { ok: true, status: await this.buildStatus(descriptor) };
    }
    async buildStatus(descriptor) {
        const encryptionAvailable = this.safeStorage.isEncryptionAvailable();
        if (this.inMemorySecrets.has(descriptor.storageKey)) {
            return {
                providerId: descriptor.providerId,
                configured: true,
                source: encryptionAvailable ? 'settings' : 'session',
                persistence: encryptionAvailable ? 'encrypted' : 'session',
                encryptionAvailable,
                label: descriptor.label,
            };
        }
        const savedSecret = await this.readPersistedSecret(descriptor.storageKey);
        if (savedSecret) {
            return {
                providerId: descriptor.providerId,
                configured: true,
                source: 'settings',
                persistence: 'encrypted',
                encryptionAvailable,
                label: descriptor.label,
            };
        }
        if (descriptor.envName) {
            const envValue = this.env[descriptor.envName]?.trim() ?? '';
            if (envValue) {
                return {
                    providerId: descriptor.providerId,
                    configured: true,
                    source: 'environment',
                    persistence: 'environment',
                    encryptionAvailable,
                    label: descriptor.label,
                };
            }
        }
        return {
            providerId: descriptor.providerId,
            configured: false,
            source: 'none',
            persistence: encryptionAvailable ? 'encrypted' : 'session',
            encryptionAvailable,
            label: descriptor.label,
        };
    }
    async readPersistedSecret(storageKey) {
        if (!this.safeStorage.isEncryptionAvailable())
            return null;
        try {
            const encrypted = await this.files.readFile(this.secretPath(storageKey));
            const secret = this.safeStorage.decryptString(encrypted).trim();
            if (secret)
                this.inMemorySecrets.set(storageKey, secret);
            return secret || null;
        }
        catch {
            return null;
        }
    }
    resolveDescriptor(providerId) {
        const normalizedProviderId = providerId.trim();
        if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(normalizedProviderId)) {
            return { ok: false, message: 'Provider id is invalid.' };
        }
        const owner = this.resolveAuthOwner(normalizedProviderId);
        if (!owner)
            return { ok: false, message: 'Conversation provider is not installed.' };
        const auth = owner.manifest.auth;
        if (!auth)
            return { ok: false, message: 'Conversation provider does not declare a secret.' };
        const envName = auth.env?.trim() || null;
        return {
            ok: true,
            providerId: normalizedProviderId,
            label: auth.label,
            envName,
            storageKey: `${normalizedProviderId}-${envName ?? auth.type}`,
        };
    }
    secretPath(storageKey) {
        return join(this.resolveUserDataDir(), 'provider-secrets', `${encodeURIComponent(storageKey)}.bin`);
    }
}
function loadElectron() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('electron');
}
// Multicode's single shared credential store. Both the conversation runtime and
// the agent-CLI launch path resolve secrets through this one instance, so a key
// set in one surface (and its in-memory/session cache) is visible to the other.
let sharedCredentialStore = null;
export function getSharedCredentialStore() {
    return (sharedCredentialStore ??= new ProviderSecretStore());
}
