import { randomUUID } from 'crypto'
import type {
  MobileRelayAuthenticatedDevice,
  MobileRelayScope,
  MobileRelayTransport,
  RelayCommandDelivery,
  RelayCommandEnvelope,
  RelayCommandResultStatus,
  RelayCommandType,
  RelayConnectResult,
  RelayPairingChallengeResult,
} from './index'
import {
  isSupportedMobileControlProtocolVersion,
  mobileControlProtocolVersion,
  unsupportedMobileControlProtocolVersion,
  type MobileControlProtocolVersion,
} from '../../../../packages/mobile-control-protocol/src/index'

// Canonical relay command whitelist: parseRelayCommandEnvelope accepts these
// inbound and MobileRelayBridge advertises the same list on connect (imported
// from here — a stale duplicate in index.ts once silently dropped the three
// backlog commands, killing every backlog mutation at delivery). The Record
// keeps this exhaustive: adding a RelayCommandType member without listing it
// here is a compile error.
const RELAY_COMMAND_TYPES: Record<RelayCommandType, true> = {
  'snapshot.request': true,
  'device.revoke': true,
  'backlog.update': true,
  'backlog.create': true,
  'automations.control': true,
}

export const RELAY_SUPPORTED_COMMANDS = Object.keys(RELAY_COMMAND_TYPES) as RelayCommandType[]

export class FetchMobileRelayTransport implements MobileRelayTransport {
  async connectDesktop(input: {
    relayUrl: string
    accessToken: string
    organizationId?: string | null
    desktopInstanceId: string
    displayName: string
    commands: RelayCommandType[]
  }): Promise<RelayConnectResult> {
    const payload = await relayJsonRequest(input.relayUrl, '/api/relay/desktop/connect', {
      token: input.accessToken,
      organizationId: input.organizationId,
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
      heartbeatAfterSeconds:
        typeof payload.heartbeatAfterSeconds === 'number' ? payload.heartbeatAfterSeconds : undefined,
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
    organizationId?: string | null
    deviceId: string
    reason: string
  }): Promise<{ revoked: true }> {
    const payload = await relayJsonRequest(
      input.relayUrl,
      `/api/relay/devices/${encodeURIComponent(input.deviceId)}/revoke`,
      {
        token: input.accessToken,
        organizationId: input.organizationId,
        method: 'POST',
        body: {
          reason: input.reason,
        },
      },
    )

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
    // The selected organisation, for a Clerk-authenticated desktop whose
    // token names none. Multiauth tokens carry their own; the
    // relay ignores the header for those.
    organizationId?: string | null
    method: 'POST'
    body: Record<string, unknown>
  },
): Promise<Record<string, unknown>> {
  const response = await fetch(`${relayUrl}${path}`, {
    method: input.method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${input.token}`,
      'content-type': 'application/json',
      'x-request-id': randomUUID(),
      ...(input.organizationId ? { 'x-multiauth-organization': input.organizationId } : {}),
    },
    body: JSON.stringify(input.body),
  })
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>

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
  field: string,
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
  // The same window the command validator applies, so the relay and the
  // commands that arrive over it can never disagree about which phones exist.
  if (!isSupportedMobileControlProtocolVersion(pairingPayload.mobileControlProtocolVersion)) {
    throw new Error(
      `Relay response field ${field}.mobileControlProtocolVersion: ${unsupportedMobileControlProtocolVersion(pairingPayload.mobileControlProtocolVersion)}.`,
    )
  }
  // Carried through rather than replaced with our own: this is the version the
  // pairing was agreed at, and echoing 2 at a phone that said 1 would be this
  // desktop inventing the one fact the field exists to report.
  const negotiated = pairingPayload.mobileControlProtocolVersion as MobileControlProtocolVersion

  return {
    mobileControlProtocolVersion: negotiated,
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

function readRelayErrorMessage(payload: Record<string, unknown>, status: number): string {
  const error = payload.error
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return `Mobile relay request failed with HTTP ${status}.`
}
