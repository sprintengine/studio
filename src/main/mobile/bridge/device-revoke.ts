import type { MobileControlCommand, MobileSprintEngineCommandResult } from '../sprintengine/command'
import type { MobileControlDevice } from './index'
import { getErrorMessage } from '../../error-message'
import { acceptedBridgeCommand, failedCommandResult } from './command-results'
import { stringPayload } from './command-payload'

export async function dispatchDeviceRevoke(input: {
  command: MobileControlCommand
  revokeDevice: (deviceId: string, reason?: string) => Promise<MobileControlDevice>
}): Promise<MobileSprintEngineCommandResult> {
  const { command, revokeDevice } = input
  const deviceId = stringPayload(command.payload, 'deviceId')
  const payload = command.payload as Record<string, unknown>
  const reason = typeof payload.reason === 'string' ? payload.reason : undefined
  let device: MobileControlDevice
  try {
    device = await revokeDevice(deviceId, reason)
  } catch (error) {
    return failedCommandResult(command, 'relay_unavailable', getErrorMessage(error))
  }
  return acceptedBridgeCommand(command, { revoked: true, deviceId: device.deviceId })
}
