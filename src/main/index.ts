import { app, shell, BrowserWindow, ipcMain, dialog, Menu, safeStorage } from 'electron'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, watch, writeFileSync, type FSWatcher } from 'fs'
import { access, appendFile, cp, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'path'
import { promisify } from 'util'
import { createHash, randomBytes } from 'crypto'
import { autoUpdater } from 'electron-updater'
import * as pty from 'node-pty'
import {
  commitGitChanges,
  discardUnstagedGitChanges,
  getGitBranches,
  getGitFileBase,
  getGitHistory,
  getGitRepoRoot,
  getGitStatus,
  pushGitBranch,
  revertGitPaths,
  stageGitPaths,
  switchGitBranch,
  unstageGitPaths,
} from './git'

const execFileAsync = promisify(execFile)

const MULTIAUTH_BASE_URL = (process.env['MULTIAUTH_BASE_URL'] || 'http://localhost:3000').replace(/\/+$/u, '')
const MULTICODE_CLIENT_ID = 'multicode-desktop' as const
const MULTICODE_REDIRECT_URI = 'multicode://auth/callback' as const
const MULTICODE_PRODUCT = 'multicode' as const
const ENTITLEMENT_GRACE_MS = 72 * 60 * 60 * 1000

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
      scope: 'openid profile entitlements:read',
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
  | 'developer'
  | 'devops-infra'
  | 'qa-test'
  | 'security-review'
  | 'frontend-design-review'
  | 'code-review'

type SpecialistPromptResult =
  | { ok: true; prompt: string; path: string }
  | { ok: false; message: string; path: string | null }

const specialistPromptFiles: Record<SpecialistActionId, string> = {
  architect: 'architect-prompt.md',
  developer: 'developer-prompt.md',
  'devops-infra': 'devops-infra-prompt.md',
  'frontend-design-review': 'frontend-design-promt.md',
  'qa-test': 'qa-test-prompt.md',
  'security-review': 'security-review-prompt.md',
  'code-review': 'code-reviewer-pre-prompt.md',
}

function getSpecialistPromptCandidates(fileName: string): string[] {
  return [
    join(process.cwd(), 'specialist-prompts', fileName),
    join(app.getAppPath(), 'specialist-prompts', fileName),
    join(__dirname, '..', '..', 'specialist-prompts', fileName),
    join(__dirname, '..', '..', '..', 'specialist-prompts', fileName),
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
  outputBuffer: string
  kind: TerminalKind
  workspaceId?: string
  agentId?: string
  terminalId?: string
  cli?: AgentCli
  cwd?: string
  swarmStatePath?: string
  startedAt: number
  lastOutputAt: number | null
  pendingResize?: TerminalSize
}

const TERMINAL_REPLAY_BUFFER_LIMIT = 2 * 1024 * 1024
const terminals = new Map<string, TerminalSession>()
const fileWatchers = new Map<string, { watcher: FSWatcher; senderId: number }>()
const trackedWatcherSenders = new Set<number>()
let nextFileWatcherId = 0

type AgentCli = 'codex' | 'claude'
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
  startedAt: number
  lastOutputAt: number | null
  outputBufferLength: number
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
        'where python >nul 2>nul',
        'if %errorlevel%==0 goto python',
        'py -3 "%TOOL%" %*',
        'exit /b %errorlevel%',
        ':python',
        'python "%TOOL%" %*',
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

function isNativeWindowsPath(dirPath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(dirPath) || /^\\\\/.test(dirPath)
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function quotePosixCommand(value: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(value) ? value : quotePosix(value)
}

function quoteCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function quoteCmdIfNeeded(value: string): string {
  return /[\s&()^|<>"]/g.test(value) ? quoteCmd(value) : value
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

type SwarmArtifactKind =
  | 'architect_plan'
  | 'branding'
  | 'design_notes'
  | 'html_mockup'
  | 'product_strategy'
  | 'requirements'
  | 'security_review'
  | 'validation_report'

type SwarmArtifactStatus =
  | 'approved'
  | 'changes_requested'
  | 'draft'
  | 'ready_for_review'
  | 'superseded'

type SwarmArtifactCommandResult =
  | { ok: true; data: unknown }
  | { ok: false; message: string; stdout?: string; stderr?: string; exitCode?: number | string }

type SwarmArtifactListPayload = {
  statePath: string
  taskId?: string
  kind?: SwarmArtifactKind
  status?: SwarmArtifactStatus
}

type SwarmArtifactActionPayload = {
  statePath: string
  artifactId: string
  actorId: string
}

type SwarmArtifactRequestChangesPayload = SwarmArtifactActionPayload & {
  feedback: string
}

type SwarmArtifactOpenPayload = {
  statePath: string
  artifactPath: string
}

type ValidSwarmStatePath = {
  statePath: string
  teamDirectory: string
  workspaceRoot: string
}

const swarmArtifactKinds = new Set<SwarmArtifactKind>([
  'architect_plan',
  'branding',
  'design_notes',
  'html_mockup',
  'product_strategy',
  'requirements',
  'security_review',
  'validation_report',
])

const swarmArtifactStatuses = new Set<SwarmArtifactStatus>([
  'approved',
  'changes_requested',
  'draft',
  'ready_for_review',
  'superseded',
])

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

function assertNotDirectSwarmStateMutation(targetPath: string): void {
  if (isSwarmStateFilePath(targetPath)) {
    throw new Error('Swarm state files must be updated through the swarm tool.')
  }
}

function validateSwarmIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} is required.`)
  }

  const trimmed = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(trimmed)) {
    throw new Error(`${label} must use letters, numbers, dots, underscores, or hyphens.`)
  }

  return trimmed
}

function validateOptionalSwarmIdentifier(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return validateSwarmIdentifier(value, label)
}

function validateArtifactKind(value: unknown): SwarmArtifactKind | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !swarmArtifactKinds.has(value as SwarmArtifactKind)) {
    throw new Error('Unknown artifact kind.')
  }
  return value as SwarmArtifactKind
}

function validateArtifactStatus(value: unknown): SwarmArtifactStatus | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !swarmArtifactStatuses.has(value as SwarmArtifactStatus)) {
    throw new Error('Unknown artifact status.')
  }
  return value as SwarmArtifactStatus
}

function validateArtifactFeedback(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Change-request feedback is required.')
  }

  const feedback = value.trim()
  if (!feedback) {
    throw new Error('Change-request feedback is required.')
  }
  if (feedback.length > 5000) {
    throw new Error('Change-request feedback must be 5000 characters or fewer.')
  }

  return feedback
}

function getSwarmToolPathForWorkspace(workspaceRoot: string): string {
  const candidates = [
    join(workspaceRoot, 'scripts', 'swarm_tool.py'),
    join(workspaceRoot, '.agents', 'skills', 'swarm-kanban', 'scripts', 'swarm_tool.py'),
    getBundledSwarmToolPath(),
  ].filter((candidate): candidate is string => Boolean(candidate))

  const toolPath = candidates.find((candidate) => existsSync(candidate))
  if (!toolPath) {
    throw new Error('Swarm tool not found.')
  }

  return toolPath
}

function parseSwarmToolOutput(stdout: string): unknown {
  const output = stdout.trim()
  if (!output) return null

  try {
    return JSON.parse(output)
  } catch {
    return { stdout: output }
  }
}

function getExecFileError(error: unknown): {
  message: string
  stdout?: string
  stderr?: string
  code?: number | string
  enoent: boolean
} {
  if (!error || typeof error !== 'object') {
    return { message: String(error), enoent: false }
  }

  const candidate = error as { message?: string; stdout?: string; stderr?: string; code?: number | string }
  return {
    message: candidate.message ?? 'Swarm tool failed.',
    stdout: candidate.stdout,
    stderr: candidate.stderr,
    code: candidate.code,
    enoent: candidate.code === 'ENOENT',
  }
}

async function execPythonSwarmTool(
  workspaceRoot: string,
  statePath: string,
  args: string[]
): Promise<SwarmArtifactCommandResult> {
  const toolPath = getSwarmToolPathForWorkspace(workspaceRoot)
  const attempts = process.platform === 'win32'
    ? [
        { command: 'python', args: [toolPath] },
        { command: 'py', args: ['-3', toolPath] },
      ]
    : [{ command: 'python3', args: [toolPath] }]

  for (const [index, attempt] of attempts.entries()) {
    try {
      const { stdout, stderr } = await execFileAsync(
        attempt.command,
        [...attempt.args, '--state', statePath, ...args],
        {
          cwd: workspaceRoot,
          env: withSwarmEnv(getTerminalEnv(), workspaceRoot, statePath),
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
        }
      )

      return {
        ok: true,
        data: parseSwarmToolOutput(stdout || stderr),
      }
    } catch (error) {
      const details = getExecFileError(error)
      const canRetry = details.enoent && index < attempts.length - 1
      if (canRetry) continue

      return {
        ok: false,
        message: details.stderr?.trim() || details.message,
        stdout: details.stdout,
        stderr: details.stderr,
        exitCode: details.code,
      }
    }
  }

  return { ok: false, message: 'Python is not available to run the swarm tool.' }
}

async function runSwarmArtifactCommand(
  statePathInput: unknown,
  args: string[]
): Promise<SwarmArtifactCommandResult> {
  try {
    const state = validateSwarmStatePath(statePathInput)
    if (!(await pathExists(state.statePath))) {
      return { ok: false, message: `Swarm state file does not exist: ${state.statePath}` }
    }
    return await execPythonSwarmTool(state.workspaceRoot, state.statePath, args)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
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
      'python3 "$tool_path" "$@";',
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

function buildWslShellScript(
  cwd: string,
  sessionId: string,
  resume = false,
  swarmStatePath?: string,
  cli: AgentCli = 'codex',
  initialPrompt?: string,
  cliRuntime?: CliRuntimeSettings
): string {
  return [
    buildUserShellStartup(),
    `cd ${quotePosix(toWslPath(cwd))}`,
    buildSwarmShellBootstrap(swarmStatePath),
    buildAgentLaunchCommand(cli, sessionId, resume, initialPrompt, cliRuntime),
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
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
): ShellLaunchConfig {
  const cliRuntime = getCliRuntimeSettings(cli, cliRuntimes)

  if (process.platform === 'win32' && !cliRuntime.useWsl) {
    const windowsCwd = toWindowsPath(cwd)
    const windowsStatePath = swarmStatePath ? toWindowsPath(swarmStatePath) : undefined
    if (!isNativeWindowsPath(windowsCwd)) {
      throw new Error(
        `Workspace path "${cwd}" is not available as a Windows path. Turn on "Run through WSL" for ${cli}.`
      )
    }
    const commandLine = buildNativeAgentLaunchCommand(
      cli,
      sessionId,
      resume,
      windowsCwd,
      initialPrompt,
      cliRuntime
    )

    return {
      command: 'cmd.exe',
      args: ['/d', '/k', commandLine],
      env: withSwarmEnv(getTerminalEnv(), windowsCwd, windowsStatePath),
      cwd: windowsCwd,
    }
  }

  if (process.platform === 'win32') {
    return {
      command: 'wsl.exe',
      args: [
        '-e',
        'bash',
        '-lic',
        buildWslShellScript(cwd, sessionId, resume, swarmStatePath, cli, initialPrompt, cliRuntime),
      ],
    }
  }

  const shellPath = process.env.SHELL || 'bash'
  const shellName = shellPath.split(/[\\/]/).at(-1)
  const args = shellName === 'bash' || shellName === 'zsh' ? ['-l'] : []

  return {
    command: shellPath,
    args,
    initialInput: `${[buildSwarmShellBootstrap(swarmStatePath), buildAgentLaunchCommand(cli, sessionId, resume, initialPrompt, cliRuntime)].join('; ')}\r`,
  }
}

function getPlainShellLaunchConfig(
  cwd: string,
  swarmStatePath?: string
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

    return {
      command: 'wsl.exe',
      args: [
        '-e',
        'bash',
        '-lic',
        [
          buildUserShellStartup(),
          `cd ${quotePosix(toWslPath(cwd))}`,
          buildSwarmShellBootstrap(swarmStatePath),
          'exec bash -li',
        ].join('; '),
      ],
    }
  }

  const shellPath = process.env.SHELL || 'bash'
  const shellName = shellPath.split(/[\\/]/).at(-1)
  const args = shellName === 'bash' || shellName === 'zsh' ? ['-l'] : []

  return {
    command: shellPath,
    args,
    cwd,
    initialInput: `${buildSwarmShellBootstrap(swarmStatePath)}\r`,
  }
}

function buildNativeAgentLaunchCommand(
  cli: AgentCli,
  sessionId: string,
  resume: boolean,
  cwd: string,
  initialPrompt: string | undefined,
  cliRuntime: CliRuntimeSettings
): string {
  const command = quoteCmdIfNeeded(cliRuntime.command || cli)

  if (cli === 'codex') {
    const promptArg = initialPrompt ? ` ${quoteCmd(initialPrompt)}` : ''
    return `${command} -C ${quoteCmdIfNeeded(cwd)}${promptArg}`
  }

  const sessionFlag = resume ? '--resume' : '--session-id'
  return `${command} ${sessionFlag} ${quoteCmdIfNeeded(sessionId)}`
}

function buildAgentLaunchCommand(
  cli: AgentCli,
  sessionId: string,
  resume = false,
  initialPrompt?: string,
  cliRuntime?: CliRuntimeSettings
): string {
  if (cli === 'claude') return buildClaudeLaunchCommand(sessionId, resume, cliRuntime)
  return buildCodexLaunchCommand(initialPrompt, cliRuntime)
}

function buildCommandAvailabilityCheck(cli: AgentCli, command: string): string {
  return [
    `if ! command -v ${quotePosixCommand(command)} >/dev/null 2>&1; then`,
    `echo ${quotePosix(`${cli === 'codex' ? 'Codex' : 'Claude'} CLI was not found. Check the ${cli} command in Multicode Settings.`)};`,
    'else',
  ].join(' ')
}

function buildCodexLaunchCommand(
  initialPrompt?: string,
  cliRuntime?: CliRuntimeSettings
): string {
  const promptArg = initialPrompt ? ` ${quotePosix(initialPrompt)}` : ''
  const configuredCommand = cliRuntime?.command?.trim()

  return [
    buildCommandAvailabilityCheck('codex', configuredCommand || 'codex'),
    `${quotePosixCommand(configuredCommand || 'codex')}${promptArg};`,
    'fi',
  ].join(' ')
}

function buildClaudeLaunchCommand(
  sessionId: string,
  resume = false,
  cliRuntime?: CliRuntimeSettings
): string {
  const quotedSessionId = quotePosix(sessionId)
  const claudeCommand = quotePosixCommand(cliRuntime?.command?.trim() || 'claude')
  const configuredCommand = cliRuntime?.command?.trim() || 'claude'

  if (!resume) {
    return [
      buildCommandAvailabilityCheck('claude', configuredCommand),
      `${claudeCommand} --session-id ${quotedSessionId};`,
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
    `${claudeCommand} --resume ${quotedSessionId};`,
    `else`,
    `${claudeCommand} --session-id ${quotedSessionId};`,
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

function appendTerminalOutput(session: TerminalSession, data: string): void {
  session.outputBuffer += data
  session.lastOutputAt = Date.now()
  if (session.outputBuffer.length > TERMINAL_REPLAY_BUFFER_LIMIT) {
    session.outputBuffer = session.outputBuffer.slice(-TERMINAL_REPLAY_BUFFER_LIMIT)
  }
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
    startedAt: session.startedAt,
    lastOutputAt: session.lastOutputAt,
    outputBufferLength: session.outputBuffer.length,
  }
}

function disposeTerminal(sessionId: string): void {
  const session = terminals.get(sessionId)
  if (!session) return

  session.isDisposed = true
  session.hasExited = true
  terminals.delete(sessionId)

  try {
    session.process.kill()
  } catch {
    // ignore kill errors if process died first
  }
}

function disposeFileWatcher(watchId: string): void {
  const fileWatcher = fileWatchers.get(watchId)
  if (!fileWatcher) return

  fileWatcher.watcher.close()
  fileWatchers.delete(watchId)
}

function disposeFileWatchersForSender(senderId: number): void {
  for (const [watchId, fileWatcher] of fileWatchers.entries()) {
    if (fileWatcher.senderId === senderId) {
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
  }: TerminalSpawnPayload) => {
    const existingSession = terminals.get(sessionId)
    if (existingSession && !existingSession.hasExited && !existingSession.isDisposed) {
      existingSession.sender = event.sender
      existingSession.workspaceId = workspaceId ?? existingSession.workspaceId
      existingSession.agentId = agentId ?? existingSession.agentId
      existingSession.terminalId = terminalId ?? existingSession.terminalId
      existingSession.kind = kind ?? existingSession.kind
      safeResizeTerminal(sessionId, cols, rows)
      if (existingSession.outputBuffer) {
        sendTerminalEvent(event.sender, `terminal:data:${sessionId}`, existingSession.outputBuffer)
      }
      return { ok: true, sessionId } satisfies TerminalSpawnResult
    }

    disposeTerminal(sessionId)

    try {
      const workingDirectory = cwd || process.cwd()
      if (swarmStatePath && (kind ?? (shellOnly ? 'terminal' : 'agent')) === 'agent') {
        // Local desktop gates improve UX only; hosted/cloud/model APIs must still
        // enforce Multiauth entitlements before any cost-bearing work starts.
        const accessDecision = await multicodeAuth.checkPremiumAccess({
          featureKey: 'multicode.swarm_mode',
        })
        if (!accessDecision.allowed) {
          sendTerminalEvent(event.sender, `terminal:error:${sessionId}`, accessDecision.message)
          sendTerminalEvent(event.sender, `terminal:exit:${sessionId}`, 1)
          return {
            ok: false,
            sessionId,
            message: accessDecision.message,
            exitCode: 1,
          } satisfies TerminalSpawnResult
        }
      }

      const { command, args, cwd: launchCwd, initialInput, env } = shellOnly
        ? getPlainShellLaunchConfig(workingDirectory, swarmStatePath)
        : getShellLaunchConfig(
          workingDirectory,
          sessionId,
          resume,
          swarmStatePath,
          cli,
          initialPrompt,
          cliRuntimes
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
        outputBuffer: '',
        kind: kind ?? (shellOnly ? 'terminal' : 'agent'),
        workspaceId,
        agentId,
        terminalId,
        cli: shellOnly ? undefined : cli,
        cwd: launchCwd ?? workingDirectory,
        swarmStatePath,
        startedAt: Date.now(),
        lastOutputAt: null,
      }

      terminals.set(sessionId, terminalSession)

      termProcess.onData((data) => {
        if (!terminalSession.isReady) {
          terminalSession.isReady = true
          flushPendingTerminalResize(sessionId, terminalSession)
        }
        appendTerminalOutput(terminalSession, data)
        sendTerminalEvent(terminalSession.sender, `terminal:data:${sessionId}`, data)
      })

      termProcess.onExit((e) => {
        terminalSession.hasExited = true
        if (terminals.get(sessionId) === terminalSession) {
          terminals.delete(sessionId)
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
  const session = terminals.get(sessionId)
  if (!session || session.hasExited || session.isDisposed) return

  try {
    session.process.write(data)
  } catch {
    session.hasExited = true
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

ipcMain.handle('swarm:artifact:list', async (_, payload: SwarmArtifactListPayload) => {
  try {
    const taskId = validateOptionalSwarmIdentifier(payload?.taskId, 'Task id')
    const kind = validateArtifactKind(payload?.kind)
    const status = validateArtifactStatus(payload?.status)
    const args = ['artifact', 'list']

    if (taskId) args.push('--task-id', taskId)
    if (kind) args.push('--kind', kind)
    if (status) args.push('--status', status)

    return runSwarmArtifactCommand(payload?.statePath, args)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('swarm:artifact:ready', async (_, payload: SwarmArtifactActionPayload) => {
  try {
    const artifactId = validateSwarmIdentifier(payload?.artifactId, 'Artifact id')
    const actorId = validateSwarmIdentifier(payload?.actorId, 'Actor id')

    return runSwarmArtifactCommand(payload?.statePath, [
      'artifact',
      'ready',
      '--artifact-id',
      artifactId,
      '--id',
      actorId,
    ])
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('swarm:artifact:approve', async (_, payload: SwarmArtifactActionPayload) => {
  try {
    const artifactId = validateSwarmIdentifier(payload?.artifactId, 'Artifact id')
    const actorId = validateSwarmIdentifier(payload?.actorId, 'Actor id')

    return runSwarmArtifactCommand(payload?.statePath, [
      'artifact',
      'approve',
      '--artifact-id',
      artifactId,
      '--id',
      actorId,
    ])
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('swarm:artifact:request-changes', async (_, payload: SwarmArtifactRequestChangesPayload) => {
  try {
    const artifactId = validateSwarmIdentifier(payload?.artifactId, 'Artifact id')
    const actorId = validateSwarmIdentifier(payload?.actorId, 'Actor id')
    const feedback = validateArtifactFeedback(payload?.feedback)

    return runSwarmArtifactCommand(payload?.statePath, [
      'artifact',
      'request-changes',
      '--artifact-id',
      artifactId,
      '--id',
      actorId,
      '--feedback',
      feedback,
    ])
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
})

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

// ── File system IPC handlers ──────────────────────────────────────────────────

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
      event.sender.send(`fs:watch-event:${watchId}`, {
        eventType,
        path: typeof filename === 'string' ? filename : null,
      })
    })

  try {
    const watcher = createWatcher(recursive)
    fileWatchers.set(watchId, { watcher, senderId: event.sender.id })
    return watchId
  } catch (error) {
    if (isMissingPathError(error)) return null
    if (!recursive) {
      throw error
    }

    try {
      const watcher = createWatcher(false)
      fileWatchers.set(watchId, { watcher, senderId: event.sender.id })
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

ipcMain.handle('fs:writefile', async (_, filePath: string, content: string) => {
  assertNotDirectSwarmStateMutation(filePath)
  await writeFile(filePath, content, 'utf-8')
})

ipcMain.handle('fs:create-file', async (_, parentDir: string, name: string) => {
  const filePath = join(parentDir, name)
  assertNotDirectSwarmStateMutation(filePath)
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
  assertNotDirectSwarmStateMutation(sourcePath)
  assertNotDirectSwarmStateMutation(targetPath)

  if (await pathExists(targetPath)) {
    throw new Error(`A file or folder named "${normalizedName}" already exists.`)
  }

  await rename(sourcePath, targetPath)
  return targetPath
})

ipcMain.handle('fs:copy', async (_, sourcePath: string, destinationDir: string) => {
  const sourceName = basename(sourcePath)
  const destinationPath = await getUniqueCopyPath(destinationDir, sourceName, sourcePath)
  assertNotDirectSwarmStateMutation(destinationPath)

  await cp(sourcePath, destinationPath, {
    errorOnExist: true,
    force: false,
    recursive: true,
  })

  return destinationPath
})

ipcMain.handle('fs:delete', async (_, targetPath: string) => {
  assertNotDirectSwarmStateMutation(targetPath)
  await shell.trashItem(targetPath)
})

ipcMain.handle('fs:show-item-in-folder', async (_, targetPath: string) => {
  await access(targetPath)
  shell.showItemInFolder(targetPath)
})

ipcMain.handle('git:get-repo-root', async (_, folderPath: string) => {
  return getGitRepoRoot(folderPath)
})

ipcMain.handle('git:get-status', async (_, repoRoot: string) => {
  return getGitStatus(repoRoot)
})

ipcMain.handle('git:get-file-base', async (_, repoRoot: string, filePath: string) => {
  return getGitFileBase(repoRoot, filePath)
})

ipcMain.handle('git:get-branches', async (_, repoRoot: string) => {
  return getGitBranches(repoRoot)
})

ipcMain.handle('git:get-history', async (_, repoRoot: string, limit?: number) => {
  return getGitHistory(repoRoot, limit)
})

ipcMain.handle('git:stage', async (_, repoRoot: string, paths: string[]) => {
  return stageGitPaths(repoRoot, paths)
})

ipcMain.handle('git:unstage', async (_, repoRoot: string, paths: string[]) => {
  return unstageGitPaths(repoRoot, paths)
})

ipcMain.handle('git:revert', async (_, repoRoot: string, paths: string[]) => {
  return revertGitPaths(repoRoot, paths)
})

ipcMain.handle('git:discard-unstaged', async (_, repoRoot: string, paths: string[]) => {
  return discardUnstagedGitChanges(repoRoot, paths)
})

ipcMain.handle('git:commit', async (_, repoRoot: string, message: string) => {
  return commitGitChanges(repoRoot, message)
})

ipcMain.handle('git:push', async (_, repoRoot: string) => {
  return pushGitBranch(repoRoot)
})

ipcMain.handle('git:switch-branch', async (_, repoRoot: string, branchName: string) => {
  return switchGitBranch(repoRoot, branchName)
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
  app.setAsDefaultProtocolClient('multicode')

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
