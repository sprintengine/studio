import type {
  MobileControlCapability,
  MobileControlDevice,
  MobileRelayAuthenticatedDevice,
  MobileRelayScope,
} from './mobile-bridge'
import { isMobileControlCapability } from './mobile-bridge-validation'

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

export function normalizeDevicePlatform(platform: MobileRelayAuthenticatedDevice['platform']): MobileControlDevice['platform'] {
  if (platform === 'ios' || platform === 'android' || platform === 'web') return platform
  return 'web'
}
