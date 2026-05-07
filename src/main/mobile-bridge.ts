import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import {
  MobileSwarmCommandService,
  type MobileControlCommand,
  type MobileSwarmCommandResult,
} from './mobile-sprintengine-command'
import { pushTokenHash, type MobilePushRegistrationTarget } from './mobile-sprintengine-activity'
import { MobileSwarmSnapshotService, type MobileControlSnapshot } from './mobile-sprintengine-snapshot'
import { getErrorMessage } from './error-message'
import { hashSecret, randomBase64Url } from './mobile-bridge-crypto'
import { getAllBrowserWindows, getDesktopDisplayName } from './mobile-bridge-desktop'

const mobileControlProtocolVersion = 1 as const

type MobileControlCommandType =
  | 'snapshot.request'
  | 'artifact.read'
  | 'sprintengine.create'
  | 'task.start'
  | 'artifact.approve'
  | 'artifact.requestChanges'
  | 'agent.followUp'
  | 'device.revoke'

export type MobileControlCapability =
  | 'snapshots.read'
  | 'artifacts.read'
  | 'swarms.create'
  | 'tasks.start'
  | 'artifacts.review'
  | 'agents.followUp'
  | 'devices.revoke'

export type MobileControlErrorCode =
  | 'unsupported_protocol_version'
  | 'invalid_payload'
  | 'unauthenticated'
  | 'unauthorized'
  | 'device_revoked'
  | 'desktop_unavailable'
  | 'relay_unavailable'
  | 'command_not_supported'
  | 'command_expired'
  | 'duplicate_idempotency_key'
  | 'stale_snapshot'
  | 'swarm_not_found'
  | 'task_not_ready'
  | 'artifact_not_found'
  | 'path_not_allowed'
  | 'python_tool_failed'
  | 'internal_error'

export type MobileControlDevice = {
  protocolVersion: typeof mobileControlProtocolVersion
  deviceId: string
  displayName: string
  platform: 'ios' | 'android' | 'web'
  appVersion: string
  pairedAt: string
  lastSeenAt?: string
  revokedAt?: string
  capabilities: MobileControlCapability[]
}

export type MobilePushProvider = 'apns' | 'fcm' | 'expo'

export type MobilePushRegistration = MobilePushRegistrationTarget & {
  protocolVersion: typeof mobileControlProtocolVersion
  provider: MobilePushProvider
  tokenHash: string
  registeredAt: string
  lastUsedAt?: string
}

export type MobilePushRegistrationInput = {
  deviceId: string
  provider: MobilePushProvider
  token: string
}

type MobileControlCapabilities = {
  protocolVersion: typeof mobileControlProtocolVersion
  deviceId: string
  commands: MobileControlCommandType[]
  capabilities: MobileControlCapability[]
  artifactPreviewModes: ('text' | 'markdown' | 'restrictedHtml')[]
  maxFollowUpCharacters: number
  snapshotTtlMs: number
}

export type MobileRelayScope =
  | 'relay:presence:read'
  | 'relay:snapshot:read'
  | 'relay:artifact:read'
  | 'relay:artifact:review'
  | 'relay:sprintengine:create'
  | 'relay:task:start'
  | 'relay:agent:followup'
  | 'relay:push:register'
  | 'relay:device:revoke'

type RelayCommandType =
  | 'snapshot.request'
  | 'artifact.read'
  | 'sprintengine.create'
  | 'task.start'
  | 'artifact.approve'
  | 'artifact.requestChanges'
  | 'agent.followup'
  | 'device.revoke'

type RelayCommandEnvelope = {
  desktopRelaySessionId: string
  commandId: string
  commandType: RelayCommandType
  issuedAt: string
  expiresAt: string
  expectedSnapshotVersion?: string
  payload: Record<string, unknown>
}

export type MobileRelayAuthenticatedDevice = {
  deviceId: string
  userId?: string
  organizationId?: string
  mobileSessionId?: string
  desktopRelaySessionId?: string
  displayName?: string
  platform?: 'ios' | 'android' | 'web' | 'other'
  appVersion?: string
  pairedAt?: string
  lastSeenAt?: string
  revokedAt?: string
  status?: 'active' | 'revoked'
  scopes?: MobileRelayScope[]
  capabilities?: MobileControlCapability[]
}

type RelayCommandDelivery = {
  envelope: RelayCommandEnvelope
  device: MobileRelayAuthenticatedDevice | null
}

type RelayConnectResult = {
  desktopRelaySessionId: string
  relayToken: string
  expiresAt: string
  heartbeatAfterSeconds?: number
}

type RelayPairingChallengeResult = {
  pairingChallengeId: string
  manualPairingCode?: string
  pairingUri: string
  pairingPayload?: {
    mobileControlProtocolVersion: 1
    pairingChallengeId: string
    relayUrl: string
    pairingSecret: string
    expiresAt: string
    desktop: {
      displayName: string
      desktopInstanceId: string
      desktopRelaySessionId: string
    }
  }
  expiresAt: string
}

type RelayCommandResultStatus = 'completed' | 'failed'

export type MobileRelayTransport = {
  connectDesktop(input: {
    relayUrl: string
    accessToken: string
    desktopInstanceId: string
    displayName: string
    commands: RelayCommandType[]
  }): Promise<RelayConnectResult>
  createPairingChallenge(input: {
    relayUrl: string
    relayToken: string
    desktopRelaySessionId: string
    requestedScopes: MobileRelayScope[]
  }): Promise<RelayPairingChallengeResult>
  listPendingCommands(input: {
    relayUrl: string
    relayToken: string
    desktopRelaySessionId: string
  }): Promise<RelayCommandDelivery[]>
  postCommandResult(input: {
    relayUrl: string
    relayToken: string
    commandId: string
    status: RelayCommandResultStatus
    resultCode: string
    summary: Record<string, unknown>
  }): Promise<void>
  revokeDevice(input: {
    relayUrl: string
    accessToken: string
    deviceId: string
    reason: string
  }): Promise<{ revoked: true }>
  publishSnapshot?(input: {
    relayUrl: string
    relayToken: string
    desktopRelaySessionId: string
    snapshot: MobileControlSnapshot
  }): Promise<void>
}

export type MobileBridgeRelayStatus =
  | 'disabled'
  | 'unconfigured'
  | 'connecting'
  | 'connected'
  | 'retrying'
  | 'error'

export type MobileBridgePresence = 'available' | 'busy' | 'idle' | 'offline'

export type MobileBridgeDiagnosticEntry = {
  id: string
  timestamp: string
  level: 'info' | 'warning' | 'error'
  code: MobileControlErrorCode | 'mobile_bridge_disabled' | 'relay_not_configured' | 'relay_connected'
  message: string
  retryable: boolean
}

export type MobileBridgePairingChallenge = {
  pairingChallengeId: string
  pairingCode: string
  pairingUri: string
  expiresAt: string
  requestedScopes: MobileControlCapability[]
}

export type MobileBridgeState = {
  enabled: boolean
  relayStatus: MobileBridgeRelayStatus
  relayUrl: string | null
  desktopInstanceId: string
  desktopRelaySessionId: string | null
  relayTokenExpiresAt: string | null
  nextReconnectAt: string | null
  presence: MobileBridgePresence
  lastPresenceAt: string | null
  pairingChallenge: Omit<MobileBridgePairingChallenge, 'pairingCode' | 'pairingUri'> | null
  pairedDevices: MobileControlDevice[]
  capabilities: MobileControlCapabilities
  diagnostics: MobileBridgeDiagnosticEntry[]
}

export type MobileBridgeSettingsUpdate = {
  enabled?: boolean
}

type PersistedMobileBridgeState = {
  enabled?: boolean
  desktopInstanceId?: string
  pairedDevices?: unknown[]
  pushRegistrations?: unknown[]
}

type DesktopSessionProvider = () => Promise<{ authenticated: boolean; session?: { id: string; expiresAt: string } }>
type DesktopAccessTokenProvider = () => Promise<string | null>
type SwarmStatePathsProvider = () => Promise<string[]>

export type MobileBridgeOptions = {
  relayUrl?: string | null
  storePath?: string
  accessTokenProvider?: DesktopAccessTokenProvider
  relayTransport?: MobileRelayTransport
  commandService?: MobileSwarmCommandService
  snapshotService?: MobileSwarmSnapshotService
  statePathsProvider?: SwarmStatePathsProvider
  commandPollIntervalMs?: number
}

const RELAY_URL = process.env['MULTICODE_MOBILE_RELAY_URL']?.replace(/\/+$/u, '') || null
const MAX_DIAGNOSTICS = 50
const INITIAL_RECONNECT_DELAY_MS = 1000
const MAX_RECONNECT_DELAY_MS = 60 * 1000
const DEFAULT_COMMAND_POLL_INTERVAL_MS = 2_000
const REQUESTED_SCOPES: MobileControlCapability[] = [
  'snapshots.read',
  'artifacts.read',
  'swarms.create',
  'tasks.start',
  'artifacts.review',
  'agents.followUp',
  'devices.revoke',
]
const REQUESTED_RELAY_SCOPES: MobileRelayScope[] = [
  'relay:snapshot:read',
  'relay:artifact:read',
  'relay:sprintengine:create',
  'relay:task:start',
  'relay:artifact:review',
  'relay:agent:followup',
  'relay:device:revoke',
]
const SUPPORTED_COMMANDS: MobileControlCommandType[] = [
  'snapshot.request',
  'artifact.read',
  'sprintengine.create',
  'task.start',
  'artifact.approve',
  'artifact.requestChanges',
  'agent.followUp',
  'device.revoke',
]
const RELAY_SUPPORTED_COMMANDS: RelayCommandType[] = [
  'snapshot.request',
  'artifact.read',
  'sprintengine.create',
  'task.start',
  'artifact.approve',
  'artifact.requestChanges',
  'agent.followup',
  'device.revoke',
]
const SIDE_EFFECTING_COMMANDS = new Set<MobileControlCommandType>([
  'sprintengine.create',
  'task.start',
  'artifact.approve',
  'artifact.requestChanges',
  'agent.followUp',
  'device.revoke',
])

const CAPABILITY_BY_COMMAND: Record<MobileControlCommandType, MobileControlCapability> = {
  'snapshot.request': 'snapshots.read',
  'artifact.read': 'artifacts.read',
  'sprintengine.create': 'swarms.create',
  'task.start': 'tasks.start',
  'artifact.approve': 'artifacts.review',
  'artifact.requestChanges': 'artifacts.review',
  'agent.followUp': 'agents.followUp',
  'device.revoke': 'devices.revoke',
}

const CAPABILITY_BY_RELAY_SCOPE: Record<MobileRelayScope, MobileControlCapability | null> = {
  'relay:presence:read': null,
  'relay:snapshot:read': 'snapshots.read',
  'relay:artifact:read': 'artifacts.read',
  'relay:artifact:review': 'artifacts.review',
  'relay:sprintengine:create': 'swarms.create',
  'relay:task:start': 'tasks.start',
  'relay:agent:followup': 'agents.followUp',
  'relay:push:register': null,
  'relay:device:revoke': 'devices.revoke',
}

export class MobileBridge {
  private enabled = false
  private relayStatus: MobileBridgeRelayStatus = 'disabled'
  private desktopInstanceId = ''
  private desktopRelaySessionId: string | null = null
  private relayTokenExpiresAt: string | null = null
  private nextReconnectAt: string | null = null
  private presence: MobileBridgePresence = 'offline'
  private lastPresenceAt: string | null = null
  private pairingChallenge: (MobileBridgePairingChallenge & { challengeHash: string }) | null = null
  private pairedDevices: MobileControlDevice[] = []
  private pushRegistrations: MobilePushRegistration[] = []
  private diagnostics: MobileBridgeDiagnosticEntry[] = []
  private reconnectTimer: NodeJS.Timeout | null = null
  private commandPollTimer: NodeJS.Timeout | null = null
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
  private loaded = false
  private relayToken: string | null = null
  private readonly relayUrl: string | null
  private readonly storePathOverride?: string
  private readonly accessTokenProvider: DesktopAccessTokenProvider
  private readonly relayTransport: MobileRelayTransport
  private readonly commandService: MobileSwarmCommandService
  private readonly snapshotService: MobileSwarmSnapshotService
  private readonly statePathsProvider: SwarmStatePathsProvider
  private readonly commandPollIntervalMs: number
  private readonly activeRelayCommandIds = new Set<string>()

  constructor(
    private readonly sessionProvider: DesktopSessionProvider,
    options: MobileBridgeOptions = {}
  ) {
    this.relayUrl = options.relayUrl === undefined ? RELAY_URL : options.relayUrl?.replace(/\/+$/u, '') || null
    this.storePathOverride = options.storePath
    this.accessTokenProvider = options.accessTokenProvider ?? (async () => null)
    this.relayTransport = options.relayTransport ?? new FetchMobileRelayTransport()
    this.commandService = options.commandService ?? new MobileSwarmCommandService()
    this.snapshotService = options.snapshotService ?? new MobileSwarmSnapshotService()
    this.statePathsProvider = options.statePathsProvider ?? defaultSwarmStatePaths
    this.commandPollIntervalMs = Math.max(250, options.commandPollIntervalMs ?? DEFAULT_COMMAND_POLL_INTERVAL_MS)
  }

  async getState(): Promise<MobileBridgeState> {
    await this.load()
    this.expirePairingChallenge()
    return this.snapshot()
  }

  async updateSettings(update: MobileBridgeSettingsUpdate): Promise<MobileBridgeState> {
    await this.load()

    const enabled = update && typeof update === 'object' ? update.enabled : undefined
    if (typeof enabled === 'boolean' && enabled !== this.enabled) {
      this.enabled = enabled
      this.recordDiagnostic(
        'info',
        enabled ? 'relay_not_configured' : 'mobile_bridge_disabled',
        enabled ? 'Mobile companion control enabled.' : 'Mobile companion control disabled.',
        enabled && !RELAY_URL
      )

      if (this.enabled) {
        this.presence = 'available'
        this.lastPresenceAt = new Date().toISOString()
        this.connectWithBackoff(0)
      } else {
        this.disconnect('disabled')
      }
    }

    await this.persist()
    this.emitStateChanged()
    return this.snapshot()
  }

  async requestPairingCode(): Promise<MobileBridgePairingChallenge> {
    await this.load()
    this.assertEnabled()
    this.assertRelayReady()

    const session = await this.sessionProvider()
    if (!session.authenticated) {
      this.recordDiagnostic('warning', 'unauthenticated', 'Sign in before pairing a mobile device.', false)
      throw new Error('Sign in before pairing a mobile device.')
    }

    const relayChallenge = await this.relayTransport.createPairingChallenge({
      relayUrl: this.relayUrl as string,
      relayToken: this.relayToken as string,
      desktopRelaySessionId: this.desktopRelaySessionId as string,
      requestedScopes: REQUESTED_RELAY_SCOPES,
    })
    const pairingCode = manualPairingValueFromRelayChallenge(relayChallenge)
    const expiresAt = relayChallenge.expiresAt
    const pairingChallengeId = relayChallenge.pairingChallengeId
    const pairingUri = relayChallenge.pairingUri
    this.pairingChallenge = {
      pairingChallengeId,
      pairingCode,
      pairingUri,
      expiresAt,
      requestedScopes: REQUESTED_SCOPES,
      challengeHash: hashSecret(pairingCode),
    }
    this.recordDiagnostic('info', 'relay_connected', 'Created a relay-backed mobile pairing challenge.', false)
    await this.persist()
    this.emitStateChanged()

    return {
      pairingChallengeId,
      pairingCode,
      pairingUri,
      expiresAt,
      requestedScopes: REQUESTED_SCOPES,
    }
  }

  async listDevices(): Promise<MobileControlDevice[]> {
    await this.load()
    return this.pairedDevices
  }

  async revokeDevice(deviceId: string, reason?: string): Promise<MobileControlDevice> {
    await this.load()
    this.assertEnabled()

    const trimmedDeviceId = deviceId.trim()
    const trimmedReason = reason?.trim()
    if (!trimmedDeviceId) {
      throw new Error('deviceId is required.')
    }

    const device = this.pairedDevices.find((candidate) => candidate.deviceId === trimmedDeviceId)
    if (!device) {
      this.recordDiagnostic('warning', 'device_revoked', `Device ${trimmedDeviceId} was not found for revocation.`, false)
      throw new Error('Paired mobile device was not found.')
    }

    await this.revokeDeviceAtRelay(trimmedDeviceId, trimmedReason ?? 'Revoked from Multicode desktop settings.')

    if (!device.revokedAt) {
      const revokedAt = new Date().toISOString()
      device.revokedAt = revokedAt
      this.revokePushRegistrationsForDevice(device.deviceId, revokedAt)
      this.recordDiagnostic(
        'info',
        'device_revoked',
        trimmedReason ? `Revoked mobile device ${device.displayName}: ${trimmedReason}` : `Revoked mobile device ${device.displayName}.`,
        false
      )
    }

    await this.persist()
    this.emitStateChanged()
    return device
  }

  async registerPushToken(input: MobilePushRegistrationInput): Promise<MobilePushRegistration> {
    await this.load()
    this.assertEnabled()

    const device = this.pairedDevices.find((candidate) => candidate.deviceId === input.deviceId)
    if (!device || device.revokedAt) {
      throw new Error('Push registration requires an active paired mobile device.')
    }
    if (!isMobilePushProvider(input.provider)) {
      throw new Error('Unsupported mobile push provider.')
    }

    const token = input.token.trim()
    if (token.length < 16 || token.length > 4096) {
      throw new Error('Push token length is invalid.')
    }

    const tokenHash = pushTokenHash(token)
    const existing = this.pushRegistrations.find((registration) =>
      registration.deviceId === device.deviceId
      && registration.provider === input.provider
      && registration.tokenHash === tokenHash
    )
    const registeredAt = new Date().toISOString()

    if (existing) {
      existing.revokedAt = undefined
      existing.registeredAt = registeredAt
      await this.persist()
      return existing
    }

    const registration: MobilePushRegistration = {
      protocolVersion: mobileControlProtocolVersion,
      registrationId: `mpr_${randomBase64Url(18)}`,
      deviceId: device.deviceId,
      provider: input.provider,
      tokenHash,
      registeredAt,
    }
    this.pushRegistrations.push(registration)
    await this.persist()
    return registration
  }

  async revokePushRegistration(registrationId: string): Promise<MobilePushRegistration> {
    await this.load()
    this.assertEnabled()

    const registration = this.pushRegistrations.find((candidate) => candidate.registrationId === registrationId)
    if (!registration) {
      throw new Error('Push registration was not found.')
    }

    registration.revokedAt = registration.revokedAt ?? new Date().toISOString()
    await this.persist()
    return registration
  }

  async listPushRegistrations(): Promise<MobilePushRegistration[]> {
    await this.load()
    return this.pushRegistrations.map(redactPushRegistration)
  }

  async listActivePushTargets(): Promise<MobilePushRegistrationTarget[]> {
    await this.load()
    const activeDeviceIds = new Set(
      this.pairedDevices
        .filter((device) => !device.revokedAt)
        .map((device) => device.deviceId)
    )
    return this.pushRegistrations
      .filter((registration) => activeDeviceIds.has(registration.deviceId) && !registration.revokedAt)
      .map((registration) => ({
        deviceId: registration.deviceId,
        registrationId: registration.registrationId,
      }))
  }

  async publishPresence(presence: MobileBridgePresence): Promise<MobileBridgeState> {
    await this.load()
    this.assertEnabled()

    if (!isMobileBridgePresence(presence)) {
      throw new Error('Unsupported mobile bridge presence value.')
    }

    this.presence = presence
    this.lastPresenceAt = new Date().toISOString()
    this.emitStateChanged()
    return this.snapshot()
  }

  async getDiagnostics(): Promise<MobileBridgeDiagnosticEntry[]> {
    await this.load()
    return this.diagnostics
  }

  shutdown(): void {
    this.clearReconnectTimer()
    this.clearCommandPollTimer()
    this.snapshotService.shutdown()
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true

    try {
      const payload = JSON.parse(await readFile(this.storePath, 'utf8')) as PersistedMobileBridgeState
      this.enabled = payload.enabled === true
      this.desktopInstanceId = typeof payload.desktopInstanceId === 'string' && payload.desktopInstanceId
        ? payload.desktopInstanceId
        : `mdi_${randomBase64Url(18)}`
      this.pairedDevices = Array.isArray(payload.pairedDevices)
        ? payload.pairedDevices.flatMap((device) => {
            return isMobileControlDevice(device) ? [device] : []
          })
        : []
      this.pushRegistrations = Array.isArray(payload.pushRegistrations)
        ? payload.pushRegistrations.flatMap((registration) => {
            return isMobilePushRegistration(registration) ? [registration] : []
          })
        : []
    } catch {
      this.desktopInstanceId = `mdi_${randomBase64Url(18)}`
    }

    this.relayStatus = this.enabled ? 'unconfigured' : 'disabled'
    this.presence = this.enabled ? 'available' : 'offline'
    if (this.enabled) {
      this.connectWithBackoff(0)
    }
    await this.persist()
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true })
    const payload: PersistedMobileBridgeState = {
      enabled: this.enabled,
      desktopInstanceId: this.desktopInstanceId,
      pairedDevices: this.pairedDevices,
      pushRegistrations: this.pushRegistrations,
    }
    await writeFile(this.storePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }

  private async connectOnce(): Promise<void> {
    if (!this.enabled) return
    if (!this.relayUrl) {
      this.relayStatus = 'unconfigured'
      this.nextReconnectAt = null
      this.recordDiagnostic('warning', 'relay_not_configured', 'Mobile relay URL is not configured.', true)
      this.emitStateChanged()
      return
    }

    const session = await this.sessionProvider()
    if (!session.authenticated) {
      this.relayStatus = 'error'
      this.recordDiagnostic('warning', 'unauthenticated', 'Mobile relay connection requires a signed-in desktop session.', true)
      this.connectWithBackoff()
      return
    }

    const accessToken = await this.accessTokenProvider()
    if (!accessToken) {
      this.relayStatus = 'error'
      this.recordDiagnostic('warning', 'unauthenticated', 'Mobile relay connection requires a desktop access token.', true)
      this.connectWithBackoff()
      return
    }

    this.relayStatus = 'connecting'
    this.nextReconnectAt = null
    this.emitStateChanged()

    try {
      const payload = await this.relayTransport.connectDesktop({
        relayUrl: this.relayUrl,
        accessToken,
        desktopInstanceId: this.desktopInstanceId,
        displayName: getDesktopDisplayName(),
        commands: RELAY_SUPPORTED_COMMANDS,
      })

      this.desktopRelaySessionId = payload.desktopRelaySessionId
      this.relayToken = payload.relayToken
      this.relayTokenExpiresAt = payload.expiresAt
      this.relayStatus = 'connected'
      this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
      this.recordDiagnostic('info', 'relay_connected', 'Mobile relay connection established.', false)
      this.emitStateChanged()
      this.startCommandPolling()
      void this.publishSnapshotToRelay()
    } catch (error) {
      this.relayStatus = 'error'
      this.recordDiagnostic('error', 'relay_unavailable', getErrorMessage(error), true)
      this.connectWithBackoff()
    }
  }

  private connectWithBackoff(delayMs = this.reconnectDelayMs): void {
    this.clearReconnectTimer()

    if (!this.enabled) {
      this.relayStatus = 'disabled'
      this.nextReconnectAt = null
      return
    }

    if (!this.relayUrl) {
      this.relayStatus = 'unconfigured'
      this.nextReconnectAt = null
      this.emitStateChanged()
      return
    }

    const boundedDelay = Math.min(Math.max(delayMs, 0), MAX_RECONNECT_DELAY_MS)
    this.relayStatus = boundedDelay > 0 ? 'retrying' : 'connecting'
    this.nextReconnectAt = new Date(Date.now() + boundedDelay).toISOString()
    this.reconnectTimer = setTimeout(() => {
      void this.connectOnce()
    }, boundedDelay)
    this.reconnectDelayMs = Math.min(Math.max(this.reconnectDelayMs * 2, INITIAL_RECONNECT_DELAY_MS), MAX_RECONNECT_DELAY_MS)
    this.emitStateChanged()
  }

  private disconnect(status: 'disabled' | 'unconfigured'): void {
    this.clearReconnectTimer()
    this.relayStatus = status
    this.desktopRelaySessionId = null
    this.relayToken = null
    this.relayTokenExpiresAt = null
    this.nextReconnectAt = null
    this.presence = 'offline'
    this.lastPresenceAt = new Date().toISOString()
    this.pairingChallenge = null
    this.clearCommandPollTimer()
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      this.recordDiagnostic('warning', 'mobile_bridge_disabled', 'Mobile companion control is disabled.', false)
      throw new Error('Mobile companion control is disabled.')
    }
  }

  private assertRelayReady(): void {
    if (!this.relayUrl || !this.desktopRelaySessionId || !this.relayToken || this.relayStatus !== 'connected') {
      this.recordDiagnostic('warning', 'relay_unavailable', 'Mobile relay session is not connected.', true)
      throw new Error('Mobile relay session is not connected.')
    }
  }

  private expirePairingChallenge(): void {
    if (!this.pairingChallenge) return
    if (Date.parse(this.pairingChallenge.expiresAt) > Date.now()) return
    this.pairingChallenge = null
  }

  private get capabilities(): MobileControlCapabilities {
    return {
      protocolVersion: mobileControlProtocolVersion,
      deviceId: this.desktopInstanceId,
      commands: SUPPORTED_COMMANDS,
      capabilities: REQUESTED_SCOPES,
      artifactPreviewModes: ['text', 'markdown'],
      maxFollowUpCharacters: 2000,
      snapshotTtlMs: 10_000,
    }
  }

  private snapshot(): MobileBridgeState {
    this.expirePairingChallenge()
    return {
      enabled: this.enabled,
      relayStatus: this.relayStatus,
      relayUrl: this.relayUrl,
      desktopInstanceId: this.desktopInstanceId,
      desktopRelaySessionId: this.desktopRelaySessionId,
      relayTokenExpiresAt: this.relayTokenExpiresAt,
      nextReconnectAt: this.nextReconnectAt,
      presence: this.presence,
      lastPresenceAt: this.lastPresenceAt,
      pairingChallenge: this.pairingChallenge
        ? {
            pairingChallengeId: this.pairingChallenge.pairingChallengeId,
            expiresAt: this.pairingChallenge.expiresAt,
            requestedScopes: this.pairingChallenge.requestedScopes,
          }
        : null,
      pairedDevices: this.pairedDevices,
      capabilities: this.capabilities,
      diagnostics: this.diagnostics,
    }
  }

  private recordDiagnostic(
    level: MobileBridgeDiagnosticEntry['level'],
    code: MobileBridgeDiagnosticEntry['code'],
    message: string,
    retryable: boolean
  ): void {
    const previous = this.diagnostics[0]
    if (previous?.code === code && previous.message === message) return

    this.diagnostics.unshift({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      code,
      message,
      retryable,
    })
    this.diagnostics = this.diagnostics.slice(0, MAX_DIAGNOSTICS)
  }

  private emitStateChanged(): void {
    const state = this.snapshot()
    for (const win of getAllBrowserWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('mobile-bridge:state-changed', state)
      }
    }
  }

  private get storePath(): string {
    if (this.storePathOverride) return this.storePathOverride
    return join(app.getPath('userData'), 'mobile-bridge.json')
  }

  private revokePushRegistrationsForDevice(deviceId: string, revokedAt: string): void {
    for (const registration of this.pushRegistrations) {
      if (registration.deviceId === deviceId && !registration.revokedAt) {
        registration.revokedAt = revokedAt
      }
    }
  }

  private startCommandPolling(): void {
    this.clearCommandPollTimer()
    this.commandPollTimer = setTimeout(() => {
      void this.pollRelayCommands()
    }, 0)
  }

  private clearCommandPollTimer(): void {
    if (!this.commandPollTimer) return
    clearTimeout(this.commandPollTimer)
    this.commandPollTimer = null
  }

  private scheduleNextCommandPoll(): void {
    this.clearCommandPollTimer()
    if (!this.enabled || this.relayStatus !== 'connected') return
    this.commandPollTimer = setTimeout(() => {
      void this.pollRelayCommands()
    }, this.commandPollIntervalMs)
  }

  private async pollRelayCommands(): Promise<void> {
    try {
      if (!this.enabled || this.relayStatus !== 'connected' || !this.relayUrl || !this.relayToken || !this.desktopRelaySessionId) {
        return
      }

      const deliveries = await this.relayTransport.listPendingCommands({
        relayUrl: this.relayUrl,
        relayToken: this.relayToken,
        desktopRelaySessionId: this.desktopRelaySessionId,
      })

      for (const delivery of deliveries) {
        await this.processRelayCommandDelivery(delivery)
      }
    } catch (error) {
      this.relayStatus = 'retrying'
      this.recordDiagnostic('error', 'relay_unavailable', getErrorMessage(error), true)
      this.connectWithBackoff()
      return
    } finally {
      this.scheduleNextCommandPoll()
    }
  }

  private async processRelayCommandDelivery(delivery: RelayCommandDelivery): Promise<void> {
    const { envelope, device } = normalizeRelayCommandDelivery(delivery)
    if (this.activeRelayCommandIds.has(envelope.commandId)) return
    this.activeRelayCommandIds.add(envelope.commandId)

    try {
      const result = await this.dispatchRelayCommand(envelope, device)
      await this.postCommandResult(envelope.commandId, result)
    } catch (error) {
      await this.postCommandResult(envelope.commandId, failedCommandResult(envelope, 'internal_error', getErrorMessage(error)))
    } finally {
      this.activeRelayCommandIds.delete(envelope.commandId)
    }
  }

  private async dispatchRelayCommand(
    envelope: RelayCommandEnvelope,
    device: MobileRelayAuthenticatedDevice | null
  ): Promise<MobileSwarmCommandResult> {
    const commandType = relayCommandTypeToMobile(envelope.commandType)
    const authorizationError = this.authorizeRelayCommand(envelope, commandType, device)
    if (authorizationError) {
      return failedCommandResult(envelope, authorizationError.code, authorizationError.message)
    }

    const activeDevice = this.upsertRelayDevice(device as MobileRelayAuthenticatedDevice)
    const command = {
      protocolVersion: mobileControlProtocolVersion,
      commandId: envelope.commandId,
      type: commandType,
      issuedAt: envelope.issuedAt,
      deviceId: activeDevice.deviceId,
      idempotencyKey: `relay:${envelope.commandId}`,
      ...(envelope.expectedSnapshotVersion ? { expectedSnapshotVersion: envelope.expectedSnapshotVersion } : {}),
      payload: envelope.payload,
    } as MobileControlCommand

    switch (commandType) {
      case 'snapshot.request':
        return this.dispatchSnapshotRequest(command)
      case 'artifact.read':
        return this.dispatchArtifactRead(command)
      case 'device.revoke':
        return this.dispatchDeviceRevoke(command)
      case 'sprintengine.create':
      case 'task.start':
      case 'artifact.approve':
      case 'artifact.requestChanges':
      case 'agent.followUp':
        return this.commandService.dispatch(command)
    }
  }

  private authorizeRelayCommand(
    envelope: RelayCommandEnvelope,
    commandType: MobileControlCommandType,
    device: MobileRelayAuthenticatedDevice | null
  ): { code: MobileControlErrorCode; message: string } | null {
    if (!this.desktopRelaySessionId || envelope.desktopRelaySessionId !== this.desktopRelaySessionId) {
      return { code: 'unauthorized', message: 'Relay command targets a different desktop relay session.' }
    }

    if (!device?.deviceId) {
      return { code: 'unauthenticated', message: 'Relay command is missing authenticated paired-device context.' }
    }

    if (device.revokedAt) {
      return { code: 'device_revoked', message: 'Relay command was issued by a revoked mobile device.' }
    }

    if (!device.status) {
      return { code: 'unauthenticated', message: 'Relay command is missing paired-device status.' }
    }

    if (device.status !== 'active') {
      return { code: 'device_revoked', message: 'Relay command was issued by an inactive mobile device.' }
    }

    if (!device.desktopRelaySessionId || device.desktopRelaySessionId !== this.desktopRelaySessionId) {
      return { code: 'unauthorized', message: 'Relay command device context targets a different desktop session.' }
    }

    const localDevice = this.pairedDevices.find((candidate) => candidate.deviceId === device.deviceId)
    if (localDevice?.revokedAt) {
      return { code: 'device_revoked', message: 'Mobile device is revoked on this desktop.' }
    }

    const capabilities = relayDeviceCapabilities(device)
    const requiredCapability = CAPABILITY_BY_COMMAND[commandType]
    if (!capabilities.includes(requiredCapability)) {
      return { code: 'unauthorized', message: `Mobile device is missing ${requiredCapability}.` }
    }

    if (SIDE_EFFECTING_COMMANDS.has(commandType) && !localDevice && !device.pairedAt) {
      return { code: 'unauthorized', message: 'Side-effecting relay command requires a known paired mobile device.' }
    }

    return null
  }

  private upsertRelayDevice(device: MobileRelayAuthenticatedDevice): MobileControlDevice {
    const now = new Date().toISOString()
    const capabilities = relayDeviceCapabilities(device)
    const existing = this.pairedDevices.find((candidate) => candidate.deviceId === device.deviceId)
    if (existing) {
      existing.displayName = device.displayName?.trim() || existing.displayName
      existing.lastSeenAt = device.lastSeenAt ?? now
      existing.revokedAt = device.revokedAt
      existing.capabilities = capabilities
      return existing
    }

    const pairedDevice: MobileControlDevice = {
      protocolVersion: mobileControlProtocolVersion,
      deviceId: device.deviceId,
      displayName: device.displayName?.trim() || 'Mobile device',
      platform: normalizeDevicePlatform(device.platform),
      appVersion: device.appVersion?.trim() || 'unknown',
      pairedAt: device.pairedAt ?? now,
      lastSeenAt: device.lastSeenAt ?? now,
      ...(device.revokedAt ? { revokedAt: device.revokedAt } : {}),
      capabilities,
    }
    this.pairedDevices.push(pairedDevice)
    void this.persist().then(() => this.emitStateChanged())
    return pairedDevice
  }

  private async dispatchSnapshotRequest(command: MobileControlCommand): Promise<MobileSwarmCommandResult> {
    const statePaths = await this.statePathsProvider()
    const snapshot = await this.snapshotService.readSnapshot({
      desktopSessionId: this.desktopRelaySessionId ?? this.desktopInstanceId,
      statePaths,
    })
    return acceptedBridgeCommand(command, snapshot)
  }

  private async dispatchArtifactRead(command: MobileControlCommand): Promise<MobileSwarmCommandResult> {
    const swarmId = stringPayload(command.payload, 'swarmId')
    const artifactId = stringPayload(command.payload, 'artifactId')
    const previewMode = stringPayload(command.payload, 'previewMode')
    if (previewMode !== 'text' && previewMode !== 'markdown') {
      return failedCommandResult(command, 'path_not_allowed', 'Only text and markdown artifact preview modes are supported.')
    }

    const statePaths = await this.statePathsProvider()
    const snapshot = await this.snapshotService.readSnapshot({
      desktopSessionId: this.desktopRelaySessionId ?? this.desktopInstanceId,
      statePaths,
    })
    const sprintengine = snapshot.swarms.find((candidate) => candidate.swarmId === swarmId)
    const artifact = sprintengine?.artifacts.find((candidate) => candidate.artifactId === artifactId)
    if (!sprintengine || !artifact?.path) {
      return failedCommandResult(command, 'artifact_not_found', 'Requested artifact was not found.')
    }

    const artifactPath = resolveArtifactPathForRead(dirname(sprintengine.statePath), sprintengine.workspacePath, artifact.path)
    const content = await readFile(artifactPath, 'utf8')
    return acceptedBridgeCommand(command, {
      artifactId,
      swarmId,
      previewMode,
      path: artifact.path,
      name: basename(artifactPath),
      content,
    })
  }

  private async dispatchDeviceRevoke(command: MobileControlCommand): Promise<MobileSwarmCommandResult> {
    const deviceId = stringPayload(command.payload, 'deviceId')
    const payload = command.payload as Record<string, unknown>
    const reason = typeof payload.reason === 'string' ? payload.reason : undefined
    let device: MobileControlDevice
    try {
      device = await this.revokeDevice(deviceId, reason)
    } catch (error) {
      return failedCommandResult(command, 'relay_unavailable', getErrorMessage(error))
    }
    return acceptedBridgeCommand(command, { revoked: true, deviceId: device.deviceId })
  }

  private async revokeDeviceAtRelay(deviceId: string, reason: string): Promise<void> {
    if (!this.relayUrl) {
      this.recordDiagnostic('warning', 'relay_not_configured', 'Mobile relay URL is not configured; device was not revoked.', true)
      throw new Error('Mobile relay URL is not configured.')
    }

    const accessToken = await this.accessTokenProvider()
    if (!accessToken) {
      this.recordDiagnostic('warning', 'unauthenticated', 'Mobile relay revocation requires a desktop access token.', true)
      throw new Error('Mobile relay revocation requires a desktop access token.')
    }

    try {
      await this.relayTransport.revokeDevice({
        relayUrl: this.relayUrl,
        accessToken,
        deviceId,
        reason,
      })
    } catch (error) {
      this.recordDiagnostic('error', 'relay_unavailable', `Relay device revocation failed: ${getErrorMessage(error)}`, true)
      throw error
    }
  }

  private async postCommandResult(commandId: string, result: MobileSwarmCommandResult): Promise<void> {
    if (!this.relayUrl || !this.relayToken) return
    const summary = summarizeCommandResult(result)
    await this.relayTransport.postCommandResult({
      relayUrl: this.relayUrl,
      relayToken: this.relayToken,
      commandId,
      status: result.ok ? 'completed' : 'failed',
      resultCode: result.ok ? 'OK' : result.error.code.toUpperCase(),
      summary,
    })
  }

  private async publishSnapshotToRelay(): Promise<void> {
    if (!this.relayTransport.publishSnapshot || !this.relayUrl || !this.relayToken || !this.desktopRelaySessionId) return
    try {
      const snapshot = await this.snapshotService.publishSnapshot({
        desktopSessionId: this.desktopRelaySessionId,
        statePaths: await this.statePathsProvider(),
      })
      if (snapshot) {
        await this.relayTransport.publishSnapshot({
          relayUrl: this.relayUrl,
          relayToken: this.relayToken,
          desktopRelaySessionId: this.desktopRelaySessionId,
          snapshot,
        })
      }
    } catch (error) {
      this.recordDiagnostic('warning', 'relay_unavailable', `Snapshot publication failed: ${getErrorMessage(error)}`, true)
    }
  }
}

class FetchMobileRelayTransport implements MobileRelayTransport {
  async connectDesktop(input: {
    relayUrl: string
    accessToken: string
    desktopInstanceId: string
    displayName: string
    commands: RelayCommandType[]
  }): Promise<RelayConnectResult> {
    const payload = await relayJsonRequest(input.relayUrl, '/api/relay/desktop/connect', {
      token: input.accessToken,
      method: 'POST',
      body: {
        desktopInstanceId: input.desktopInstanceId,
        displayName: input.displayName,
        capabilities: {
          mobileControlProtocolVersion,
          commands: input.commands,
        },
      },
    })

    return {
      desktopRelaySessionId: requireRelayString(payload, 'desktopRelaySessionId'),
      relayToken: requireRelayString(payload, 'relayToken'),
      expiresAt: requireRelayString(payload, 'expiresAt'),
      heartbeatAfterSeconds: typeof payload.heartbeatAfterSeconds === 'number' ? payload.heartbeatAfterSeconds : undefined,
    }
  }

  async createPairingChallenge(input: {
    relayUrl: string
    relayToken: string
    desktopRelaySessionId: string
    requestedScopes: MobileRelayScope[]
  }): Promise<RelayPairingChallengeResult> {
    const payload = await relayJsonRequest(input.relayUrl, '/api/relay/desktop/pairing-challenges', {
      token: input.relayToken,
      method: 'POST',
      body: {
        desktopRelaySessionId: input.desktopRelaySessionId,
        requestedScopes: input.requestedScopes,
        relayUrl: input.relayUrl,
      },
    })
    const pairingPayload = optionalPairingPayload(payload, 'pairingPayload')

    return {
      pairingChallengeId: requireRelayString(payload, 'pairingChallengeId'),
      ...(typeof payload['manualPairingCode'] === 'string' && payload['manualPairingCode'].trim()
        ? { manualPairingCode: payload['manualPairingCode'].trim() }
        : {}),
      pairingUri: requireRelayString(payload, 'pairingUri'),
      ...(pairingPayload ? { pairingPayload } : {}),
      expiresAt: requireRelayString(payload, 'expiresAt'),
    }
  }

  async listPendingCommands(input: {
    relayUrl: string
    relayToken: string
    desktopRelaySessionId: string
  }): Promise<RelayCommandDelivery[]> {
    const payload = await relayJsonRequest(input.relayUrl, '/api/relay/desktop/commands', {
      token: input.relayToken,
      method: 'POST',
      body: {
        desktopRelaySessionId: input.desktopRelaySessionId,
      },
    })
    const commands = payload.commands
    if (!Array.isArray(commands)) {
      throw new Error('Relay command response did not include commands.')
    }
    return commands.map(parseRelayCommandDelivery)
  }

  async postCommandResult(input: {
    relayUrl: string
    relayToken: string
    commandId: string
    status: RelayCommandResultStatus
    resultCode: string
    summary: Record<string, unknown>
  }): Promise<void> {
    await relayJsonRequest(input.relayUrl, `/api/relay/commands/${encodeURIComponent(input.commandId)}/result`, {
      token: input.relayToken,
      method: 'POST',
      body: {
        status: input.status,
        resultCode: input.resultCode,
        summary: input.summary,
      },
    })
  }

  async revokeDevice(input: {
    relayUrl: string
    accessToken: string
    deviceId: string
    reason: string
  }): Promise<{ revoked: true }> {
    const payload = await relayJsonRequest(input.relayUrl, `/api/relay/devices/${encodeURIComponent(input.deviceId)}/revoke`, {
      token: input.accessToken,
      method: 'POST',
      body: {
        reason: input.reason,
      },
    })

    if (payload.revoked !== true) {
      throw new Error('Relay revoke response did not confirm device revocation.')
    }

    return { revoked: true }
  }
}

async function relayJsonRequest(
  relayUrl: string,
  path: string,
  input: {
    token: string
    method: 'POST'
    body: Record<string, unknown>
  }
): Promise<Record<string, unknown>> {
  const response = await fetch(`${relayUrl}${path}`, {
    method: input.method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${input.token}`,
      'content-type': 'application/json',
      'x-request-id': randomUUID(),
    },
    body: JSON.stringify(input.body),
  })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>

  if (!response.ok) {
    throw new Error(readRelayErrorMessage(payload, response.status))
  }

  return payload
}

function requireRelayString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Relay response field ${field} is required.`)
  }
  return value
}

function parseRelayCommandDelivery(input: unknown): RelayCommandDelivery {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Relay command delivery must be an object.')
  }

  const delivery = input as Record<string, unknown>
  if (!Object.hasOwn(delivery, 'envelope') || !Object.hasOwn(delivery, 'device')) {
    throw new Error('Relay command delivery must include envelope and device.')
  }

  return {
    envelope: parseRelayCommandEnvelope(delivery.envelope),
    device: parseRelayCommandDevice(delivery.device),
  }
}

function parseRelayCommandEnvelope(input: unknown): RelayCommandEnvelope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Relay command envelope must be an object.')
  }

  const envelope = input as Record<string, unknown>
  const commandType = requireRelayRecordString(envelope, 'commandType')
  if (!RELAY_SUPPORTED_COMMANDS.includes(commandType as RelayCommandType)) {
    throw new Error(`Unsupported relay command type: ${commandType}.`)
  }

  const payload = envelope.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Relay command payload must be an object.')
  }

  const expectedSnapshotVersion = envelope.expectedSnapshotVersion
  if (expectedSnapshotVersion !== undefined && typeof expectedSnapshotVersion !== 'string') {
    throw new Error('Relay command expectedSnapshotVersion must be a string.')
  }

  return {
    desktopRelaySessionId: requireRelayRecordString(envelope, 'desktopRelaySessionId'),
    commandId: requireRelayRecordString(envelope, 'commandId'),
    commandType: commandType as RelayCommandType,
    issuedAt: requireRelayRecordString(envelope, 'issuedAt'),
    expiresAt: requireRelayRecordString(envelope, 'expiresAt'),
    ...(expectedSnapshotVersion ? { expectedSnapshotVersion } : {}),
    payload: payload as Record<string, unknown>,
  }
}

function parseRelayCommandDevice(input: unknown): MobileRelayAuthenticatedDevice | null {
  if (input === null) return null
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Relay command device must be an object or null.')
  }

  return input as MobileRelayAuthenticatedDevice
}

function requireRelayRecordString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Relay command field ${field} is required.`)
  }
  return value
}

function optionalPairingPayload(
  payload: Record<string, unknown>,
  field: string
): RelayPairingChallengeResult['pairingPayload'] | undefined {
  const value = payload[field]
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Relay response field ${field} must be an object.`)
  }

  const pairingPayload = value as Record<string, unknown>
  const desktop = pairingPayload.desktop
  if (!desktop || typeof desktop !== 'object' || Array.isArray(desktop)) {
    throw new Error(`Relay response field ${field}.desktop must be an object.`)
  }
  const desktopPayload = desktop as Record<string, unknown>
  if (pairingPayload.mobileControlProtocolVersion !== mobileControlProtocolVersion) {
    throw new Error(`Relay response field ${field}.mobileControlProtocolVersion must be 1.`)
  }

  return {
    mobileControlProtocolVersion: 1,
    pairingChallengeId: requireRelayString(pairingPayload, 'pairingChallengeId'),
    relayUrl: requireRelayString(pairingPayload, 'relayUrl'),
    pairingSecret: requireRelayString(pairingPayload, 'pairingSecret'),
    expiresAt: requireRelayString(pairingPayload, 'expiresAt'),
    desktop: {
      displayName: requireRelayString(desktopPayload, 'displayName'),
      desktopInstanceId: requireRelayString(desktopPayload, 'desktopInstanceId'),
      desktopRelaySessionId: requireRelayString(desktopPayload, 'desktopRelaySessionId'),
    },
  }
}

function normalizeRelayCommandDelivery(delivery: RelayCommandDelivery): {
  envelope: RelayCommandEnvelope
  device: MobileRelayAuthenticatedDevice | null
} {
  return { envelope: delivery.envelope, device: delivery.device }
}

function relayCommandTypeToMobile(type: RelayCommandType): MobileControlCommandType {
  return type === 'agent.followup' ? 'agent.followUp' : type
}

function relayDeviceCapabilities(device: MobileRelayAuthenticatedDevice): MobileControlCapability[] {
  const capabilities = new Set<MobileControlCapability>()

  for (const capability of device.capabilities ?? []) {
    if (isMobileControlCapability(capability)) capabilities.add(capability)
  }

  for (const scope of device.scopes ?? []) {
    const capability = CAPABILITY_BY_RELAY_SCOPE[scope]
    if (capability) capabilities.add(capability)
  }

  return [...capabilities]
}

function normalizeDevicePlatform(platform: MobileRelayAuthenticatedDevice['platform']): MobileControlDevice['platform'] {
  if (platform === 'ios' || platform === 'android' || platform === 'web') return platform
  return 'web'
}

function acceptedBridgeCommand(
  command: MobileControlCommand,
  data: unknown
): Extract<MobileSwarmCommandResult, { ok: true }> {
  return {
    ok: true,
    commandId: command.commandId,
    commandType: command.type,
    idempotencyKey: command.idempotencyKey,
    executedAt: new Date().toISOString(),
    data,
    stdout: '',
    stderr: '',
    audit: {
      auditId: `msa_${randomUUID()}`,
      commandId: command.commandId,
      commandType: command.type,
      deviceId: command.deviceId,
      ...(command.idempotencyKey ? { idempotencyKey: command.idempotencyKey } : {}),
      status: 'accepted',
      message: 'Mobile relay command was handled by the desktop bridge.',
      recordedAt: new Date().toISOString(),
    },
  }
}

function failedCommandResult(
  command: Pick<MobileControlCommand, 'commandId' | 'type' | 'idempotencyKey'> | RelayCommandEnvelope,
  code: MobileControlErrorCode,
  message: string
): Extract<MobileSwarmCommandResult, { ok: false }> {
  const commandType = 'type' in command ? command.type : relayCommandTypeToMobile(command.commandType)
  return {
    ok: false,
    commandId: command.commandId,
    commandType,
    ...('idempotencyKey' in command && command.idempotencyKey ? { idempotencyKey: command.idempotencyKey } : {}),
    error: {
      protocolVersion: mobileControlProtocolVersion,
      code,
      message,
      retryable: code === 'relay_unavailable' || code === 'desktop_unavailable',
    },
    audit: {
      auditId: `msa_${randomUUID()}`,
      commandId: command.commandId,
      commandType,
      deviceId: null,
      status: 'rejected',
      code,
      message,
      recordedAt: new Date().toISOString(),
    },
  }
}

function summarizeCommandResult(result: MobileSwarmCommandResult): Record<string, unknown> {
  if (!result.ok) {
    return {
      ok: false,
      commandId: result.commandId,
      commandType: result.commandType,
      code: result.error.code,
      message: result.error.message,
      retryable: result.error.retryable,
    }
  }

  return {
    ok: true,
    commandId: result.commandId,
    commandType: result.commandType,
    executedAt: result.executedAt,
    data: sanitizeResultData(result.data),
  }
}

function sanitizeResultData(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data
  const json = JSON.stringify(data)
  if (json.length > 256 * 1024) {
    return { truncated: true }
  }
  return data
}

function stringPayload(payload: unknown, field: string): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Command payload must be an object.')
  }
  const value = (payload as Record<string, unknown>)[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`)
  }
  return value
}

function resolveArtifactPathForRead(teamDirectory: string, workspacePath: string, artifactPathInput: string): string {
  const artifactPath = artifactPathInput.trim()
  if (!artifactPath || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(artifactPath)) {
    throw new Error('Artifact path must be a workspace file path.')
  }

  const fullPath = isAbsolute(artifactPath)
    ? resolve(artifactPath)
    : [
        resolve(workspacePath, artifactPath),
        resolve(teamDirectory, artifactPath),
      ].find((candidate) => isPathInsideOrEqual(teamDirectory, candidate))
        ?? resolve(workspacePath, artifactPath)

  if (!isPathInsideOrEqual(teamDirectory, fullPath)) {
    throw new Error('Artifact path must stay inside the Sprint Engine team directory.')
  }

  return fullPath
}

function isPathInsideOrEqual(parentPath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(targetPath))
  return (
    relativePath === ''
    || (!relativePath.startsWith('..') && !isAbsolute(relativePath) && !relativePath.split(sep).includes('..'))
  )
}

async function defaultSwarmStatePaths(): Promise<string[]> {
  return []
}

function manualPairingValueFromRelayChallenge(challenge: RelayPairingChallengeResult): string {
  if (challenge.manualPairingCode) return challenge.manualPairingCode

  if (!challenge.pairingPayload) {
    if (isCurrentMobilePairingUri(challenge.pairingUri)) return challenge.pairingUri
    throw new Error('Relay pairing challenge did not include a mobile-compatible pairing payload.')
  }

  let url: URL
  try {
    url = new URL(challenge.pairingUri)
  } catch {
    url = new URL('multicode://mobile/pair')
  }

  url.searchParams.set('mobileControlProtocolVersion', String(challenge.pairingPayload.mobileControlProtocolVersion))
  url.searchParams.set('pairingChallengeId', challenge.pairingPayload.pairingChallengeId)
  url.searchParams.set('relayUrl', challenge.pairingPayload.relayUrl)
  url.searchParams.set('pairingSecret', challenge.pairingPayload.pairingSecret)
  url.searchParams.set('expiresAt', challenge.pairingPayload.expiresAt)
  url.searchParams.set('desktopName', challenge.pairingPayload.desktop.displayName)
  url.searchParams.set('desktopInstanceId', challenge.pairingPayload.desktop.desktopInstanceId)
  url.searchParams.set('desktopRelaySessionId', challenge.pairingPayload.desktop.desktopRelaySessionId)

  return url.toString()
}

function isCurrentMobilePairingUri(pairingUri: string): boolean {
  try {
    const params = new URL(pairingUri).searchParams
    return params.get('mobileControlProtocolVersion') === String(mobileControlProtocolVersion)
      && Boolean(params.get('pairingChallengeId')?.trim())
      && Boolean(params.get('relayUrl')?.trim() || params.get('relay')?.trim())
      && Boolean(params.get('pairingSecret')?.trim())
      && Boolean(params.get('expiresAt')?.trim())
      && Boolean((params.get('desktopName') ?? params.get('desktopDisplayName'))?.trim())
      && Boolean(params.get('desktopInstanceId')?.trim())
  } catch {
    return false
  }
}

function isMobileControlDevice(input: unknown): input is MobileControlDevice {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const device = input as Partial<MobileControlDevice>
  return device.protocolVersion === mobileControlProtocolVersion
    && typeof device.deviceId === 'string'
    && typeof device.displayName === 'string'
    && (device.platform === 'ios' || device.platform === 'android' || device.platform === 'web')
    && typeof device.appVersion === 'string'
    && typeof device.pairedAt === 'string'
    && Number.isFinite(Date.parse(device.pairedAt))
    && (device.lastSeenAt === undefined || Number.isFinite(Date.parse(device.lastSeenAt)))
    && (device.revokedAt === undefined || Number.isFinite(Date.parse(device.revokedAt)))
    && Array.isArray(device.capabilities)
    && device.capabilities.every(isMobileControlCapability)
}

function isMobileControlCapability(input: unknown): input is MobileControlCapability {
  return REQUESTED_SCOPES.includes(input as MobileControlCapability)
}

function isMobilePushRegistration(input: unknown): input is MobilePushRegistration {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const registration = input as Partial<MobilePushRegistration>
  return registration.protocolVersion === mobileControlProtocolVersion
    && typeof registration.registrationId === 'string'
    && typeof registration.deviceId === 'string'
    && isMobilePushProvider(registration.provider)
    && typeof registration.tokenHash === 'string'
    && /^[a-f0-9]{64}$/u.test(registration.tokenHash)
    && typeof registration.registeredAt === 'string'
    && Number.isFinite(Date.parse(registration.registeredAt))
    && (registration.lastUsedAt === undefined || Number.isFinite(Date.parse(registration.lastUsedAt)))
    && (registration.revokedAt === undefined || Number.isFinite(Date.parse(registration.revokedAt)))
}

function isMobilePushProvider(input: unknown): input is MobilePushProvider {
  return input === 'apns' || input === 'fcm' || input === 'expo'
}

function redactPushRegistration(registration: MobilePushRegistration): MobilePushRegistration {
  return { ...registration }
}

function isMobileBridgePresence(input: string): input is MobileBridgePresence {
  return input === 'available' || input === 'busy' || input === 'idle' || input === 'offline'
}

function readRelayErrorMessage(payload: Record<string, unknown>, status: number): string {
  const error = payload.error
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return `Mobile relay request failed with HTTP ${status}.`
}
