import assert from 'node:assert/strict'

import { validateMobileControlCommand } from './command-validation'
import {
  mobileControlMinSupportedProtocolVersion,
  mobileControlProtocolVersion,
  mobileControlSupportedProtocolVersions,
} from './protocol'
import { test } from 'vitest'

test('command-validation', async () => {
  // The desktop-side gate on a command that arrived from a phone.
  //
  // The phone checks the same window on its side, so the thing worth pinning is
  // that this gate agrees with `mobileControlSupportedProtocolVersions` about
  // which phones exist. A command the phone sends and this desktop refuses is a
  // phone that pairs and then cannot do anything, which is the failure the
  // window was widened to avoid.

  function command(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      protocolVersion: mobileControlProtocolVersion,
      commandId: 'cmd_1',
      type: 'snapshot.request',
      issuedAt: '2026-09-14T10:00:00.000Z',
      deviceId: 'device_1',
      payload: {},
      ...overrides,
    }
  }

  for (const version of mobileControlSupportedProtocolVersions) {
    assert.equal(
      validateMobileControlCommand(command({ protocolVersion: version })).ok,
      true,
      `a command at protocol version ${version} is inside the window`,
    )
  }

  // A phone one release behind is the case the window exists for: its build is
  // waiting on a store review this repository does not control.
  assert.equal(
    validateMobileControlCommand(command({ protocolVersion: mobileControlMinSupportedProtocolVersion })).ok,
    true,
  )

  for (const outside of [
    mobileControlMinSupportedProtocolVersion - 1,
    mobileControlProtocolVersion + 1,
    undefined,
    // The right number spelled as a string is still not a version.
    String(mobileControlProtocolVersion),
    null,
  ]) {
    const refused = validateMobileControlCommand(command({ protocolVersion: outside }))
    assert.equal(refused.ok, false, `protocol version ${String(outside)} must be refused`)
    // The refusal path is unchanged: the same code a client branches on.
    assert.equal(refused.ok === false && refused.error.code, 'unsupported_protocol_version')
  }

  {
    const refused = validateMobileControlCommand(command({ protocolVersion: 7 }))
    const message = refused.ok === false ? refused.error.message : ''
    // Both numbers, or the phone's owner cannot tell which side is behind.
    assert.match(message, /\b7\b/u)
    assert.match(
      message,
      new RegExp(`${mobileControlMinSupportedProtocolVersion}.${mobileControlProtocolVersion}`, 'u'),
    )
  }

  // The version is checked before anything else, so a command that is wrong in
  // two ways still reports the one its sender can act on.
  {
    const refused = validateMobileControlCommand({ protocolVersion: 999, type: 'terminal.write' })
    assert.equal(refused.ok === false && refused.error.code, 'unsupported_protocol_version')
  }

  console.log('mobile command validation: ok')
})
