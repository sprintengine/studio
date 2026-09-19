// Part of the IPC contract: the mobile companion bridge.
// ../electron-api.ts re-exports everything here.

import type { MobileControlProtocolVersion } from '../../../packages/mobile-control-protocol/src/index'
import type { MobileControlCapability, MobileControlCommandType } from './account'

export type MobileControlDevice = {
  /** Inside the supported window, not necessarily current: a device paired before a bump keeps its stamp. */
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

export type MobileControlCapabilities = {
  // The wire version this desktop stamps, from the protocol package. A literal
  // `2` sat here until protocol v3 — a hand-maintained second copy of a number
  // that only ever has one right value, in a file nothing would fail to compile
  // if it went stale.
  protocolVersion: MobileControlProtocolVersion
  deviceId: string
  commands: MobileControlCommandType[]
  capabilities: MobileControlCapability[]
  snapshotTtlMs: number
}

export type MobileBridgeRelayStatus =
  | 'disabled'
  | 'unconfigured'
  // Enabled and configured, but deliberately not connected because no active paired
  // device (and no pending pairing challenge) can be listening; zero relay traffic.
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'retrying'
  | 'error'

// Current effective command-poll cadence, surfaced so Settings → Mobile can explain
// first-command latency. `paused` = not polling; `fast` = base interval; `decayed` =
// backed off toward the idle ceiling.
export type MobileBridgeCommandPollCadence = {
  intervalMs: number
  state: 'paused' | 'fast' | 'decayed'
}

export type MobileBridgePresence = 'available' | 'busy' | 'idle' | 'offline'

export type MobileBridgeDiagnosticEntry = {
  id: string
  timestamp: string
  level: 'info' | 'warning' | 'error'
  code: string
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

export type WorkspaceBackupPayload = {
  version: number
  writtenAt: string
  data: unknown
}

export type WorkspaceBackupReadResult =
  | { ok: true; payload: WorkspaceBackupPayload }
  | { ok: false; reason: 'missing' | 'unreadable' | 'parse_error'; message?: string }
