import type {
  MobileBridgePresence,
  MobileControlCapability,
  MobileControlDevice,
  MobilePushProvider,
  MobilePushRegistration,
} from './index'

const MOBILE_CONTROL_CAPABILITIES: MobileControlCapability[] = [
  'snapshots.read',
  'artifacts.read',
  'swarms.create',
  'tasks.start',
  'artifacts.review',
  'agents.followUp',
  'devices.revoke',
]

export function isMobileControlDevice(input: unknown): input is MobileControlDevice {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const device = input as Partial<MobileControlDevice>
  return device.protocolVersion === 1
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
  return registration.protocolVersion === 1
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
