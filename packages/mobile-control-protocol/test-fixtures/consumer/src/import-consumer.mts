// The desktop's shape, and the phone's Metro bundle: real ESM, resolving the
// package's "import" condition. See require-consumer.ts for why the two entry
// points assert the same things rather than sharing a helper.

import {
  isSupportedMobileControlProtocolVersion,
  mobileControlMinSupportedProtocolVersion,
  mobileControlProtocolVersion,
  unsupportedMobileControlProtocolVersion,
  validateMobileControlCommand,
  type MobileControlCommand,
} from '@sprintengine/mobile-control-protocol'

type IsAny<T> = 0 extends 1 & T ? true : false
const _commandIsNotAny: IsAny<MobileControlCommand> extends true ? never : true = true
void _commandIsNotAny

export function assertProtocolContract(): void {
  const command: MobileControlCommand = {
    protocolVersion: mobileControlProtocolVersion,
    commandId: 'cmd_1',
    type: 'artifact.approve',
    issuedAt: '2026-04-28T19:00:00.000Z',
    deviceId: 'device_1',
    idempotencyKey: 'mobile:device_1:cmd_1',
    payload: { sprintEngineId: 'engine_1', artifactId: 'A1' },
  }
  const accepted = validateMobileControlCommand(command)
  if (accepted.ok !== true) throw new Error(`a current-version command was refused: ${accepted.error.message}`)

  const oldEnough = validateMobileControlCommand({
    ...command,
    protocolVersion: mobileControlMinSupportedProtocolVersion,
  })
  if (oldEnough.ok !== true) throw new Error('a command at the oldest supported version was refused')

  const refused = validateMobileControlCommand({ ...command, protocolVersion: 99 })
  if (refused.ok !== false) throw new Error('a command outside the window was accepted')
  if (refused.error.code !== 'unsupported_protocol_version') {
    throw new Error(`expected unsupported_protocol_version, got ${refused.error.code}`)
  }

  if (isSupportedMobileControlProtocolVersion(99)) throw new Error('99 reported as a supported version')
  if (!unsupportedMobileControlProtocolVersion(99).includes('99')) {
    throw new Error('the refusal message does not name the version it saw')
  }
}

assertProtocolContract()
console.log('import consumer: ok')
