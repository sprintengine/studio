import type {
  MobileBridgePresence,
  MobileControlCapability,
  MobileControlDevice,
  MobilePushProvider,
  MobilePushRegistration,
} from './index'
import { isSupportedMobileControlProtocolVersion } from '../../../shared/mobile-control/protocol'

const MOBILE_CONTROL_CAPABILITIES = [
  'snapshots.read',
  'artifacts.read',
  'sprintengines.create',
  'tasks.start',
  'artifacts.review',
  'agents.followUp',
  'devices.revoke',
  'backlog.update',
  'backlog.start',
  'backlog.create',
  'sprintengines.pr',
  'sprintengines.automation',
  'automations.control',
] as const satisfies readonly MobileControlCapability[]

// A missing member here is silent and destructive, so it is a compile error — the
// same guard protocol.ts carries, for the same reason (MC-1499). `isMobileControlDevice`
// requires EVERY capability on a device to appear in this list, and readMobileBridgeStore
// DROPS a device that fails it: a capability granted at pairing but absent here would
// unpair the owner's phone on the next desktop restart, with nothing in the log to say why.
type _AssertCapabilityListComplete = [
  Exclude<MobileControlCapability, (typeof MOBILE_CONTROL_CAPABILITIES)[number]>,
] extends [never]
  ? true
  : ['MOBILE_CONTROL_CAPABILITIES is missing', Exclude<MobileControlCapability, (typeof MOBILE_CONTROL_CAPABILITIES)[number]>]
const _capabilityListComplete: _AssertCapabilityListComplete = true
void _capabilityListComplete

// These two read records off this machine's own disk, not off the wire, so the
// window matters here for the reason the capability list above does: a stored
// device that fails this check is DROPPED by readMobileBridgeStore, and a check
// pinned to the current version alone would unpair every phone paired before
// the last bump, on the first restart after it, with nothing in the log to say
// why. The window is the same one the wire uses; a version outside it is a
// record this build genuinely cannot read.
export function isMobileControlDevice(input: unknown): input is MobileControlDevice {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const device = input as Partial<MobileControlDevice>
  return isSupportedMobileControlProtocolVersion(device.protocolVersion)
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

export function isMobileControlCapability(input: unknown): input is MobileControlCapability {
  return MOBILE_CONTROL_CAPABILITIES.includes(input as MobileControlCapability)
}

export function isMobilePushRegistration(input: unknown): input is MobilePushRegistration {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const registration = input as Partial<MobilePushRegistration>
  return isSupportedMobileControlProtocolVersion(registration.protocolVersion)
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

export function isMobilePushProvider(input: unknown): input is MobilePushProvider {
  return input === 'apns' || input === 'fcm' || input === 'expo'
}

export function redactPushRegistration(registration: MobilePushRegistration): MobilePushRegistration {
  return { ...registration }
}

export function isMobileBridgePresence(input: string): input is MobileBridgePresence {
  return input === 'available' || input === 'busy' || input === 'idle' || input === 'offline'
}
