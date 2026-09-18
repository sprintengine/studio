import { app, BrowserWindow, safeStorage, shell } from 'electron'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { createHash, randomBytes } from 'crypto'
import { createServer, type Server } from 'http'
import { dirname, join } from 'path'
import type { EntitlementSnapshot, MulticodeAuthState, SessionSnapshot, SessionUser } from '../shared/electron-api'
import { AccountPhotoCache } from './account-photo-cache'
import { CURRENT_DEEP_LINK_SCHEME, DEEP_LINK_SCHEMES, LEGACY_DEEP_LINK_SCHEME } from './deep-link-scheme'
import {
  ENTITLEMENT_GRACE_MS,
  ENTITLEMENT_MAX_CACHE_AGE_MS,
  EntitlementService,
  entitlementCacheStatus,
  entitlementGraceExpiresAt,
  isEntitlementSnapshot,
  offlineGraceMessage,
  type CachedEntitlementSnapshot,
} from './entitlement-service'
import {
  CLERK_IDENTITY_PROVIDER,
  IDENTITY_MARKER_FILE_NAME,
  MULTIAUTH_IDENTITY_PROVIDER,
  REFRESH_TOKEN_FILE_NAMES,
  buildClerkAuthorizationUrl,
  buildMultiauthAuthorizationUrl,
  isIdentityProviderKind,
  parseClerkIdentityConfig,
  type IdentityConfig,
} from './desktop-identity'
import {
  MulticodeAccountClient,
  parseAccountProfile,
  type AccountProfile,
  type IdentityMarker,
  type IdentityMarkerStore,
  type SecureRefreshTokenStore,
} from './account-client'
import { getErrorMessage } from './error-message'
import { DEFAULT_MULTIAUTH_BASE_URL } from './service-endpoints'
import { readStudioEnv } from '../shared/studio-env'

// `MULTIAUTH_BASE_URL` names the studio's ACCOUNT SERVICE: where entitlement
// snapshots come from and where the mobile relay lives. It is no longer, by
// definition, the identity provider (MC-2183): the service publishes which
// issuer a sign-in should go to at `/api/auth/identity` — itself on a
// self-hosted deployment, Clerk on the hosted one — and this bridge follows.
// The environment variable keeps its historical name so existing overrides
// (`MULTIAUTH_BASE_URL=http://localhost:3000` for local dev) keep working.
// The default it falls back to is set in `./service-endpoints`, where a build
// can bake in a different deployment via the same `MULTIAUTH_BASE_URL` name.
const MULTIAUTH_BASE_URL = (process.env['MULTIAUTH_BASE_URL'] || DEFAULT_MULTIAUTH_BASE_URL).replace(/\/+$/u, '')
const DESKTOP_CLIENT_ID = 'multicode-desktop' as const
const LOOPBACK_HOST = '127.0.0.1' as const
const LOOPBACK_PORT = 43110
const LOOPBACK_REDIRECT_URI = `http://${LOOPBACK_HOST}:${LOOPBACK_PORT}/callback` as const
// What a custom-scheme sign-in asks the issuer to redirect to. Unlike the rest
// of the rename this half is not ours alone: a redirect_uri has to be on the
// issuer's registered list for the client or the authorization request is
// refused outright, so `SPRINTENGINE_AUTH_REDIRECT_MODE=custom` needs this
// spelling registered before it works. Loopback, the default, is unaffected.
const CUSTOM_SCHEME_REDIRECT_URI = `${CURRENT_DEEP_LINK_SCHEME}://auth/callback` as const
// The same callback under the scheme the app shipped under before the
// 2026-09-08 rename. A constant of its own rather than folded into the one
// above because the token exchange has to echo back the *exact* redirect_uri
// the authorization request carried (RFC 6749 §4.1.3) — so a callback that
// arrives on the old scheme has to be exchanged with the old spelling, and
// guessing from the mode this process would pick now would get it wrong.
const LEGACY_CUSTOM_SCHEME_REDIRECT_URI = `${LEGACY_DEEP_LINK_SCHEME}://auth/callback` as const
// Loopback for packaged builds too (MC-2183). The custom scheme is bound by
// macOS LaunchServices to whichever Electron bundle registered it last — a
// released build beside a beta is enough to send the callback to the wrong
// app — while RFC 8252 loopback has no such ambiguity. The custom scheme stays
// registered and reachable with `SPRINTENGINE_AUTH_REDIRECT_MODE=custom` for the
// one case loopback loses: the port being occupied.
const DEFAULT_AUTH_REDIRECT_MODE = 'loopback'
const CONFIGURED_AUTH_REDIRECT_MODE = readStudioEnv('SPRINTENGINE_AUTH_REDIRECT_MODE')
const AUTH_REDIRECT_MODE =
  CONFIGURED_AUTH_REDIRECT_MODE === 'custom' || CONFIGURED_AUTH_REDIRECT_MODE === 'loopback'
    ? CONFIGURED_AUTH_REDIRECT_MODE
    : DEFAULT_AUTH_REDIRECT_MODE
const REDIRECT_URI: typeof CUSTOM_SCHEME_REDIRECT_URI | typeof LOOPBACK_REDIRECT_URI =
  AUTH_REDIRECT_MODE === 'loopback' ? LOOPBACK_REDIRECT_URI : CUSTOM_SCHEME_REDIRECT_URI
const PRODUCT_KEY = 'multicode' as const
const MULTIAUTH_DESKTOP_SCOPE = 'openid profile entitlements:read relay:desktop'
const AUTH_PREFLIGHT_TIMEOUT_MS = 3000
const ACCOUNT_SERVICE_LABEL = 'The Multicode account service'

type ElectronRendererAuthState = Pick<
  MulticodeAuthState,
  'authenticated' | 'user' | 'selectedOrganization' | 'entitlements'
>

type PendingDesktopLogin = {
  state: string
  nonce: string
  codeVerifier: string
  organizationId: string | null
  identity: IdentityConfig
  createdAt: number
}

type DesktopCallbackServer = {
  close(): Promise<void>
}

class ElectronSafeRefreshTokenStore implements SecureRefreshTokenStore {
  private inMemoryRefreshToken: string | null = null

  constructor(private readonly fileName: string) {}

  private get tokenPath(): string {
    return join(app.getPath('userData'), this.fileName)
  }

  async readRefreshToken(): Promise<string | null> {
    if (this.inMemoryRefreshToken) return this.inMemoryRefreshToken
    if (!safeStorage.isEncryptionAvailable()) return null

    try {
      const encrypted = await readFile(this.tokenPath)
      const refreshToken = safeStorage.decryptString(encrypted)
      this.inMemoryRefreshToken = refreshToken
      return refreshToken
    } catch {
      return null
    }
  }

  async writeRefreshToken(refreshToken: string): Promise<void> {
    this.inMemoryRefreshToken = refreshToken
    if (!safeStorage.isEncryptionAvailable()) return

    await mkdir(dirname(this.tokenPath), { recursive: true })
    await writeFile(this.tokenPath, safeStorage.encryptString(refreshToken), { mode: 0o600 })
  }

  async clearRefreshToken(): Promise<void> {
    this.inMemoryRefreshToken = null
    await unlink(this.tokenPath).catch(() => {})
  }
}

class ElectronIdentityMarkerStore implements IdentityMarkerStore {
  private get markerPath(): string {
    return join(app.getPath('userData'), IDENTITY_MARKER_FILE_NAME)
  }

  async read(): Promise<IdentityMarker | null> {
    try {
      const payload = JSON.parse(await readFile(this.markerPath, 'utf8')) as Partial<IdentityMarker>
      if (!isIdentityProviderKind(payload.provider)) return null
      const shared = {
        baseUrl: typeof payload.baseUrl === 'string' ? payload.baseUrl : undefined,
        organizationId:
          typeof payload.organizationId === 'string' && payload.organizationId.trim() ? payload.organizationId : null,
      }
      if (payload.provider === CLERK_IDENTITY_PROVIDER) {
        // Re-validated, not trusted: this file is plain JSON beside a
        // safeStorage-protected refresh token, and it names where that
        // token is POSTed on the next launch.
        const clerk = parseClerkIdentityConfig(payload.clerk)
        return clerk ? { provider: CLERK_IDENTITY_PROVIDER, clerk, ...shared } : null
      }
      return { provider: MULTIAUTH_IDENTITY_PROVIDER, ...shared }
    } catch {
      return null
    }
  }

  async write(marker: IdentityMarker): Promise<void> {
    await mkdir(dirname(this.markerPath), { recursive: true })
    await writeFile(this.markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  async clear(): Promise<void> {
    await unlink(this.markerPath).catch(() => {})
  }
}

export class MulticodeAuthBridge {
  private readonly client = new MulticodeAccountClient({
    baseUrl: MULTIAUTH_BASE_URL,
    clientId: DESKTOP_CLIENT_ID,
    product: PRODUCT_KEY,
    refreshTokenStores: {
      multiauth: new ElectronSafeRefreshTokenStore(REFRESH_TOKEN_FILE_NAMES.multiauth),
      clerk: new ElectronSafeRefreshTokenStore(REFRESH_TOKEN_FILE_NAMES.clerk),
    },
    identityMarker: new ElectronIdentityMarkerStore(),
    env: process.env,
    fetch,
    log: (event, data) => {
      if (event.includes('failed') || event.includes('invalid')) console.warn(`[auth] ${event}`, data ?? {})
      else console.info(`[auth] ${event}`, data ?? {})
    },
  })
  private state: MulticodeAuthState = signedOutAuthState('Checking account.')
  private pendingLogin: PendingDesktopLogin | null = null
  private callbackServer: DesktopCallbackServer | null = null
  private cachedEntitlements: CachedEntitlementSnapshot | null = null
  // The account profile (name, email, remote photo URL) behind the cached
  // entitlements, so an offline boot shows who is signed in — and, through
  // the photo cache, their photo — rather than a blank badge (MC-2220).
  private cachedAccount: AccountProfile | null = null
  private photoRefreshInFlight: string | null = null
  private readonly photoCache = new AccountPhotoCache({
    cachePath: () => join(app.getPath('userData'), 'multiauth-account-photo.json'),
  })

  // This bridge is the account-service ADAPTER behind the entitlement seam. It
  // answers the two questions `EntitlementProvider` asks and knows nothing
  // about how a decision is reached; every gate in the app goes through
  // `entitlements`, so nothing above this class knows which issuer signed the
  // session in — that is what let the identity provider move (MC-2183)
  // without a caller changing.
  readonly entitlements = new EntitlementService(
    {
      read: () => ({
        authenticated: this.state.authenticated,
        snapshot: this.state.entitlements,
        cache: this.cachedEntitlements,
        lastRefreshAt: this.state.lastRefreshAt,
      }),
      refresh: async () => {
        await this.refreshEntitlements({ forceRefresh: true })
      },
    },
    {
      product: PRODUCT_KEY,
      graceMs: ENTITLEMENT_GRACE_MS,
      maxCacheAgeMs: ENTITLEMENT_MAX_CACHE_AGE_MS,
    },
  )

  async initialize(): Promise<MulticodeAuthState> {
    this.setState({ ...this.state, status: 'checking', message: 'Checking account.' })

    try {
      await this.client.resumeStoredSession()
      return this.refreshEntitlements({ forceRefresh: true })
    } catch {
      const cache = this.cachedEntitlements ?? (await this.readCachedEntitlements())
      this.cachedEntitlements = cache
      if (cache) {
        const entitlementStatus = entitlementCacheStatus(cache)
        const graceExpiresAt = entitlementGraceExpiresAt(cache)
        const account = await this.readOfflineAccount(cache.snapshot)
        this.setState({
          ...this.state,
          ...account,
          status: 'signed_in',
          authenticated: true,
          entitlements: cache.snapshot,
          entitlementStatus,
          message:
            entitlementStatus === 'offline_grace'
              ? offlineGraceMessage(graceExpiresAt)
              : 'Sign in again to refresh Multicode access.',
          lastRefreshAt: cache.lastRefreshAt,
          graceExpiresAt,
        })
        return this.state
      }

      this.setState(signedOutAuthState(null))
      return this.state
    }
  }

  getState(): MulticodeAuthState {
    return this.state
  }

  async login(organizationId?: string | null): Promise<{ state: string; authorizationUrl: string }> {
    await this.preflightAuthServer()
    const identity = await this.resolveIdentityForLogin()
    await this.closeCallbackServer()

    const state = randomBase64Url(24)
    const nonce = randomBase64Url(24)
    const codeVerifier = randomBase64Url(48)
    const codeChallenge = pkceChallenge(codeVerifier)
    const selectedOrganizationId = organizationId?.trim() || this.state.selectedOrganization?.id
    const request = {
      redirectUri: REDIRECT_URI,
      codeChallenge,
      state,
      nonce,
      organizationId: selectedOrganizationId ?? null,
    }
    const authorizationUrl =
      identity.provider === CLERK_IDENTITY_PROVIDER
        ? buildClerkAuthorizationUrl(request, identity)
        : buildMultiauthAuthorizationUrl(request, {
            baseUrl: MULTIAUTH_BASE_URL,
            clientId: DESKTOP_CLIENT_ID,
            product: PRODUCT_KEY,
            scope: MULTIAUTH_DESKTOP_SCOPE,
          })

    if (REDIRECT_URI === LOOPBACK_REDIRECT_URI) {
      try {
        this.callbackServer = await startDesktopCallbackServer(async (callbackUrl) => {
          await this.handleCallback(callbackUrl)
        })
      } catch (error) {
        const message = getErrorMessage(error)
        this.setState({ ...this.state, status: 'error', message })
        throw new Error(message)
      }
    }

    this.pendingLogin = {
      state,
      nonce,
      codeVerifier,
      organizationId: selectedOrganizationId ?? null,
      identity,
      createdAt: Date.now(),
    }
    try {
      await shell.openExternal(authorizationUrl)
    } catch (error) {
      this.pendingLogin = null
      await this.closeCallbackServer()
      const message = `Could not open sign-in: ${getErrorMessage(error)}`
      this.setState({ ...this.state, status: 'error', message })
      console.error('[auth] login-open-failed', { authorizationUrl, message })
      throw new Error(message)
    }

    this.setState({ ...this.state, message: 'Complete sign-in in your browser.' })
    console.info('[auth] login-started', {
      provider: identity.provider,
      authorizationUrl,
      organizationId: selectedOrganizationId ?? null,
    })

    return { state, authorizationUrl }
  }

  async handleCallback(callbackUrl: string): Promise<MulticodeAuthState> {
    const url = new URL(callbackUrl)
    if (!isSupportedAuthCallbackUrl(url)) {
      throw new Error('Unsupported sign-in callback URL.')
    }

    const state = url.searchParams.get('state')
    const pending = this.pendingLogin
    if (!state || !pending || pending.state !== state) {
      throw new Error('Desktop sign-in state did not match.')
    }

    // The issuer's refusal, carried back on the redirect. Only acted on for
    // the sign-in it belongs to — the state check above — so nothing that can
    // reach the loopback port cancels a pending sign-in with a bare `error=`.
    const oauthError = url.searchParams.get('error')
    if (oauthError) {
      this.pendingLogin = null
      const description = url.searchParams.get('error_description')
      throw new Error(description ? `${oauthError}: ${description}` : `Sign-in was refused: ${oauthError}`)
    }

    const code = url.searchParams.get('code')
    if (!code) {
      throw new Error('Desktop sign-in callback carried no authorization code.')
    }

    if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
      this.pendingLogin = null
      throw new Error('Desktop sign-in expired. Start sign-in again.')
    }

    await this.client.exchangeCode({
      identity: pending.identity,
      redirectUri: customSchemeRedirectUriFor(url) ?? LOOPBACK_REDIRECT_URI,
      code,
      codeVerifier: pending.codeVerifier,
    })
    this.pendingLogin = null
    if (customSchemeRedirectUriFor(url)) {
      // The callback came in over the OS rather than the loopback listener, so
      // the listener (if `beginLogin` opened one) has nothing left to answer.
      await this.closeCallbackServer()
    }
    if (pending.organizationId) {
      await this.client.selectOrganization(pending.organizationId)
    }

    return this.refreshEntitlements({ forceRefresh: true })
  }

  async logout(): Promise<{ loggedOut: true }> {
    const result = await this.client.logout()
    this.pendingLogin = null
    await this.closeCallbackServer()
    this.cachedEntitlements = null
    this.cachedAccount = null
    await unlink(this.cachePath).catch(() => {})
    await unlink(this.accountCachePath).catch(() => {})
    await this.photoCache.clear()
    this.setState(signedOutAuthState(null))
    return result
  }

  async selectOrganization(organizationId: string): Promise<{ organizationId: string }> {
    const result = await this.client.selectOrganization(organizationId)
    await this.refreshEntitlements({ forceRefresh: true })
    return result
  }

  async refreshEntitlements(options: { forceRefresh?: boolean } = {}): Promise<MulticodeAuthState> {
    try {
      const entitlements = await this.client.getEntitlements({ forceRefresh: options.forceRefresh ?? true })
      const session = await this.readSessionFromEntitlements(entitlements)
      const cache = {
        snapshot: entitlements,
        lastRefreshAt: new Date().toISOString(),
      }

      this.cachedEntitlements = cache
      await this.writeCachedEntitlements(cache)
      // Same ladder the seam gates on, so a snapshot that arrives already past
      // its expiry is published as `offline_grace` here and read as
      // `offline_grace` there — the state and the decisions cannot disagree.
      const entitlementStatus = entitlementCacheStatus(cache)
      const graceExpiresAt = entitlementGraceExpiresAt(cache)
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
      })
    } catch (error) {
      const cache = this.cachedEntitlements ?? (await this.readCachedEntitlements())
      this.cachedEntitlements = cache
      if (cache) {
        const entitlementStatus = entitlementCacheStatus(cache)
        const graceExpiresAt = entitlementGraceExpiresAt(cache)
        const account = await this.readOfflineAccount(cache.snapshot)
        this.setState({
          ...this.state,
          ...account,
          authenticated: true,
          entitlements: cache.snapshot,
          status: 'signed_in',
          entitlementStatus,
          message: entitlementStatus === 'offline_grace' ? offlineGraceMessage(graceExpiresAt) : getErrorMessage(error),
          lastRefreshAt: cache.lastRefreshAt,
          graceExpiresAt,
        })
        return this.state
      }

      this.setState({
        ...signedOutAuthState(getErrorMessage(error)),
        status: this.state.authenticated ? 'error' : 'signed_out',
      })
    }

    return this.state
  }

  async getSession(): Promise<SessionSnapshot> {
    if (!this.state.authenticated || !this.state.user || !this.state.selectedOrganization) {
      return { authenticated: false, user: null, selectedOrganization: null }
    }

    return {
      authenticated: true,
      user: this.state.user,
      selectedOrganization: this.state.selectedOrganization,
      session: {
        id: 'desktop',
        expiresAt: this.state.entitlements?.expiresAt ?? new Date(0).toISOString(),
      },
    }
  }

  // The relay is part of the account service and accepts whichever issuer's
  // token the session holds (MC-2185), so this stays provider-blind.
  async getRelayAccessToken(): Promise<string | null> {
    try {
      return await this.client.getAccessToken()
    } catch {
      return null
    }
  }

  async openUpgrade(reason?: string): Promise<{ opened: true; url: string }> {
    const search = new URLSearchParams({
      returnTo: 'checkout',
      product: PRODUCT_KEY,
    })

    if (reason?.trim()) search.set('reason', reason.trim())
    if (this.state.selectedOrganization?.id) {
      search.set('organizationId', this.state.selectedOrganization.id)
    }

    const url = `${MULTIAUTH_BASE_URL}/?${search.toString()}`
    await shell.openExternal(url)
    return { opened: true, url }
  }

  // Which issuer this sign-in goes to: the operator override if set, else
  // whatever the account service publishes. Discovery failure is explicit —
  // guessing an issuer would send the user to the wrong sign-in page — and
  // so is a malformed override, since the operator asked for something.
  private async resolveIdentityForLogin(): Promise<IdentityConfig> {
    try {
      return await this.client.resolveIdentityForLogin()
    } catch (error) {
      const message = `${ACCOUNT_SERVICE_LABEL} could not say which sign-in to use. ${getErrorMessage(error)}`
      this.pendingLogin = null
      this.setState({ ...this.state, status: 'error', message })
      console.error('[auth] identity-discovery-failed', { message })
      throw new Error(message)
    }
  }

  private async preflightAuthServer(): Promise<void> {
    const healthUrl = `${MULTIAUTH_BASE_URL}/api/health`

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), AUTH_PREFLIGHT_TIMEOUT_MS)
      const response = await fetch(healthUrl, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout))

      if (!response.ok) {
        throw new Error(`Account service health returned ${response.status}.`)
      }
    } catch (error) {
      const message = `${ACCOUNT_SERVICE_LABEL} is not reachable at ${MULTIAUTH_BASE_URL}. ${getErrorMessage(error)}`
      this.pendingLogin = null
      this.setState({ ...this.state, status: 'error', message })
      console.error('[auth] login-preflight-failed', { healthUrl, message })
      throw new Error(message)
    }
  }

  private async closeCallbackServer(): Promise<void> {
    const server = this.callbackServer
    this.callbackServer = null
    await server?.close()
  }

  private async readSessionFromEntitlements(entitlements: EntitlementSnapshot): Promise<ElectronRendererAuthState> {
    // The entitlement snapshot names the user and organization by id only.
    // Who they are — name, email, photo — comes from the profile call, made
    // on every refresh so a changed photo or name follows the provider.
    const account = await this.fetchAccount(entitlements)
    if (account) {
      // Publish with whatever the photo cache holds — the cached bytes, or
      // nothing — and fetch on the side. The avatar host is not Multiauth:
      // a blocked or stalled CDN must not hold the account state (or the
      // browser's "sign-in complete" page) for the fetch timeout.
      const photoUrl = await this.photoCache.resolve(account.user.avatarUrl, { allowNetwork: false })
      if (await this.photoCache.needsFetch(account.user.avatarUrl)) {
        this.refreshPhotoInBackground(account.user)
      }
      return {
        authenticated: true,
        user: toSessionUser(account.user, photoUrl),
        selectedOrganization: account.selectedOrganization,
        entitlements,
      }
    }

    // No profile this time (a Multiauth without `/api/auth/me`, or a request
    // that failed on its own): keep the identity already on screen, else the
    // one cached from an earlier session, else the ids alone.
    if (
      this.state.authenticated &&
      this.state.user &&
      this.state.selectedOrganization?.id === entitlements.organizationId
    ) {
      return {
        authenticated: true,
        user: this.state.user,
        selectedOrganization: this.state.selectedOrganization,
        entitlements,
      }
    }

    return {
      authenticated: true,
      ...(await this.readOfflineAccount(entitlements)),
      entitlements,
    }
  }

  // Fetches (or refreshes) the photo and re-publishes the state with it once
  // it lands, if the same user is still signed in. One fetch per source URL
  // at a time; a failure leaves the published photo as it was.
  private refreshPhotoInBackground(user: AccountProfile['user']): void {
    const sourceUrl = user.avatarUrl
    if (!sourceUrl || this.photoRefreshInFlight === sourceUrl) return
    this.photoRefreshInFlight = sourceUrl
    void this.photoCache
      .resolve(sourceUrl)
      .then((photoUrl) => {
        const current = this.state.user
        if (
          !photoUrl ||
          !this.state.authenticated ||
          !current ||
          current.id !== user.id ||
          current.photoUrl === photoUrl
        ) {
          return
        }
        this.setState({ ...this.state, user: { ...current, photoUrl } })
      })
      .catch((error) => {
        console.warn('[auth] account-photo-refresh-failed', { message: getErrorMessage(error) })
      })
      .finally(() => {
        if (this.photoRefreshInFlight === sourceUrl) this.photoRefreshInFlight = null
      })
  }

  private async fetchAccount(entitlements: EntitlementSnapshot): Promise<AccountProfile | null> {
    try {
      const profile = await this.client.getProfile()
      if (profile.user.id !== entitlements.userId || profile.selectedOrganization.id !== entitlements.organizationId) {
        console.warn('[auth] account-profile-mismatch', {
          profileUserId: profile.user.id,
          entitlementUserId: entitlements.userId,
        })
        return null
      }
      this.cachedAccount = profile
      await this.writeCachedAccount(profile)
      return profile
    } catch (error) {
      console.info('[auth] account-profile-unavailable', { message: getErrorMessage(error) })
      return null
    }
  }

  // The user and organization to publish when the server cannot be asked:
  // what is already on screen, else the cached profile (photo from the local
  // cache only — no network), else the ids the entitlement snapshot carries.
  private async readOfflineAccount(
    entitlements: EntitlementSnapshot,
  ): Promise<Pick<MulticodeAuthState, 'user' | 'selectedOrganization'>> {
    if (this.state.user && this.state.selectedOrganization?.id === entitlements.organizationId) {
      return { user: this.state.user, selectedOrganization: this.state.selectedOrganization }
    }

    const cached = this.cachedAccount ?? (await this.readCachedAccount())
    if (
      cached &&
      cached.user.id === entitlements.userId &&
      cached.selectedOrganization.id === entitlements.organizationId
    ) {
      this.cachedAccount = cached
      const photoUrl = await this.photoCache.resolve(cached.user.avatarUrl, { allowNetwork: false })
      return { user: toSessionUser(cached.user, photoUrl), selectedOrganization: cached.selectedOrganization }
    }

    return {
      user: {
        id: entitlements.userId,
        email: null,
        displayName: null,
        photoUrl: null,
      },
      selectedOrganization: {
        id: entitlements.organizationId,
        name: entitlements.organizationId,
        slug: entitlements.organizationId,
        type: 'team',
      },
    }
  }

  private get cachePath(): string {
    return join(app.getPath('userData'), 'multiauth-entitlements-cache.json')
  }

  private get accountCachePath(): string {
    return join(app.getPath('userData'), 'multiauth-account-cache.json')
  }

  private async readCachedAccount(): Promise<AccountProfile | null> {
    try {
      return parseAccountProfile(JSON.parse(await readFile(this.accountCachePath, 'utf8')))
    } catch {
      return null
    }
  }

  private async writeCachedAccount(profile: AccountProfile): Promise<void> {
    try {
      await mkdir(dirname(this.accountCachePath), { recursive: true })
      await writeFile(this.accountCachePath, `${JSON.stringify(profile, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      console.warn('[auth] account-cache-write-failed', { message: getErrorMessage(error) })
    }
  }

  private async readCachedEntitlements(): Promise<CachedEntitlementSnapshot | null> {
    try {
      const payload = JSON.parse(await readFile(this.cachePath, 'utf8')) as Partial<CachedEntitlementSnapshot>
      if (!payload.snapshot || typeof payload.lastRefreshAt !== 'string') return null
      if (!isEntitlementSnapshot(payload.snapshot, PRODUCT_KEY)) return null
      return {
        snapshot: payload.snapshot,
        lastRefreshAt: payload.lastRefreshAt,
      }
    } catch {
      return null
    }
  }

  private async writeCachedEntitlements(cache: CachedEntitlementSnapshot): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true })
    await writeFile(this.cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
  }

  private setState(state: MulticodeAuthState): void {
    this.state = state
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('auth:state-changed', state)
      }
    }
  }
}

async function startDesktopCallbackServer(
  onCallback: (callbackUrl: string) => Promise<void>,
): Promise<DesktopCallbackServer> {
  let closed = false
  const server = createServer((request, response) => {
    void (async () => {
      const callbackUrl = new URL(request.url ?? '/', LOOPBACK_REDIRECT_URI)

      if (request.method !== 'GET' || callbackUrl.pathname !== '/callback') {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Not found.')
        return
      }

      try {
        await onCallback(callbackUrl.toString())
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(callbackSuccessHtml())
      } catch (error) {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('auth:callback-error', getErrorMessage(error))
          }
        }
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        response.end(callbackErrorHtml(getErrorMessage(error)))
      } finally {
        void closeServer(server)
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(LOOPBACK_PORT, LOOPBACK_HOST, () => {
      server.off('error', reject)
      resolve()
    })
  }).catch((error) => {
    throw new Error(
      `Could not start the sign-in callback listener on ${LOOPBACK_REDIRECT_URI}: ${getErrorMessage(error)}`,
    )
  })

  return {
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await closeServer(server)
    },
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

// Null for anything that is not one of the app's own schemes — loopback
// included — so callers can use it both as "which redirect_uri does this
// callback belong to" and as "did this arrive over the OS".
function customSchemeRedirectUriFor(
  url: URL,
): typeof CUSTOM_SCHEME_REDIRECT_URI | typeof LEGACY_CUSTOM_SCHEME_REDIRECT_URI | null {
  if (url.protocol === `${CURRENT_DEEP_LINK_SCHEME}:`) return CUSTOM_SCHEME_REDIRECT_URI
  if (url.protocol === `${LEGACY_DEEP_LINK_SCHEME}:`) return LEGACY_CUSTOM_SCHEME_REDIRECT_URI
  return null
}

function isSupportedAuthCallbackUrl(url: URL): boolean {
  return (
    (url.protocol === 'http:' &&
      url.hostname === LOOPBACK_HOST &&
      url.port === String(LOOPBACK_PORT) &&
      url.pathname === '/callback') ||
    (customSchemeRedirectUriFor(url) !== null && url.hostname === 'auth' && url.pathname === '/callback')
  )
}

function callbackSuccessHtml(): string {
  return '<!doctype html><meta charset="utf-8"><title>Multicode sign-in complete</title><body style="font:14px system-ui,sans-serif;background:#101012;color:#f4f4f5;padding:32px">Sign-in is complete. You can return to Multicode.</body>'
}

function callbackErrorHtml(message: string): string {
  const escaped = message.replace(
    /[&<>"']/gu,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char] ?? char,
  )
  return `<!doctype html><meta charset="utf-8"><title>Multicode sign-in failed</title><body style="font:14px system-ui,sans-serif;background:#101012;color:#f4f4f5;padding:32px">Sign-in failed: ${escaped}</body>`
}

function toSessionUser(user: AccountProfile['user'], photoUrl: string | null): SessionUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    photoUrl,
  }
}

function signedOutAuthState(message: string | null): MulticodeAuthState {
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
  }
}

function randomBase64Url(byteLength: number): string {
  return randomBytes(byteLength).toString('base64url')
}

function pkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url')
}

// Picked out of the raw command line rather than parsed, because a
// second-instance relaunch hands over every argument the OS launched with and
// most of them are not URLs. Case-folded first: a scheme is case-insensitive
// and nothing guarantees which case the OS hands back.
function isAuthCallbackArg(arg: string): boolean {
  const lowered = arg.toLowerCase()
  return (
    DEEP_LINK_SCHEMES.some((scheme) => lowered.startsWith(`${scheme}://auth/callback`)) ||
    lowered.startsWith(LOOPBACK_REDIRECT_URI)
  )
}

export async function parseAuthCallbackFromArgv(auth: MulticodeAuthBridge, argv: string[]): Promise<void> {
  const callbackUrl = argv.find(isAuthCallbackArg)
  if (!callbackUrl) return

  try {
    await auth.handleCallback(callbackUrl)
  } catch (error) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('auth:callback-error', getErrorMessage(error))
      }
    }
  }
}
