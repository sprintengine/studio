import type {
  MobileControlCapability,
  MobileControlCommandType,
  MobileControlDevice,
  MobileControlErrorCode,
  MobileRelayAuthenticatedDevice,
  RelayCommandEnvelope,
} from './index'
import { relayDeviceCapabilities } from './relay-device'

const SIDE_EFFECTING_COMMANDS = new Set<MobileControlCommandType>([
  'device.revoke',
  'backlog.update',
  'backlog.create',
  'automations.control',
])

const CAPABILITY_BY_COMMAND: Record<MobileControlCommandType, MobileControlCapability> = {
  'snapshot.request': 'snapshots.read',
  'device.revoke': 'devices.revoke',
  'backlog.update': 'backlog.update',
  'backlog.create': 'backlog.create',
  'automations.control': 'automations.control',
}

export type MobileBridgeRelayAuthorizationError = {
  code: MobileControlErrorCode
  message: string
}

export function authorizeRelayCommand(input: {
  desktopRelaySessionId: string | null
  pairedDevices: MobileControlDevice[]
  envelope: RelayCommandEnvelope
  commandType: MobileControlCommandType
  device: MobileRelayAuthenticatedDevice | null
}): MobileBridgeRelayAuthorizationError | null {
  const { desktopRelaySessionId, pairedDevices, envelope, commandType, device } = input

  if (!desktopRelaySessionId || envelope.desktopRelaySessionId !== desktopRelaySessionId) {
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

  if (!device.desktopRelaySessionId || device.desktopRelaySessionId !== desktopRelaySessionId) {
    return { code: 'unauthorized', message: 'Relay command device context targets a different desktop session.' }
  }

  const localDevice = pairedDevices.find((candidate) => candidate.deviceId === device.deviceId)
  if (localDevice?.revokedAt) {
    return { code: 'device_revoked', message: 'Mobile device is revoked on this desktop.' }
  }

  // A command type this table does not map is one this protocol version does not
  // have — the nine sprint commands, until v3 took them off the wire. Answer it
  // as unsupported rather than falling through to an `includes(undefined)` that
  // happens to be false: both refuse, but only one of them says why.
  const requiredCapability = CAPABILITY_BY_COMMAND[commandType] as MobileControlCapability | undefined
  if (!requiredCapability) {
    return {
      code: 'command_not_supported',
      message: `Mobile command ${commandType} is not part of this protocol version.`,
    }
  }

  const capabilities = relayDeviceCapabilities(device)
  if (!capabilities.includes(requiredCapability)) {
    return { code: 'unauthorized', message: `Mobile device is missing ${requiredCapability}.` }
  }

  if (SIDE_EFFECTING_COMMANDS.has(commandType) && !localDevice && !device.pairedAt) {
    return { code: 'unauthorized', message: 'Side-effecting relay command requires a known paired mobile device.' }
  }

  return null
}
