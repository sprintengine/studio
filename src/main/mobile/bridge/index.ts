import {
  MobileControlCommandService,
  type MobileControlCommand,
  type MobileControlCommandResult,
} from '../control/command'
import { MobileControlSnapshotService, type MobileControlSnapshot } from '../control/snapshot'
import { getErrorMessage } from '../../error-message'
import { hashSecret } from './crypto'
import { getDesktopDisplayName } from './desktop'
import { manualPairingValueFromRelayChallenge } from './pairing'
import { FetchMobileRelayTransport, RELAY_SUPPORTED_COMMANDS } from './relay-transport'
import { isMobileBridgePresence } from './validation'
import {
  failedCommandResult,
  relaySummaryByteLength,
  relayResultSummaryMaxBytes,
  summarizeCommandResult,
} from './command-results'
import { relayCommandTypeToMobile, relayEnvelopeToMobileCommand } from './relay-command'
import { dispatchDeviceRevoke } from './device-revoke'
import { dispatchSnapshotRequest } from './snapshot-request'
import { authorizeRelayCommand } from './relay-auth'
import { upsertRelayDevice } from './relay-device'
import { DEFAULT_MOBILE_RELAY_URL } from '../../service-endpoints'
import { getDefaultMobileBridgeStorePath, readMobileBridgeStore, writeMobileBridgeStore } from './store'
import { emitMobileBridgeStateChanged, recordMobileBridgeDiagnostic } from './notifications'
import {
  listActiveMobilePushTargets,
  listMobilePushRegistrations,
  registerMobilePushToken,
  revokeMobilePushRegistration,
  revokePushRegistrationsForDevice,
  type MobilePushRegistrationTarget,
} from './push'

// The wire's version window is owned by packages/mobile-control-protocol/src/index.ts.
// This module kept its own `const mobileControlProtocolVersion = 2` until
// 2026-09-14, as did relay-transport.ts and command-validation.ts — and
// command-results.ts and push.ts until the v4 bump, which found them still
// stamping 2. Private copies of one wire fact are places for a bump to miss.
import {
  mobileControlProtocolVersion,
  type MobileControlProtocolVersion,
} from '../../../../packages/mobile-control-protocol/src/index'
import { readStudioEnv } from '../../../shared/studio-env'

export type MobileControlCommandType =
  'snapshot.request' | 'device.revoke' | 'backlog.update' | 'backlog.create' | 'automations.control'

export type MobileControlCapability =
  | 'snapshots.read'
  | 'devices.revoke'
  | 'backlog.update'
  | 'backlog.create'
  // Enable, pause or run one of the desktop's automations (src/main/automations).
  | 'automations.control'

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
  // The automations controller answers `runNow` on a run already in flight with
  // it (../control/command.ts).
  | 'task_not_ready'
  | 'path_not_allowed'
  | 'snapshot_too_large'
  | 'internal_error'

export type MobileControlDevice = {
  /**
   * The version this device was last stamped at — inside the window, not
   * necessarily current. A record written by an older build is still a record,
   * and the store validator must keep reading it: dropping one would unpair
   * someone's phone on the first restart after a bump, silently.
   */
  protocolVersion: MobileControlProtocolVersion
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
  /** Stamped at registration time, and read back across bumps — see `MobileControlDevice`. */
  protocolVersion: MobileControlProtocolVersion
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
  snapshotTtlMs: number
}

export type MobileRelayScope =
  | 'relay:presence:read'
  | 'relay:snapshot:read'
  | 'relay:push:register'
  | 'relay:device:revoke'
  | 'relay:backlog:update'
  | 'relay:backlog:create'
  | 'relay:automations:control'

export type RelayCommandType =
  'snapshot.request' | 'device.revoke' | 'backlog.update' | 'backlog.create' | 'automations.control'

export type RelayCommandEnvelope = {
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

export type RelayCommandDelivery = {
  envelope: RelayCommandEnvelope
  device: MobileRelayAuthenticatedDevice | null
}

export type RelayConnectResult = {
  desktopRelaySessionId: string
  relayToken: string
  expiresAt: string
  heartbeatAfterSeconds?: number
}

export type RelayPairingChallengeResult = {
  pairingChallengeId: string
  manualPairingCode?: string
  pairingUri: string
  pairingPayload?: {
    /** The version the relay named, carried through rather than assumed current. */
    mobileControlProtocolVersion: MobileControlProtocolVersion
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

export type RelayCommandResultStatus = 'completed' | 'failed'

export type MobileRelayTransport = {
  connectDesktop(input: {
    relayUrl: string
    accessToken: string
    organizationId?: string | null
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
    organizationId?: string | null
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
  // Enabled and configured, but deliberately not connected because no active
  // paired device (and no pending pairing challenge) can be listening. The bridge
  // issues zero relay traffic in this state; pairing a device brings it up.
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'retrying'
  | 'error'

// Current effective command-poll cadence, surfaced on the bridge status payload so
// Settings → Mobile can explain first-command latency. `paused` = not polling (no
// device/challenge); `fast` = base interval; `decayed` = backed off toward the ceiling.
export type MobileBridgeCommandPollCadence = {
  intervalMs: number
  state: 'paused' | 'fast' | 'decayed'
}

export type MobileBridgePresence = 'available' | 'busy' | 'idle' | 'offline'

export type MobileBridgeDiagnosticEntry = {
  id: string
  timestamp: string
  level: 'info' | 'warning' | 'error'
  code: MobileControlErrorCode | 'mobile_bridge_disabled' | 'relay_not_configured' | 'relay_connected'
  message: string
  retryable: boolean
}

export type MobileBridgeCommandEvent = {
  id: string
  commandId: string
  commandType: MobileControlCommandType
  deviceId: string | null
  deviceName: string | null
  receivedAt: string
  completedAt?: string
  status: 'received' | 'completed' | 'failed'
  resultCode?: string
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
  recentCommands: MobileBridgeCommandEvent[]
  commandPollCadence: MobileBridgeCommandPollCadence
}

export type MobileBridgeSettingsUpdate = {
  enabled?: boolean
  relayUrl?: string | null
}

// `selectedOrganization` is what a Clerk-authenticated desktop tells the relay
// to bind to; a Multiauth token carries its own and the relay
// ignores the header. Optional so test doubles need not supply it.
type DesktopSessionProvider = () => Promise<{
  authenticated: boolean
  session?: { id: string; expiresAt: string }
  selectedOrganization?: { id: string } | null
}>
type DesktopAccessTokenProvider = () => Promise<string | null>
type MobileWorkspaceRootsProvider = () => Promise<string[]>

export type MobileBridgeOptions = {
  relayUrl?: string | null
  storePath?: string
  accessTokenProvider?: DesktopAccessTokenProvider
  relayTransport?: MobileRelayTransport
  commandService?: MobileControlCommandService
  snapshotService?: MobileControlSnapshotService
  workspaceRootsProvider?: MobileWorkspaceRootsProvider
  commandPollIntervalMs?: number
  commandPollCeilingMs?: number
  commandPollAttentionWindowMs?: number
}

// The default relay; `./service-endpoints` lets a build bake in a different
// one via SPRINTENGINE_MOBILE_RELAY_URL, which also overrides it at runtime.
const DEFAULT_RELAY_URL = DEFAULT_MOBILE_RELAY_URL
const RELAY_URL = readStudioEnv('SPRINTENGINE_MOBILE_RELAY_URL')?.replace(/\/+$/u, '') || DEFAULT_RELAY_URL
const USING_DEFAULT_RELAY_URL = RELAY_URL === DEFAULT_RELAY_URL
const INITIAL_RECONNECT_DELAY_MS = 1000
const MAX_RECONNECT_DELAY_MS = 60 * 1000
const DEFAULT_COMMAND_POLL_INTERVAL_MS = 2_000
// Idle backoff: once no command has arrived for the attention window, the poll
// interval doubles each tick up to the ceiling; any delivered command snaps it back
// to the base interval. The window covers the phone's own ~20s foreground cadence so
// an actively-viewed phone keeps the desktop fast.
const DEFAULT_COMMAND_POLL_CEILING_MS = 30_000
const DEFAULT_COMMAND_POLL_ATTENTION_WINDOW_MS = 150_000
// What this desktop ASKS a phone for at pairing, and what it tells a paired
// phone it can do. Removing the Sprint Engine took its scopes and commands out of
// these three lists; protocol v3 took them off the wire entirely, so the INBOUND
// vocabulary — `RelayCommandType`, `MobileControlCapability` and the protocol's
// command union — no longer carries them either. There is no older phone to read
// an envelope for: a peer outside the version window is refused at the
// handshake, which is the one place a version mismatch should be answered.
const REQUESTED_SCOPES: MobileControlCapability[] = [
  'snapshots.read',
  'devices.revoke',
  'backlog.update',
  'backlog.create',
  'automations.control',
]
const REQUESTED_RELAY_SCOPES: MobileRelayScope[] = [
  'relay:snapshot:read',
  'relay:device:revoke',
  'relay:backlog:update',
  'relay:backlog:create',
  'relay:automations:control',
]
const SUPPORTED_COMMANDS: MobileControlCommandType[] = [
  'snapshot.request',
  'device.revoke',
  'backlog.update',
  'backlog.create',
  'automations.control',
]
function normalizeRelayUrlUpdate(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  const trimmed = value.trim().replace(/\/+$/u, '')
  return trimmed || null
}

function shouldReplaceStoredRelayUrl(value: string | null): boolean {
  if (!USING_DEFAULT_RELAY_URL || !value) return false

  try {
    const url = new URL(value)
    return (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && (url.port === '3000' || url.port === '')
  } catch {
    return false
  }
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
  private recentCommands: MobileBridgeCommandEvent[] = []
  private reconnectTimer: NodeJS.Timeout | null = null
  private commandPollTimer: NodeJS.Timeout | null = null
  // shutdown() is sync; connectOnce / pollRelayCommands are not. An in-flight
  // poll's `finally` used to call scheduleNextCommandPoll after the timer was
  // cleared, which rescheduled forever and kept a Node process (the unit-test
  // runner included) from exiting.
  private closed = false
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
  private loaded = false
  private relayToken: string | null = null
  private relayUrl: string | null
  private readonly storePathOverride?: string
  private readonly accessTokenProvider: DesktopAccessTokenProvider
  private readonly relayTransport: MobileRelayTransport
  private readonly commandService: MobileControlCommandService
  private readonly snapshotService: MobileControlSnapshotService
  private readonly workspaceRootsProvider: MobileWorkspaceRootsProvider
  private readonly commandPollIntervalMs: number
  private readonly commandPollCeilingMs: number
  private readonly commandPollAttentionWindowMs: number
  private commandPollIntervalMsCurrent: number
  private commandPollAttentionUntil = 0
  private readonly activeRelayCommandIds = new Set<string>()

  constructor(
    private readonly sessionProvider: DesktopSessionProvider,
    options: MobileBridgeOptions = {},
  ) {
    this.relayUrl = options.relayUrl === undefined ? RELAY_URL : options.relayUrl?.replace(/\/+$/u, '') || null
    this.storePathOverride = options.storePath
    this.accessTokenProvider = options.accessTokenProvider ?? (async () => null)
    this.relayTransport = options.relayTransport ?? new FetchMobileRelayTransport()
    this.commandService = options.commandService ?? new MobileControlCommandService()
    this.snapshotService = options.snapshotService ?? new MobileControlSnapshotService()
    this.workspaceRootsProvider = options.workspaceRootsProvider ?? (async () => [])
    this.commandPollIntervalMs = Math.max(250, options.commandPollIntervalMs ?? DEFAULT_COMMAND_POLL_INTERVAL_MS)
    this.commandPollCeilingMs = Math.max(
      this.commandPollIntervalMs,
      options.commandPollCeilingMs ?? DEFAULT_COMMAND_POLL_CEILING_MS,
    )
    this.commandPollAttentionWindowMs = Math.max(
      0,
      options.commandPollAttentionWindowMs ?? DEFAULT_COMMAND_POLL_ATTENTION_WINDOW_MS,
    )
    this.commandPollIntervalMsCurrent = this.commandPollIntervalMs
  }

  async getState(): Promise<MobileBridgeState> {
    await this.load()
    this.expirePairingChallenge()
    return this.snapshot()
  }

  async updateSettings(update: MobileBridgeSettingsUpdate): Promise<MobileBridgeState> {
    await this.load()

    const enabled = update && typeof update === 'object' ? update.enabled : undefined
    const relayUrl =
      update && typeof update === 'object' && Object.hasOwn(update, 'relayUrl')
        ? normalizeRelayUrlUpdate(update.relayUrl)
        : undefined
    if (relayUrl !== undefined && relayUrl !== this.relayUrl) {
      this.relayUrl = relayUrl
      this.disconnect(this.enabled ? 'unconfigured' : 'disabled')
      this.recordDiagnostic(
        'info',
        relayUrl ? 'relay_connected' : 'relay_not_configured',
        relayUrl ? 'Mobile relay URL updated.' : 'Mobile relay URL cleared.',
        false,
      )
    }

    if (typeof enabled === 'boolean' && enabled !== this.enabled) {
      this.enabled = enabled
      this.recordDiagnostic(
        'info',
        enabled ? 'relay_not_configured' : 'mobile_bridge_disabled',
        enabled ? 'Mobile companion control enabled.' : 'Mobile companion control disabled.',
        enabled && !this.relayUrl,
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
    if (this.enabled && relayUrl !== undefined && this.relayUrl) {
      this.connectWithBackoff(0)
    }
    this.emitStateChanged()
    return this.snapshot()
  }

  async requestPairingCode(): Promise<MobileBridgePairingChallenge> {
    await this.load()
    this.assertEnabled()
    // With no active paired device the bridge stays idle (no relay traffic), so a
    // pairing request has to bring the connection up on demand before a challenge
    // can be minted. Already-connected callers pass straight through.
    await this.ensureRelayConnectedForPairing()
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
    // The pending challenge now gates polling on, so the desktop can receive the new
    // phone's first command. The awaited createPairingChallenge above yields, during
    // which the connect-time poll can have found no device/challenge yet and dropped
    // us to idle; the session is retained, so restore connected and arm the loop.
    if (this.relayStatus === 'idle') {
      this.relayStatus = 'connected'
    }
    this.startCommandPolling()
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
      this.recordDiagnostic(
        'warning',
        'device_revoked',
        `Device ${trimmedDeviceId} was not found for revocation.`,
        false,
      )
      throw new Error('Paired mobile device was not found.')
    }

    await this.revokeDeviceAtRelay(trimmedDeviceId, trimmedReason ?? 'Revoked from Multicode desktop settings.')

    if (!device.revokedAt) {
      const revokedAt = new Date().toISOString()
      device.revokedAt = revokedAt
      revokePushRegistrationsForDevice(this.pushRegistrations, device.deviceId, revokedAt)
      this.recordDiagnostic(
        'info',
        'device_revoked',
        trimmedReason
          ? `Revoked mobile device ${device.displayName}: ${trimmedReason}`
          : `Revoked mobile device ${device.displayName}.`,
        false,
      )
    }

    // Revoking the last active device tears the connection back down to idle: with
    // nobody able to listen, holding a relay session and polling is pure waste.
    if (!this.shouldPollCommands()) {
      this.pauseRelayForNoDevices()
    }

    await this.persist()
    this.emitStateChanged()
    return device
  }

  async registerPushToken(input: MobilePushRegistrationInput): Promise<MobilePushRegistration> {
    await this.load()
    this.assertEnabled()

    const registration = registerMobilePushToken(this.pairedDevices, this.pushRegistrations, input)
    await this.persist()
    return registration
  }

  async revokePushRegistration(registrationId: string): Promise<MobilePushRegistration> {
    await this.load()
    this.assertEnabled()

    const registration = revokeMobilePushRegistration(this.pushRegistrations, registrationId)
    await this.persist()
    return registration
  }

  async listPushRegistrations(): Promise<MobilePushRegistration[]> {
    await this.load()
    return listMobilePushRegistrations(this.pushRegistrations)
  }

  async listActivePushTargets(): Promise<MobilePushRegistrationTarget[]> {
    await this.load()
    return listActiveMobilePushTargets(this.pairedDevices, this.pushRegistrations)
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
    this.closed = true
    this.clearReconnectTimer()
    this.clearCommandPollTimer()
    this.snapshotService.shutdown()
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true

    const persisted = await readMobileBridgeStore(this.storePath)
    this.enabled = persisted.enabled
    this.relayUrl = shouldReplaceStoredRelayUrl(persisted.relayUrl) ? RELAY_URL : (persisted.relayUrl ?? this.relayUrl)
    this.desktopInstanceId = persisted.desktopInstanceId
    this.pairedDevices = persisted.pairedDevices
    this.pushRegistrations = persisted.pushRegistrations

    this.relayStatus = this.enabled ? 'unconfigured' : 'disabled'
    this.presence = this.enabled ? 'available' : 'offline'
    if (this.enabled) {
      this.connectWithBackoff(0)
    }
    await this.persist()
  }

  private async persist(): Promise<void> {
    await writeMobileBridgeStore(this.storePath, {
      enabled: this.enabled,
      relayUrl: this.relayUrl,
      desktopInstanceId: this.desktopInstanceId,
      pairedDevices: this.pairedDevices,
      pushRegistrations: this.pushRegistrations,
    })
  }

  private async connectOnce(): Promise<void> {
    if (this.closed || !this.enabled) return
    if (!this.relayUrl) {
      this.relayStatus = 'unconfigured'
      this.nextReconnectAt = null
      this.recordDiagnostic('warning', 'relay_not_configured', 'Mobile relay URL is not configured.', true)
      this.emitStateChanged()
      return
    }

    const session = await this.sessionProvider()
    if (this.closed) return
    if (!session.authenticated) {
      this.relayStatus = 'error'
      this.recordDiagnostic(
        'warning',
        'unauthenticated',
        'Mobile relay connection requires a signed-in desktop session.',
        true,
      )
      this.connectWithBackoff()
      return
    }

    const accessToken = await this.accessTokenProvider()
    if (this.closed) return
    if (!accessToken) {
      this.relayStatus = 'error'
      this.recordDiagnostic(
        'warning',
        'unauthenticated',
        'Mobile relay connection requires a desktop access token.',
        true,
      )
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
        organizationId: session.selectedOrganization?.id ?? null,
        desktopInstanceId: this.desktopInstanceId,
        displayName: getDesktopDisplayName(),
        commands: RELAY_SUPPORTED_COMMANDS,
      })
      if (this.closed) return

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
    if (this.closed) return

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

    // Demand gate: only hold a relay session while an active device can be listening,
    // or a pairing challenge is pending (so a new phone can complete pairing). With
    // neither, stay idle and issue zero relay traffic. requestPairingCode connects
    // directly via connectOnce, bypassing this gate to mint the first challenge.
    if (!this.shouldPollCommands()) {
      this.pauseRelayForNoDevices()
      this.emitStateChanged()
      return
    }

    const boundedDelay = Math.min(Math.max(delayMs, 0), MAX_RECONNECT_DELAY_MS)
    this.relayStatus = boundedDelay > 0 ? 'retrying' : 'connecting'
    this.nextReconnectAt = new Date(Date.now() + boundedDelay).toISOString()
    this.reconnectTimer = setTimeout(() => {
      void this.connectOnce()
    }, boundedDelay)
    this.reconnectDelayMs = Math.min(
      Math.max(this.reconnectDelayMs * 2, INITIAL_RECONNECT_DELAY_MS),
      MAX_RECONNECT_DELAY_MS,
    )
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
      recentCommands: this.recentCommands,
      commandPollCadence: this.commandPollCadence(),
    }
  }

  private recordCommandEvent(input: {
    commandId: string
    commandType: MobileControlCommandType
    device: MobileRelayAuthenticatedDevice | null
    status: MobileBridgeCommandEvent['status']
  }): void {
    const event: MobileBridgeCommandEvent = {
      id: `${input.commandId}:${Date.now()}`,
      commandId: input.commandId,
      commandType: input.commandType,
      deviceId: input.device?.deviceId ?? null,
      deviceName: input.device?.displayName ?? null,
      receivedAt: new Date().toISOString(),
      status: input.status,
    }
    this.recentCommands = [event, ...this.recentCommands].slice(0, 12)
    this.emitStateChanged()
  }

  private completeCommandEvent(
    commandId: string,
    status: Extract<MobileBridgeCommandEvent['status'], 'completed' | 'failed'>,
    resultCode: string,
  ): void {
    const completedAt = new Date().toISOString()
    this.recentCommands = this.recentCommands.map((event) =>
      event.commandId === commandId ? { ...event, status, resultCode, completedAt } : event,
    )
    this.emitStateChanged()
  }

  private recordDiagnostic(
    level: MobileBridgeDiagnosticEntry['level'],
    code: MobileBridgeDiagnosticEntry['code'],
    message: string,
    retryable: boolean,
  ): void {
    this.diagnostics = recordMobileBridgeDiagnostic(this.diagnostics, level, code, message, retryable)
  }

  private emitStateChanged(): void {
    emitMobileBridgeStateChanged(this.snapshot())
  }

  private get storePath(): string {
    if (this.storePathOverride) return this.storePathOverride
    return getDefaultMobileBridgeStorePath()
  }

  private hasActivePairedDevice(): boolean {
    return this.pairedDevices.some((device) => !device.revokedAt)
  }

  // The relay session is only worth holding while an active device can listen, or a
  // pairing challenge is pending so a new phone can complete pairing and send its
  // first command. Gates both the connection and the command poll loop.
  private shouldPollCommands(): boolean {
    return this.hasActivePairedDevice() || this.pairingChallenge !== null
  }

  // Stop polling and drop to idle when nothing can be listening. The relay session is
  // retained rather than torn down: a held session issues no traffic on its own (no
  // keepalive), and nulling the desktop token here would break the in-flight
  // postCommandResult of a command that self-revoked the last device. A fresh pairing
  // reconnects via connectOnce, replacing any stale session.
  private pauseRelayForNoDevices(): void {
    this.clearReconnectTimer()
    this.clearCommandPollTimer()
    this.relayStatus = 'idle'
    this.nextReconnectAt = null
    this.resetCommandPollCadence()
  }

  private async ensureRelayConnectedForPairing(): Promise<void> {
    if (this.relayStatus === 'connected' && this.relayToken && this.desktopRelaySessionId) return
    await this.connectOnce()
  }

  private resetCommandPollCadence(): void {
    this.commandPollIntervalMsCurrent = this.commandPollIntervalMs
    this.commandPollAttentionUntil = 0
  }

  // A delivered command means a human is looking: hold the fast base cadence for the
  // attention window before backoff resumes.
  private markCommandActivity(): void {
    this.commandPollIntervalMsCurrent = this.commandPollIntervalMs
    this.commandPollAttentionUntil = Date.now() + this.commandPollAttentionWindowMs
  }

  private nextCommandPollIntervalMs(): number {
    if (Date.now() < this.commandPollAttentionUntil) return this.commandPollIntervalMs
    return Math.min(
      Math.max(this.commandPollIntervalMsCurrent * 2, this.commandPollIntervalMs),
      this.commandPollCeilingMs,
    )
  }

  private commandPollCadence(): MobileBridgeCommandPollCadence {
    if (!this.enabled || this.relayStatus !== 'connected' || !this.shouldPollCommands()) {
      return { intervalMs: 0, state: 'paused' }
    }
    const intervalMs = this.commandPollIntervalMsCurrent
    return { intervalMs, state: intervalMs > this.commandPollIntervalMs ? 'decayed' : 'fast' }
  }

  private startCommandPolling(): void {
    this.clearCommandPollTimer()
    if (this.closed) return
    // Fresh connection (or newly-armed pairing loop): start fast with an attention
    // window so the first command is delivered promptly, then decay if it stays quiet.
    this.commandPollIntervalMsCurrent = this.commandPollIntervalMs
    this.commandPollAttentionUntil = Date.now() + this.commandPollAttentionWindowMs
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
    if (this.closed) return
    if (!this.enabled || this.relayStatus !== 'connected' || !this.shouldPollCommands()) {
      // Nothing left to poll for. If we were connected — last active device revoked, or
      // a pairing challenge expired unpaired — drop to idle. This runs in pollRelayCommands'
      // finally, after any in-flight postCommandResult, so the session is safe to retire.
      if (this.enabled && this.relayStatus === 'connected') {
        this.pauseRelayForNoDevices()
        this.emitStateChanged()
      } else {
        this.resetCommandPollCadence()
      }
      return
    }
    const intervalMs = this.nextCommandPollIntervalMs()
    this.commandPollIntervalMsCurrent = intervalMs
    this.commandPollTimer = setTimeout(() => {
      void this.pollRelayCommands()
    }, intervalMs)
  }

  private async pollRelayCommands(): Promise<void> {
    try {
      if (
        !this.enabled ||
        this.relayStatus !== 'connected' ||
        !this.relayUrl ||
        !this.relayToken ||
        !this.desktopRelaySessionId ||
        !this.shouldPollCommands()
      ) {
        return
      }

      const deliveries = await this.relayTransport.listPendingCommands({
        relayUrl: this.relayUrl,
        relayToken: this.relayToken,
        desktopRelaySessionId: this.desktopRelaySessionId,
      })

      if (deliveries.length > 0) this.markCommandActivity()

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
    const commandType = relayCommandTypeToMobile(envelope.commandType)
    this.recordCommandEvent({
      commandId: envelope.commandId,
      commandType,
      device,
      status: 'received',
    })

    try {
      const result = await this.dispatchRelayCommand(envelope, device)
      this.completeCommandEvent(
        envelope.commandId,
        result.ok ? 'completed' : 'failed',
        result.ok ? 'ok' : result.error.code,
      )
      await this.postCommandResult(envelope.commandId, result)
    } catch (error) {
      this.completeCommandEvent(envelope.commandId, 'failed', 'internal_error')
      await this.postCommandResult(
        envelope.commandId,
        failedCommandResult(envelope, 'internal_error', getErrorMessage(error)),
      )
    } finally {
      this.activeRelayCommandIds.delete(envelope.commandId)
    }
  }

  private async dispatchRelayCommand(
    envelope: RelayCommandEnvelope,
    device: MobileRelayAuthenticatedDevice | null,
  ): Promise<MobileControlCommandResult> {
    const commandType = relayCommandTypeToMobile(envelope.commandType)
    const authorizationError = authorizeRelayCommand({
      desktopRelaySessionId: this.desktopRelaySessionId,
      pairedDevices: this.pairedDevices,
      envelope,
      commandType,
      device,
    })
    if (authorizationError) {
      return failedCommandResult(envelope, authorizationError.code, authorizationError.message)
    }

    const { pairedDevice: activeDevice, inserted } = upsertRelayDevice(
      this.pairedDevices,
      device as MobileRelayAuthenticatedDevice,
      mobileControlProtocolVersion,
    )
    if (inserted) void this.persist().then(() => this.emitStateChanged())
    const command = relayEnvelopeToMobileCommand({
      envelope,
      commandType,
      deviceId: activeDevice.deviceId,
      protocolVersion: mobileControlProtocolVersion,
    })

    switch (commandType) {
      case 'snapshot.request':
        return dispatchSnapshotRequest({
          command,
          snapshotService: this.snapshotService,
          desktopSessionId: this.desktopRelaySessionId ?? this.desktopInstanceId,
          workspaceRootsProvider: this.workspaceRootsProvider,
        })
      case 'device.revoke':
        return dispatchDeviceRevoke({
          command,
          revokeDevice: (deviceId, reason) => this.revokeDevice(deviceId, reason),
        })
      // Everything else: the backlog and automations mutations, which the
      // command service executes against a resolved workspace root.
      case 'backlog.update':
      case 'backlog.create':
      case 'automations.control':
        return this.dispatchWorkspaceMutation(command)
    }
  }

  // Backlog and automations commands target workspace roots directly. The phone
  // sends a workspace token, never a path; the handler resolves it against these
  // roots and fails closed when it matches none.
  private async dispatchWorkspaceMutation(command: MobileControlCommand): Promise<MobileControlCommandResult> {
    return this.commandService.dispatch(command, {
      allowedWorkspaceRoots: await this.workspaceRootsProvider(),
    })
  }

  private async revokeDeviceAtRelay(deviceId: string, reason: string): Promise<void> {
    if (!this.relayUrl) {
      this.recordDiagnostic(
        'warning',
        'relay_not_configured',
        'Mobile relay URL is not configured; device was not revoked.',
        true,
      )
      throw new Error('Mobile relay URL is not configured.')
    }

    const accessToken = await this.accessTokenProvider()
    if (!accessToken) {
      this.recordDiagnostic(
        'warning',
        'unauthenticated',
        'Mobile relay revocation requires a desktop access token.',
        true,
      )
      throw new Error('Mobile relay revocation requires a desktop access token.')
    }
    const session = await this.sessionProvider()

    try {
      await this.relayTransport.revokeDevice({
        relayUrl: this.relayUrl,
        accessToken,
        organizationId: session.authenticated ? (session.selectedOrganization?.id ?? null) : null,
        deviceId,
        reason,
      })
    } catch (error) {
      this.recordDiagnostic(
        'error',
        'relay_unavailable',
        `Relay device revocation failed: ${getErrorMessage(error)}`,
        true,
      )
      throw error
    }
  }

  private async postCommandResult(commandId: string, result: MobileControlCommandResult): Promise<void> {
    if (!this.relayUrl || !this.relayToken) return
    const resultForRelay = this.ensureRelaySizedCommandResult(result)
    const summary = summarizeCommandResult(resultForRelay)
    await this.relayTransport.postCommandResult({
      relayUrl: this.relayUrl,
      relayToken: this.relayToken,
      commandId,
      status: resultForRelay.ok ? 'completed' : 'failed',
      resultCode: resultForRelay.ok ? 'OK' : resultForRelay.error.code.toUpperCase(),
      summary,
    })
  }

  private ensureRelaySizedCommandResult(result: MobileControlCommandResult): MobileControlCommandResult {
    if (!result.ok || result.commandType !== 'snapshot.request') {
      return result
    }

    if (relaySummaryByteLength(result.data) > relayResultSummaryMaxBytes) {
      return failedSnapshotSizeResult(result)
    }

    const summary = summarizeCommandResult(result)
    if (relaySummaryByteLength(summary) <= relayResultSummaryMaxBytes) {
      return result
    }

    return failedSnapshotSizeResult(result)
  }

  private async publishSnapshotToRelay(): Promise<void> {
    if (!this.relayTransport.publishSnapshot || !this.relayUrl || !this.relayToken || !this.desktopRelaySessionId)
      return
    try {
      const snapshot = await this.snapshotService.publishSnapshot({
        desktopSessionId: this.desktopRelaySessionId,
        workspaceRoots: await this.workspaceRootsProvider(),
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
      this.recordDiagnostic(
        'warning',
        'relay_unavailable',
        `Snapshot publication failed: ${getErrorMessage(error)}`,
        true,
      )
    }
  }
}

function failedSnapshotSizeResult(
  result: Extract<MobileControlCommandResult, { ok: true }>,
): MobileControlCommandResult {
  return failedCommandResult(
    {
      commandId: result.commandId,
      type: result.commandType,
      ...(result.idempotencyKey ? { idempotencyKey: result.idempotencyKey } : {}),
    },
    'snapshot_too_large',
    'Mobile control snapshot result exceeded the relay result summary size limit.',
  )
}

function normalizeRelayCommandDelivery(delivery: RelayCommandDelivery): {
  envelope: RelayCommandEnvelope
  device: MobileRelayAuthenticatedDevice | null
} {
  return { envelope: delivery.envelope, device: delivery.device }
}
