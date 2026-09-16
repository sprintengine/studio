import type { MobileControlCommand } from '../control/command'
import type { MobileControlCommandType, MobileControlDevice, RelayCommandEnvelope, RelayCommandType } from './index'

// The relay's command vocabulary and the protocol's are now the same strings.
// They were not always: `agent.followup` rode the relay in lower camel while the
// protocol spelled it `agent.followUp`, and that one disagreement is the whole
// reason this function exists. Both spellings left with the Sprint Engine
// (protocol v3), so the mapping is the identity — kept as a named seam rather
// than inlined, because the next divergence should have somewhere to land.
export function relayCommandTypeToMobile(type: RelayCommandType): MobileControlCommandType {
  return type
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
