// The phone's shape: a .ts file in a package with no "type" field, so node16
// emit makes this CommonJS and the imports below become a require() against the
// package's "require" condition.
//
// Its ESM twin, import-consumer.mts, asserts the same things on purpose. The
// two entry points exist to resolve two different conditions of the exports
// map, and factoring the assertions into a shared helper would leave only one
// of those conditions actually exercised.

import {
  isSupportedMobileControlProtocolVersion,
  mobileControlMinSupportedProtocolVersion,
  mobileControlProtocolVersion,
  unsupportedMobileControlProtocolVersion,
  validateMobileControlCommand,
  type MobileControlCommand,
} from '@sprintengine/mobile-control-protocol'

// If the declarations ever widened to `any` across the package boundary, every
// runtime assertion below would still pass and every call site would silently
// stop being checked. This turns that into a compile error.
type IsAny<T> = 0 extends 1 & T ? true : false
const _commandIsNotAny: IsAny<MobileControlCommand> extends true ? never : true = true
void _commandIsNotAny

export function assertProtocolContract(): void {
  const command: MobileControlCommand = {
    protocolVersion: mobileControlProtocolVersion,
    commandId: 'cmd_1',
    type: 'backlog.update',
    issuedAt: '2026-04-28T19:00:00.000Z',
    deviceId: 'device_1',
    idempotencyKey: 'mobile:device_1:cmd_1',
    payload: { workspacePath: 'ws_1', relativePath: 'backlog/2026-04-28-example.md' },
  }
  const accepted = validateMobileControlCommand(command)
  if (accepted.ok !== true) throw new Error(`a current-version command was refused: ${accepted.error.message}`)

  // The window, not just the current version: a phone one release behind has to
  // still be readable, which is the whole reason the window exists.
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
console.log('require() consumer: ok')
