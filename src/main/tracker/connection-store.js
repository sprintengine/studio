import { randomUUID } from 'crypto';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { ProviderSecretStore } from '../secret-store';
export class TrackerConnectionStore {
    resolveUserDataDir;
    files;
    generateId;
    resolveCapabilities;
    secretStore;
    connections = null;
    draftConnections = new Map();
    draftSecrets = new Map();
    probeCache = new Map();
    constructor(options = {}) {
        this.resolveUserDataDir = options.resolveUserDataDir ?? (() => loadElectron().app.getPath('userData'));
        this.files = options.files ?? { mkdir, readFile, writeFile, unlink };
        this.generateId = options.generateConnectionId ?? (() => `trk-${randomUUID()}`);
        this.resolveCapabilities = options.resolveCapabilities ?? (() => undefined);
        this.secretStore = new ProviderSecretStore({
            resolveAuthOwner: (id) => this.resolveTrackerAuthOwner(id),
            resolveUserDataDir: this.resolveUserDataDir,
            safeStorage: options.safeStorage,
            files: options.files,
            env: options.env,
        });
    }
    async list() {
        const connections = await this.ensureLoaded();
        const redacted = [];
        for (const connection of connections) {
            redacted.push(await this.redact(connection));
        }
        return redacted;
    }
    async getConnection(id) {
        const connections = await this.ensureLoaded();
        return connections.find((c) => c.id === id) ?? this.draftConnections.get(id);
    }
    async add(input) {
        const validation = validateConnectionShape(input);
        if (!validation.ok)
            throw new Error(validation.message);
        const connections = await this.ensureLoaded();
        const connection = {
            id: this.generateId(),
            provider: input.provider,
            baseUrl: normalizeBaseUrl(input.provider, input.baseUrl),
            authMode: input.authMode,
            label: input.label.trim(),
            envVar: normalizeEnvVar(input.envVar),
        };
        connections.push(connection);
        await this.persist(connections);
        const secret = input.secret?.trim();
        if (secret) {
            const stored = await this.secretStore.setSecret(connection.id, secret);
            if (!stored.ok) {
                // Roll the metadata back so a connection is never persisted without the
                // credential the caller intended it to carry.
                const rolled = connections.filter((c) => c.id !== connection.id);
                this.connections = rolled;
                await this.persist(rolled);
                throw new Error(stored.message);
            }
        }
        return this.redact(connection);
    }
    async remove(id) {
        const connections = await this.ensureLoaded();
        if (!connections.some((c) => c.id === id))
            return;
        // Clear the credential first so a failed metadata write never orphans a live
        // secret behind a removed connection.
        await this.secretStore.clearSecret(id).catch(() => { });
        this.probeCache.delete(id);
        const remaining = connections.filter((c) => c.id !== id);
        this.connections = remaining;
        await this.persist(remaining);
    }
    // Provider-facing secret accessor (T3/T4/T5). Never crosses IPC. Consults the
    // in-memory draft secret first so a not-yet-saved connection can be tested.
    async resolveSecret(id) {
        await this.ensureLoaded();
        const draft = this.draftSecrets.get(id);
        if (draft !== undefined) {
            return { ok: true, providerId: id, value: draft, source: 'session' };
        }
        return this.secretStore.resolveSecret(id);
    }
    // Records the outcome of an explicit probe so listConnections reflects it. A
    // rejected credential (auth) is 'expired' so the row offers Reconnect; any other
    // failure (network/rate-limit/unclassified) stays 'unknown' — we tried but can't
    // confirm the credential — rather than falsely claiming the token expired.
    recordProbe(id, probe) {
        if (probe.ok) {
            this.probeCache.set(id, { status: 'connected' });
            return;
        }
        this.probeCache.set(id, { status: probe.kind === 'auth' ? 'expired' : 'unknown', reason: probe.reason });
    }
    // Runs `fn` against a transient, un-persisted connection carrying an in-memory
    // secret — the "test before save" path for the settings form. Nothing touches
    // disk, and the transient connection/secret are always cleaned up.
    async withDraftConnection(draft, fn) {
        const validation = validateConnectionShape(draft);
        if (!validation.ok)
            throw new Error(validation.message);
        const id = `trk-draft-${randomUUID()}`;
        this.draftConnections.set(id, {
            id,
            provider: draft.provider,
            baseUrl: normalizeBaseUrl(draft.provider, draft.baseUrl),
            authMode: draft.authMode,
            label: draft.label.trim(),
            envVar: normalizeEnvVar(draft.envVar),
        });
        const secret = draft.secret?.trim();
        if (secret)
            this.draftSecrets.set(id, secret);
        try {
            return await fn(id);
        }
        finally {
            this.draftConnections.delete(id);
            this.draftSecrets.delete(id);
        }
    }
    async redact(connection) {
        const { status, statusReason } = await this.resolveStatus(connection);
        const capabilities = this.resolveCapabilities(connection.provider);
        return {
            ...connection,
            status,
            ...(statusReason ? { statusReason } : {}),
            ...(capabilities ? { capabilities } : {}),
        };
    }
    async resolveStatus(connection) {
        const cached = this.probeCache.get(connection.id);
        if (cached)
            return { status: cached.status, statusReason: cached.reason };
        const secret = await this.secretStore.getStatus(connection.id);
        if (secret.ok && secret.status.configured) {
            return { status: 'unknown', statusReason: 'Not tested yet.' };
        }
        return { status: 'expired', statusReason: 'No credential configured.' };
    }
    // Maps a connection id → the api-key auth descriptor the ProviderSecretStore
    // needs. The storage key becomes `${id}-${envVar ?? 'api-key'}`, so two
    // connections of the same provider (distinct ids) resolve distinct secrets.
    resolveTrackerAuthOwner(id) {
        const connection = this.connections?.find((c) => c.id === id) ?? this.draftConnections.get(id);
        if (!connection)
            return undefined;
        return {
            manifest: {
                auth: {
                    type: 'api-key',
                    label: `${connection.label} credential`,
                    ...(connection.envVar ? { env: connection.envVar } : {}),
                },
            },
        };
    }
    async ensureLoaded() {
        if (this.connections)
            return this.connections;
        this.connections = await this.readPersisted();
        return this.connections;
    }
    async readPersisted() {
        let raw;
        try {
            raw = (await this.files.readFile(this.storePath(), 'utf8'));
        }
        catch {
            return []; // No file yet ⇒ zero connections ⇒ byte-identical to today.
        }
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || !Array.isArray(parsed.connections))
                return [];
            return parsed.connections.filter(isPersistableConnection);
        }
        catch {
            return [];
        }
    }
    async persist(connections) {
        const payload = { version: 1, connections };
        const path = this.storePath();
        await this.files.mkdir(dirname(path), { recursive: true });
        await this.files.writeFile(path, JSON.stringify(payload, null, 2), { mode: 0o600 });
    }
    storePath() {
        return join(this.resolveUserDataDir(), 'tracker-connections.json');
    }
}
function normalizeEnvVar(envVar) {
    const trimmed = envVar?.trim();
    return trimmed ? trimmed : null;
}
// GitHub github.com is expressed as a null base URL; a GHES/self-hosted host is a
// string. Jira always has a site/server URL. Linear has no server address.
function normalizeBaseUrl(provider, baseUrl) {
    if (provider === 'linear')
        return null;
    const trimmed = baseUrl?.trim();
    if (!trimmed)
        return null;
    if (provider === 'github')
        return normalizeGithubBaseUrl(trimmed);
    return trimmed;
}
// Canonicalizes a GitHub host into the REST API base the client fetches against.
// github.com in any form (bare, scheme-prefixed, trailing slash) carries no
// override and resolves to https://api.github.com downstream, so it becomes null.
// Any other host is a GitHub Enterprise Server whose v3 API lives at
// https://<host>/api/v3; a value already in that shape normalizes to itself.
function normalizeGithubBaseUrl(host) {
    const authority = host
        .replace(/^https?:\/\//i, '')
        .replace(/\/.*$/, '')
        .replace(/\/+$/, '');
    if (!authority || authority.toLowerCase() === 'github.com')
        return null;
    return `https://${authority}/api/v3`;
}
const AUTH_MODES_BY_PROVIDER = {
    github: ['github_pat'],
    jira: ['jira_basic', 'jira_pat'],
    linear: ['linear_key'],
};
// Validates a connection at the boundary: provider/authMode must agree, Linear
// carries no base URL, and Jira requires one. Structural, not credential-testing.
function validateConnectionShape(input) {
    if (!AUTH_MODES_BY_PROVIDER[input.provider]) {
        return { ok: false, message: 'Unknown tracker.' };
    }
    if (!AUTH_MODES_BY_PROVIDER[input.provider].includes(input.authMode)) {
        return { ok: false, message: 'This sign-in method does not match the chosen tracker.' };
    }
    if (!input.label || !input.label.trim()) {
        return { ok: false, message: 'A connection name is required.' };
    }
    if (input.provider === 'linear' && input.baseUrl && input.baseUrl.trim()) {
        return { ok: false, message: 'Linear has no server address.' };
    }
    if (input.provider === 'jira' && (!input.baseUrl || !input.baseUrl.trim())) {
        return { ok: false, message: 'A Jira server address is required.' };
    }
    return { ok: true };
}
function isPersistableConnection(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const c = value;
    return (typeof c.id === 'string' &&
        (c.provider === 'github' || c.provider === 'jira' || c.provider === 'linear') &&
        (c.baseUrl === null || typeof c.baseUrl === 'string') &&
        typeof c.authMode === 'string' &&
        typeof c.label === 'string');
}
function loadElectron() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('electron');
}
