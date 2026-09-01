import { app, BrowserWindow, safeStorage, shell } from 'electron';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { createHash, randomBytes } from 'crypto';
import { createServer } from 'http';
import { dirname, join } from 'path';
import { ENTITLEMENT_GRACE_MS, ENTITLEMENT_MAX_CACHE_AGE_MS, EntitlementService, entitlementCacheStatus, entitlementGraceExpiresAt, isEntitlementSnapshot, isEntitlementSnapshotFresh, offlineGraceMessage, } from './entitlement-service';
import { getErrorMessage } from './error-message';
const DEFAULT_MULTIAUTH_BASE_URL = 'https://multiauth-production.up.railway.app';
const MULTIAUTH_BASE_URL = (process.env['MULTIAUTH_BASE_URL'] || DEFAULT_MULTIAUTH_BASE_URL).replace(/\/+$/u, '');
const MULTICODE_CLIENT_ID = 'multicode-desktop';
const MULTICODE_LOOPBACK_HOST = '127.0.0.1';
const MULTICODE_LOOPBACK_PORT = 43110;
const MULTICODE_LOOPBACK_REDIRECT_URI = `http://${MULTICODE_LOOPBACK_HOST}:${MULTICODE_LOOPBACK_PORT}/callback`;
const MULTICODE_CUSTOM_REDIRECT_URI = 'multicode://auth/callback';
const DEFAULT_MULTICODE_AUTH_REDIRECT_MODE = app.isPackaged ? 'custom' : 'loopback';
const MULTICODE_AUTH_REDIRECT_MODE = process.env['MULTICODE_AUTH_REDIRECT_MODE'] === 'custom' ||
    process.env['MULTICODE_AUTH_REDIRECT_MODE'] === 'loopback'
    ? process.env['MULTICODE_AUTH_REDIRECT_MODE']
    : DEFAULT_MULTICODE_AUTH_REDIRECT_MODE;
const MULTICODE_REDIRECT_URI = MULTICODE_AUTH_REDIRECT_MODE === 'loopback' ? MULTICODE_LOOPBACK_REDIRECT_URI : MULTICODE_CUSTOM_REDIRECT_URI;
const MULTICODE_PRODUCT = 'multicode';
const AUTH_PREFLIGHT_TIMEOUT_MS = 3000;
class MulticodeMultiauthClient {
    refreshTokenStore;
    accessToken = null;
    accessTokenExpiresAt = 0;
    selectedOrganizationId = null;
    entitlementCache = null;
    constructor(refreshTokenStore) {
        this.refreshTokenStore = refreshTokenStore;
    }
    async exchangeDesktopCode(input) {
        const tokenSet = await this.request('/api/auth/desktop/exchange', {
            method: 'POST',
            body: JSON.stringify(input),
        });
        await this.installTokens(tokenSet);
        return tokenSet;
    }
    async refresh(clientId = MULTICODE_CLIENT_ID) {
        const refreshToken = await this.refreshTokenStore.readRefreshToken();
        if (!refreshToken) {
            throw new Error('No desktop refresh token is available.');
        }
        const tokenSet = await this.request('/api/auth/refresh', {
            method: 'POST',
            body: JSON.stringify({ clientId, refreshToken }),
        });
        await this.installTokens(tokenSet);
        return tokenSet;
    }
    async logout() {
        const refreshToken = await this.refreshTokenStore.readRefreshToken();
        const result = await this.request('/api/auth/logout', {
            method: 'POST',
            body: JSON.stringify({ refreshToken }),
        }).catch(async (error) => {
            await this.refreshTokenStore.clearRefreshToken();
            this.accessToken = null;
            this.accessTokenExpiresAt = 0;
            this.entitlementCache = null;
            console.warn('[auth] server-logout-failed-local-session-cleared', { message: getErrorMessage(error) });
            return { loggedOut: true };
        });
        await this.refreshTokenStore.clearRefreshToken();
        this.accessToken = null;
        this.accessTokenExpiresAt = 0;
        this.entitlementCache = null;
        return result;
    }
    async selectOrganization(organizationId) {
        if (!organizationId.trim()) {
            throw new Error('organizationId is required.');
        }
        this.selectedOrganizationId = organizationId;
        this.entitlementCache = null;
        return { organizationId };
    }
    async getEntitlements(options = {}) {
        if (!options.forceRefresh && this.entitlementCache && isEntitlementSnapshotFresh(this.entitlementCache)) {
            return this.entitlementCache;
        }
        const snapshot = await this.request(`/api/entitlements?product=${encodeURIComponent(MULTICODE_PRODUCT)}`, { method: 'GET' });
        if (this.selectedOrganizationId && snapshot.organizationId !== this.selectedOrganizationId) {
            throw new Error('Selected organization does not match the authenticated desktop session.');
        }
        this.entitlementCache = snapshot;
        return snapshot;
    }
    async getAccessToken(clientId = MULTICODE_CLIENT_ID) {
        if (!this.accessToken || this.accessTokenExpiresAt <= Date.now() + 60_000) {
            await this.refresh(clientId);
        }
        if (!this.accessToken) {
            throw new Error('No desktop access token is available.');
        }
        return this.accessToken;
    }
    async request(path, init) {
        const headers = new Headers(init.headers);
        headers.set('accept', 'application/json');
        if (init.body && !headers.has('content-type')) {
            headers.set('content-type', 'application/json');
        }
        if (this.accessToken) {
            headers.set('authorization', `Bearer ${this.accessToken}`);
        }
        const response = await fetch(new URL(path, `${MULTIAUTH_BASE_URL}/`), {
            ...init,
            headers,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(readMultiauthErrorMessage(payload));
        }
        return payload;
    }
    async installTokens(tokenSet) {
        this.accessToken = tokenSet.accessToken;
        this.accessTokenExpiresAt = Date.now() + Math.max(0, tokenSet.expiresIn - 30) * 1000;
        await this.refreshTokenStore.writeRefreshToken(tokenSet.refreshToken);
    }
}
class ElectronSafeRefreshTokenStore {
    inMemoryRefreshToken = null;
    get tokenPath() {
        return join(app.getPath('userData'), 'multiauth-refresh-token.bin');
    }
    async readRefreshToken() {
        if (this.inMemoryRefreshToken)
            return this.inMemoryRefreshToken;
        if (!safeStorage.isEncryptionAvailable())
            return null;
        try {
            const encrypted = await readFile(this.tokenPath);
            const refreshToken = safeStorage.decryptString(encrypted);
            this.inMemoryRefreshToken = refreshToken;
            return refreshToken;
        }
        catch {
            return null;
        }
    }
    async writeRefreshToken(refreshToken) {
        this.inMemoryRefreshToken = refreshToken;
        if (!safeStorage.isEncryptionAvailable())
            return;
        await mkdir(dirname(this.tokenPath), { recursive: true });
        await writeFile(this.tokenPath, safeStorage.encryptString(refreshToken), { mode: 0o600 });
    }
    async clearRefreshToken() {
        this.inMemoryRefreshToken = null;
        await unlink(this.tokenPath).catch(() => { });
    }
}
export class MulticodeAuthBridge {
    refreshTokenStore = new ElectronSafeRefreshTokenStore();
    client = new MulticodeMultiauthClient(this.refreshTokenStore);
    state = signedOutAuthState('Checking account.');
    pendingLogin = null;
    callbackServer = null;
    cachedEntitlements = null;
    // This bridge is the Multiauth ADAPTER behind the entitlement seam. It answers
    // the two questions `EntitlementProvider` asks and knows nothing about how a
    // decision is reached; every gate in the app goes through `entitlements`, so
    // replacing Multiauth means replacing this class, not its callers.
    entitlements = new EntitlementService({
        read: () => ({
            authenticated: this.state.authenticated,
            snapshot: this.state.entitlements,
            cache: this.cachedEntitlements,
            lastRefreshAt: this.state.lastRefreshAt,
        }),
        refresh: async () => {
            await this.refreshEntitlements({ forceRefresh: true });
        },
    }, {
        product: MULTICODE_PRODUCT,
        graceMs: ENTITLEMENT_GRACE_MS,
        maxCacheAgeMs: ENTITLEMENT_MAX_CACHE_AGE_MS,
    });
    async initialize() {
        this.setState({ ...this.state, status: 'checking', message: 'Checking account.' });
        try {
            await this.client.refresh(MULTICODE_CLIENT_ID);
            return this.refreshEntitlements({ forceRefresh: true });
        }
        catch {
            const cache = this.cachedEntitlements ?? await this.readCachedEntitlements();
            this.cachedEntitlements = cache;
            if (cache) {
                const entitlementStatus = entitlementCacheStatus(cache);
                const graceExpiresAt = entitlementGraceExpiresAt(cache);
                this.setState({
                    ...this.state,
                    status: 'signed_in',
                    authenticated: true,
                    entitlements: cache.snapshot,
                    entitlementStatus,
                    message: entitlementStatus === 'offline_grace'
                        ? offlineGraceMessage(graceExpiresAt)
                        : 'Sign in again to refresh Multicode access.',
                    lastRefreshAt: cache.lastRefreshAt,
                    graceExpiresAt,
                });
                return this.state;
            }
            this.setState(signedOutAuthState(null));
            return this.state;
        }
    }
    getState() {
        return this.state;
    }
    async login(organizationId) {
        await this.preflightAuthServer();
        await this.closeCallbackServer();
        const state = randomBase64Url(24);
        const nonce = randomBase64Url(24);
        const codeVerifier = randomBase64Url(48);
        const codeChallenge = pkceChallenge(codeVerifier);
        const search = new URLSearchParams({
            returnTo: 'desktop',
            product: MULTICODE_PRODUCT,
            client_id: MULTICODE_CLIENT_ID,
            redirect_uri: MULTICODE_REDIRECT_URI,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            state,
            nonce,
            scope: 'openid profile entitlements:read relay:desktop',
        });
        const selectedOrganizationId = organizationId?.trim() || this.state.selectedOrganization?.id;
        if (selectedOrganizationId) {
            search.set('organization_id', selectedOrganizationId);
        }
        if (MULTICODE_REDIRECT_URI === MULTICODE_LOOPBACK_REDIRECT_URI) {
            try {
                this.callbackServer = await startDesktopCallbackServer(async (callbackUrl) => {
                    await this.handleCallback(callbackUrl);
                });
            }
            catch (error) {
                const message = getErrorMessage(error);
                this.setState({ ...this.state, status: 'error', message });
                throw new Error(message);
            }
        }
        this.pendingLogin = {
            state,
            nonce,
            codeVerifier,
            organizationId: selectedOrganizationId ?? null,
            createdAt: Date.now(),
        };
        const authorizationUrl = `${MULTIAUTH_BASE_URL}/?${search.toString()}`;
        try {
            await shell.openExternal(authorizationUrl);
        }
        catch (error) {
            this.pendingLogin = null;
            await this.closeCallbackServer();
            const message = `Could not open Multiauth sign-in: ${getErrorMessage(error)}`;
            this.setState({ ...this.state, status: 'error', message });
            console.error('[auth] login-open-failed', { authorizationUrl, message });
            throw new Error(message);
        }
        this.setState({ ...this.state, message: 'Complete sign-in in your browser.' });
        console.info('[auth] login-started', { authorizationUrl, organizationId: selectedOrganizationId ?? null });
        return { state, authorizationUrl };
    }
    async handleCallback(callbackUrl) {
        const url = new URL(callbackUrl);
        if (!isSupportedAuthCallbackUrl(url)) {
            throw new Error('Unsupported Multiauth callback URL.');
        }
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const pending = this.pendingLogin;
        if (!code || !state || !pending || pending.state !== state) {
            throw new Error('Desktop sign-in state did not match.');
        }
        if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
            this.pendingLogin = null;
            throw new Error('Desktop sign-in expired. Start sign-in again.');
        }
        await this.client.exchangeDesktopCode({
            clientId: MULTICODE_CLIENT_ID,
            redirectUri: url.protocol === 'multicode:' ? MULTICODE_CUSTOM_REDIRECT_URI : MULTICODE_LOOPBACK_REDIRECT_URI,
            code,
            codeVerifier: pending.codeVerifier,
        });
        this.pendingLogin = null;
        if (url.protocol === 'multicode:') {
            await this.closeCallbackServer();
        }
        if (pending.organizationId) {
            await this.client.selectOrganization(pending.organizationId);
        }
        return this.refreshEntitlements({ forceRefresh: true });
    }
    async logout() {
        const result = await this.client.logout();
        this.pendingLogin = null;
        await this.closeCallbackServer();
        this.cachedEntitlements = null;
        await unlink(this.cachePath).catch(() => { });
        this.setState(signedOutAuthState(null));
        return result;
    }
    async selectOrganization(organizationId) {
        const result = await this.client.selectOrganization(organizationId);
        await this.refreshEntitlements({ forceRefresh: true });
        return result;
    }
    async refreshEntitlements(options = {}) {
        try {
            const entitlements = await this.client.getEntitlements({ forceRefresh: options.forceRefresh ?? true });
            const session = await this.readSessionFromEntitlements(entitlements);
            const cache = {
                snapshot: entitlements,
                lastRefreshAt: new Date().toISOString(),
            };
            this.cachedEntitlements = cache;
            await this.writeCachedEntitlements(cache);
            // Same ladder the seam gates on, so a snapshot that arrives already past
            // its expiry is published as `offline_grace` here and read as
            // `offline_grace` there — the state and the decisions cannot disagree.
            const entitlementStatus = entitlementCacheStatus(cache);
            const graceExpiresAt = entitlementGraceExpiresAt(cache);
            this.setState({
                authenticated: true,
                user: session.user,
                selectedOrganization: session.selectedOrganization,
                entitlements,
                status: 'signed_in',
                entitlementStatus,
                message: entitlementStatus === 'offline_grace' ? offlineGraceMessage(graceExpiresAt) : null,
                lastRefreshAt: cache.lastRefreshAt,
                graceExpiresAt,
            });
        }
        catch (error) {
            const cache = this.cachedEntitlements ?? await this.readCachedEntitlements();
            this.cachedEntitlements = cache;
            if (cache) {
                const entitlementStatus = entitlementCacheStatus(cache);
                const graceExpiresAt = entitlementGraceExpiresAt(cache);
                this.setState({
                    ...this.state,
                    authenticated: true,
                    entitlements: cache.snapshot,
                    status: 'signed_in',
                    entitlementStatus,
                    message: entitlementStatus === 'offline_grace'
                        ? offlineGraceMessage(graceExpiresAt)
                        : getErrorMessage(error),
                    lastRefreshAt: cache.lastRefreshAt,
                    graceExpiresAt,
                });
                return this.state;
            }
            this.setState({
                ...signedOutAuthState(getErrorMessage(error)),
                status: this.state.authenticated ? 'error' : 'signed_out',
            });
        }
        return this.state;
    }
    async getSession() {
        if (!this.state.authenticated || !this.state.user || !this.state.selectedOrganization) {
            return { authenticated: false, user: null, selectedOrganization: null };
        }
        return {
            authenticated: true,
            user: this.state.user,
            selectedOrganization: this.state.selectedOrganization,
            session: {
                id: 'desktop',
                expiresAt: this.state.entitlements?.expiresAt ?? new Date(0).toISOString(),
            },
        };
    }
    async getRelayAccessToken() {
        try {
            return await this.client.getAccessToken(MULTICODE_CLIENT_ID);
        }
        catch {
            return null;
        }
    }
    async openUpgrade(reason) {
        const search = new URLSearchParams({
            returnTo: 'checkout',
            product: MULTICODE_PRODUCT,
        });
        if (reason?.trim())
            search.set('reason', reason.trim());
        if (this.state.selectedOrganization?.id) {
            search.set('organizationId', this.state.selectedOrganization.id);
        }
        const url = `${MULTIAUTH_BASE_URL}/?${search.toString()}`;
        await shell.openExternal(url);
        return { opened: true, url };
    }
    async preflightAuthServer() {
        const healthUrl = `${MULTIAUTH_BASE_URL}/api/health`;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), AUTH_PREFLIGHT_TIMEOUT_MS);
            const response = await fetch(healthUrl, {
                headers: { accept: 'application/json' },
                signal: controller.signal,
            }).finally(() => clearTimeout(timeout));
            if (!response.ok) {
                throw new Error(`Multiauth health returned ${response.status}.`);
            }
        }
        catch (error) {
            const message = `Multiauth is not reachable at ${MULTIAUTH_BASE_URL}. ${getErrorMessage(error)}`;
            this.pendingLogin = null;
            this.setState({ ...this.state, status: 'error', message });
            console.error('[auth] login-preflight-failed', { healthUrl, message });
            throw new Error(message);
        }
    }
    async closeCallbackServer() {
        const server = this.callbackServer;
        this.callbackServer = null;
        await server?.close();
    }
    async readSessionFromEntitlements(entitlements) {
        if (this.state.authenticated && this.state.selectedOrganization?.id === entitlements.organizationId) {
            return {
                authenticated: true,
                user: this.state.user,
                selectedOrganization: this.state.selectedOrganization,
                entitlements,
            };
        }
        return {
            authenticated: true,
            user: {
                id: entitlements.userId,
                email: null,
                displayName: null,
            },
            selectedOrganization: {
                id: entitlements.organizationId,
                name: entitlements.organizationId,
                slug: entitlements.organizationId,
                type: 'team',
            },
            entitlements,
        };
    }
    get cachePath() {
        return join(app.getPath('userData'), 'multiauth-entitlements-cache.json');
    }
    async readCachedEntitlements() {
        try {
            const payload = JSON.parse(await readFile(this.cachePath, 'utf8'));
            if (!payload.snapshot || typeof payload.lastRefreshAt !== 'string')
                return null;
            if (!isEntitlementSnapshot(payload.snapshot, MULTICODE_PRODUCT))
                return null;
            return {
                snapshot: payload.snapshot,
                lastRefreshAt: payload.lastRefreshAt,
            };
        }
        catch {
            return null;
        }
    }
    async writeCachedEntitlements(cache) {
        await mkdir(dirname(this.cachePath), { recursive: true });
        await writeFile(this.cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
    }
    setState(state) {
        this.state = state;
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
                win.webContents.send('auth:state-changed', state);
            }
        }
    }
}
async function startDesktopCallbackServer(onCallback) {
    let closed = false;
    const server = createServer((request, response) => {
        void (async () => {
            const callbackUrl = new URL(request.url ?? '/', MULTICODE_LOOPBACK_REDIRECT_URI);
            if (request.method !== 'GET' || callbackUrl.pathname !== '/callback') {
                response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
                response.end('Not found.');
                return;
            }
            try {
                await onCallback(callbackUrl.toString());
                response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                response.end(callbackSuccessHtml());
            }
            catch (error) {
                for (const win of BrowserWindow.getAllWindows()) {
                    if (!win.isDestroyed()) {
                        win.webContents.send('auth:callback-error', getErrorMessage(error));
                    }
                }
                response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
                response.end(callbackErrorHtml(getErrorMessage(error)));
            }
            finally {
                void closeServer(server);
            }
        })();
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(MULTICODE_LOOPBACK_PORT, MULTICODE_LOOPBACK_HOST, () => {
            server.off('error', reject);
            resolve();
        });
    }).catch((error) => {
        throw new Error(`Could not start Multicode auth callback listener on ${MULTICODE_LOOPBACK_REDIRECT_URI}: ${getErrorMessage(error)}`);
    });
    return {
        async close() {
            if (closed)
                return;
            closed = true;
            await closeServer(server);
        },
    };
}
async function closeServer(server) {
    if (!server.listening)
        return;
    await new Promise((resolve) => server.close(() => resolve()));
}
function isSupportedAuthCallbackUrl(url) {
    return (url.protocol === 'http:' && url.hostname === MULTICODE_LOOPBACK_HOST && url.port === String(MULTICODE_LOOPBACK_PORT) && url.pathname === '/callback')
        || (url.protocol === 'multicode:' && url.hostname === 'auth' && url.pathname === '/callback');
}
function callbackSuccessHtml() {
    return '<!doctype html><meta charset="utf-8"><title>Multicode sign-in complete</title><body style="font:14px system-ui,sans-serif;background:#101012;color:#f4f4f5;padding:32px">Sign-in is complete. You can return to Multicode.</body>';
}
function callbackErrorHtml(message) {
    const escaped = message.replace(/[&<>"']/gu, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[char] ?? char));
    return `<!doctype html><meta charset="utf-8"><title>Multicode sign-in failed</title><body style="font:14px system-ui,sans-serif;background:#101012;color:#f4f4f5;padding:32px">Sign-in failed: ${escaped}</body>`;
}
function signedOutAuthState(message) {
    return {
        authenticated: false,
        user: null,
        selectedOrganization: null,
        entitlements: null,
        status: 'signed_out',
        entitlementStatus: 'missing',
        message,
        lastRefreshAt: null,
        graceExpiresAt: null,
    };
}
function randomBase64Url(byteLength) {
    return randomBytes(byteLength).toString('base64url');
}
function pkceChallenge(codeVerifier) {
    return createHash('sha256').update(codeVerifier).digest('base64url');
}
function readMultiauthErrorMessage(payload) {
    if (!payload || typeof payload !== 'object')
        return 'Multiauth request failed.';
    const error = payload.error;
    if (!error || typeof error !== 'object')
        return 'Multiauth request failed.';
    const message = error.message;
    return typeof message === 'string' && message.trim() ? message : 'Multiauth request failed.';
}
export async function parseAuthCallbackFromArgv(auth, argv) {
    const callbackUrl = argv.find((arg) => /^multicode:\/\/auth\/callback/i.test(arg) || /^http:\/\/127\.0\.0\.1:43110\/callback/i.test(arg));
    if (!callbackUrl)
        return;
    try {
        await auth.handleCallback(callbackUrl);
    }
    catch (error) {
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
                win.webContents.send('auth:callback-error', getErrorMessage(error));
            }
        }
    }
}
