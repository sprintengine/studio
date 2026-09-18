import type {
  MobileControlCapability,
  MobileControlDevice,
  MobileRelayAuthenticatedDevice,
  MobileRelayScope,
} from './index'
import { isMobileControlCapability } from './validation'

const CAPABILITY_BY_RELAY_SCOPE: Record<MobileRelayScope, MobileControlCapability | null> = {
  'relay:presence:read': null,
  'relay:snapshot:read': 'snapshots.read',
  'relay:push:register': null,
  'relay:device:revoke': 'devices.revoke',
  'relay:backlog:update': 'backlog.update',
  'relay:backlog:create': 'backlog.create',
  'relay:automations:control': 'automations.control',
}

export function relayDeviceCapabilities(device: MobileRelayAuthenticatedDevice): MobileControlCapability[] {
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

function normalizeDevicePlatform(
  platform: MobileRelayAuthenticatedDevice['platform'],
): MobileControlDevice['platform'] {
  if (platform === 'ios' || platform === 'android' || platform === 'web') return platform
  return 'web'
}

export function upsertRelayDevice(
  pairedDevices: MobileControlDevice[],
  device: MobileRelayAuthenticatedDevice,
  protocolVersion: MobileControlDevice['protocolVersion'],
): { pairedDevice: MobileControlDevice; inserted: boolean } {
  const now = new Date().toISOString()
  const capabilities = relayDeviceCapabilities(device)
  const existing = pairedDevices.find((candidate) => candidate.deviceId === device.deviceId)
  if (existing) {
    existing.displayName = device.displayName?.trim() || existing.displayName
    existing.lastSeenAt = device.lastSeenAt ?? now
    existing.revokedAt = device.revokedAt
    existing.capabilities = capabilities
    return { pairedDevice: existing, inserted: false }
  }

  const pairedDevice: MobileControlDevice = {
    protocolVersion,
    deviceId: device.deviceId,
    displayName: device.displayName?.trim() || 'Mobile device',
    platform: normalizeDevicePlatform(device.platform),
    appVersion: device.appVersion?.trim() || 'unknown',
    pairedAt: device.pairedAt ?? now,
    lastSeenAt: device.lastSeenAt ?? now,
    ...(device.revokedAt ? { revokedAt: device.revokedAt } : {}),
    capabilities,
  }
  pairedDevices.push(pairedDevice)
  return { pairedDevice, inserted: true }
}
