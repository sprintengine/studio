import { app, shell, BrowserWindow, ipcMain, dialog, Menu, safeStorage } from 'electron'
import { existsSync, mkdirSync, watch, writeFileSync, type FSWatcher } from 'fs'
import { access, appendFile, chmod, cp, lstat, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'path'
import { createHash, randomBytes } from 'crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { autoUpdater } from 'electron-updater'
import { rgPath } from '@vscode/ripgrep'
import * as pty from 'node-pty'
import {
  commitGitChanges,
  copyGitWorktreeIncludedFiles,
  createGitWorktree,
  discardUnstagedGitChanges,
  getGitBranches,
  getGitFileBase,
  getGitHistory,
  getGitRepoRoot,
  getGitStatus,
  listGitWorktrees,
  pruneGitWorktrees,
  removeGitWorktree,
  repairGitWorktrees,
  pushGitBranch,
  revertGitPaths,
  stageGitPaths,
  switchGitBranch,
  unstageGitPaths,
} from './git'
import {
  MobileBridge,
  type MobileBridgePresence,
  type MobileBridgeSettingsUpdate,
} from './mobile-bridge'
import { MobileSwarmCommandService } from './mobile-swarm-command'
import { DesktopMobileSwarmSessionOrchestrator } from './mobile-swarm-session'
import { MobileSwarmSnapshotService } from './mobile-swarm-snapshot'

const MULTIAUTH_BASE_URL = (process.env['MULTIAUTH_BASE_URL'] || 'http://localhost:3000').replace(/\/+$/u, '')
const MULTICODE_CLIENT_ID = 'multicode-desktop' as const
const MULTICODE_REDIRECT_URI = 'multicode://auth/callback' as const
const MULTICODE_PRODUCT = 'multicode' as const
const ENTITLEMENT_GRACE_MS = 72 * 60 * 60 * 1000
const MULTICODE_DIAGNOSTICS = process.env['MULTICODE_DIAGNOSTICS'] === '1'
const DIAGNOSTIC_SLOW_IPC_MS = 250

type FeatureValue = boolean | number | string

type SessionUser = {
  id: string
  email: string | null
  displayName: string | null
}

type SessionOrganization = {
  id: string
  name: string
  slug: string
  type: 'personal' | 'team' | 'enterprise'
}

type SessionSnapshot =
  | {
    authenticated: true
    user: SessionUser
    selectedOrganization: SessionOrganization
    session: {
      id: string
      expiresAt: string
    }
  }
  | {
    authenticated: false
    user: null
    selectedOrganization: null
  }

type EntitlementSnapshot = {
  userId: string
  organizationId: string
  product: 'multicode'
  roles: string[]
  features: Record<string, FeatureValue>
  limits: Record<string, number>
  sources: Record<string, string>
  plan: {
    code: string
    status: string
  }
  issuedAt: string
  expiresAt: string
  schemaVersion: 1
}

type UsageRequest = {
  featureKey: string
  amount?: number
  actorType?: 'user' | 'organization' | 'api_key'
  actorId?: string
  idempotencyKey: string
  window?: 'day' | 'month'
}

type UsageResult = {
  allowed: boolean
  featureKey: string
  amount: number
  used: number
  remaining: number | null
  limit: number | null
  idempotencyKey: string
  windowStart: string
  windowEnd: string
  replayed: boolean
  reason: 'allowed' | 'missing_entitlement' | 'limit_exceeded' | 'released'
}

type DiagnosticLevel = 'info' | 'warning' | 'error'
type DiagnosticSource = 'auth' | 'filesystem' | 'git' | 'swarm' | 'terminal' | 'workspace'

type DiagnosticLogInput = {
  level: DiagnosticLevel
  source: DiagnosticSource
  title: string
  message: string
  details?: string
  workspaceId?: string
  workspaceName?: string
  agentId?: string
  taskId?: string
  sessionId?: string
}

type DiagnosticLogEntry = DiagnosticLogInput & {
  id: string
  timestamp: string
  logPath?: string
}

type WorkspaceFolderCheckResult =
  | {
      ok: true
      status: 'ready'
      path: string
      checkedPath: string
      message: string
    }
  | {
      ok: false
      status: 'missing' | 'inaccessible' | 'timeout'
      path: string
      checkedPath: string
      message: string
      code?: string
    }

type ElectronRendererAuthState = {
  authenticated: boolean
  user: SessionUser | null
  selectedOrganization: SessionOrganization | null
  entitlements: EntitlementSnapshot | null
}

type TokenSet = {
  accessToken: string
  refreshToken: string
  tokenType: 'Bearer'
  expiresIn: number
}

type DesktopExchangeRequest = {
  clientId: typeof MULTICODE_CLIENT_ID
  redirectUri: typeof MULTICODE_REDIRECT_URI
  code: string
  codeVerifier: string
}

type SecureRefreshTokenStore = {
  readRefreshToken(): Promise<string | null>
  writeRefreshToken(refreshToken: string): Promise<void>
  clearRefreshToken(): Promise<void>
}

type PremiumAccessRequest = {
  featureKey: string
  amount?: number
  hostedCost?: boolean
}

type PremiumAccessDecision = {
  allowed: boolean
  featureKey: string
  value: FeatureValue | undefined
  status: 'fresh' | 'offline_grace' | 'expired' | 'signed_out' | 'missing' | 'error'
  message: string
  limit?: number
  graceExpiresAt?: string
}

type MulticodeAuthState = ElectronRendererAuthState & {
  status: 'checking' | 'signed_out' | 'signed_in' | 'error'
  entitlementStatus: 'fresh' | 'offline_grace' | 'expired' | 'missing'
  message: string | null
  lastRefreshAt: string | null
  graceExpiresAt: string | null
}

type CachedEntitlements = {
  snapshot: EntitlementSnapshot
  lastRefreshAt: string
}

type PendingDesktopLogin = {
  state: string
  nonce: string
  codeVerifier: string
  organizationId: string | null
  createdAt: number
}

class MulticodeMultiauthClient {
  private accessToken: string | null = null
  private selectedOrganizationId: string | null = null
  private entitlementCache: EntitlementSnapshot | null = null

  constructor(
    private readonly refreshTokenStore: SecureRefreshTokenStore
  ) {}

  async exchangeDesktopCode(input: DesktopExchangeRequest): Promise<TokenSet> {
    const tokenSet = await this.request<TokenSet>('/api/auth/desktop/exchange', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    await this.installTokens(tokenSet)
    return tokenSet
  }

  async refresh(clientId: typeof MULTICODE_CLIENT_ID = MULTICODE_CLIENT_ID): Promise<TokenSet> {
    const refreshToken = await this.refreshTokenStore.readRefreshToken()
    if (!refreshToken) {
      throw new Error('No desktop refresh token is available.')
    }

    const tokenSet = await this.request<TokenSet>('/api/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ clientId, refreshToken }),
    })
    await this.installTokens(tokenSet)
    return tokenSet
  }

  async logout(): Promise<{ loggedOut: true }> {
    const refreshToken = await this.refreshTokenStore.readRefreshToken()
    const result = await this.request<{ loggedOut: true }>('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }).catch(async (error) => {
      await this.refreshTokenStore.clearRefreshToken()
      this.accessToken = null
      this.entitlementCache = null
      throw error
    })
    await this.refreshTokenStore.clearRefreshToken()
    this.accessToken = null
    this.entitlementCache = null
    return result
  }

  async selectOrganization(organizationId: string): Promise<{ organizationId: string }> {
    if (!organizationId.trim()) {
      throw new Error('organizationId is required.')
    }

    this.selectedOrganizationId = organizationId
    this.entitlementCache = null
    return { organizationId }
  }

  async getEntitlements(options: { forceRefresh?: boolean } = {}): Promise<EntitlementSnapshot> {
    if (!options.forceRefresh && this.entitlementCache && isSnapshotFresh(this.entitlementCache)) {
      return this.entitlementCache
    }

    const snapshot = await this.request<EntitlementSnapshot>(
      `/api/entitlements?product=${encodeURIComponent(MULTICODE_PRODUCT)}`,
      { method: 'GET' }
    )

    if (this.selectedOrganizationId && snapshot.organizationId !== this.selectedOrganizationId) {
      throw new Error('Selected organization does not match the authenticated desktop session.')
    }

    this.entitlementCache = snapshot
    return snapshot
  }

  async checkUsage(input: UsageRequest): Promise<UsageResult> {
    return this.usage('/api/usage/check', input)
  }

  async consumeUsage(input: UsageRequest): Promise<UsageResult> {
    return this.usage('/api/usage/consume', input)
  }

  async releaseUsage(input: UsageRequest): Promise<UsageResult> {
    return this.usage('/api/usage/release', input)
  }

  async getAccessToken(clientId: typeof MULTICODE_CLIENT_ID = MULTICODE_CLIENT_ID): Promise<string> {
    if (!this.accessToken) {
      await this.refresh(clientId)
    }
    if (!this.accessToken) {
      throw new Error('No desktop access token is available.')
    }
    return this.accessToken
  }

  private async usage(path: string, input: UsageRequest): Promise<UsageResult> {
    return this.request<UsageResult>(path, {
      method: 'POST',
      body: JSON.stringify({
        product: MULTICODE_PRODUCT,
        ...input,
      }),
    })
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    if (init.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
    if (this.accessToken) {
      headers.set('authorization', `Bearer ${this.accessToken}`)
    }

    const response = await fetch(new URL(path, `${MULTIAUTH_BASE_URL}/`), {
      ...init,
      headers,
    })
    const payload = await response.json().catch(() => ({})) as unknown

    if (!response.ok) {
      throw new Error(readMultiauthErrorMessage(payload))
    }

    return payload as T
  }

  private async installTokens(tokenSet: TokenSet): Promise<void> {
    this.accessToken = tokenSet.accessToken
    await this.refreshTokenStore.writeRefreshToken(tokenSet.refreshToken)
  }
}

class ElectronSafeRefreshTokenStore implements SecureRefreshTokenStore {
  private inMemoryRefreshToken: string | null = null

  private get tokenPath(): string {
    return join(app.getPath('userData'), 'multiauth-refresh-token.bin')
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

class MulticodeAuthBridge {
  private readonly refreshTokenStore = new ElectronSafeRefreshTokenStore()
  private readonly client = new MulticodeMultiauthClient(this.refreshTokenStore)
  private state: MulticodeAuthState = signedOutAuthState('Checking account.')
  private pendingLogin: PendingDesktopLogin | null = null
  private cachedEntitlements: CachedEntitlements | null = null

  async initialize(): Promise<MulticodeAuthState> {
    this.setState({ ...this.state, status: 'checking', message: 'Checking account.' })

    try {
      await this.client.refresh(MULTICODE_CLIENT_ID)
      return this.refreshEntitlements({ forceRefresh: true })
    } catch {
      const cache = this.cachedEntitlements ?? await this.readCachedEntitlements()
      this.cachedEntitlements = cache
      if (cache) {
        const entitlementStatus = getEntitlementCacheStatus(cache)
        this.setState({
          ...this.state,
          status: 'signed_in',
          authenticated: true,
          entitlements: cache.snapshot,
          entitlementStatus,
          message: entitlementStatus === 'offline_grace'
            ? 'Using cached Multicode access while offline.'
            : 'Sign in again to refresh Multicode access.',
          lastRefreshAt: cache.lastRefreshAt,
          graceExpiresAt: getGraceExpiresAt(cache),
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
    const state = randomBase64Url(24)
    const nonce = randomBase64Url(24)
    const codeVerifier = randomBase64Url(48)
    const codeChallenge = pkceChallenge(codeVerifier)
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
    })
    const selectedOrganizationId = organizationId?.trim() || this.state.selectedOrganization?.id

    if (selectedOrganizationId) {
      search.set('organization_id', selectedOrganizationId)
    }

    this.pendingLogin = {
      state,
      nonce,
      codeVerifier,
      organizationId: selectedOrganizationId ?? null,
      createdAt: Date.now(),
    }
    const authorizationUrl = `${MULTIAUTH_BASE_URL}/?${search.toString()}`
    await shell.openExternal(authorizationUrl)
    this.setState({ ...this.state, message: 'Complete sign-in in your browser.' })

    return { state, authorizationUrl }
  }

  async handleCallback(callbackUrl: string): Promise<MulticodeAuthState> {
    const url = new URL(callbackUrl)
    if (url.protocol !== 'multicode:' || url.hostname !== 'auth' || url.pathname !== '/callback') {
      throw new Error('Unsupported Multiauth callback URL.')
    }

    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const pending = this.pendingLogin
    if (!code || !state || !pending || pending.state !== state) {
      throw new Error('Desktop sign-in state did not match.')
    }

    if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
      this.pendingLogin = null
      throw new Error('Desktop sign-in expired. Start sign-in again.')
    }

    await this.client.exchangeDesktopCode({
      clientId: MULTICODE_CLIENT_ID,
      redirectUri: MULTICODE_REDIRECT_URI,
      code,
      codeVerifier: pending.codeVerifier,
    })
    this.pendingLogin = null
    if (pending.organizationId) {
      await this.client.selectOrganization(pending.organizationId)
    }

    return this.refreshEntitlements({ forceRefresh: true })
  }

  async logout(): Promise<{ loggedOut: true }> {
    const result = await this.client.logout()
    this.pendingLogin = null
    this.cachedEntitlements = null
    await unlink(this.cachePath).catch(() => {})
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
      this.setState({
        authenticated: true,
        user: session.user,
        selectedOrganization: session.selectedOrganization,
        entitlements,
        status: 'signed_in',
        entitlementStatus: isSnapshotFresh(entitlements) ? 'fresh' : 'expired',
        message: null,
        lastRefreshAt: cache.lastRefreshAt,
        graceExpiresAt: getGraceExpiresAt(cache),
      })
    } catch (error) {
      const cache = this.cachedEntitlements ?? await this.readCachedEntitlements()
      this.cachedEntitlements = cache
      if (cache) {
        const entitlementStatus = getEntitlementCacheStatus(cache)
        this.setState({
          ...this.state,
          authenticated: true,
          entitlements: cache.snapshot,
          status: 'signed_in',
          entitlementStatus,
          message: entitlementStatus === 'offline_grace'
            ? 'Using cached Multicode access while offline.'
            : getErrorMessage(error),
          lastRefreshAt: cache.lastRefreshAt,
          graceExpiresAt: getGraceExpiresAt(cache),
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

  async getRelayAccessToken(): Promise<string | null> {
    try {
      return await this.client.getAccessToken(MULTICODE_CLIENT_ID)
    } catch {
      return null
    }
  }

  async getEntitlements(options?: { forceRefresh?: boolean }): Promise<EntitlementSnapshot> {
    if (options?.forceRefresh) {
      await this.refreshEntitlements({ forceRefresh: true })
    }

    if (!this.state.entitlements) {
      throw new Error('No Multicode entitlement snapshot is available.')
    }

    return this.state.entitlements
  }

  async requireEntitlement(input: PremiumAccessRequest | string): Promise<FeatureValue> {
    const decision = await this.checkPremiumAccess(
      typeof input === 'string' ? { featureKey: input } : input
    )

    if (!decision.allowed) {
      throw new Error(decision.message)
    }

    return decision.value ?? true
  }

  async checkPremiumAccess(input: PremiumAccessRequest): Promise<PremiumAccessDecision> {
    if (!this.state.authenticated) {
      return denied(input.featureKey, undefined, 'signed_out', 'Sign in to unlock this Multicode feature.')
    }

    const entitlements = this.state.entitlements
    if (!entitlements || entitlements.schemaVersion !== 1 || entitlements.product !== MULTICODE_PRODUCT) {
      return denied(input.featureKey, undefined, 'missing', 'Multicode access could not be verified.')
    }

    const cache = this.cachedEntitlements ?? {
      snapshot: entitlements,
      lastRefreshAt: this.state.lastRefreshAt ?? new Date(0).toISOString(),
    }
    const cacheStatus = getEntitlementCacheStatus(cache)
    const value = entitlementValue(entitlements, input.featureKey)
    const limit = typeof value === 'number' ? value : undefined

    if (cacheStatus === 'expired') {
      return denied(input.featureKey, value, 'expired', 'Multicode premium access needs a fresh entitlement check.', limit)
    }

    if (cacheStatus === 'offline_grace') {
      if (input.hostedCost || !isAllowedDuringDesktopGrace(input.featureKey)) {
        return denied(
          input.featureKey,
          value,
          'offline_grace',
          'This premium action needs online entitlement verification.',
          limit,
          getGraceExpiresAt(cache)
        )
      }
    }

    if (typeof value === 'boolean' && value) {
      return allowed(input.featureKey, value, cacheStatus, getGraceExpiresAt(cache))
    }

    if (typeof value === 'number' && value > 0 && (input.amount === undefined || input.amount <= value)) {
      return allowed(input.featureKey, value, cacheStatus, getGraceExpiresAt(cache), value)
    }

    if (typeof value === 'string' && value.trim()) {
      return allowed(input.featureKey, value, cacheStatus, getGraceExpiresAt(cache))
    }

    return denied(
      input.featureKey,
      value,
      'missing',
      'Upgrade this organization or switch to one with Multicode premium access.',
      limit
    )
  }

  async checkUsage(input: UsageRequest): Promise<UsageResult> {
    return this.client.checkUsage(input)
  }

  async consumeUsage(input: UsageRequest): Promise<UsageResult> {
    return this.client.consumeUsage(input)
  }

  async releaseUsage(input: UsageRequest): Promise<UsageResult> {
    return this.client.releaseUsage(input)
  }

  async openUpgrade(reason?: string): Promise<{ opened: true; url: string }> {
    const search = new URLSearchParams({
      returnTo: 'checkout',
      product: MULTICODE_PRODUCT,
    })

    if (reason?.trim()) search.set('reason', reason.trim())
    if (this.state.selectedOrganization?.id) {
      search.set('organizationId', this.state.selectedOrganization.id)
    }

    const url = `${MULTIAUTH_BASE_URL}/?${search.toString()}`
    await shell.openExternal(url)
    return { opened: true, url }
  }

  private async readSessionFromEntitlements(entitlements: EntitlementSnapshot): Promise<ElectronRendererAuthState> {
    if (this.state.authenticated && this.state.selectedOrganization?.id === entitlements.organizationId) {
      return {
        authenticated: true,
        user: this.state.user,
        selectedOrganization: this.state.selectedOrganization,
        entitlements,
      }
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
    }
  }

  private get cachePath(): string {
    return join(app.getPath('userData'), 'multiauth-entitlements-cache.json')
  }

  private async readCachedEntitlements(): Promise<CachedEntitlements | null> {
    try {
      const payload = JSON.parse(await readFile(this.cachePath, 'utf8')) as Partial<CachedEntitlements>
      if (!payload.snapshot || typeof payload.lastRefreshAt !== 'string') return null
      if (!isValidEntitlementSnapshot(payload.snapshot)) return null
      return {
        snapshot: payload.snapshot,
        lastRefreshAt: payload.lastRefreshAt,
      }
    } catch {
      return null
    }
  }

  private async writeCachedEntitlements(cache: CachedEntitlements): Promise<void> {
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

const multicodeAuth = new MulticodeAuthBridge()
const mobileSnapshotService = new MobileSwarmSnapshotService()
const mobileBridge = new MobileBridge(() => multicodeAuth.getSession(), {
  accessTokenProvider: () => multicodeAuth.getRelayAccessToken(),
  commandService: createMobileCommandService(),
  snapshotService: mobileSnapshotService,
  statePathsProvider: discoverMobileSwarmStatePaths,
})

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

function isValidEntitlementSnapshot(input: unknown): input is EntitlementSnapshot {
  if (!input || typeof input !== 'object') return false
  const snapshot = input as Partial<EntitlementSnapshot>
  return snapshot.product === MULTICODE_PRODUCT
    && snapshot.schemaVersion === 1
    && typeof snapshot.userId === 'string'
    && typeof snapshot.organizationId === 'string'
    && typeof snapshot.features === 'object'
    && typeof snapshot.limits === 'object'
    && typeof snapshot.issuedAt === 'string'
    && typeof snapshot.expiresAt === 'string'
}

function isSnapshotFresh(snapshot: EntitlementSnapshot): boolean {
  const expiresAt = Date.parse(snapshot.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
}

function getGraceExpiresAt(cache: CachedEntitlements): string | null {
  const snapshotExpiresAt = Date.parse(cache.snapshot.expiresAt)
  const lastRefreshAt = Date.parse(cache.lastRefreshAt)
  if (!Number.isFinite(snapshotExpiresAt) || !Number.isFinite(lastRefreshAt)) return null

  const graceExpiresAt = Math.min(
    snapshotExpiresAt + ENTITLEMENT_GRACE_MS,
    lastRefreshAt + ENTITLEMENT_GRACE_MS
  )
  return new Date(graceExpiresAt).toISOString()
}

function getEntitlementCacheStatus(cache: CachedEntitlements): 'fresh' | 'offline_grace' | 'expired' {
  if (isSnapshotFresh(cache.snapshot)) return 'fresh'

  const graceExpiresAt = getGraceExpiresAt(cache)
  if (graceExpiresAt && Date.parse(graceExpiresAt) > Date.now()) {
    return 'offline_grace'
  }

  return 'expired'
}

function entitlementValue(snapshot: EntitlementSnapshot, featureKey: string): FeatureValue | undefined {
  if (featureKey in snapshot.features) return snapshot.features[featureKey]
  if (featureKey in snapshot.limits) return snapshot.limits[featureKey]
  return undefined
}

function isAllowedDuringDesktopGrace(featureKey: string): boolean {
  return featureKey === 'multicode.swarm_mode' || featureKey === 'multicode.max_agent_slots'
}

function allowed(
  featureKey: string,
  value: FeatureValue,
  status: 'fresh' | 'offline_grace',
  graceExpiresAt: string | null,
  limit?: number
): PremiumAccessDecision {
  return {
    allowed: true,
    featureKey,
    value,
    status,
    message: status === 'offline_grace'
      ? 'Using cached Multicode access while offline.'
      : 'Access granted.',
    ...(limit !== undefined ? { limit } : {}),
    ...(graceExpiresAt ? { graceExpiresAt } : {}),
  }
}

function denied(
  featureKey: string,
  value: FeatureValue | undefined,
  status: PremiumAccessDecision['status'],
  message: string,
  limit?: number,
  graceExpiresAt?: string | null
): PremiumAccessDecision {
  return {
    allowed: false,
    featureKey,
    value,
    status,
    message,
    ...(limit !== undefined ? { limit } : {}),
    ...(graceExpiresAt ? { graceExpiresAt } : {}),
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readMultiauthErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'Multiauth request failed.'
  const error = (payload as { error?: unknown }).error
  if (!error || typeof error !== 'object') return 'Multiauth request failed.'
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message.trim() ? message : 'Multiauth request failed.'
}

async function parseAuthCallbackFromArgv(argv: string[]): Promise<void> {
  const callbackUrl = argv.find((arg) => /^multicode:\/\/auth\/callback/i.test(arg))
  if (!callbackUrl) return

  try {
    await multicodeAuth.handleCallback(callbackUrl)
  } catch (error) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('auth:callback-error', getErrorMessage(error))
      }
    }
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    ...(process.platform !== 'darwin'
      ? {
          frame: false,
        }
      : {}),
    autoHideMenuBar: process.platform !== 'darwin',
    backgroundColor: '#09090b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  win.on('ready-to-show', () => win.show())
  win.on('maximize', () => sendWindowState(win))
  win.on('unmaximize', () => sendWindowState(win))
  win.on('enter-full-screen', () => sendWindowState(win))
  win.on('leave-full-screen', () => sendWindowState(win))

  if (MULTICODE_DIAGNOSTICS) {
    win.webContents.on('console-message', function (_event, detailsOrLevel) {
      const args = Array.from(arguments)
      const details = detailsOrLevel && typeof detailsOrLevel === 'object'
        ? detailsOrLevel as { level?: string; message?: string; sourceId?: string; lineNumber?: number }
        : null
      const level = details?.level ?? String(detailsOrLevel)
      const message = details?.message ?? String(args[2] ?? '')
      console.info(`[Renderer:${level}] ${message}`, {
        sourceId: details?.sourceId ?? args[4],
        line: details?.lineNumber ?? args[3],
      })
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error('[Renderer] render-process-gone', details)
    })
    win.webContents.on('unresponsive', () => {
      console.error('[Renderer] unresponsive')
    })
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.error('[Renderer] did-fail-load', { errorCode, errorDescription, validatedURL })
    })
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function getWindowState(win: BrowserWindow): { isMaximized: boolean; isFullScreen: boolean } {
  return {
    isMaximized: win.isMaximized(),
    isFullScreen: win.isFullScreen(),
  }
}

function sendWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.webContents.send('window:state-changed', getWindowState(win))
}

function getRequestWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return null
  return win
}

function sendMenuCommand(win: Electron.BaseWindow | null, command: string): void {
  if (!win || win.isDestroyed()) return
  const browserWindow = BrowserWindow.fromId(win.id)
  if (!browserWindow || browserWindow.isDestroyed()) return
  browserWindow.webContents.send('app-menu:command', command)
}

function zoomFocusedWindowIn(win: Electron.BaseWindow | null): void {
  if (!win || win.isDestroyed()) return
  const browserWindow = BrowserWindow.fromId(win.id)
  if (!browserWindow || browserWindow.isDestroyed()) return
  browserWindow.webContents.setZoomLevel(browserWindow.webContents.getZoomLevel() + 0.5)
}

function createAppMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'show-settings'),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle File Explorer',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'toggle-explorer'),
        },
        {
          label: 'Toggle Code Editor',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'toggle-editor'),
        },
        {
          label: 'Toggle Git Panel',
          accelerator: 'CmdOrCtrl+Shift+G',
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'toggle-git'),
        },
        {
          label: 'Open Swarm Kanban Board',
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'open-swarm-kanban'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: (_, win) => zoomFocusedWindowIn(win ?? BrowserWindow.getFocusedWindow()),
        },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Multicode',
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'show-about'),
        },
      ],
    },
  ])
}

type ContextMenuItem = {
  id?: string
  label?: string
  enabled?: boolean
  type?: 'normal' | 'separator'
}

type SpecialistActionId =
  | 'architect'
  | 'product-strategist'
  | 'developer'
  | 'devops-infra'
  | 'performance'
  | 'qa-test'
  | 'security-review'
  | 'frontend-design-review'
  | 'code-review'

type SpecialistPromptResult =
  | { ok: true; prompt: string; path: string }
  | { ok: false; message: string; path: string | null }
type MultiloopAgentSoulRole =
  | 'coordinator'
  | 'architect'
  | 'product'
  | 'developer'
  | 'frontend'
  | 'tester'
  | 'security'
  | 'code_reviewer'
  | 'performance'

const specialistPromptFiles: Record<SpecialistActionId, string> = {
  architect: 'architect-prompt.md',
  'product-strategist': 'product-strategist-prompt.md',
  developer: 'developer-prompt.md',
  'devops-infra': 'devops-infra-prompt.md',
  performance: 'performance-engineer-prompt.md',
  'frontend-design-review': 'frontend-design-promt.md',
  'qa-test': 'qa-test-prompt.md',
  'security-review': 'security-review-prompt.md',
  'code-review': 'code-reviewer-pre-prompt.md',
}
const multiloopAgentSoulFiles: Record<MultiloopAgentSoulRole, string> = {
  coordinator: 'coordinator.md',
  architect: 'architect.md',
  product: 'product.md',
  developer: 'developer.md',
  frontend: 'frontend.md',
  tester: 'tester.md',
  security: 'security.md',
  code_reviewer: 'code_reviewer.md',
  performance: 'performance.md',
}

function getSpecialistPromptCandidates(fileName: string): string[] {
  return [
    join(process.cwd(), 'specialist-prompts', fileName),
    join(app.getAppPath(), 'specialist-prompts', fileName),
    join(__dirname, '..', '..', 'specialist-prompts', fileName),
    join(__dirname, '..', '..', '..', 'specialist-prompts', fileName),
  ]
}

function getMultiloopAgentSoulCandidates(fileName: string): string[] {
  if (app.isPackaged) {
    return [
      join(process.resourcesPath, 'multiloop-agent-souls', fileName),
      join(app.getAppPath(), 'multiloop-agent-souls', fileName),
    ]
  }

  return [
    join(process.cwd(), 'multiloop-agent-souls', fileName),
    join(app.getAppPath(), 'multiloop-agent-souls', fileName),
    join(__dirname, '..', '..', 'multiloop-agent-souls', fileName),
    join(__dirname, '..', '..', '..', 'multiloop-agent-souls', fileName),
  ]
}

async function readSpecialistPrompt(specialistId: SpecialistActionId): Promise<SpecialistPromptResult> {
  const fileName = specialistPromptFiles[specialistId]
  if (!fileName) {
    return {
      ok: false,
      message: `Unknown specialist prompt: ${specialistId}`,
      path: null,
    }
  }

  const candidates = getSpecialistPromptCandidates(fileName)

  for (const candidate of candidates) {
    try {
      return { ok: true, prompt: await readFile(candidate, 'utf-8'), path: candidate }
    } catch {
      // Try the next likely app/dev path before reporting a recoverable missing prompt.
    }
  }

  return {
    ok: false,
    message: `Prompt file missing: specialist-prompts/${fileName}`,
    path: candidates[0] ?? null,
  }
}

async function readMultiloopAgentSoul(role: MultiloopAgentSoulRole): Promise<SpecialistPromptResult> {
  const fileName = multiloopAgentSoulFiles[role]
  if (!fileName) {
    return {
      ok: false,
      message: `Unknown Multiloop agent soul: ${role}`,
      path: null,
    }
  }

  const candidates = getMultiloopAgentSoulCandidates(fileName)

  for (const candidate of candidates) {
    try {
      return { ok: true, prompt: await readFile(candidate, 'utf-8'), path: candidate }
    } catch {
      // Try the next likely app/dev path before reporting a recoverable missing prompt.
    }
  }

  return {
    ok: false,
    message: `Prompt file missing: multiloop-agent-souls/${fileName}`,
    path: candidates[0] ?? null,
  }
}

// ── Claude Code CLI Terminal IPC ──────────────────────────────────────────────

type TerminalSize = {
  cols: number
  rows: number
}

type TerminalKind = 'agent' | 'terminal'

type TerminalSession = {
  sessionId: string
  process: pty.IPty
  sender: Electron.WebContents
  isReady: boolean
  hasExited: boolean
  isDisposed: boolean
  outputChunks: string[]
  outputChunkBytes: number[]
  outputChunkStart: number
  outputBytes: number
  outputLength: number
  kind: TerminalKind
  workspaceId?: string
  agentId?: string
  terminalId?: string
  cli?: AgentCli
  cwd?: string
  swarmStatePath?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  startedAt: number
  lastOutputAt: number | null
  lastInputAt: number | null
  pendingResize?: TerminalSize
  startupScriptPath?: string
}

const TERMINAL_REPLAY_BUFFER_LIMIT = 512 * 1024
const TERMINAL_INTERACTIVE_DATA_BATCH_MS = 0
const TERMINAL_DATA_BATCH_MS = 16
const TERMINAL_RECENT_INPUT_WINDOW_MS = 250
const TERMINAL_INTERACTIVE_DATA_LIMIT = 4096
const TERMINAL_PENDING_DATA_LIMIT = 256 * 1024
const TERMINAL_REPLAY_COMPACT_THRESHOLD = 1024
const TERMINAL_BATCH_DIAGNOSTIC_INTERVAL_MS = 1_000
const terminals = new Map<string, TerminalSession>()
const pendingTerminalData = new Map<string, {
  sender: Electron.WebContents
  channel: string
  chunks: string[]
  bytes: number
  timer: NodeJS.Timeout
}>()
const terminalBatchDiagnostics = new Map<string, {
  batches: number
  chunks: number
  bytes: number
  lastLogAt: number
}>()
const TERMINAL_INPUT_DIAGNOSTIC_INTERVAL_MS = 1_000
const TERMINAL_SLOW_INPUT_WRITE_MS = 50
const terminalInputDiagnostics = new Map<string, {
  writes: number
  bytes: number
  totalMs: number
  maxMs: number
  errors: number
  lastLogAt: number
}>()
type FileWatchEvent = {
  eventType: string
  path: string | null
}

type FileWatcherRecord = {
  watcher: FSWatcher
  senderId: number
  pendingEvent: FileWatchEvent | null
  flushTimer: NodeJS.Timeout | null
}

const FILE_WATCH_EVENT_COALESCE_MS = 100
const fileWatchers = new Map<string, FileWatcherRecord>()
const trackedWatcherSenders = new Set<number>()
let nextFileWatcherId = 0

const FILE_SEARCH_DEFAULT_LIMIT = 200
const FILE_SEARCH_MAX_LIMIT = 500
const CONTENT_SEARCH_DEFAULT_LIMIT = 200
const CONTENT_SEARCH_MAX_LIMIT = 500
const FILE_SEARCH_DEFAULT_EXCLUDES = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  '.turbo',
  'coverage',
]
const activeFileSearches = new Map<number, ChildProcessWithoutNullStreams>()
const cancelledFileSearches = new WeakSet<ChildProcessWithoutNullStreams>()
const activeContentSearches = new Map<number, ChildProcessWithoutNullStreams>()
const cancelledContentSearches = new WeakSet<ChildProcessWithoutNullStreams>()

type FileSearchEngine = 'ripgrep'
type ContentSearchEngine = 'ripgrep'

type FileSearchRequest = {
  rootPath: string
  query: string
  limit?: number
  excludes?: string[]
}

type ContentSearchRequest = FileSearchRequest

type FileSearchEntry = {
  name: string
  path: string
  parentPath: string
  isDir: false
}

type ContentSearchEntry = {
  name: string
  path: string
  parentPath: string
  lineNumber: number
  column: number
  lineText: string
  matchText: string
}

type FileSearchResult =
  | {
      ok: true
      results: FileSearchEntry[]
      truncated: boolean
      engine: FileSearchEngine
      elapsedMs: number
      resultCount: number
    }
  | {
      ok: false
      message: string
      engine: FileSearchEngine | null
    }

type ContentSearchResult =
  | {
      ok: true
      results: ContentSearchEntry[]
      truncated: boolean
      engine: ContentSearchEngine
      elapsedMs: number
      resultCount: number
    }
  | {
      ok: false
      message: string
      engine: ContentSearchEngine | null
    }

type FileSearchEngineResult =
  | {
      ok: true
      results: FileSearchEntry[]
      truncated: boolean
      engine: FileSearchEngine
    }
  | {
      ok: false
      message: string
      engine: FileSearchEngine | null
    }

type ContentSearchEngineResult =
  | {
      ok: true
      results: ContentSearchEntry[]
      truncated: boolean
      engine: ContentSearchEngine
    }
  | {
      ok: false
      message: string
      engine: ContentSearchEngine | null
    }

type AgentCli = 'codex' | 'claude'
type AgentExecutionMode = 'current_workspace' | 'worktree'
type SwarmCliPermissionPreset = 'default' | 'auto_workspace' | 'bypass_all'
type CliRuntimeSettings = {
  command: string
  useWsl: boolean
}

type TerminalSpawnPayload = {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  resume?: boolean
  swarmStatePath?: string
  cli?: AgentCli
  initialPrompt?: string
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  shellOnly?: boolean
  kind?: TerminalKind
  workspaceId?: string
  agentId?: string
  terminalId?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  cliPermissionPreset?: SwarmCliPermissionPreset
}

type TerminalSessionSnapshot = {
  sessionId: string
  running: boolean
  kind: TerminalKind
  workspaceId?: string
  agentId?: string
  terminalId?: string
  cli?: AgentCli
  cwd?: string
  swarmStatePath?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  startedAt: number
  lastOutputAt: number | null
  outputBufferLength: number
  retainedOutputBytes: number
}

type TerminalSpawnResult =
  | { ok: true; sessionId: string }
  | { ok: false; sessionId: string; message: string; exitCode: number }

type ShellLaunchConfig = {
  command: string
  args: string[]
  cwd?: string
  initialInput?: string
  env?: Record<string, string>
  startupScriptPath?: string
}

function getTerminalEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )

  delete env.ELECTRON_RUN_AS_NODE
  env.TERM = env.TERM || 'xterm-256color'

  return env
}

function withSwarmEnv(
  env: Record<string, string>,
  cwd: string,
  swarmStatePath?: string
): Record<string, string> {
  const bundledToolPath = getBundledSwarmToolPath()
  const nextEnv = {
    ...env,
    SWARM_REPO_TOOL_PATH: join(cwd, '.agents', 'skills', 'swarm-kanban', 'scripts', 'swarm_tool.py'),
    SWARM_REPO_WRAPPER_PATH: join(cwd, 'scripts', 'swarm_tool.py'),
    ...(bundledToolPath ? { MULTICODE_SWARM_TOOL_PATH: bundledToolPath } : {}),
    ...(swarmStatePath ? { SWARM_STATE_PATH: swarmStatePath } : {}),
  }

  if (process.platform !== 'win32') return nextEnv

  const shimDirectory = ensureWindowsSwarmShimDirectory()
  if (!shimDirectory) return nextEnv

  const pathKey = Object.keys(nextEnv).find((key) => key.toLowerCase() === 'path') ?? 'Path'
  return {
    ...nextEnv,
    [pathKey]: `${shimDirectory};${nextEnv[pathKey] ?? ''}`,
  }
}

function ensureWindowsSwarmShimDirectory(): string | null {
  if (process.platform !== 'win32') return null

  try {
    const shimDirectory = join(app.getPath('userData'), 'swarm-bin')
    const shimPath = join(shimDirectory, 'swarm.cmd')
    mkdirSync(shimDirectory, { recursive: true })
    writeFileSync(
      shimPath,
      [
        '@echo off',
        'setlocal',
        'set "TOOL=%SWARM_REPO_WRAPPER_PATH%"',
        'if exist "%TOOL%" goto run',
        'set "TOOL=%SWARM_REPO_TOOL_PATH%"',
        'if exist "%TOOL%" goto run',
        'set "TOOL=%MULTICODE_SWARM_TOOL_PATH%"',
        'if exist "%TOOL%" goto run',
        'echo swarm tool not found 1>&2',
        'exit /b 127',
        ':run',
        'set "PYTHON_EXE="',
        'if exist ".venv\\Scripts\\python.exe" set "PYTHON_EXE=.venv\\Scripts\\python.exe"',
        'if defined PYTHON_EXE goto run_python',
        'if "%SWARM_REPO_WRAPPER_PATH%"=="" goto global_python',
        'for %%I in ("%SWARM_REPO_WRAPPER_PATH%") do set "WRAPPER_DIR=%%~dpI"',
        'if exist "%WRAPPER_DIR%..\\.venv\\Scripts\\python.exe" set "PYTHON_EXE=%WRAPPER_DIR%..\\.venv\\Scripts\\python.exe"',
        'if defined PYTHON_EXE goto run_python',
        ':global_python',
        'for /f "delims=" %%P in (\'where python 2^>nul\') do if not defined PYTHON_EXE if /I not "%%~dpP"=="%LOCALAPPDATA%\\Microsoft\\WindowsApps\\" set "PYTHON_EXE=%%P"',
        'if defined PYTHON_EXE goto run_python',
        'echo python not found; expected repo venv at .venv\\Scripts\\python.exe 1>&2',
        'exit /b 127',
        ':run_python',
        '"%PYTHON_EXE%" "%TOOL%" %*',
        'exit /b %errorlevel%',
        '',
      ].join('\r\n'),
      'utf8'
    )
    return shimDirectory
  } catch {
    return null
  }
}

function toWslPath(dirPath: string): string {
  const normalized = dirPath.replace(/\\/g, '/')
  const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/)

  if (!driveMatch) {
    return normalized
  }

  const [, drive, rest] = driveMatch
  return `/mnt/${drive.toLowerCase()}/${rest}`
}

function toWindowsPath(dirPath: string): string {
  const normalized = dirPath.replace(/\\/g, '/')
  const wslMatch = normalized.match(/^\/mnt\/([A-Za-z])\/(.*)$/)

  if (!wslMatch) {
    return dirPath
  }

  const [, drive, rest] = wslMatch
  return `${drive.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`
}

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return search && search !== replacement ? value.split(search).join(replacement) : value
}

function normalizeInitialPromptPaths(
  initialPrompt: string | undefined,
  target: 'windows' | 'wsl',
  paths: Array<string | undefined>
): string | undefined {
  if (!initialPrompt) return initialPrompt

  let normalizedPrompt = initialPrompt
  for (const pathValue of paths) {
    if (!pathValue) continue

    const targetPath = target === 'wsl' ? toWslPath(pathValue) : toWindowsPath(pathValue)
    const candidates = Array.from(new Set([pathValue, toWindowsPath(pathValue), toWslPath(pathValue)]))
    for (const candidate of candidates) {
      normalizedPrompt = replaceAllLiteral(normalizedPrompt, candidate, targetPath)
    }
  }

  return normalizedPrompt
}

function isNativeWindowsPath(dirPath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(dirPath) || /^\\\\/.test(dirPath)
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function quotePosixCommand(value: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(value) ? value : quotePosix(value)
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function powerShellBase64Literal(value: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${quotePowerShell(Buffer.from(value, 'utf8').toString('base64'))}))`
}

function nativeWindowsPromptArg(value: string | undefined): string | undefined {
  return value?.replace(/\r\n|\r|\n/g, '\\n')
}

function getCliPermissionArgs(
  cli: AgentCli,
  preset: SwarmCliPermissionPreset = 'default'
): string[] {
  if (preset === 'auto_workspace') {
    return cli === 'codex'
      ? ['--ask-for-approval', 'never', '--sandbox', 'workspace-write']
      : ['--permission-mode', 'auto']
  }

  if (preset === 'bypass_all') {
    return cli === 'codex'
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--permission-mode', 'bypassPermissions']
  }

  return []
}

function getCliRuntimeSettings(
  cli: AgentCli,
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
): CliRuntimeSettings {
  return {
    command: cliRuntimes?.[cli]?.command?.trim() || cli,
    useWsl: Boolean(cliRuntimes?.[cli]?.useWsl),
  }
}

function getBundledSwarmToolPath(): string | null {
  const candidates = [
    join(process.cwd(), '.agents', 'skills', 'swarm-kanban', 'scripts', 'swarm_tool.py'),
    join(app.getAppPath(), '.agents', 'skills', 'swarm-kanban', 'scripts', 'swarm_tool.py'),
    join(__dirname, '..', '..', '.agents', 'skills', 'swarm-kanban', 'scripts', 'swarm_tool.py'),
    join(__dirname, '..', '..', '..', '.agents', 'skills', 'swarm-kanban', 'scripts', 'swarm_tool.py'),
  ]

  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function getBundledMultiloopToolPath(): string | null {
  if (app.isPackaged) {
    const packagedToolPath = join(process.resourcesPath, 'scripts', 'multiloop_tool.py')
    return existsSync(packagedToolPath) ? packagedToolPath : null
  }

  const candidates = [
    join(process.cwd(), 'scripts', 'multiloop_tool.py'),
    join(app.getAppPath(), 'scripts', 'multiloop_tool.py'),
    join(__dirname, '..', '..', 'scripts', 'multiloop_tool.py'),
    join(__dirname, '..', '..', '..', 'scripts', 'multiloop_tool.py'),
  ]

  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function getMultiloopPythonExecutable(toolPath: string): string {
  const repoRoot = dirname(dirname(toolPath))
  const venvPython = process.platform === 'win32'
    ? join(repoRoot, '.venv', 'Scripts', 'python.exe')
    : join(repoRoot, '.venv', 'bin', 'python')
  if (existsSync(venvPython)) return venvPython
  return process.platform === 'win32' ? 'python' : 'python3'
}

function quoteSh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function installMultiloopWorkspaceCli(workspaceRoot: string): Promise<void> {
  const toolPath = getBundledMultiloopToolPath()
  if (!toolPath) {
    throw new Error('Multiloop Python tool is unavailable: scripts/multiloop_tool.py was not found.')
  }

  const toolRoot = dirname(dirname(toolPath))
  const pythonExecutable = getMultiloopPythonExecutable(toolPath)
  const scriptDirectory = join(workspaceRoot, 'scripts')
  await mkdir(scriptDirectory, { recursive: true })

  const shellWrapper = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `export PYTHONPATH=${quoteSh(toolRoot)}:\${PYTHONPATH:-}`,
    `exec ${quoteSh(pythonExecutable)} ${quoteSh(toolPath)} "$@"`,
    '',
  ].join('\n')
  const shellPath = join(scriptDirectory, 'multiloop')
  await writeFile(shellPath, shellWrapper, 'utf8')
  await chmod(shellPath, 0o755).catch(() => {})

  const cmdWrapper = [
    '@echo off',
    `set "PYTHONPATH=${toolRoot};%PYTHONPATH%"`,
    `"${pythonExecutable}" "${toolPath}" %*`,
    '',
  ].join('\r\n')
  await writeFile(join(scriptDirectory, 'multiloop.cmd'), cmdWrapper, 'utf8')
}

function slugifyMultiloopName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!slug) {
    throw new Error('Loop name must contain at least one letter or digit.')
  }
  return slug
}

async function resolveMultiloopWorkspaceRoot(input: unknown): Promise<string> {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Workspace root is required.')
  }

  const rawWorkspaceRoot = input.trim()
  if (!isAbsolute(rawWorkspaceRoot)) {
    throw new Error('Workspace root must be an absolute path.')
  }

  const workspaceRoot = resolve(rawWorkspaceRoot)
  let workspaceStats
  try {
    workspaceStats = await stat(workspaceRoot)
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error('Workspace root must be an existing directory.')
    }
    throw error
  }
  if (!workspaceStats.isDirectory()) {
    throw new Error('Workspace root must be an existing directory.')
  }

  return realpath(workspaceRoot)
}

function readRequiredMultiloopText(input: unknown, label: string): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error(`${label} is required.`)
  }
  return input.trim()
}

async function readExistingMultiloopState(
  statePath: string,
  loopName: string,
  loopSlug: string,
  finalGoal: string
): Promise<{ exists: false } | { exists: true; conflicting: false } | { exists: true; conflicting: true; message: string }> {
  try {
    const stateContent = await readFile(statePath, 'utf8')
    const state = JSON.parse(stateContent) as unknown
    if (!state || typeof state !== 'object' || !('loop' in state)) {
      return { exists: true, conflicting: true, message: 'Existing Multiloop state file is not valid.' }
    }

    const loop = (state as { loop?: unknown }).loop
    if (!loop || typeof loop !== 'object') {
      return { exists: true, conflicting: true, message: 'Existing Multiloop state file has no loop metadata.' }
    }

    const record = loop as Record<string, unknown>
    if (record.name !== loopSlug || record.displayName !== loopName) {
      return { exists: true, conflicting: true, message: 'A different Multiloop state already exists for this loop path.' }
    }
    if (record.finalGoal !== finalGoal) {
      return { exists: true, conflicting: true, message: 'A Multiloop state already exists with a different final goal.' }
    }

    return { exists: true, conflicting: false }
  } catch (error) {
    if (isMissingPathError(error)) return { exists: false }
    if (error instanceof SyntaxError) {
      return { exists: true, conflicting: true, message: 'Existing Multiloop state file is not valid JSON.' }
    }
    throw error
  }
}

function runMultiloopInitTool(
  workspaceRoot: string,
  statePath: string,
  loopName: string,
  finalGoal: string
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const toolPath = getBundledMultiloopToolPath()
    if (!toolPath) {
      resolvePromise({
        exitCode: 127,
        stdout: '',
        stderr: 'Multiloop Python tool is unavailable: scripts/multiloop_tool.py was not found.',
      })
      return
    }

    const repoRoot = dirname(dirname(toolPath))
    const child = spawn(
      getMultiloopPythonExecutable(toolPath),
      [toolPath, '--state', statePath, 'init', '--name', loopName, '--final-goal', finalGoal],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          PYTHONPATH: [repoRoot, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
        },
        windowsHide: true,
      }
    )
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      resolvePromise({
        exitCode: null,
        stdout,
        stderr: stderr || `Multiloop Python tool could not start: ${error.message}`,
      })
    })
    child.on('close', (exitCode) => {
      resolvePromise({ exitCode, stdout, stderr })
    })
  })
}

async function initializeMultiloopState(payload: MultiloopInitPayload): Promise<MultiloopInitResult> {
  try {
    const loopName = readRequiredMultiloopText(payload?.loopName, 'Loop name')
    const finalGoal = readRequiredMultiloopText(payload?.finalGoal, 'Final goal')
    const loopSlug = slugifyMultiloopName(loopName)
    const workspaceRoot = await resolveMultiloopWorkspaceRoot(payload?.workspaceRoot)
    const loopDirectory = resolve(workspaceRoot, 'multiloop', loopSlug)
    const statePath = resolve(loopDirectory, 'state.json')

    if (!isPathInsideOrEqual(workspaceRoot, statePath) || basename(dirname(loopDirectory)) !== 'multiloop') {
      throw new Error('Multiloop state path must stay inside multiloop/<loop>/state.json.')
    }

    const existing = await readExistingMultiloopState(statePath, loopName, loopSlug, finalGoal)
    if (existing.exists) {
      if (existing.conflicting) {
        return { ok: false, message: existing.message }
      }
      await installMultiloopWorkspaceCli(workspaceRoot)
      return {
        ok: true,
        data: { workspaceRoot, loopName, loopSlug, loopDirectory, statePath, created: false },
      }
    }

    const completed = await runMultiloopInitTool(workspaceRoot, statePath, loopName, finalGoal)
    if (completed.exitCode !== 0) {
      return {
        ok: false,
        message: completed.stderr.trim() || completed.stdout.trim() || 'Multiloop initialization failed.',
        stdout: completed.stdout,
        stderr: completed.stderr,
        exitCode: completed.exitCode ?? 'spawn-error',
      }
    }

    const created = await readExistingMultiloopState(statePath, loopName, loopSlug, finalGoal)
    if (!created.exists || created.conflicting) {
      return {
        ok: false,
        message: created.exists && created.conflicting
          ? created.message
          : 'Multiloop initialization did not create state.json.',
        stdout: completed.stdout,
        stderr: completed.stderr,
        exitCode: completed.exitCode ?? undefined,
      }
    }

    await installMultiloopWorkspaceCli(workspaceRoot)

    return {
      ok: true,
      data: { workspaceRoot, loopName, loopSlug, loopDirectory, statePath, created: true },
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

type SwarmArtifactCommandResult =
  | { ok: true; data: unknown }
  | { ok: false; message: string; stdout?: string; stderr?: string; exitCode?: number | string }

type MultiloopInitPayload = {
  workspaceRoot: string
  loopName: string
  finalGoal: string
}

type MultiloopInitResult =
  | {
      ok: true
      data: {
        workspaceRoot: string
        loopName: string
        loopSlug: string
        loopDirectory: string
        statePath: string
        created: boolean
      }
    }
  | { ok: false; message: string; stdout?: string; stderr?: string; exitCode?: number | string }

type SwarmArtifactOpenPayload = {
  statePath: string
  artifactPath: string
}

type SwarmArtifactReviewPayload = {
  statePath: string
  artifactId: string
  feedback?: string
}

type SwarmArtifactReviewAction = 'approve' | 'request-changes'
type SwarmArtifactReviewMode = 'user' | 'auto-run'

type SwarmMcpActorContext = {
  id: string
  role: 'user'
  authenticated: true
  mcpAuthorized: true
}

type SwarmMcpToolResponse =
  | { ok: true; tool: string; result: unknown }
  | { ok: false; tool: string; error?: { code?: string; message?: string } }

type SwarmArtifactRecord = {
  id: string
  kind: string
  title: string
  path: string
  status: string
  createdBy: string
  taskId: string
}

type SwarmTaskRecord = {
  id: string
  status: string
  ownerAgentId: string
}

const autoApprovableArtifactKinds = new Set([
  'architect_plan',
  'product_strategy',
  'requirements',
  'html_mockup',
  'design_notes',
  'branding',
  'security_review',
  'code_review',
  'performance_review',
  'validation_report',
])

type ValidSwarmStatePath = {
  statePath: string
  teamDirectory: string
  workspaceRoot: string
}

function validateSwarmStatePath(input: unknown): ValidSwarmStatePath {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('A swarm state path is required.')
  }

  const rawStatePath = input.trim()
  if (!isAbsolute(rawStatePath)) {
    throw new Error('Swarm state path must be absolute.')
  }

  const statePath = resolve(rawStatePath)
  const teamDirectory = dirname(statePath)
  const swarmDirectory = dirname(teamDirectory)
  const workspaceRoot = dirname(swarmDirectory)

  if (basename(statePath) !== 'state.yaml' || basename(swarmDirectory) !== 'swarm' || workspaceRoot === swarmDirectory) {
    throw new Error('Swarm state path must point to swarm/<team>/state.yaml.')
  }

  return { statePath, teamDirectory, workspaceRoot }
}

function isPathInsideOrEqual(parentPath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(targetPath))
  return (
    relativePath === ''
    || (!relativePath.startsWith('..') && !isAbsolute(relativePath) && !relativePath.split(sep).includes('..'))
  )
}

function isSwarmStateFilePath(input: string): boolean {
  const statePath = resolve(input)
  const teamDirectory = dirname(statePath)
  const swarmDirectory = dirname(teamDirectory)
  const workspaceRoot = dirname(swarmDirectory)

  return (
    basename(statePath) === 'state.yaml'
    && basename(swarmDirectory) === 'swarm'
    && workspaceRoot !== swarmDirectory
  )
}

async function getRealMutationTargetPath(targetPath: string): Promise<string | null> {
  try {
    await lstat(targetPath)
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error
    }

    const parentDirectory = dirname(resolve(targetPath))
    try {
      return resolve(await realpath(parentDirectory), basename(targetPath))
    } catch (parentError) {
      if (isMissingPathError(parentError)) {
        return null
      }
      throw parentError
    }
  }

  try {
    return await realpath(targetPath)
  } catch (error) {
    if (isMissingPathError(error)) {
      return null
    }
    throw error
  }
}

async function getExistingDirectoryPath(targetPath: string): Promise<string | null> {
  try {
    const targetStats = await stat(targetPath)
    return targetStats.isDirectory() ? targetPath : null
  } catch (error) {
    if (isMissingPathError(error)) {
      return null
    }
    throw error
  }
}

async function directorySubtreeContainsSwarmStatePath(directoryPath: string): Promise<boolean> {
  const visitedRealDirectories = new Set<string>()

  const visit = async (currentDirectory: string): Promise<boolean> => {
    let realCurrentDirectory: string | null = null
    try {
      realCurrentDirectory = await realpath(currentDirectory)
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error
      }
    }

    if (realCurrentDirectory) {
      if (visitedRealDirectories.has(realCurrentDirectory)) {
        return false
      }
      visitedRealDirectories.add(realCurrentDirectory)
    }

    let entries
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true })
    } catch (error) {
      if (isMissingPathError(error)) {
        return false
      }
      throw error
    }

    for (const entry of entries) {
      const entryPath = join(currentDirectory, entry.name)
      if (entry.name === 'state.yaml' && isSwarmStateFilePath(entryPath)) {
        return true
      }
      if (entry.isDirectory() && await visit(entryPath)) {
        return true
      }
    }

    return false
  }

  return visit(directoryPath)
}

async function assertNotDirectSwarmStateMutation(targetPath: string): Promise<void> {
  const realTargetPath = await getRealMutationTargetPath(targetPath)
  if (isSwarmStateFilePath(targetPath) || (realTargetPath && isSwarmStateFilePath(realTargetPath))) {
    throw new Error('Swarm state files must be updated through the swarm tool.')
  }

  const existingDirectoryPath = await getExistingDirectoryPath(targetPath)
  if (!existingDirectoryPath) {
    return
  }

  if (await directorySubtreeContainsSwarmStatePath(existingDirectoryPath)) {
    throw new Error('Swarm state files must be updated through the swarm tool.')
  }

  const realDirectoryPath = realTargetPath && realTargetPath !== resolve(existingDirectoryPath)
    ? await getExistingDirectoryPath(realTargetPath)
    : null
  if (realDirectoryPath && await directorySubtreeContainsSwarmStatePath(realDirectoryPath)) {
    throw new Error('Swarm state files must be updated through the swarm tool.')
  }
}

function resolveArtifactFilePath(state: ValidSwarmStatePath, artifactPathInput: unknown): string {
  if (typeof artifactPathInput !== 'string' || !artifactPathInput.trim()) {
    throw new Error('Artifact path is required.')
  }

  const artifactPath = artifactPathInput.trim()
  if (/^https?:\/\//i.test(artifactPath)) {
    return artifactPath
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/i.test(artifactPath)) {
    throw new Error('Only http, https, or workspace artifact file paths can be opened.')
  }

  const fullPath = isAbsolute(artifactPath)
    ? resolve(artifactPath)
    : [
        resolve(state.workspaceRoot, artifactPath),
        resolve(state.teamDirectory, artifactPath),
      ].find((candidate) => isPathInsideOrEqual(state.teamDirectory, candidate))
        ?? resolve(state.workspaceRoot, artifactPath)
  if (!isPathInsideOrEqual(state.teamDirectory, fullPath)) {
    throw new Error('Artifact path must stay inside the swarm team directory.')
  }

  return fullPath
}

function resolveSwarmArtifactId(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Artifact id is required.')
  }
  const artifactId = input.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(artifactId)) {
    throw new Error('Artifact id must be a safe swarm identifier.')
  }
  return artifactId
}

function getSwarmMcpPythonExecutable(workspaceRoot: string): string {
  const venvPython = process.platform === 'win32'
    ? join(workspaceRoot, '.venv', 'Scripts', 'python.exe')
    : join(workspaceRoot, '.venv', 'bin', 'python')
  if (existsSync(venvPython)) return venvPython
  return process.platform === 'win32' ? 'python' : 'python3'
}

function runSwarmMcpTool(
  state: ValidSwarmStatePath,
  tool: string,
  payload: Record<string, unknown>,
  actor: SwarmMcpActorContext
): Promise<{
  exitCode: number | null
  stdout: string
  stderr: string
  response: SwarmMcpToolResponse | null
}> {
  return new Promise((resolvePromise) => {
    const child = spawn(getSwarmMcpPythonExecutable(state.workspaceRoot), ['-m', 'swarm_mcp', '--allowed-root', state.workspaceRoot], {
      cwd: state.workspaceRoot,
      env: {
        ...process.env,
        PYTHONPATH: [state.workspaceRoot, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
        SWARM_MCP_USER_ID: actor.id,
        SWARM_MCP_USER_AUTHORIZED: '1',
      },
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      resolvePromise({ exitCode: 1, stdout, stderr: stderr || error.message, response: null })
    })
    child.on('close', (exitCode) => {
      let response: SwarmMcpToolResponse | null = null
      const responseLine = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)
      if (responseLine) {
        try {
          response = JSON.parse(responseLine) as SwarmMcpToolResponse
        } catch {
          response = null
        }
      }
      resolvePromise({ exitCode, stdout, stderr, response })
    })
    child.stdin.end(`${JSON.stringify({ tool, payload, actor })}\n`)
  })
}

async function requireSwarmMcpAuthority(): Promise<SwarmMcpActorContext> {
  const userId = getAuthenticatedMulticodeUserId()
  if (!userId) {
    throw new Error('Artifact review requires an authenticated Multicode user.')
  }

  return {
    id: userId,
    role: 'user',
    authenticated: true,
    mcpAuthorized: true,
  }
}

function getAuthenticatedMulticodeUserId(): string | null {
  const state = multicodeAuth.getState()
  if (!state.authenticated) return null
  return state.user?.id?.trim() || state.entitlements?.userId?.trim() || null
}

function requireAuthenticatedMulticodeUser(message: string): void {
  if (!getAuthenticatedMulticodeUserId()) {
    throw new Error(message)
  }
}

function parseSwarmStateForArtifactReview(content: string): {
  tasks: SwarmTaskRecord[]
  artifacts: SwarmArtifactRecord[]
} {
  const parsed = JSON.parse(content) as Record<string, unknown>
  const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : []).flatMap((task): SwarmTaskRecord[] => {
    if (!task || typeof task !== 'object') return []
    const record = task as Record<string, unknown>
    return typeof record.id === 'string' && typeof record.status === 'string'
      ? [{
          id: record.id,
          status: record.status,
          ownerAgentId: typeof record.ownerAgentId === 'string' ? record.ownerAgentId : '',
        }]
      : []
  })
  const artifacts = (Array.isArray(parsed.artifacts) ? parsed.artifacts : []).flatMap((artifact): SwarmArtifactRecord[] => {
    if (!artifact || typeof artifact !== 'object') return []
    const record = artifact as Record<string, unknown>
    if (typeof record.id !== 'string') return []
    return [{
      id: record.id,
      kind: typeof record.kind === 'string' ? record.kind : '',
      title: typeof record.title === 'string' ? record.title : '',
      path: typeof record.path === 'string' ? record.path : '',
      status: typeof record.status === 'string' ? record.status : '',
      createdBy: typeof record.createdBy === 'string' ? record.createdBy : '',
      taskId: typeof record.taskId === 'string' ? record.taskId : '',
    }]
  })
  return { tasks, artifacts }
}

function getArtifactAutoApprovalBlocker(
  artifact: SwarmArtifactRecord,
  tasks: SwarmTaskRecord[],
  artifacts: SwarmArtifactRecord[]
): string | null {
  if (artifact.status === 'approved') return 'Artifact is already approved.'
  if (artifact.status === 'superseded') return 'Superseded artifacts are obsolete and cannot receive auto-approval intent.'
  if (!['draft', 'ready_for_review', 'changes_requested'].includes(artifact.status)) {
    return 'Artifact status is not eligible for auto-approval intent.'
  }
  if (!artifact.path.trim()) return 'Artifact file path is missing.'
  if (!autoApprovableArtifactKinds.has(artifact.kind)) return 'Artifact kind is not eligible for auto-approval intent.'

  const task = tasks.find((candidate) => candidate.id === artifact.taskId)
  if (!task) return 'Artifact task was not found.'
  if (!artifact.createdBy.trim() && !task.ownerAgentId.trim()) {
    return 'Artifact task has no responsible agent to receive auto-approval intent.'
  }

  const blockingArtifacts = artifacts.filter((candidate) =>
    candidate.taskId === task.id
    && candidate.status !== 'approved'
    && candidate.status !== 'superseded'
    && autoApprovableArtifactKinds.has(candidate.kind)
  )
  if (blockingArtifacts.length === 0) return 'No blocking review artifact is waiting for approval.'

  const ineligibleBlockingArtifact = blockingArtifacts.find((candidate) =>
    !['draft', 'ready_for_review', 'changes_requested'].includes(candidate.status) || !candidate.path.trim()
  )
  if (ineligibleBlockingArtifact) {
    return `Related artifact ${ineligibleBlockingArtifact.id} is not eligible for auto-approval.`
  }

  return null
}

async function assertAutoApprovalAllowed(state: ValidSwarmStatePath, artifactId: string): Promise<SwarmArtifactRecord> {
  const stateContent = await readFile(state.statePath, 'utf8')
  const { tasks, artifacts } = parseSwarmStateForArtifactReview(stateContent)
  const artifact = artifacts.find((candidate) => candidate.id === artifactId)
  if (!artifact) throw new Error('Requested artifact was not found in the swarm state.')

  const blocker = getArtifactAutoApprovalBlocker(artifact, tasks, artifacts)
  if (blocker) throw new Error(blocker)
  if (/^https?:\/\//i.test(artifact.path)) throw new Error('Remote artifact links cannot be auto-approved.')

  const artifactPath = resolveArtifactFilePath(state, artifact.path)
  const artifactStats = await stat(artifactPath)
  if (!artifactStats.isFile()) throw new Error('Artifact path must be a file.')
  await readFile(artifactPath, 'utf8')
  return artifact
}

async function reviewSwarmArtifact(
  payload: SwarmArtifactReviewPayload,
  action: SwarmArtifactReviewAction,
  mode: SwarmArtifactReviewMode
): Promise<SwarmArtifactCommandResult> {
  try {
    const state = validateSwarmStatePath(payload?.statePath)
    const artifactId = resolveSwarmArtifactId(payload?.artifactId)
    const actor = await requireSwarmMcpAuthority()
    let feedback: string | undefined

    if (action === 'request-changes') {
      feedback = typeof payload?.feedback === 'string' ? payload.feedback.trim() : ''
      if (!feedback) return { ok: false, message: 'Artifact change requests require feedback.' }
    }
    if (mode === 'auto-run') {
      if (action !== 'approve') throw new Error('Auto-run can only approve eligible artifacts.')
      const artifact = await assertAutoApprovalAllowed(state, artifactId)
      const stateContent = await readFile(state.statePath, 'utf8')
      return {
        ok: true,
        data: {
          action: 'approve-intent',
          actor: 'auto-run',
          authorizedUserId: actor.id,
          artifactId,
          artifact,
          stateContent,
        },
      }
    }

    const reviewPayload = {
      statePath: state.statePath,
      artifactId,
      id: actor.id,
      ...(feedback ? { feedback } : {}),
    }
    const toolName = action === 'approve' ? 'swarm.artifact.approve' : 'swarm.artifact.request_changes'

    const toolResult = await runSwarmMcpTool(state, toolName, reviewPayload, actor)
    if (toolResult.exitCode !== 0 || !toolResult.response?.ok) {
      const message = toolResult.response && !toolResult.response.ok
        ? toolResult.response.error?.message
        : undefined
      return {
        ok: false,
        message: message ?? (toolResult.stderr.trim() || 'The swarm MCP command failed.'),
        stdout: toolResult.stdout,
        stderr: toolResult.stderr,
        exitCode: toolResult.exitCode ?? 'unknown',
      }
    }

    const stateContent = await readFile(state.statePath, 'utf8')
    return {
      ok: true,
      data: {
        action,
        actor: reviewPayload.id,
        authorizedUserId: actor.id,
        artifactId,
        stateContent,
        tool: toolResult.response.result,
      },
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

function buildSwarmShellBootstrap(swarmStatePath?: string): string {
  const shellStatePath =
    swarmStatePath && process.platform === 'win32' ? toWslPath(swarmStatePath) : swarmStatePath
  const bundledToolPath = getBundledSwarmToolPath()
  const shellBundledToolPath =
    bundledToolPath && process.platform === 'win32' ? toWslPath(bundledToolPath) : bundledToolPath
  const lines = [
    'export SWARM_REPO_TOOL_PATH="$PWD/.agents/skills/swarm-kanban/scripts/swarm_tool.py"',
    'export SWARM_REPO_WRAPPER_PATH="$PWD/scripts/swarm_tool.py"',
  ]

  if (shellStatePath) {
    lines.push(`export SWARM_STATE_PATH=${quotePosix(shellStatePath)}`)
  }

  if (shellBundledToolPath) {
    lines.push(`export MULTICODE_SWARM_TOOL_PATH=${quotePosix(shellBundledToolPath)}`)
  }

  lines.push(
    [
      'swarm() {',
      'local tool_path="";',
      'if [ -f "$SWARM_REPO_WRAPPER_PATH" ]; then tool_path="$SWARM_REPO_WRAPPER_PATH";',
      'elif [ -f "$SWARM_REPO_TOOL_PATH" ]; then tool_path="$SWARM_REPO_TOOL_PATH";',
      'elif [ -n "${MULTICODE_SWARM_TOOL_PATH:-}" ] && [ -f "$MULTICODE_SWARM_TOOL_PATH" ]; then tool_path="$MULTICODE_SWARM_TOOL_PATH";',
      'else echo "swarm tool not found" >&2; return 127; fi;',
      'local python_exe="python3";',
      'if [ -x "$PWD/.venv/bin/python" ]; then python_exe="$PWD/.venv/bin/python";',
      'elif [ -x "$PWD/.venv/Scripts/python.exe" ]; then python_exe="$PWD/.venv/Scripts/python.exe"; fi;',
      '"$python_exe" "$tool_path" "$@";',
      '}',
    ].join(' '),
    'export -f swarm >/dev/null 2>&1 || true',
  )

  return lines.join('; ')
}

function buildUserShellStartup(): string {
  return [
    'for profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do [ -r "$profile" ] && . "$profile" && break; done',
    '[ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
    '[ -d "$HOME/.npm-global/bin" ] && export PATH="$HOME/.npm-global/bin:$PATH"',
  ].join('; ')
}

function isLoginShell(shellName: string | undefined): boolean {
  return shellName === 'bash' || shellName === 'zsh'
}

function buildInteractiveShellExec(shellPath: string, shellName: string | undefined): string {
  const loginArg = isLoginShell(shellName) ? ' -l' : ''
  return `exec ${quotePosixCommand(shellPath)}${loginArg}`
}

function createTerminalStartupScript(
  sessionId: string,
  extension: 'sh' | 'ps1',
  content: string
): string {
  const scriptDirectory = join(app.getPath('userData'), 'terminal-startup')
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  const scriptPath = join(scriptDirectory, `${safeSessionId}-${Date.now()}.${extension}`)
  mkdirSync(scriptDirectory, { recursive: true })
  writeFileSync(scriptPath, `${content.trim()}\n`, { encoding: 'utf8', mode: 0o600 })
  return scriptPath
}

function cleanupTerminalStartupScript(scriptPath: string | undefined): void {
  if (!scriptPath) return
  void unlink(scriptPath).catch(() => {})
}

function buildWslShellScript(
  cwd: string,
  sessionId: string,
  resume = false,
  swarmStatePath?: string,
  cli: AgentCli = 'codex',
  initialPrompt?: string,
  cliRuntime?: CliRuntimeSettings,
  cliPermissionPreset: SwarmCliPermissionPreset = 'default'
): string {
  const shellInitialPrompt = normalizeInitialPromptPaths(initialPrompt, 'wsl', [cwd, swarmStatePath])
  return [
    buildUserShellStartup(),
    `cd ${quotePosix(toWslPath(cwd))}`,
    buildSwarmShellBootstrap(swarmStatePath),
    buildAgentLaunchCommand(cli, sessionId, resume, shellInitialPrompt, cliRuntime, cliPermissionPreset),
    'exec bash -li',
  ].join('; ')
}

function getShellLaunchConfig(
  cwd: string,
  sessionId: string,
  resume = false,
  swarmStatePath?: string,
  cli: AgentCli = 'codex',
  initialPrompt?: string,
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
  cliPermissionPreset: SwarmCliPermissionPreset = 'default'
): ShellLaunchConfig {
  const cliRuntime = getCliRuntimeSettings(cli, cliRuntimes)

  if (process.platform === 'win32' && !cliRuntime.useWsl) {
    const windowsCwd = toWindowsPath(cwd)
    const windowsStatePath = swarmStatePath ? toWindowsPath(swarmStatePath) : undefined
    const shellInitialPrompt = normalizeInitialPromptPaths(initialPrompt, 'windows', [cwd, swarmStatePath])
    if (!isNativeWindowsPath(windowsCwd)) {
      throw new Error(
        `Workspace path "${cwd}" is not available as a Windows path. Turn on "Run through WSL" for ${cli}.`
      )
    }
    const startupScriptPath = createTerminalStartupScript(
      sessionId,
      'ps1',
      buildNativeAgentLaunchPowerShellScript(
        cli,
        sessionId,
        resume,
        windowsCwd,
        shellInitialPrompt,
        cliRuntime,
        cliPermissionPreset
      )
    )

    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', startupScriptPath],
      env: withSwarmEnv(getTerminalEnv(), windowsCwd, windowsStatePath),
      cwd: windowsCwd,
      startupScriptPath,
    }
  }

  if (process.platform === 'win32') {
    const startupScriptPath = createTerminalStartupScript(
      sessionId,
      'sh',
      buildWslShellScript(
        cwd,
        sessionId,
        resume,
        swarmStatePath,
        cli,
        initialPrompt,
        cliRuntime,
        cliPermissionPreset
      )
    )
    return {
      command: 'wsl.exe',
      args: [
        '-e',
        'bash',
        '-li',
        toWslPath(startupScriptPath),
      ],
      startupScriptPath,
    }
  }

  const shellPath = process.env.SHELL || 'bash'
  const shellName = shellPath.split(/[\\/]/).at(-1)
  const launchCommand = [
    buildSwarmShellBootstrap(swarmStatePath),
    buildAgentLaunchCommand(cli, sessionId, resume, initialPrompt, cliRuntime, cliPermissionPreset),
    buildInteractiveShellExec(shellPath, shellName),
  ].join('; ')
  const startupScriptPath = createTerminalStartupScript(sessionId, 'sh', launchCommand)

  return {
    command: shellPath,
    args: isLoginShell(shellName) ? ['-l', startupScriptPath] : [startupScriptPath],
    cwd,
    startupScriptPath,
  }
}

function getPlainShellLaunchConfig(
  cwd: string,
  swarmStatePath?: string,
  sessionId = 'plain-terminal'
): ShellLaunchConfig {
  if (process.platform === 'win32') {
    const windowsCwd = toWindowsPath(cwd)
    const windowsStatePath = swarmStatePath ? toWindowsPath(swarmStatePath) : undefined

    if (isNativeWindowsPath(windowsCwd)) {
      return {
        command: 'powershell.exe',
        args: ['-NoLogo'],
        env: withSwarmEnv(getTerminalEnv(), windowsCwd, windowsStatePath),
        cwd: windowsCwd,
      }
    }

    const startupScriptPath = createTerminalStartupScript(
      sessionId,
      'sh',
      [
        buildUserShellStartup(),
        `cd ${quotePosix(toWslPath(cwd))}`,
        buildSwarmShellBootstrap(swarmStatePath),
        'exec bash -li',
      ].join('; ')
    )

    return {
      command: 'wsl.exe',
      args: [
        '-e',
        'bash',
        '-li',
        toWslPath(startupScriptPath),
      ],
      startupScriptPath,
    }
  }

  const shellPath = process.env.SHELL || 'bash'
  const shellName = shellPath.split(/[\\/]/).at(-1)
  const launchCommand = [
    buildSwarmShellBootstrap(swarmStatePath),
    buildInteractiveShellExec(shellPath, shellName),
  ].join('; ')
  const startupScriptPath = createTerminalStartupScript(sessionId, 'sh', launchCommand)

  return {
    command: shellPath,
    cwd,
    args: isLoginShell(shellName) ? ['-l', startupScriptPath] : [startupScriptPath],
    startupScriptPath,
  }
}

function buildNativeAgentLaunchPowerShellScript(
  cli: AgentCli,
  sessionId: string,
  resume: boolean,
  cwd: string,
  initialPrompt: string | undefined,
  cliRuntime: CliRuntimeSettings,
  cliPermissionPreset: SwarmCliPermissionPreset = 'default'
): string {
  const permissionArgs = getCliPermissionArgs(cli, cliPermissionPreset)
  const command = cliRuntime.command || cli
  const promptArg = cli === 'codex' ? nativeWindowsPromptArg(initialPrompt) : initialPrompt
  const args = cli === 'codex'
    ? [
        ...permissionArgs,
        ...(resume ? ['resume'] : []),
        '-C',
        cwd,
        ...(!resume && promptArg ? [promptArg] : []),
      ]
    : [
        ...permissionArgs,
        resume ? '--resume' : '--session-id',
        sessionId,
        ...(promptArg ? [promptArg] : []),
      ]

  return [
    `$ErrorActionPreference = 'Continue'`,
    `Set-Location -LiteralPath ${quotePowerShell(cwd)}`,
    `$command = ${quotePowerShell(command)}`,
    `$arguments = @(${args.map((arg) => powerShellBase64Literal(arg)).join(', ')})`,
    `& $command @arguments`,
  ].join('\r\n')
}

function buildAgentLaunchCommand(
  cli: AgentCli,
  sessionId: string,
  resume = false,
  initialPrompt?: string,
  cliRuntime?: CliRuntimeSettings,
  cliPermissionPreset: SwarmCliPermissionPreset = 'default'
): string {
  if (cli === 'claude') {
    return buildClaudeLaunchCommand(sessionId, resume, initialPrompt, cliRuntime, cliPermissionPreset)
  }
  return buildCodexLaunchCommand(resume, initialPrompt, cliRuntime, cliPermissionPreset)
}

function buildCommandAvailabilityCheck(cli: AgentCli, command: string): string {
  return [
    `if ! command -v ${quotePosixCommand(command)} >/dev/null 2>&1; then`,
    `echo ${quotePosix(`${cli === 'codex' ? 'Codex' : 'Claude'} CLI was not found. Check the ${cli} command in Multicode Settings.`)};`,
    'else',
  ].join(' ')
}

function buildCodexLaunchCommand(
  resume = false,
  initialPrompt?: string,
  cliRuntime?: CliRuntimeSettings,
  cliPermissionPreset: SwarmCliPermissionPreset = 'default'
): string {
  const promptArg = initialPrompt ? ` ${quotePosix(initialPrompt)}` : ''
  const configuredCommand = cliRuntime?.command?.trim()
  const permissionArgs = getCliPermissionArgs('codex', cliPermissionPreset).map(quotePosixCommand)
  const permissionArgText = permissionArgs.length ? ` ${permissionArgs.join(' ')}` : ''

  return [
    buildCommandAvailabilityCheck('codex', configuredCommand || 'codex'),
    resume
      ? `${quotePosixCommand(configuredCommand || 'codex')}${permissionArgText} resume;`
      : `${quotePosixCommand(configuredCommand || 'codex')}${permissionArgText}${promptArg};`,
    'fi',
  ].join(' ')
}

function buildClaudeLaunchCommand(
  sessionId: string,
  resume = false,
  initialPrompt?: string,
  cliRuntime?: CliRuntimeSettings,
  cliPermissionPreset: SwarmCliPermissionPreset = 'default'
): string {
  const quotedSessionId = quotePosix(sessionId)
  const claudeCommand = quotePosixCommand(cliRuntime?.command?.trim() || 'claude')
  const configuredCommand = cliRuntime?.command?.trim() || 'claude'
  const promptArg = initialPrompt ? ` ${quotePosix(initialPrompt)}` : ''
  const permissionArgs = getCliPermissionArgs('claude', cliPermissionPreset).map(quotePosixCommand)
  const permissionArgText = permissionArgs.length ? ` ${permissionArgs.join(' ')}` : ''

  if (!resume) {
    return [
      buildCommandAvailabilityCheck('claude', configuredCommand),
      `${claudeCommand}${permissionArgText} --session-id ${quotedSessionId}${promptArg};`,
      'fi',
    ].join(' ')
  }

  // Some panes get a generated session id before the user actually starts a Claude
  // conversation. In that case there is nothing persisted to resume yet, so fall
  // back to starting a fresh session with the same id instead of surfacing the
  // "No conversation found" error on every app launch.
  return [
    buildCommandAvailabilityCheck('claude', configuredCommand),
    `if find "$HOME/.claude/projects" -type f -name ${quotePosix(`${sessionId}.jsonl`)} -print -quit 2>/dev/null | grep -q .; then`,
    `${claudeCommand}${permissionArgText} --resume ${quotedSessionId}${promptArg};`,
    `else`,
    `${claudeCommand}${permissionArgText} --session-id ${quotedSessionId}${promptArg};`,
    `fi`,
    'fi',
  ].join(' ')
}

function sendTerminalEvent(
  sender: Electron.WebContents,
  channel: string,
  payload: string | number
): void {
  if (!sender.isDestroyed()) {
    sender.send(channel, payload)
  }
}

function broadcastTerminalSessionsChanged(): void {
  const snapshots = [...terminals.values()]
    .filter((session) => !session.hasExited && !session.isDisposed)
    .map(getTerminalSnapshot)

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('terminal:sessions-changed', snapshots)
    }
  }
}

function logMainPerfEvent(scope: string, event: string, payload: Record<string, unknown>): void {
  if (app.isPackaged && !MULTICODE_DIAGNOSTICS) return
  console.info(`[${scope}] ${event}`, payload)
}

async function withIpcDiagnostics<T>(
  scope: string,
  event: string,
  payload: Record<string, unknown>,
  action: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now()
  try {
    const result = await action()
    const elapsedMs = Date.now() - startedAt
    if (MULTICODE_DIAGNOSTICS || elapsedMs >= DIAGNOSTIC_SLOW_IPC_MS) {
      logMainPerfEvent(scope, event, {
        ...payload,
        elapsedMs,
        ok: true,
      })
    }
    return result
  } catch (error) {
    logMainPerfEvent(scope, `${event}-error`, {
      ...payload,
      elapsedMs: Date.now() - startedAt,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

function recordTerminalDataBatch(
  session: TerminalSession | undefined,
  cause: 'timer' | 'exit' | 'dispose',
  chunkCount: number,
  byteCount: number
): void {
  if (!session || chunkCount === 0) return

  const now = Date.now()
  const stats = terminalBatchDiagnostics.get(session.sessionId) ?? {
    batches: 0,
    chunks: 0,
    bytes: 0,
    lastLogAt: now,
  }

  stats.batches += 1
  stats.chunks += chunkCount
  stats.bytes += byteCount

  if (cause !== 'timer' || now - stats.lastLogAt >= TERMINAL_BATCH_DIAGNOSTIC_INTERVAL_MS) {
    logMainPerfEvent('Terminal', 'output-batches', {
      sessionId: session.sessionId,
      kind: session.kind,
      workspaceId: session.workspaceId,
      cause,
      batches: stats.batches,
      chunks: stats.chunks,
      bytes: stats.bytes,
      retainedOutputBytes: session.outputBytes,
    })
    stats.batches = 0
    stats.chunks = 0
    stats.bytes = 0
    stats.lastLogAt = now
  }

  terminalBatchDiagnostics.set(session.sessionId, stats)
}

function recordTerminalInputWrite(
  session: TerminalSession | undefined,
  byteCount: number,
  elapsedMs: number,
  ok: boolean
): void {
  if (!session || !MULTICODE_DIAGNOSTICS) return

  const now = Date.now()
  const stats = terminalInputDiagnostics.get(session.sessionId) ?? {
    writes: 0,
    bytes: 0,
    totalMs: 0,
    maxMs: 0,
    errors: 0,
    lastLogAt: now,
  }

  stats.writes += 1
  stats.bytes += byteCount
  stats.totalMs += elapsedMs
  stats.maxMs = Math.max(stats.maxMs, elapsedMs)
  if (!ok) stats.errors += 1

  if (now - stats.lastLogAt >= TERMINAL_INPUT_DIAGNOSTIC_INTERVAL_MS || elapsedMs >= TERMINAL_SLOW_INPUT_WRITE_MS || !ok) {
    logMainPerfEvent('Terminal', 'input-writes', {
      sessionId: session.sessionId,
      kind: session.kind,
      workspaceId: session.workspaceId,
      agentId: session.agentId,
      terminalId: session.terminalId,
      writes: stats.writes,
      bytes: stats.bytes,
      avgMs: stats.writes > 0 ? Math.round((stats.totalMs / stats.writes) * 10) / 10 : 0,
      maxMs: Math.round(stats.maxMs * 10) / 10,
      errors: stats.errors,
    })
    stats.writes = 0
    stats.bytes = 0
    stats.totalMs = 0
    stats.maxMs = 0
    stats.errors = 0
    stats.lastLogAt = now
  }

  terminalInputDiagnostics.set(session.sessionId, stats)
}

function trimPendingTerminalChunks(chunks: string[], maxBytes: number): { chunks: string[]; bytes: number; dropped: boolean } {
  let bytes = 0
  const retained: string[] = []

  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index] ?? ''
    const chunkBytes = Buffer.byteLength(chunk)
    if (bytes + chunkBytes <= maxBytes) {
      retained.unshift(chunk)
      bytes += chunkBytes
      continue
    }

    const remainingBytes = maxBytes - bytes
    if (remainingBytes > 0) {
      const tail = Buffer.from(chunk)
        .subarray(Math.max(0, chunkBytes - remainingBytes))
        .toString('utf8')
      retained.unshift(tail)
      bytes += Buffer.byteLength(tail)
    }
    retained.unshift('\r\n[Multicode: terminal output throttled to keep the UI responsive]\r\n')
    return {
      chunks: retained,
      bytes: retained.reduce((total, value) => total + Buffer.byteLength(value), 0),
      dropped: true,
    }
  }

  return { chunks: retained, bytes, dropped: false }
}

function flushTerminalData(sessionId: string, cause: 'timer' | 'exit' | 'dispose' = 'timer'): void {
  const pending = pendingTerminalData.get(sessionId)
  if (!pending) return

  pendingTerminalData.delete(sessionId)
  clearTimeout(pending.timer)
  const data = pending.chunks.join('')
  sendTerminalEvent(pending.sender, pending.channel, data)
  recordTerminalDataBatch(
    terminals.get(sessionId),
    cause,
    pending.chunks.length,
    Buffer.byteLength(data)
  )
}

function sendTerminalData(session: TerminalSession, data: string): void {
  const channel = `terminal:data:${session.sessionId}`
  const pending = pendingTerminalData.get(session.sessionId)
  if (pending) {
    pending.sender = session.sender
    pending.channel = channel
    pending.chunks.push(data)
    pending.bytes += Buffer.byteLength(data)
    if (pending.bytes > TERMINAL_PENDING_DATA_LIMIT) {
      const trimmed = trimPendingTerminalChunks(pending.chunks, TERMINAL_PENDING_DATA_LIMIT)
      pending.chunks = trimmed.chunks
      pending.bytes = trimmed.bytes
    }
    return
  }

  const delayMs = getTerminalDataBatchDelay(session, data)
  const timer = setTimeout(() => {
    flushTerminalData(session.sessionId, 'timer')
  }, delayMs)
  pendingTerminalData.set(session.sessionId, {
    sender: session.sender,
    channel,
    chunks: [data],
    bytes: Buffer.byteLength(data),
    timer,
  })
}

function getTerminalDataBatchDelay(session: TerminalSession, data: string): number {
  const recentInput = session.lastInputAt !== null
    && Date.now() - session.lastInputAt <= TERMINAL_RECENT_INPUT_WINDOW_MS
  const smallOutput = Buffer.byteLength(data) <= TERMINAL_INTERACTIVE_DATA_LIMIT

  return recentInput && smallOutput
    ? TERMINAL_INTERACTIVE_DATA_BATCH_MS
    : TERMINAL_DATA_BATCH_MS
}

function getTerminalErrorMessage(error: unknown): string {
  if (error instanceof Error && /enoent/i.test(error.message)) {
    return process.platform === 'win32'
      ? 'WSL could not be started. Make sure your default WSL distro is installed and available.'
      : 'Agent CLI shell could not be started. Make sure your login shell is available.'
  }

  return error instanceof Error ? error.message : String(error)
}

function getTerminalSize(cols: number, rows: number): TerminalSize {
  return {
    cols: Math.max(Number.isFinite(cols) ? Math.floor(cols) : 80, 20),
    rows: Math.max(Number.isFinite(rows) ? Math.floor(rows) : 24, 8),
  }
}

function safeResizeTerminal(sessionId: string, cols: number, rows: number): void {
  const session = terminals.get(sessionId)
  if (!session || session.hasExited || session.isDisposed) return

  const size = getTerminalSize(cols, rows)
  if (process.platform === 'win32' && !session.isReady) {
    session.pendingResize = size
    return
  }

  try {
    session.process.resize(size.cols, size.rows)
  } catch {
    // node-pty can report resize-after-exit races before its exit event is delivered.
    session.hasExited = true
  }
}

function flushPendingTerminalResize(sessionId: string, session: TerminalSession): void {
  const pendingResize = session.pendingResize
  if (!pendingResize) return

  session.pendingResize = undefined
  safeResizeTerminal(sessionId, pendingResize.cols, pendingResize.rows)
}

function trimTerminalChunkToReplayLimit(data: string): { data: string; bytes: number } {
  const bytes = Buffer.byteLength(data)
  if (bytes <= TERMINAL_REPLAY_BUFFER_LIMIT) return { data, bytes }

  const trimmed = Buffer.from(data)
    .subarray(bytes - TERMINAL_REPLAY_BUFFER_LIMIT)
    .toString('utf8')

  return {
    data: trimmed,
    bytes: Buffer.byteLength(trimmed),
  }
}

function appendTerminalOutput(session: TerminalSession, data: string): void {
  const chunk = trimTerminalChunkToReplayLimit(data)
  session.outputChunks.push(chunk.data)
  session.outputChunkBytes.push(chunk.bytes)
  session.outputBytes += chunk.bytes
  session.outputLength += chunk.data.length
  session.lastOutputAt = Date.now()

  while (
    session.outputBytes > TERMINAL_REPLAY_BUFFER_LIMIT
    && session.outputChunkStart < session.outputChunks.length
  ) {
    const removed = session.outputChunks[session.outputChunkStart]
    const removedBytes = session.outputChunkBytes[session.outputChunkStart] ?? 0
    session.outputChunkStart += 1
    session.outputBytes -= removedBytes
    session.outputLength -= removed?.length ?? 0
  }

  if (
    session.outputChunkStart >= TERMINAL_REPLAY_COMPACT_THRESHOLD
    && session.outputChunkStart > session.outputChunks.length / 2
  ) {
    session.outputChunks.splice(0, session.outputChunkStart)
    session.outputChunkBytes.splice(0, session.outputChunkStart)
    session.outputChunkStart = 0
  }
}

function materializeTerminalReplay(session: TerminalSession): string {
  return session.outputChunks.slice(session.outputChunkStart).join('')
}

function getTerminalSnapshot(session: TerminalSession): TerminalSessionSnapshot {
  return {
    sessionId: session.sessionId,
    running: !session.hasExited && !session.isDisposed,
    kind: session.kind,
    workspaceId: session.workspaceId,
    agentId: session.agentId,
    terminalId: session.terminalId,
    cli: session.cli,
    cwd: session.cwd,
    swarmStatePath: session.swarmStatePath,
    executionMode: session.executionMode,
    worktreeId: session.worktreeId,
    worktreePath: session.worktreePath,
    startedAt: session.startedAt,
    lastOutputAt: session.lastOutputAt,
    outputBufferLength: session.outputLength,
    retainedOutputBytes: session.outputBytes,
  }
}

function disposeTerminal(sessionId: string): void {
  const session = terminals.get(sessionId)
  if (!session) return

  cleanupTerminalStartupScript(session.startupScriptPath)
  flushTerminalData(sessionId, 'dispose')
  terminalBatchDiagnostics.delete(sessionId)
  terminalInputDiagnostics.delete(sessionId)
  session.isDisposed = true
  session.hasExited = true
  terminals.delete(sessionId)
  broadcastTerminalSessionsChanged()

  try {
    session.process.kill()
  } catch {
    // ignore kill errors if process died first
  }
}

function disposeOtherAgentSessions(
  sessionId: string,
  workspaceId: string | undefined,
  agentId: string | undefined,
  swarmStatePath: string | undefined
): void {
  if (!workspaceId || !agentId) return

  const duplicateSessionIds = [...terminals.values()]
    .filter((session) => (
      session.sessionId !== sessionId
      && !session.hasExited
      && !session.isDisposed
      && session.kind === 'agent'
      && session.workspaceId === workspaceId
      && session.agentId === agentId
      && (!swarmStatePath || !session.swarmStatePath || session.swarmStatePath === swarmStatePath)
    ))
    .map((session) => session.sessionId)

  duplicateSessionIds.forEach(disposeTerminal)
}

function disposeFileWatcher(watchId: string): void {
  const fileWatcher = fileWatchers.get(watchId)
  if (!fileWatcher) return

  if (fileWatcher.flushTimer) {
    clearTimeout(fileWatcher.flushTimer)
  }
  fileWatcher.watcher.close()
  fileWatchers.delete(watchId)
}

function flushFileWatchEvent(watchId: string): void {
  const fileWatcher = fileWatchers.get(watchId)
  if (!fileWatcher) return

  fileWatcher.flushTimer = null
  const watchEvent = fileWatcher.pendingEvent
  fileWatcher.pendingEvent = null
  if (!watchEvent) return

  const sender = BrowserWindow.getAllWindows()
    .map((window) => window.webContents)
    .find((webContents) => webContents.id === fileWatcher.senderId)
  if (!sender || sender.isDestroyed()) return

  sender.send(`fs:watch-event:${watchId}`, watchEvent)
}

function scheduleFileWatchEvent(watchId: string, watchEvent: FileWatchEvent): void {
  const fileWatcher = fileWatchers.get(watchId)
  if (!fileWatcher) return

  fileWatcher.pendingEvent = fileWatcher.pendingEvent
    ? { eventType: 'change', path: null }
    : watchEvent

  if (fileWatcher.flushTimer) clearTimeout(fileWatcher.flushTimer)
  fileWatcher.flushTimer = setTimeout(() => flushFileWatchEvent(watchId), FILE_WATCH_EVENT_COALESCE_MS)
}

function createMobileCommandService(): MobileSwarmCommandService {
  const orchestrator = new DesktopMobileSwarmSessionOrchestrator({
    adapters: {
      listTerminals: async () => {
        return [...terminals.values()].map(getTerminalSnapshot)
      },
      spawnAgentTerminal: spawnMobileAgentTerminal,
      writeTerminal: (sessionId, data) => {
        const session = terminals.get(sessionId)
        if (!session || session.hasExited || session.isDisposed) {
          throw new Error('Desktop terminal session is no longer running.')
        }
        session.process.write(data)
      },
      pathExists,
      listGitWorktrees: async (repoRoot) => {
        const snapshot = await listGitWorktrees(repoRoot)
        if (!snapshot.ok) return { ok: false, message: snapshot.message }
        return {
          ok: true,
          data: {
            worktrees: snapshot.data.worktrees.map((worktree) => ({ path: worktree.path, branch: worktree.branch })),
          },
        }
      },
      createGitWorktree,
    },
  })

  return new MobileSwarmCommandService({
    workspaceRoot: process.cwd(),
    sessionOrchestrator: orchestrator,
  })
}

async function spawnMobileAgentTerminal(input: {
  sessionId: string
  cwd: string
  swarmStatePath: string
  agentId: string
  initialPrompt: string
  cli: AgentCli
  executionMode: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
}): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }> {
  const sender = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())?.webContents
  if (!sender) {
    return { ok: false, message: 'No desktop window is available to host a mobile-started agent terminal.' }
  }

  try {
    requireAuthenticatedMulticodeUser('Sign in to launch Sprint Engine specialist workflows from the app.')
  } catch (error) {
    return { ok: false, message: getErrorMessage(error) }
  }

  disposeTerminal(input.sessionId)

  try {
    const { command, args, cwd: launchCwd, initialInput, env, startupScriptPath } = getShellLaunchConfig(
      input.cwd,
      input.sessionId,
      false,
      input.swarmStatePath,
      input.cli,
      input.initialPrompt,
      undefined,
      'auto_workspace'
    )
    const initialSize = getTerminalSize(120, 30)
    const termProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: initialSize.cols,
      rows: initialSize.rows,
      cwd: launchCwd ?? input.cwd,
      env: env ?? getTerminalEnv(),
    })
    const terminalSession: TerminalSession = {
      sessionId: input.sessionId,
      process: termProcess,
      sender,
      isReady: process.platform !== 'win32',
      hasExited: false,
      isDisposed: false,
      outputChunks: [],
      outputChunkBytes: [],
      outputChunkStart: 0,
      outputBytes: 0,
      outputLength: 0,
      kind: 'agent',
      agentId: input.agentId,
      cli: input.cli,
      cwd: launchCwd ?? input.cwd,
      swarmStatePath: input.swarmStatePath,
      executionMode: input.executionMode,
      worktreeId: input.worktreeId,
      worktreePath: input.worktreePath,
      startedAt: Date.now(),
      lastOutputAt: null,
      lastInputAt: null,
      startupScriptPath,
    }

    terminals.set(input.sessionId, terminalSession)
    broadcastTerminalSessionsChanged()
    termProcess.onData((data) => {
      if (!terminalSession.isReady) {
        terminalSession.isReady = true
        flushPendingTerminalResize(input.sessionId, terminalSession)
      }
      appendTerminalOutput(terminalSession, data)
      sendTerminalData(terminalSession, data)
    })
    termProcess.onExit((event) => {
      cleanupTerminalStartupScript(terminalSession.startupScriptPath)
      flushTerminalData(input.sessionId, 'exit')
      terminalBatchDiagnostics.delete(input.sessionId)
      terminalInputDiagnostics.delete(input.sessionId)
      terminalSession.hasExited = true
      if (terminals.get(input.sessionId) === terminalSession) {
        terminals.delete(input.sessionId)
        broadcastTerminalSessionsChanged()
      }
      if (!terminalSession.isDisposed) {
        sendTerminalEvent(terminalSession.sender, `terminal:exit:${input.sessionId}`, event.exitCode)
      }
    })
    if (initialInput) {
      termProcess.write(initialInput)
    }

    return { ok: true, sessionId: input.sessionId }
  } catch (error) {
    return { ok: false, message: getTerminalErrorMessage(error) }
  }
}

async function discoverMobileSwarmStatePaths(): Promise<string[]> {
  const swarmRoot = join(process.cwd(), 'swarm')
  let entries
  try {
    entries = await readdir(swarmRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const statePaths = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const statePath = join(swarmRoot, entry.name, 'state.yaml')
        return (await pathExists(statePath)) ? statePath : null
      })
  )
  return statePaths.filter((statePath): statePath is string => Boolean(statePath))
}

function disposeFileWatchersForSender(senderId: number): void {
  for (const [watchId, fileWatcher] of fileWatchers.entries()) {
    if (fileWatcher.senderId === senderId) {
      if (fileWatcher.flushTimer) {
        clearTimeout(fileWatcher.flushTimer)
      }
      fileWatcher.watcher.close()
      fileWatchers.delete(watchId)
    }
  }
}

ipcMain.handle('window:minimize', (event) => {
  getRequestWindow(event)?.minimize()
})

ipcMain.handle('window:toggle-maximize', (event) => {
  const win = getRequestWindow(event)
  if (!win) return null

  if (win.isFullScreen()) {
    win.setFullScreen(false)
  } else if (win.isMaximized()) {
    win.unmaximize()
  } else {
    win.maximize()
  }

  return getWindowState(win)
})

ipcMain.handle('window:close', (event) => {
  getRequestWindow(event)?.close()
})

ipcMain.handle('window:get-state', (event) => {
  const win = getRequestWindow(event)
  return win ? getWindowState(win) : null
})

ipcMain.handle('auth:get-state', () => multicodeAuth.initialize())

ipcMain.handle('auth:login', (_, organizationId?: string | null) => multicodeAuth.login(organizationId))

ipcMain.handle('auth:logout', () => multicodeAuth.logout())

ipcMain.handle('auth:refresh-entitlements', () => multicodeAuth.refreshEntitlements({ forceRefresh: true }))

ipcMain.handle('auth:select-organization', (_, organizationId: string) => multicodeAuth.selectOrganization(organizationId))

ipcMain.handle('auth:open-upgrade', (_, reason?: string) => multicodeAuth.openUpgrade(reason))

ipcMain.handle('auth:check-premium-access', (_, input: PremiumAccessRequest) => multicodeAuth.checkPremiumAccess(input))

ipcMain.handle('auth:get-session', () => multicodeAuth.getSession())

ipcMain.handle('auth:get-entitlements', (_, options?: { forceRefresh?: boolean }) => multicodeAuth.getEntitlements(options))

ipcMain.handle('auth:require-entitlement', (_, input: PremiumAccessRequest | string) => multicodeAuth.requireEntitlement(input))

ipcMain.handle('auth:check-usage', (_, input: UsageRequest) => multicodeAuth.checkUsage(input))

ipcMain.handle('auth:consume-usage', (_, input: UsageRequest) => multicodeAuth.consumeUsage(input))

ipcMain.handle('auth:release-usage', (_, input: UsageRequest) => multicodeAuth.releaseUsage(input))

ipcMain.handle('mobile-bridge:get-state', () => mobileBridge.getState())

ipcMain.handle('mobile-bridge:update-settings', (_, input: MobileBridgeSettingsUpdate) => {
  return mobileBridge.updateSettings(input)
})

ipcMain.handle('mobile-bridge:request-pairing-code', () => mobileBridge.requestPairingCode())

ipcMain.handle('mobile-bridge:list-devices', () => mobileBridge.listDevices())

ipcMain.handle('mobile-bridge:revoke-device', (_, deviceId: string, reason?: string) => {
  return mobileBridge.revokeDevice(deviceId, reason)
})

ipcMain.handle('mobile-bridge:publish-presence', (_, presence: MobileBridgePresence) => {
  return mobileBridge.publishPresence(presence)
})

ipcMain.handle('mobile-bridge:get-diagnostics', () => mobileBridge.getDiagnostics())

ipcMain.handle(
  'terminal:spawn',
  async (event, {
    sessionId,
    cols,
    rows,
    cwd,
    resume,
    swarmStatePath,
    cli = 'codex',
    initialPrompt,
    cliRuntimes,
    shellOnly,
    kind,
    workspaceId,
    agentId,
    terminalId,
    executionMode,
    worktreeId,
    worktreePath,
    cliPermissionPreset = 'default',
  }: TerminalSpawnPayload) => {
    const existingSession = terminals.get(sessionId)
    if (existingSession && !existingSession.hasExited && !existingSession.isDisposed) {
      existingSession.sender = event.sender
      existingSession.workspaceId = workspaceId ?? existingSession.workspaceId
      existingSession.agentId = agentId ?? existingSession.agentId
      existingSession.terminalId = terminalId ?? existingSession.terminalId
      existingSession.kind = kind ?? existingSession.kind
      existingSession.executionMode = executionMode ?? existingSession.executionMode
      existingSession.worktreeId = worktreeId ?? existingSession.worktreeId
      existingSession.worktreePath = worktreePath ?? existingSession.worktreePath
      safeResizeTerminal(sessionId, cols, rows)
      const replay = materializeTerminalReplay(existingSession)
      if (replay) {
        sendTerminalEvent(event.sender, `terminal:data:${sessionId}`, replay)
      }
      broadcastTerminalSessionsChanged()
      return { ok: true, sessionId } satisfies TerminalSpawnResult
    }

    disposeTerminal(sessionId)

    try {
      const workingDirectory = cwd || process.cwd()
      if (swarmStatePath && (kind ?? (shellOnly ? 'terminal' : 'agent')) === 'agent') {
        try {
          requireAuthenticatedMulticodeUser('Sign in to launch Sprint Engine specialist workflows from the app.')
        } catch (error) {
          const message = getErrorMessage(error)
          sendTerminalEvent(event.sender, `terminal:error:${sessionId}`, message)
          sendTerminalEvent(event.sender, `terminal:exit:${sessionId}`, 1)
          return {
            ok: false,
            sessionId,
            message,
            exitCode: 1,
          } satisfies TerminalSpawnResult
        }
      }
      if ((kind ?? (shellOnly ? 'terminal' : 'agent')) === 'agent') {
        disposeOtherAgentSessions(sessionId, workspaceId, agentId, swarmStatePath)
      }

      const { command, args, cwd: launchCwd, initialInput, env, startupScriptPath } = shellOnly
        ? getPlainShellLaunchConfig(workingDirectory, swarmStatePath, sessionId)
        : getShellLaunchConfig(
          workingDirectory,
          sessionId,
          resume,
          swarmStatePath,
          cli,
          initialPrompt,
          cliRuntimes,
          cliPermissionPreset
        )
      const initialSize = getTerminalSize(cols, rows)
      const termProcess = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols: initialSize.cols,
        rows: initialSize.rows,
        cwd: launchCwd ?? workingDirectory,
        env: env ?? getTerminalEnv(),
      })
      const terminalSession: TerminalSession = {
        sessionId,
        process: termProcess,
        sender: event.sender,
        isReady: process.platform !== 'win32',
        hasExited: false,
        isDisposed: false,
        outputChunks: [],
        outputChunkBytes: [],
        outputChunkStart: 0,
        outputBytes: 0,
        outputLength: 0,
        kind: kind ?? (shellOnly ? 'terminal' : 'agent'),
        workspaceId,
        agentId,
        terminalId,
        cli: shellOnly ? undefined : cli,
        cwd: launchCwd ?? workingDirectory,
        swarmStatePath,
        executionMode,
        worktreeId,
        worktreePath,
        startedAt: Date.now(),
        lastOutputAt: null,
        lastInputAt: null,
        startupScriptPath,
      }

      terminals.set(sessionId, terminalSession)
      broadcastTerminalSessionsChanged()

      termProcess.onData((data) => {
        if (!terminalSession.isReady) {
          terminalSession.isReady = true
          flushPendingTerminalResize(sessionId, terminalSession)
        }
        appendTerminalOutput(terminalSession, data)
        sendTerminalData(terminalSession, data)
      })

      termProcess.onExit((e) => {
        cleanupTerminalStartupScript(terminalSession.startupScriptPath)
        flushTerminalData(sessionId, 'exit')
        terminalBatchDiagnostics.delete(sessionId)
        terminalInputDiagnostics.delete(sessionId)
        terminalSession.hasExited = true
        if (terminals.get(sessionId) === terminalSession) {
          terminals.delete(sessionId)
          broadcastTerminalSessionsChanged()
        }
        if (!terminalSession.isDisposed) {
          sendTerminalEvent(terminalSession.sender, `terminal:exit:${sessionId}`, e.exitCode)
        }
      })

      if (initialInput) {
        // Start the selected agent CLI inside the interactive shell so the user can keep using the terminal afterward.
        termProcess.write(initialInput)
      }

      return { ok: true, sessionId } satisfies TerminalSpawnResult
    } catch (error) {
      const message = getTerminalErrorMessage(error)
      sendTerminalEvent(event.sender, `terminal:error:${sessionId}`, message)
      sendTerminalEvent(event.sender, `terminal:exit:${sessionId}`, 1)
      return {
        ok: false,
        sessionId,
        message,
        exitCode: 1,
      } satisfies TerminalSpawnResult
    }
  }
)

ipcMain.handle('terminal:write', (_, { sessionId, data }: { sessionId: string; data: string }) => {
  const startedAt = Date.now()
  const session = terminals.get(sessionId)
  if (!session || session.hasExited || session.isDisposed) return

  try {
    session.lastInputAt = Date.now()
    session.process.write(data)
    recordTerminalInputWrite(session, Buffer.byteLength(data), Date.now() - startedAt, true)
  } catch {
    session.hasExited = true
    recordTerminalInputWrite(session, Buffer.byteLength(data), Date.now() - startedAt, false)
  }
})

ipcMain.on('terminal:write-fast', (_, payload: unknown) => {
  if (!payload || typeof payload !== 'object') return
  const { sessionId, data } = payload as { sessionId?: unknown; data?: unknown }
  if (typeof sessionId !== 'string' || typeof data !== 'string') return

  const startedAt = Date.now()
  const session = terminals.get(sessionId)
  if (!session || session.hasExited || session.isDisposed) return

  try {
    session.lastInputAt = Date.now()
    session.process.write(data)
    recordTerminalInputWrite(session, Buffer.byteLength(data), Date.now() - startedAt, true)
  } catch {
    session.hasExited = true
    recordTerminalInputWrite(session, Buffer.byteLength(data), Date.now() - startedAt, false)
  }
})

ipcMain.handle('terminal:resize', (_, { sessionId, cols, rows }: { sessionId: string; cols: number; rows: number }) => {
  safeResizeTerminal(sessionId, cols, rows)
})

ipcMain.handle('terminal:status', (_, sessionId: string) => {
  const session = terminals.get(sessionId)
  return {
    running: Boolean(session && !session.hasExited && !session.isDisposed),
  }
})

ipcMain.handle('terminal:list', () => {
  return [...terminals.values()]
    .filter((session) => !session.hasExited && !session.isDisposed)
    .map(getTerminalSnapshot)
})

ipcMain.handle('terminal:kill', (_, sessionId: string) => {
  disposeTerminal(sessionId)
})

// ── Swarm artifact IPC handlers ──────────────────────────────────────────────
// Renderer IPC gets narrow artifact review commands only. The main process owns
// authenticated MCP authority, review actor selection, auto-run policy checks,
// and fresh state snapshots after mutations.

ipcMain.handle('swarm:artifact:open', async (_, payload: SwarmArtifactOpenPayload): Promise<SwarmArtifactCommandResult> => {
  try {
    const state = validateSwarmStatePath(payload?.statePath)
    const targetPath = resolveArtifactFilePath(state, payload?.artifactPath)

    if (/^https?:\/\//i.test(targetPath)) {
      await shell.openExternal(targetPath)
      return { ok: true, data: { path: targetPath } }
    }

    const targetStats = await stat(targetPath)
    if (!targetStats.isFile()) {
      return { ok: false, message: 'Artifact path must be a file.' }
    }

    const content = await readFile(targetPath, 'utf8')
    return { ok: true, data: { path: targetPath, name: basename(targetPath), content } }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('swarm:artifact:approve', async (_, payload: SwarmArtifactReviewPayload): Promise<SwarmArtifactCommandResult> => {
  return reviewSwarmArtifact(payload, 'approve', 'user')
})

ipcMain.handle('swarm:artifact:auto-approve', async (_, payload: SwarmArtifactReviewPayload): Promise<SwarmArtifactCommandResult> => {
  return reviewSwarmArtifact(payload, 'approve', 'auto-run')
})

ipcMain.handle('swarm:artifact:request-changes', async (_, payload: SwarmArtifactReviewPayload): Promise<SwarmArtifactCommandResult> => {
  return reviewSwarmArtifact(payload, 'request-changes', 'user')
})

// ── File system IPC handlers ──────────────────────────────────────────────────

ipcMain.handle('multiloop:init', async (_, payload: MultiloopInitPayload): Promise<MultiloopInitResult> => {
  return initializeMultiloopState(payload)
})

function normalizeFileSearchLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return FILE_SEARCH_DEFAULT_LIMIT
  return Math.min(Math.max(Math.floor(limit), 1), FILE_SEARCH_MAX_LIMIT)
}

function normalizeContentSearchLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return CONTENT_SEARCH_DEFAULT_LIMIT
  return Math.min(Math.max(Math.floor(limit), 1), CONTENT_SEARCH_MAX_LIMIT)
}

function normalizeSearchExcludePatterns(excludes: unknown): string[] {
  if (!Array.isArray(excludes)) return []
  const seen = new Set<string>()
  const patterns: string[] = []

  excludes.forEach((exclude) => {
    if (typeof exclude !== 'string') return
    const pattern = exclude.trim().replace(/\\/g, '/').replace(/^!+/u, '')
    if (!pattern || pattern.length > 200 || seen.has(pattern)) return
    seen.add(pattern)
    patterns.push(pattern)
  })

  return patterns.slice(0, 100)
}

function normalizeSearchPath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase()
}

function hasGlobSyntax(pattern: string): boolean {
  return /[*?[\]{}]/u.test(pattern)
}

function searchExcludeToRipgrepGlobs(pattern: string): string[] {
  if (!hasGlobSyntax(pattern) && !pattern.includes('/')) {
    return [`!**/${pattern}`, `!**/${pattern}/**`]
  }

  return pattern.startsWith('**/')
    ? [`!${pattern}`]
    : [`!${pattern}`, `!**/${pattern}`]
}

function searchExcludeArgs(userExcludes: string[]): string[] {
  const defaultExcludeArgs = FILE_SEARCH_DEFAULT_EXCLUDES.flatMap((pattern) => ['-g', `!**/${pattern}/**`])
  const userExcludeArgs = userExcludes.flatMap((pattern) =>
    searchExcludeToRipgrepGlobs(pattern).flatMap((glob) => ['-g', glob])
  )

  return [...defaultExcludeArgs, ...userExcludeArgs]
}

function toFileSearchEntry(rootPath: string, relativePath: string): FileSearchEntry {
  const normalizedRelativePath = relativePath.replace(/\\/g, sep)
  const fullPath = join(rootPath, normalizedRelativePath)
  const parentRelativePath = dirname(normalizedRelativePath)
  return {
    name: basename(fullPath),
    path: fullPath,
    parentPath: parentRelativePath === '.' ? rootPath : join(rootPath, parentRelativePath),
    isDir: false,
  }
}

function sortFileSearchResults(results: FileSearchEntry[], query: string): FileSearchEntry[] {
  const normalizedQuery = normalizeSearchPath(query)
  return [...results].sort((a, b) => {
    const aName = normalizeSearchPath(a.name)
    const bName = normalizeSearchPath(b.name)
    const aNameIndex = aName.indexOf(normalizedQuery)
    const bNameIndex = bName.indexOf(normalizedQuery)
    const aPath = normalizeSearchPath(a.path)
    const bPath = normalizeSearchPath(b.path)
    const aScore = aNameIndex === -1 ? 10_000 + aPath.indexOf(normalizedQuery) : aNameIndex
    const bScore = bNameIndex === -1 ? 10_000 + bPath.indexOf(normalizedQuery) : bNameIndex
    return aScore - bScore || a.path.length - b.path.length || a.path.localeCompare(b.path)
  })
}

function cancelActiveFileSearch(senderId: number): void {
  const activeSearch = activeFileSearches.get(senderId)
  if (!activeSearch) return
  activeFileSearches.delete(senderId)
  cancelledFileSearches.add(activeSearch)
  try {
    activeSearch.kill()
  } catch {
    // Process may already be exiting.
  }
}

function cancelActiveContentSearch(senderId: number): void {
  const activeSearch = activeContentSearches.get(senderId)
  if (!activeSearch) return
  activeContentSearches.delete(senderId)
  cancelledContentSearches.add(activeSearch)
  try {
    activeSearch.kill()
  } catch {
    // Process may already be exiting.
  }
}

async function searchFilesWithRipgrep(
  senderId: number,
  rootPath: string,
  query: string,
  limit: number,
  userExcludes: string[]
): Promise<FileSearchEngineResult> {
  const normalizedQuery = normalizeSearchPath(query)
  const results: FileSearchEntry[] = []
  let stdoutBuffer = ''
  let stderrBuffer = ''
  let truncated = false
  const excludeArgs = searchExcludeArgs(userExcludes)

  return new Promise<FileSearchEngineResult>((resolve) => {
    let settled = false
    const child = spawn(rgPath, [
      '--files',
      '--color',
      'never',
      '--no-messages',
      ...excludeArgs,
    ], {
      cwd: rootPath,
      windowsHide: true,
    })

    activeFileSearches.set(senderId, child)

    const finish = (result: FileSearchEngineResult) => {
      if (settled) return
      settled = true
      if (activeFileSearches.get(senderId) === child) {
        activeFileSearches.delete(senderId)
      }
      resolve(result)
    }

    const consumeLine = (relativePath: string) => {
      if (!relativePath) return
      if (!normalizeSearchPath(relativePath).includes(normalizedQuery)) return
      results.push(toFileSearchEntry(rootPath, relativePath))
      if (results.length > limit) {
        truncated = true
        results.length = limit
        finish({ ok: true, results: sortFileSearchResults(results, query), truncated, engine: 'ripgrep' })
        try {
          child.kill()
        } catch {
          // Process may already have exited after producing enough results.
        }
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (settled) return
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split(/\r?\n/u)
      stdoutBuffer = lines.pop() ?? ''
      lines.forEach(consumeLine)
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk
    })

    child.on('error', (error) => {
      if (cancelledFileSearches.has(child)) {
        finish({ ok: true, results: [], truncated: false, engine: 'ripgrep' })
        return
      }

      finish({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        engine: 'ripgrep',
      })
    })

    child.on('close', (code) => {
      if (settled) return
      if (cancelledFileSearches.has(child)) {
        finish({ ok: true, results: [], truncated: false, engine: 'ripgrep' })
        return
      }
      if (stdoutBuffer) consumeLine(stdoutBuffer)
      if (settled) return
      if (code === 0 || code === 1) {
        finish({ ok: true, results: sortFileSearchResults(results, query), truncated, engine: 'ripgrep' })
        return
      }

      finish({
        ok: false,
        message: stderrBuffer.trim() || `ripgrep exited with code ${code ?? 'unknown'}.`,
        engine: 'ripgrep',
      })
    })
  })
}

function withFileSearchDiagnostics(result: FileSearchEngineResult, startedAt: number): FileSearchResult {
  if (!result.ok) return result
  return {
    ...result,
    elapsedMs: Date.now() - startedAt,
    resultCount: result.results.length,
  }
}

function toContentSearchEntry(rootPath: string, message: unknown): ContentSearchEntry | null {
  if (!message || typeof message !== 'object') return null
  const envelope = message as {
    type?: unknown
    data?: {
      path?: { text?: unknown }
      lines?: { text?: unknown }
      line_number?: unknown
      submatches?: Array<{
        start?: unknown
        match?: { text?: unknown }
      }>
    }
  }

  if (envelope.type !== 'match') return null
  const relativePath = typeof envelope.data?.path?.text === 'string'
    ? envelope.data.path.text.replace(/^\.[\\/]/u, '')
    : ''
  const lineText = typeof envelope.data?.lines?.text === 'string'
    ? envelope.data.lines.text.replace(/\r?\n$/u, '')
    : ''
  const lineNumber = typeof envelope.data?.line_number === 'number'
    ? envelope.data.line_number
    : 0
  const firstMatch = envelope.data?.submatches?.[0]
  const column = typeof firstMatch?.start === 'number' ? firstMatch.start + 1 : 1
  const matchText = typeof firstMatch?.match?.text === 'string' ? firstMatch.match.text : ''

  if (!relativePath || lineNumber < 1) return null

  const normalizedRelativePath = relativePath.replace(/\\/g, sep)
  const fullPath = join(rootPath, normalizedRelativePath)
  const parentRelativePath = dirname(normalizedRelativePath)
  return {
    name: basename(fullPath),
    path: fullPath,
    parentPath: parentRelativePath === '.' ? rootPath : join(rootPath, parentRelativePath),
    lineNumber,
    column,
    lineText,
    matchText,
  }
}

async function searchContentWithRipgrep(
  senderId: number,
  rootPath: string,
  query: string,
  limit: number,
  userExcludes: string[]
): Promise<ContentSearchEngineResult> {
  const results: ContentSearchEntry[] = []
  let stdoutBuffer = ''
  let stderrBuffer = ''
  let truncated = false

  return new Promise<ContentSearchEngineResult>((resolve) => {
    let settled = false
    const child = spawn(rgPath, [
      '--json',
      '--color',
      'never',
      '--no-messages',
      '--line-number',
      '--column',
      '--fixed-strings',
      ...searchExcludeArgs(userExcludes),
      '--',
      query,
      '.',
    ], {
      cwd: rootPath,
      windowsHide: true,
    })

    activeContentSearches.set(senderId, child)

    const finish = (result: ContentSearchEngineResult) => {
      if (settled) return
      settled = true
      if (activeContentSearches.get(senderId) === child) {
        activeContentSearches.delete(senderId)
      }
      resolve(result)
    }

    const consumeLine = (line: string) => {
      if (!line) return
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        return
      }

      const entry = toContentSearchEntry(rootPath, message)
      if (!entry) return
      results.push(entry)
      if (results.length > limit) {
        truncated = true
        results.length = limit
        finish({ ok: true, results, truncated, engine: 'ripgrep' })
        try {
          child.kill()
        } catch {
          // Process may already have exited after producing enough results.
        }
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (settled) return
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split(/\r?\n/u)
      stdoutBuffer = lines.pop() ?? ''
      lines.forEach(consumeLine)
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk
    })

    child.on('error', (error) => {
      if (cancelledContentSearches.has(child)) {
        finish({ ok: true, results: [], truncated: false, engine: 'ripgrep' })
        return
      }

      finish({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        engine: 'ripgrep',
      })
    })

    child.on('close', (code) => {
      if (settled) return
      if (cancelledContentSearches.has(child)) {
        finish({ ok: true, results: [], truncated: false, engine: 'ripgrep' })
        return
      }
      if (stdoutBuffer) consumeLine(stdoutBuffer)
      if (settled) return
      if (code === 0 || code === 1) {
        finish({ ok: true, results, truncated, engine: 'ripgrep' })
        return
      }

      finish({
        ok: false,
        message: stderrBuffer.trim() || `ripgrep exited with code ${code ?? 'unknown'}.`,
        engine: 'ripgrep',
      })
    })
  })
}

function withContentSearchDiagnostics(
  result: ContentSearchEngineResult,
  startedAt: number
): ContentSearchResult {
  if (!result.ok) return result
  return {
    ...result,
    elapsedMs: Date.now() - startedAt,
    resultCount: result.results.length,
  }
}

async function searchFiles(senderId: number, input: FileSearchRequest): Promise<FileSearchResult> {
  const startedAt = Date.now()
  const rootPath = typeof input.rootPath === 'string' ? input.rootPath : ''
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  const limit = normalizeFileSearchLimit(input.limit)
  const userExcludes = normalizeSearchExcludePatterns(input.excludes)
  if (!rootPath || !query) {
    return withFileSearchDiagnostics({ ok: true, results: [], truncated: false, engine: 'ripgrep' }, startedAt)
  }

  try {
    const rootStats = await stat(rootPath)
    if (!rootStats.isDirectory()) {
      return { ok: false, message: 'Search root is not a directory.', engine: null }
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      engine: null,
    }
  }

  cancelActiveFileSearch(senderId)
  const ripgrepResult = await searchFilesWithRipgrep(senderId, rootPath, query, limit, userExcludes)
  if (ripgrepResult.ok) return withFileSearchDiagnostics(ripgrepResult, startedAt)
  return ripgrepResult
}

async function searchContent(senderId: number, input: ContentSearchRequest): Promise<ContentSearchResult> {
  const startedAt = Date.now()
  const rootPath = typeof input.rootPath === 'string' ? input.rootPath : ''
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  const limit = normalizeContentSearchLimit(input.limit)
  const userExcludes = normalizeSearchExcludePatterns(input.excludes)
  if (!rootPath || !query) {
    return withContentSearchDiagnostics({ ok: true, results: [], truncated: false, engine: 'ripgrep' }, startedAt)
  }

  try {
    const rootStats = await stat(rootPath)
    if (!rootStats.isDirectory()) {
      return { ok: false, message: 'Search root is not a directory.', engine: null }
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      engine: null,
    }
  }

  cancelActiveContentSearch(senderId)
  return withContentSearchDiagnostics(
    await searchContentWithRipgrep(senderId, rootPath, query, limit, userExcludes),
    startedAt
  )
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

ipcMain.handle('fs:watch-start', async (event, dirPath: string) => {
  if (!trackedWatcherSenders.has(event.sender.id)) {
    trackedWatcherSenders.add(event.sender.id)
    event.sender.once('destroyed', () => {
      trackedWatcherSenders.delete(event.sender.id)
      disposeFileWatchersForSender(event.sender.id)
    })
  }

  if (!(await pathExists(dirPath))) return null

  const watchId = `watch-${++nextFileWatcherId}`
  const recursive = process.platform === 'win32' || process.platform === 'darwin'

  const createWatcher = (useRecursive: boolean): FSWatcher =>
    watch(dirPath, { recursive: useRecursive }, (eventType, filename) => {
      if (event.sender.isDestroyed()) return
      scheduleFileWatchEvent(watchId, {
        eventType,
        path: typeof filename === 'string' ? filename : null,
      })
    })

  try {
    const watcher = createWatcher(recursive)
    fileWatchers.set(watchId, { watcher, senderId: event.sender.id, pendingEvent: null, flushTimer: null })
    return watchId
  } catch (error) {
    if (isMissingPathError(error)) return null
    if (!recursive) {
      throw error
    }

    try {
      const watcher = createWatcher(false)
      fileWatchers.set(watchId, { watcher, senderId: event.sender.id, pendingEvent: null, flushTimer: null })
      return watchId
    } catch (fallbackError) {
      if (isMissingPathError(fallbackError)) return null
      throw fallbackError
    }
  }
})

ipcMain.handle('fs:watch-stop', (_, watchId: string) => {
  disposeFileWatcher(watchId)
})

ipcMain.handle('fs:search-files', async (event, input: FileSearchRequest) => {
  return searchFiles(event.sender.id, input)
})

ipcMain.handle('fs:search-content', async (event, input: ContentSearchRequest) => {
  return searchContent(event.sender.id, input)
})

ipcMain.handle('fs:cancel-content-search', (event) => {
  cancelActiveContentSearch(event.sender.id)
})

ipcMain.handle('fs:readdir', async (_, dirPath: string) => {
  const entries = await readdir(dirPath, { withFileTypes: true })
  return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }))
})

ipcMain.handle('fs:readfile', async (_, filePath: string) => {
  return readFile(filePath, 'utf-8')
})

ipcMain.handle('fs:path-exists', async (_, targetPath: string) => {
  return pathExists(targetPath)
})

ipcMain.handle('fs:check-workspace-folder', async (_, targetPath: string) => {
  return checkWorkspaceFolder(targetPath)
})

ipcMain.handle('diagnostics:log', async (_, input: DiagnosticLogInput) => {
  return writeDiagnosticLog(input)
})

ipcMain.handle('diagnostics:open-logs-folder', async () => {
  return openDiagnosticsLogsFolder()
})

ipcMain.handle('specialist:read-prompt', async (_, specialistId: SpecialistActionId) => {
  return readSpecialistPrompt(specialistId)
})

ipcMain.handle('multiloop:read-agent-soul', async (_, role: MultiloopAgentSoulRole) => {
  return readMultiloopAgentSoul(role)
})

ipcMain.handle('fs:writefile', async (_, filePath: string, content: string) => {
  await assertNotDirectSwarmStateMutation(filePath)
  await writeFile(filePath, content, 'utf-8')
})

ipcMain.handle('fs:create-file', async (_, parentDir: string, name: string) => {
  const filePath = join(parentDir, name)
  await assertNotDirectSwarmStateMutation(filePath)
  await writeFile(filePath, '', { encoding: 'utf-8', flag: 'wx' })
  return filePath
})

ipcMain.handle('fs:create-dir', async (_, parentDir: string, name: string) => {
  const dirPath = join(parentDir, name)
  await mkdir(dirPath)
  return dirPath
})

ipcMain.handle('fs:ensure-dir', async (_, parentDir: string, name: string) => {
  const dirPath = join(parentDir, name)
  await mkdir(dirPath, { recursive: true })
  return dirPath
})

ipcMain.handle('fs:rename', async (_, sourcePath: string, nextName: string) => {
  const normalizedName = nextName.trim()
  if (!normalizedName || normalizedName === '.' || normalizedName === '..' || /[/\\]/.test(normalizedName)) {
    throw new Error('Enter a valid file or folder name.')
  }

  const targetPath = join(dirname(sourcePath), normalizedName)
  if (targetPath === sourcePath) return targetPath
  await assertNotDirectSwarmStateMutation(sourcePath)
  await assertNotDirectSwarmStateMutation(targetPath)

  if (await pathExists(targetPath)) {
    throw new Error(`A file or folder named "${normalizedName}" already exists.`)
  }

  await rename(sourcePath, targetPath)
  return targetPath
})

ipcMain.handle('fs:copy', async (_, sourcePath: string, destinationDir: string) => {
  const sourceName = basename(sourcePath)
  const destinationPath = await getUniqueCopyPath(destinationDir, sourceName, sourcePath)
  await assertNotDirectSwarmStateMutation(sourcePath)
  await assertNotDirectSwarmStateMutation(destinationPath)

  await cp(sourcePath, destinationPath, {
    errorOnExist: true,
    force: false,
    recursive: true,
  })

  return destinationPath
})

ipcMain.handle('fs:delete', async (_, targetPath: string) => {
  await assertNotDirectSwarmStateMutation(targetPath)
  await shell.trashItem(targetPath)
})

ipcMain.handle('fs:show-item-in-folder', async (_, targetPath: string) => {
  await access(targetPath)
  shell.showItemInFolder(targetPath)
})

ipcMain.handle('git:get-repo-root', async (_, folderPath: string) => {
  return withIpcDiagnostics('GitIPC', 'get-repo-root', { folderPath }, () => getGitRepoRoot(folderPath))
})

ipcMain.handle('git:get-status', async (_, repoRoot: string) => {
  return withIpcDiagnostics('GitIPC', 'get-status', { repoRoot }, async () => {
    const snapshot = await getGitStatus(repoRoot)
    return snapshot
  }).then((snapshot) => {
    if (MULTICODE_DIAGNOSTICS) {
      logMainPerfEvent('GitIPC', 'get-status-result', {
        repoRoot,
        changedFileCount: Object.keys(snapshot.files).length,
      })
    }
    return snapshot
  })
})

ipcMain.handle('git:get-file-base', async (_, repoRoot: string, filePath: string) => {
  return withIpcDiagnostics('GitIPC', 'get-file-base', { repoRoot, filePath }, () => getGitFileBase(repoRoot, filePath))
})

ipcMain.handle('git:get-branches', async (_, repoRoot: string) => {
  return withIpcDiagnostics('GitIPC', 'get-branches', { repoRoot }, () => getGitBranches(repoRoot))
})

ipcMain.handle('git:get-history', async (_, repoRoot: string, limit?: number) => {
  return withIpcDiagnostics('GitIPC', 'get-history', { repoRoot, limit }, () => getGitHistory(repoRoot, limit))
})

ipcMain.handle('git:stage', async (_, repoRoot: string, paths: string[]) => {
  return withIpcDiagnostics('GitIPC', 'stage', { repoRoot, pathCount: paths.length }, () => stageGitPaths(repoRoot, paths))
})

ipcMain.handle('git:unstage', async (_, repoRoot: string, paths: string[]) => {
  return withIpcDiagnostics('GitIPC', 'unstage', { repoRoot, pathCount: paths.length }, () => unstageGitPaths(repoRoot, paths))
})

ipcMain.handle('git:revert', async (_, repoRoot: string, paths: string[]) => {
  return withIpcDiagnostics('GitIPC', 'revert', { repoRoot, pathCount: paths.length }, () => revertGitPaths(repoRoot, paths))
})

ipcMain.handle('git:discard-unstaged', async (_, repoRoot: string, paths: string[]) => {
  return withIpcDiagnostics('GitIPC', 'discard-unstaged', { repoRoot, pathCount: paths.length }, () => discardUnstagedGitChanges(repoRoot, paths))
})

ipcMain.handle('git:commit', async (_, repoRoot: string, message: string) => {
  return withIpcDiagnostics('GitIPC', 'commit', { repoRoot, messageLength: message.length }, () => commitGitChanges(repoRoot, message))
})

ipcMain.handle('git:push', async (_, repoRoot: string) => {
  return withIpcDiagnostics('GitIPC', 'push', { repoRoot }, () => pushGitBranch(repoRoot))
})

ipcMain.handle('git:switch-branch', async (_, repoRoot: string, branchName: string) => {
  return withIpcDiagnostics('GitIPC', 'switch-branch', { repoRoot, branchName }, () => switchGitBranch(repoRoot, branchName))
})

ipcMain.handle('git:worktree:list', async (_, repoRoot: string) => {
  return withIpcDiagnostics('GitIPC', 'worktree-list', { repoRoot }, () => listGitWorktrees(repoRoot))
})

ipcMain.handle('git:worktree:create', async (_, input) => {
  return createGitWorktree(input)
})

ipcMain.handle('git:worktree:remove', async (_, input) => {
  return removeGitWorktree(input)
})

ipcMain.handle('git:worktree:prune', async (_, repoRoot: string) => {
  return pruneGitWorktrees(repoRoot)
})

ipcMain.handle('git:worktree:repair', async (_, input) => {
  return repairGitWorktrees(input)
})

ipcMain.handle('git:worktree:copy-included', async (_, input) => {
  return copyGitWorktreeIncludedFiles(input)
})

ipcMain.handle('fs:dialog:opendir', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(win!, {
    properties: ['openDirectory'],
    title: 'Open Folder',
  })
  return result.filePaths[0] ?? null
})

ipcMain.handle('fs:dialog:savefile', async (event, options: Electron.SaveDialogOptions) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showSaveDialog(win!, options ?? {})
  return result.filePath ?? null
})

ipcMain.handle('fs:dialog:openfile', async (event, options: Electron.OpenDialogOptions) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(win!, {
    ...(options ?? {}),
    properties: ['openFile'],
  })
  return result.filePaths[0] ?? null
})

ipcMain.handle('app:show-context-menu', async (event, items: ContextMenuItem[]) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return null

  return await new Promise<string | null>((resolve) => {
    let settled = false
    const menu = Menu.buildFromTemplate(
      items.map((item) => {
        if (item.type === 'separator') {
          return { type: 'separator' }
        }

        return {
          label: item.label ?? '',
          enabled: item.enabled ?? true,
          click: () => {
            if (settled) return
            settled = true
            resolve(item.id ?? null)
          },
        }
      })
    )

    menu.popup({
      window: win,
      callback: () => {
        if (settled) return
        settled = true
        resolve(null)
      },
    })
  })
})

ipcMain.handle('app:show-menubar-menu', async (
  event,
  menuLabel: string,
  position?: { x?: number; y?: number }
) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const appMenu = Menu.getApplicationMenu()
  if (!win || !appMenu) return false

  const topLevelItem = appMenu.items.find((item) => item.label === menuLabel)
  if (!topLevelItem?.submenu) return false

  topLevelItem.submenu.popup({
    window: win,
    x: typeof position?.x === 'number' ? Math.round(position.x) : undefined,
    y: typeof position?.y === 'number' ? Math.round(position.y) : undefined,
  })

  return true
})

async function pathExists(targetPath: string): Promise<boolean> {
  const result = await checkWorkspaceFolder(targetPath)
  return result.ok
}

function getFsErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

async function checkPathAccess(targetPath: string): Promise<{ ok: true } | { ok: false; code?: string }> {
  try {
    await access(targetPath)
    return { ok: true }
  } catch (error) {
    return { ok: false, code: getFsErrorCode(error) }
  }
}

async function accessWithTimeout(targetPath: string, timeoutMs = 5000): Promise<WorkspaceFolderCheckResult> {
  let timeoutId: NodeJS.Timeout | null = null
  try {
    const result = await Promise.race([
      checkPathAccess(targetPath),
      new Promise<'timeout'>((resolve) => {
        timeoutId = setTimeout(() => resolve('timeout'), timeoutMs)
      }),
    ])

    if (result === 'timeout') {
      return {
        ok: false,
        status: 'timeout',
        path: targetPath,
        checkedPath: targetPath,
        message: `Timed out checking workspace folder: ${targetPath}`,
      }
    }

    if (result.ok) {
      return {
        ok: true,
        status: 'ready',
        path: targetPath,
        checkedPath: targetPath,
        message: `Workspace folder is ready: ${targetPath}`,
      }
    }

    return {
      ok: false,
      status: result.code === 'EACCES' || result.code === 'EPERM' ? 'inaccessible' : 'missing',
      path: targetPath,
      checkedPath: targetPath,
      message: result.code === 'EACCES' || result.code === 'EPERM'
        ? `Workspace folder is not accessible: ${targetPath}`
        : `Workspace folder does not exist: ${targetPath}`,
      code: result.code,
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function checkWorkspaceFolder(targetPath: string): Promise<WorkspaceFolderCheckResult> {
  const trimmedPath = targetPath?.trim()
  if (!trimmedPath) {
    return {
      ok: false,
      status: 'missing',
      path: '',
      checkedPath: '',
      message: 'Workspace folder path is empty.',
    }
  }

  const direct = await accessWithTimeout(trimmedPath)
  if (direct.ok || process.platform !== 'win32') return direct

  const windowsPath = toWindowsPath(trimmedPath)
  if (windowsPath === trimmedPath) return direct

  const normalized = await accessWithTimeout(windowsPath)
  return {
    ...normalized,
    path: trimmedPath,
    checkedPath: windowsPath,
    message: normalized.ok
      ? `Workspace folder is ready: ${trimmedPath}`
      : normalized.message,
  }
}

function getDiagnosticsLogDirectory(): string {
  return app.getPath('logs')
}

function getDiagnosticsLogPath(timestamp = new Date()): string {
  const day = timestamp.toISOString().slice(0, 10)
  return join(getDiagnosticsLogDirectory(), `diagnostics-${day}.jsonl`)
}

async function writeDiagnosticLog(input: DiagnosticLogInput): Promise<DiagnosticLogEntry> {
  const timestamp = new Date()
  const logPath = getDiagnosticsLogPath(timestamp)
  const entry: DiagnosticLogEntry = {
    ...input,
    id: `diag-${timestamp.getTime()}-${randomBytes(4).toString('hex')}`,
    timestamp: timestamp.toISOString(),
    logPath,
  }

  await mkdir(dirname(logPath), { recursive: true })
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf-8')
  return entry
}

async function openDiagnosticsLogsFolder(): Promise<{ opened: true; path: string }> {
  const logDirectory = getDiagnosticsLogDirectory()
  await mkdir(logDirectory, { recursive: true })
  const errorMessage = await shell.openPath(logDirectory)
  if (errorMessage) throw new Error(errorMessage)
  return { opened: true, path: logDirectory }
}

async function getUniqueCopyPath(
  destinationDir: string,
  sourceName: string,
  sourcePath: string
): Promise<string> {
  const base = await buildCopyBaseName(sourceName, sourcePath)
  let attempt = 0

  while (true) {
    const candidateName = attempt === 0 ? base.first : base.next(attempt + 1)
    const candidatePath = join(destinationDir, candidateName)
    if (!(await pathExists(candidatePath))) {
      return candidatePath
    }
    attempt += 1
  }
}

async function buildCopyBaseName(
  sourceName: string,
  sourcePath: string
): Promise<{ first: string; next: (count: number) => string }> {
  const sourceStats = await stat(sourcePath)
  const sourceIsDirectory = sourceStats.isDirectory()

  if (sourceIsDirectory) {
    return {
      first: `${sourceName} copy`,
      next: (count) => `${sourceName} copy ${count}`,
    }
  }

  const parsed = parse(sourceName)
  return {
    first: `${parsed.name} copy${parsed.ext}`,
    next: (count) => `${parsed.name} copy ${count}${parsed.ext}`,
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

const singleInstanceLock = app.requestSingleInstanceLock()
if (!singleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_, argv) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    void parseAuthCallbackFromArgv(argv)
  })
}

app.on('open-url', (event, callbackUrl) => {
  event.preventDefault()
  void parseAuthCallbackFromArgv([callbackUrl])
})

app.whenReady().then(() => {
  app.setAppLogsPath()

  if (process.platform === 'win32') {
    app.setAppUserModelId(
      process.env['ELECTRON_RENDERER_URL'] ? process.execPath : 'com.multicode'
    )
  }
  registerMulticodeProtocol()

  Menu.setApplicationMenu(createAppMenu())
  createWindow()
  void parseAuthCallbackFromArgv(process.argv)

  // Check for updates in production only (no update server configured = silent no-op)
  if (!process.env['ELECTRON_RENDERER_URL']) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {
      // No update server configured yet — ignore silently
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  mobileBridge.shutdown()
})

function registerMulticodeProtocol(): void {
  if (process.defaultApp) {
    const appEntry = process.argv[1] ? resolve(process.argv[1]) : app.getAppPath()
    app.setAsDefaultProtocolClient('multicode', process.execPath, [appEntry])
    return
  }

  app.setAsDefaultProtocolClient('multicode')
}
