import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type {
  MobileControlCapability,
  MobileRelayAuthenticatedDevice,
  MobileRelayScope,
  RelayCommandEnvelope,
} from './index'
import { isMobileControlCapability, isMobileControlDevice } from './validation'
import {
  mobileControlMinSupportedProtocolVersion,
  mobileControlProtocolVersion,
  mobileControlSupportedProtocolVersions,
} from '../../../../packages/mobile-control-protocol/src/index'
import { readMobileBridgeStore } from './store'
import { manualPairingValueFromRelayChallenge } from './pairing'
import { relayDeviceCapabilities } from './relay-device'
import { authorizeRelayCommand } from './relay-auth'
import { test } from 'vitest'

test('validation', async () => {
  // Every capability the bridge REQUESTS at pairing (bridge/index.ts REQUESTED_SCOPES).
  // The list is restated here on purpose: a test that imported the runtime list would
  // pass by construction and prove nothing. This is the assertion side of MC-1499.
  const GRANTED_AT_PAIRING: MobileControlCapability[] = [
    'snapshots.read',
    'devices.revoke',
    'backlog.update',
    'backlog.create',
    'automations.control',
  ]

  // The eight capabilities that left with the Sprint Engine (protocol v3). Spelled
  // out as plain strings because they are no longer members of the type — which is
  // the fact this list exists to pin. `isMobileControlCapability` must reject every
  // one: a device still advertising one is speaking a wire this build does not.
  const RETIRED_WITH_THE_SPRINT_ENGINE = [
    'artifacts.read',
    'sprintengines.create',
    'tasks.start',
    'artifacts.review',
    'agents.followUp',
    'backlog.start',
    'sprintengines.pr',
    'sprintengines.automation',
  ]

  const suiteRun = main()

  async function main(): Promise<void> {
    assertEveryGrantedCapabilityValidates()
    assertDeviceGrantedAutomationsControlIsValid()
    await assertStoreKeepsDeviceGrantedAutomationsControl()
    assertAutomationsControlNeedsItsOwnScope()
    assertRetiredSprintCapabilitiesAreRefused()
    assertStoredDeviceSurvivesTheProtocolWindow()
    await assertStoreKeepsDeviceStampedOneVersionBack()
    assertPairingLinkFollowsTheSameWindow()
    console.log('mobile bridge validation: ok')
  }

  // THE SECURITY DECISION THIS COMMAND EXISTS TO MAKE, held on the desktop side.
  // `relay:sprintengine:automation` was the tempting donor scope: every device paired
  // for sprintengine.setAutomationMode already held it, so reusing it would have
  // meant no re-pair. It was declined — that scope was the Sprint Engine RUN
  // automation mode, a different subsystem, and reusing it would silently have
  // granted every already-paired device the power to fire agent runs here.
  //
  // Protocol v3 removed that scope from the wire, so the donor no longer exists to
  // be reached for. This now pins the general shape of the same decision: no scope
  // other than `relay:automations:control` authorizes the command, and a device
  // that presents one of the retired sprint scopes derives no capability at all.
  function assertAutomationsControlNeedsItsOwnScope(): void {
    const authorize = (scopes: MobileRelayScope[]): string | null => {
      const device = relayAuthenticatedDevice(scopes)
      const error = authorizeRelayCommand({
        desktopRelaySessionId: 'drs_1',
        pairedDevices: [],
        envelope: relayEnvelope(),
        commandType: 'automations.control',
        device,
      })
      return error?.code ?? null
    }

    assert.equal(authorize(['relay:automations:control']), null, 'the granted scope must authorize automations.control')
    assert.equal(
      authorize(['relay:backlog:update']),
      'unauthorized',
      'no other granted scope may authorize automations.control',
    )
    assert.equal(
      authorize(['relay:sprintengine:automation' as MobileRelayScope]),
      'unauthorized',
      'the retired Sprint Engine run-mode scope is not merely unmapped, it grants nothing',
    )
    assert.deepEqual(
      relayDeviceCapabilities(relayAuthenticatedDevice(['relay:sprintengine:automation' as MobileRelayScope])),
      [],
      'a retired scope derives no capability',
    )
    assert.deepEqual(relayDeviceCapabilities(relayAuthenticatedDevice(['relay:automations:control'])), [
      'automations.control',
    ])
  }

  // The inverse of what this file asserted at v2, and the point of the change: a
  // capability that WAS granted at pairing must now be refused. A device still
  // advertising one is a device built against a wire this desktop no longer speaks.
  function assertRetiredSprintCapabilitiesAreRefused(): void {
    for (const capability of RETIRED_WITH_THE_SPRINT_ENGINE) {
      assert.equal(
        isMobileControlCapability(capability),
        false,
        `${capability} left the wire with the Sprint Engine and must no longer validate`,
      )
      assert.equal(
        isMobileControlDevice(pairedDevice([capability as MobileControlCapability])),
        false,
        `a device advertising ${capability} must not read back as valid`,
      )
    }
  }

  function relayAuthenticatedDevice(scopes: MobileRelayScope[]): MobileRelayAuthenticatedDevice {
    return {
      deviceId: 'mobile-1',
      displayName: "Owner's iPhone",
      platform: 'ios',
      appVersion: '0.1.0',
      pairedAt: '2026-07-14T12:00:00.000Z',
      status: 'active',
      desktopRelaySessionId: 'drs_1',
      capabilities: [],
      scopes,
    } as MobileRelayAuthenticatedDevice
  }

  function relayEnvelope(): RelayCommandEnvelope {
    return {
      desktopRelaySessionId: 'drs_1',
      commandId: 'cmd-1',
      commandType: 'automations.control',
      issuedAt: '2026-07-14T12:00:00.000Z',
      expiresAt: '2026-07-14T12:00:30.000Z',
      payload: { workspacePath: 'ws_2f6c1d', automationId: 'auto-1', action: 'pause' },
    }
  }

  // A capability pairing grants but validation rejects is the MC-1499 defect: the
  // device payload was refused for carrying a scope the desktop itself asked for.
  function assertEveryGrantedCapabilityValidates(): void {
    for (const capability of GRANTED_AT_PAIRING) {
      assert.equal(
        isMobileControlCapability(capability),
        true,
        `${capability} is requested at pairing but rejected by isMobileControlCapability`,
      )
    }
    assert.equal(isMobileControlCapability('automations.destroy'), false)
    assert.equal(isMobileControlCapability(undefined), false)
  }

  function assertDeviceGrantedAutomationsControlIsValid(): void {
    assert.equal(isMobileControlDevice(pairedDevice(GRANTED_AT_PAIRING)), true)
    // isMobileControlDevice demands EVERY capability be known, so one unknown entry
    // invalidates the whole device — which is exactly why the list must never lag.
    assert.equal(isMobileControlDevice(pairedDevice(['automations.destroy'])), false)
  }

  // THE REGRESSION. readMobileBridgeStore drops any device that fails validation, so a
  // capability missing from MOBILE_CONTROL_CAPABILITIES does not merely go unread: the
  // re-pair that granted it is silently undone on the next desktop restart, and the
  // owner's phone disappears from the paired list with nothing in the log to say why.
  async function assertStoreKeepsDeviceGrantedAutomationsControl(): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'multicode-mobile-bridge-validation-'))
    const storePath = join(dir, 'mobile-bridge.json')
    await writeFile(
      storePath,
      JSON.stringify({
        enabled: true,
        relayUrl: null,
        desktopInstanceId: 'mdi_test',
        pairedDevices: [pairedDevice(GRANTED_AT_PAIRING)],
        pushRegistrations: [],
      }),
      'utf8',
    )

    const state = await readMobileBridgeStore(storePath)

    assert.equal(
      state.pairedDevices.length,
      1,
      'a device re-paired with automations.control was dropped from the store',
    )
    assert.deepEqual(state.pairedDevices[0].capabilities, GRANTED_AT_PAIRING)
  }

  // THE SAME REGRESSION, one axis over. These validators read records off THIS
  // machine's disk, and every one of them was pinned to the current version — so
  // the first restart after a protocol bump would have dropped every device
  // paired before it, exactly as an unlisted capability did. The window is what
  // makes a stored record from the previous release still a record.
  function assertStoredDeviceSurvivesTheProtocolWindow(): void {
    for (const version of mobileControlSupportedProtocolVersions) {
      assert.equal(
        isMobileControlDevice({ ...pairedDevice(GRANTED_AT_PAIRING), protocolVersion: version }),
        true,
        `a device stamped at protocol version ${version} must still be readable`,
      )
    }
    // Outside the window it genuinely is a record this build cannot read, and
    // refusing it is the right answer rather than a silent misreading.
    assert.equal(
      isMobileControlDevice({
        ...pairedDevice(GRANTED_AT_PAIRING),
        protocolVersion: mobileControlMinSupportedProtocolVersion - 1,
      }),
      false,
    )
    assert.equal(
      isMobileControlDevice({ ...pairedDevice(GRANTED_AT_PAIRING), protocolVersion: mobileControlProtocolVersion + 1 }),
      false,
    )
    assert.equal(isMobileControlDevice({ ...pairedDevice(GRANTED_AT_PAIRING), protocolVersion: undefined }), false)
  }

  // And the whole way through the store, since dropping happens there.
  async function assertStoreKeepsDeviceStampedOneVersionBack(): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'multicode-mobile-bridge-window-'))
    const storePath = join(dir, 'mobile-bridge.json')
    await writeFile(
      storePath,
      JSON.stringify({
        enabled: true,
        relayUrl: null,
        desktopInstanceId: 'mdi_test',
        pairedDevices: [
          { ...pairedDevice(GRANTED_AT_PAIRING), protocolVersion: mobileControlMinSupportedProtocolVersion },
        ],
        pushRegistrations: [],
      }),
      'utf8',
    )

    const state = await readMobileBridgeStore(storePath)
    assert.equal(state.pairedDevices.length, 1, 'a device paired one protocol version back was dropped from the store')
  }

  // The pairing link is the one thing an out-of-date phone has to be able to use,
  // since it is how it gets back in. Held to the same window as everything else,
  // so a link is never accepted by the command gate and refused by the scanner.
  function assertPairingLinkFollowsTheSameWindow(): void {
    const link = (version: number): string =>
      `multicode://mobile/pair?mobileControlProtocolVersion=${version}` +
      '&pairingChallengeId=pc_1&relayUrl=https://relay.example.com&pairingSecret=s3cret' +
      '&expiresAt=2026-09-14T10:00:30.000Z&desktopName=mac-mini&desktopInstanceId=mdi_test'

    for (const version of mobileControlSupportedProtocolVersions) {
      assert.equal(
        manualPairingValueFromRelayChallenge({ pairingUri: link(version) }),
        link(version),
        `a pairing link at protocol version ${version} must be usable`,
      )
    }
    for (const outside of [mobileControlMinSupportedProtocolVersion - 1, mobileControlProtocolVersion + 1]) {
      assert.throws(
        () => manualPairingValueFromRelayChallenge({ pairingUri: link(outside) }),
        /mobile-compatible pairing link/u,
        `a pairing link at protocol version ${outside} must be refused`,
      )
    }
  }

  function pairedDevice(capabilities: string[]): Record<string, unknown> {
    return {
      protocolVersion: mobileControlProtocolVersion,
      deviceId: 'mobile-1',
      displayName: "Owner's iPhone",
      platform: 'ios',
      appVersion: '0.1.0',
      pairedAt: '2026-07-14T12:00:00.000Z',
      capabilities,
    }
  }

  await suiteRun
})
