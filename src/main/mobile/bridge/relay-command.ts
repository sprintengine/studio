import type { MobileControlCommand } from '../control/command'
import type { MobileControlCommandType, MobileControlDevice, RelayCommandEnvelope, RelayCommandType } from './index'

export function relayCommandTypeToMobile(type: RelayCommandType): MobileControlCommandType {
  return type === 'agent.followup' ? 'agent.followUp' : type
}

export function relayEnvelopeToMobileCommand(input: {
  envelope: RelayCommandEnvelope
  commandType: MobileControlCommandType
  deviceId: MobileControlDevice['deviceId']
  protocolVersion: MobileControlCommand['protocolVersion']
}): MobileControlCommand {
  const { envelope, commandType, deviceId, protocolVersion } = input
  return {
    protocolVersion,
    commandId: envelope.commandId,
    type: commandType,
    issuedAt: envelope.issuedAt,
    deviceId,
    idempotencyKey: `relay:${envelope.commandId}`,
    ...(envelope.expectedSnapshotVersion ? { expectedSnapshotVersion: envelope.expectedSnapshotVersion } : {}),
    payload: envelope.payload,
  } as MobileControlCommand
}
