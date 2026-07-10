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
  'sprintengine.create',
  'task.start',
  'artifact.approve',
  'artifact.requestChanges',
  'agent.followUp',
  'device.revoke',
  'backlog.update',
  'backlog.startSprintEngine',
  'backlog.create',
  'sprintengine.openPullRequest',
  'sprintengine.setAutomationMode',
])

const CAPABILITY_BY_COMMAND: Record<MobileControlCommandType, MobileControlCapability> = {
  'snapshot.request': 'snapshots.read',
  'artifact.read': 'artifacts.read',
  'sprintengine.create': 'sprintengines.create',
  'task.start': 'tasks.start',
  'artifact.approve': 'artifacts.review',
  'artifact.requestChanges': 'artifacts.review',
  'agent.followUp': 'agents.followUp',
  'device.revoke': 'devices.revoke',
  'backlog.update': 'backlog.update',
  'backlog.startSprintEngine': 'backlog.start',
  'backlog.create': 'backlog.create',
  'sprintengine.openPullRequest': 'sprintengines.pr',
  'sprintengine.setAutomationMode': 'sprintengines.automation',
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
