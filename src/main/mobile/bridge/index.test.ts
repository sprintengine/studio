import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MobileBridge,
  type MobileRelayAuthenticatedDevice,
  type MobileRelayScope,
  type MobileRelayTransport,
  type RelayCommandType,
} from './index'
import { MobileControlCommandService, type MobileControlCommand } from '../control/command'
import { relaySummaryByteLength, relayResultSummaryMaxBytes, summarizeCommandResult } from './command-results'
import { dispatchSnapshotRequest } from './snapshot-request'
import { MobileControlSnapshotService } from '../control/snapshot'
import {
  mobileControlProtocolVersion,
  validateMobileControlSnapshot,
} from '../../../../packages/mobile-control-protocol/src/index'
import { DEFAULT_MOBILE_RELAY_URL } from '../../service-endpoints'
import { test } from 'vitest'

test('index', async () => {
  const now = new Date('2026-04-28T22:00:00.000Z')

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  async function main(): Promise<void> {
    await assertLegacyLocalRelayUrlMigratesToProductionDefault()
    await assertDesktopPairingDisplayUsesManualRelayCode()
    await assertDesktopPairingDisplayRejectsLegacyRelayChallenge()
    await assertAuthenticatedRelayTransportDispatchesAndFailsClosed()
    await assertOversizedSnapshotRequestFailsRatherThanTruncating()
    await assertSnapshotWithinBudgetShipsWhole()
    await assertSnapshotRequestSkipsUnchangedWhenKnownVersionMatches()
    await assertMobileDeviceCannotRevokeSiblingDevice()
    await assertEnabledBridgeWithNoPairedDevicesIssuesNoRelayTraffic()
    await assertPairedIdleCadenceBacksOffToCeilingAndSnapsBackOnCommand()
    await assertRevokingLastDeviceStopsPollingAndGoesIdle()
    await assertPairingFromIdleKeepsConnectionAfterRaceWithConnectPoll()
    await assertShutdownDoesNotReschedulePolling()
  }

  async function assertLegacyLocalRelayUrlMigratesToProductionDefault(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-bridge-store-'))
    const storePath = join(workspaceRoot, 'mobile-bridge.json')
    await writeFile(
      storePath,
      `${JSON.stringify(
        {
          enabled: false,
          relayUrl: 'http://localhost:3000',
          desktopInstanceId: 'mdi_existing',
          pairedDevices: [],
          pushRegistrations: [],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    const bridge = new MobileBridge(async () => ({ authenticated: false }), { storePath })

    const state = await bridge.getState()
    bridge.shutdown()

    assert.equal(state.relayUrl, DEFAULT_MOBILE_RELAY_URL)
  }

  async function assertDesktopPairingDisplayUsesManualRelayCode(): Promise<void> {
    const fixture = await writeBridgeFixture({ pairDevice: false })
    const relay = new PairingChallengeRelayTransport()
    const bridge = new MobileBridge(
      async () => ({
        authenticated: true,
        session: { id: 'ses_seed_usr_seed_pro', expiresAt: new Date(now.getTime() + 60_000).toISOString() },
      }),
      {
        relayUrl: 'https://relay.test',
        storePath: join(fixture.workspaceRoot, 'mobile-bridge.json'),
        accessTokenProvider: async () => 'desktop-access-token',
        relayTransport: relay,
        workspaceRootsProvider: async () => [fixture.workspaceRoot],
        commandPollIntervalMs: 10_000,
      },
    )

    // No device is paired yet, so enabling stays idle; requesting a pairing code is
    // what brings the relay connection up on demand.
    await bridge.updateSettings({ enabled: true })
    const challenge = await bridge.requestPairingCode()
    bridge.shutdown()

    assert.equal(relay.connects.length, 1)
    assert.equal(challenge.pairingCode, '123456')
    assert.notEqual(challenge.pairingCode, challenge.pairingUri)
    assert.equal(challenge.pairingUri.includes('pairingSecret=psec_current'), true)
  }

  async function assertDesktopPairingDisplayRejectsLegacyRelayChallenge(): Promise<void> {
    const fixture = await writeBridgeFixture({ pairDevice: false })
    const relay = new LegacyPairingChallengeRelayTransport()
    const bridge = new MobileBridge(
      async () => ({
        authenticated: true,
        session: { id: 'ses_seed_usr_seed_pro', expiresAt: new Date(now.getTime() + 60_000).toISOString() },
      }),
      {
        relayUrl: 'https://relay.test',
        storePath: join(fixture.workspaceRoot, 'mobile-bridge.json'),
        accessTokenProvider: async () => 'desktop-access-token',
        relayTransport: relay,
        workspaceRootsProvider: async () => [fixture.workspaceRoot],
        commandPollIntervalMs: 10_000,
      },
    )

    // Enabling stays idle with no paired device; requestPairingCode connects on demand,
    // then rejects the legacy challenge shape.
    await bridge.updateSettings({ enabled: true })
    await assert.rejects(
      () => bridge.requestPairingCode(),
      /Relay pairing challenge did not include a mobile-compatible pairing link/u,
    )
    assert.equal(relay.connects.length, 1)
    bridge.shutdown()
  }

  // The relay's authorization gate and its command routing, together. Since the
  // Sprint Engine's removal the sprint commands still ARRIVE — a paired phone sends what it was
  // paired for — and every one of them comes back as a well-formed refusal rather
  // than a throw, a hang or a malformed result.
  async function assertAuthenticatedRelayTransportDispatchesAndFailsClosed(): Promise<void> {
    const fixture = await writeBridgeFixture()
    // The mutated workspace is deliberately NOT the one the snapshot reads. The
    // relay dispatches a batch concurrently, and a backlog write racing the
    // snapshot's read of the same `items.json` is a real (pre-existing) product
    // race that would make this test flaky rather than tell us anything about the
    // routing it exists to check.
    const mutation = await writeBridgeFixture({ pairDevice: false })
    const relay = new FakeRelayTransport([
      commandDelivery('cmd_backlog_update', {
        desktopRelaySessionId: 'drs_desktop_1',
        commandType: 'backlog.update',
        payload: {
          workspacePath: mutation.workspaceRoot,
          relativePath: 'backlog/backlog_0000.md',
          status: 'in_progress',
        },
        device: pairedDevice({ scopes: ['relay:backlog:update'] }),
      }),
      commandDelivery('cmd_snapshot', {
        desktopRelaySessionId: 'drs_desktop_1',
        commandType: 'snapshot.request',
        payload: {},
        device: pairedDevice({ scopes: ['relay:snapshot:read'] }),
      }),
      // Retired with the Sprint Engine and then removed from the wire entirely
      // (protocol v3), so their types and scopes no longer exist and are cast in.
      // A relay that still delivered one must still get an ANSWER: a command the
      // desktop drops is a command the phone waits out to its own timeout.
      commandDelivery('cmd_retired_approve', {
        desktopRelaySessionId: 'drs_desktop_1',
        commandType: 'artifact.approve' as RelayCommandType,
        payload: { sprintEngineId: 'relay-team', artifactId: 'A1' },
        device: pairedDevice({ scopes: ['relay:artifact:review' as MobileRelayScope] }),
      }),
      commandDelivery('cmd_retired_artifact_read', {
        desktopRelaySessionId: 'drs_desktop_1',
        commandType: 'artifact.read' as RelayCommandType,
        payload: { sprintEngineId: 'relay-team', artifactId: 'A1', previewMode: 'markdown' },
        device: pairedDevice({ scopes: ['relay:artifact:read' as MobileRelayScope] }),
      }),
      commandDelivery('cmd_retired_task_start', {
        desktopRelaySessionId: 'drs_desktop_1',
        commandType: 'task.start' as RelayCommandType,
        payload: { sprintEngineId: 'relay-team', taskId: 'T1', role: 'developer', worktreeIsolation: 'preferred' },
        device: pairedDevice({ scopes: ['relay:task:start' as MobileRelayScope] }),
      }),
      commandDelivery('cmd_missing_device', {
        desktopRelaySessionId: 'drs_desktop_1',
        commandType: 'backlog.update',
        payload: { workspacePath: mutation.workspaceRoot, relativePath: 'backlog/backlog_0000.md', status: 'ready' },
        device: null,
      }),
      commandDelivery('cmd_revoked', {
        desktopRelaySessionId: 'drs_desktop_1',
        commandType: 'backlog.update',
        payload: { workspacePath: mutation.workspaceRoot, relativePath: 'backlog/backlog_0000.md', status: 'ready' },
        device: pairedDevice({ revokedAt: now.toISOString(), scopes: ['relay:backlog:update'] }),
      }),
      commandDelivery('cmd_wrong_session', {
        desktopRelaySessionId: 'drs_other',
        commandType: 'backlog.update',
        payload: { workspacePath: mutation.workspaceRoot, relativePath: 'backlog/backlog_0000.md', status: 'ready' },
        device: pairedDevice({ scopes: ['relay:backlog:update'] }),
      }),
      commandDelivery('cmd_missing_capability', {
        desktopRelaySessionId: 'drs_desktop_1',
        commandType: 'backlog.update',
        payload: { workspacePath: mutation.workspaceRoot, relativePath: 'backlog/backlog_0000.md', status: 'ready' },
        device: pairedDevice({ scopes: ['relay:snapshot:read'] }),
      }),
    ])
    const bridge = new MobileBridge(
      async () => ({
        authenticated: true,
        session: { id: 'ses_seed_usr_seed_pro', expiresAt: new Date(now.getTime() + 60_000).toISOString() },
      }),
      {
        relayUrl: 'https://relay.test',
        storePath: join(fixture.workspaceRoot, 'mobile-bridge.json'),
        accessTokenProvider: async () => 'desktop-access-token',
        relayTransport: relay,
        commandService: new MobileControlCommandService({
          workspaceRoot: mutation.workspaceRoot,
          now: () => now,
        }),
        workspaceRootsProvider: async () => [fixture.workspaceRoot],
        commandPollIntervalMs: 10_000,
      },
    )

    await bridge.updateSettings({ enabled: true })
    await waitFor(() => relay.results.length === 9 && relay.snapshots.length === 1)
    bridge.shutdown()

    assert.equal(relay.connects.length, 1)
    assert.equal(relay.connects[0].accessToken, 'desktop-access-token')
    // INVERTED at protocol v3. The relay's inbound vocabulary used to keep the
    // sprint members so an old phone's envelope still parsed; the wire no longer
    // has them, so this desktop no longer offers to accept them either.
    assert.equal(relay.connects[0].commands.includes('artifact.approve' as RelayCommandType), false)
    assert.equal(Object.hasOwn(relay.snapshots[0].snapshot, 'sprintEngines'), false)

    const resultByCommand = new Map(relay.results.map((result) => [result.commandId, result]))
    assert.equal(resultByCommand.get('cmd_backlog_update')?.status, 'completed')
    assert.equal(resultByCommand.get('cmd_snapshot')?.status, 'completed')
    assert.equal(resultByCommand.get('cmd_snapshot')?.resultCode, 'OK')
    // Every retired sprint command is answered, and answered honestly. The refusal
    // now comes from the relay gate (the type maps to no capability) rather than
    // from the command service, one step earlier and with the same code.
    for (const commandId of ['cmd_retired_approve', 'cmd_retired_artifact_read', 'cmd_retired_task_start']) {
      assert.equal(resultByCommand.get(commandId)?.status, 'failed', `${commandId} must come back`)
      assert.equal(resultByCommand.get(commandId)?.resultCode, 'COMMAND_NOT_SUPPORTED', `${commandId} must say why`)
    }
    assert.equal(resultByCommand.get('cmd_missing_device')?.resultCode, 'UNAUTHENTICATED')
    assert.equal(resultByCommand.get('cmd_revoked')?.resultCode, 'DEVICE_REVOKED')
    assert.equal(resultByCommand.get('cmd_wrong_session')?.resultCode, 'UNAUTHORIZED')
    assert.equal(resultByCommand.get('cmd_missing_capability')?.resultCode, 'UNAUTHORIZED')

    const backlogAudit = resultByCommand.get('cmd_backlog_update')?.summary.audit as Record<string, unknown>
    assert.equal(typeof backlogAudit.auditId, 'string')
    assert.equal(backlogAudit.commandId, 'cmd_backlog_update')
    assert.equal(backlogAudit.deviceId, 'pdv_phone_1')
    assert.equal(backlogAudit.commandType, 'backlog.update')
    assert.equal(backlogAudit.status, 'accepted')
    assert.equal(typeof backlogAudit.recordedAt, 'string')
    // The workspace root never crosses the relay, in a result or in its audit.
    assert.equal(
      JSON.stringify(resultByCommand.get('cmd_backlog_update')?.summary).includes(mutation.workspaceRoot),
      false,
    )

    const snapshotSummary = resultByCommand.get('cmd_snapshot')?.summary ?? {}
    assert.equal(snapshotSummary.ok, true)
    assert.notDeepEqual((snapshotSummary as { data?: unknown }).data, { truncated: true })
    const snapshotValidation = validateMobileControlSnapshot((snapshotSummary as { data?: unknown }).data)
    assert.equal(
      snapshotValidation.ok,
      true,
      snapshotValidation.ok === false ? snapshotValidation.error.message : undefined,
    )
    assert.equal(relaySummaryByteLength(snapshotSummary) < relayResultSummaryMaxBytes, true)
  }

  // A snapshot that cannot be brought inside the relay's result-summary budget
  // must come back as a well-formed `snapshot_too_large` FAILURE, never as a
  // success carrying `{ truncated: true }` — a phone cannot tell a truncated
  // snapshot from a real one, and would render a fleet that is not there.
  //
  // Until the Sprint Engine was removed the ladder could always get there by dropping sprint
  // engines one at a time. It no longer can: what is left in an over-budget
  // snapshot is backlog, and there is no rung that drops backlog items. So the
  // honest refusal is what this asserts.
  async function assertOversizedSnapshotRequestFailsRatherThanTruncating(): Promise<void> {
    const fixture = await writeBridgeFixture()
    const relay = new FakeRelayTransport([
      commandDelivery('cmd_oversized_snapshot', {
        desktopRelaySessionId: 'drs_desktop_1',
        commandType: 'snapshot.request',
        payload: {},
        device: pairedDevice({ scopes: ['relay:snapshot:read'] }),
      }),
    ])
    // The payload is non-ASCII on purpose: it sits under the relay's CHARACTER
    // count and over its BYTE budget, so only a byte-wise measure refuses it.
    const oversized = {
      protocolVersion: mobileControlProtocolVersion,
      generatedAt: now.toISOString(),
      desktopSessionId: 'desktop_1',
      snapshotVersion: 'snap_oversized',
      commands: [],
      backlog: [
        {
          workspaceId: 'backlog:ws_token',
          workspacePath: 'ws_token',
          workspaceName: 'projA',
          updatedAt: now.toISOString(),
          items: [
            {
              itemId: 'i1',
              relativePath: 'backlog/a.md',
              title: createNonAsciiPayloadBelowCharacterCapAboveByteCap(),
              status: 'idea',
            },
          ],
        },
      ],
    }
    const bridge = new MobileBridge(
      async () => ({
        authenticated: true,
        session: { id: 'ses_seed_usr_seed_pro', expiresAt: new Date(now.getTime() + 60_000).toISOString() },
      }),
      {
        relayUrl: 'https://relay.test',
        storePath: join(fixture.workspaceRoot, 'mobile-bridge.json'),
        accessTokenProvider: async () => 'desktop-access-token',
        relayTransport: relay,
        snapshotService: {
          readSnapshot: async () => oversized,
          publishSnapshot: async () => null,
          subscribe: () => () => undefined,
          shutdown: () => undefined,
        } as unknown as MobileControlSnapshotService,
        workspaceRootsProvider: async () => [fixture.workspaceRoot],
        commandPollIntervalMs: 10_000,
      },
    )

    await bridge.updateSettings({ enabled: true })
    await waitFor(() => relay.results.some((result) => result.commandId === 'cmd_oversized_snapshot'))
    bridge.shutdown()

    const result = relay.results.find((candidate) => candidate.commandId === 'cmd_oversized_snapshot')
    assert.equal(result?.status, 'failed')
    assert.equal(result?.resultCode, 'SNAPSHOT_TOO_LARGE')
    assert.equal(JSON.stringify(result?.summary).includes('"truncated":true'), false)
    assert.equal(relaySummaryByteLength(result?.summary) < relayResultSummaryMaxBytes, true)
  }

  // A snapshot that FITS is shipped whole, validates on the wire, and says sprints
  // are absent rather than omitting the required key.
  async function assertSnapshotWithinBudgetShipsWhole(): Promise<void> {
    const fixture = await writeBridgeFixture({ backlogItems: 20 })
    const relay = new FakeRelayTransport([
      commandDelivery('cmd_sized_snapshot', {
        desktopRelaySessionId: 'drs_desktop_1',
        commandType: 'snapshot.request',
        payload: {},
        device: pairedDevice({ scopes: ['relay:snapshot:read'] }),
      }),
    ])
    const bridge = new MobileBridge(
      async () => ({
        authenticated: true,
        session: { id: 'ses_seed_usr_seed_pro', expiresAt: new Date(now.getTime() + 60_000).toISOString() },
      }),
      {
        relayUrl: 'https://relay.test',
        storePath: join(fixture.workspaceRoot, 'mobile-bridge.json'),
        accessTokenProvider: async () => 'desktop-access-token',
        relayTransport: relay,
        workspaceRootsProvider: async () => [fixture.workspaceRoot],
        commandPollIntervalMs: 10_000,
      },
    )

    await bridge.updateSettings({ enabled: true })
    await waitFor(() => relay.results.some((result) => result.commandId === 'cmd_sized_snapshot'))
    bridge.shutdown()

    const result = relay.results.find((candidate) => candidate.commandId === 'cmd_sized_snapshot')
    assert.equal(result?.status, 'completed')
    assert.equal(result?.resultCode, 'OK')
    assert.equal(result?.summary.ok, true)
    assert.equal(JSON.stringify(result?.summary).includes('"truncated":true'), false)
    const snapshot = result?.summary.data
    const validation = validateMobileControlSnapshot(snapshot)
    assert.equal(validation.ok, true, validation.ok === false ? validation.error.message : undefined)
    assert.equal(Object.hasOwn(snapshot as object, 'sprintEngines'), false)
    assert.equal(Object.hasOwn(snapshot as object, 'snapshotLimits'), false)
    assert.equal((snapshot as { backlog?: { items: unknown[] }[] })?.backlog?.[0]?.items.length, 20)
  }

  // Item 1599: a snapshot.request that echoes the version the client already
  // holds is answered with a tiny change token, not a re-shipped full snapshot;
  // an absent or stale version returns the full snapshot exactly as before.
  async function assertSnapshotRequestSkipsUnchangedWhenKnownVersionMatches(): Promise<void> {
    // Inflate the payload so the full snapshot is unmistakably larger than the
    // change-token result the fast-path returns.
    const fixture = await writeBridgeFixture({ backlogItems: 40 })
    const service = new MobileControlSnapshotService()

    // Build once and pin it: dispatchSnapshotRequest recomputes the snapshot on
    // every call (with a fresh wall-clock generatedAt), so a stub that returns the
    // same internal snapshot is what makes the version comparison deterministic.
    // The sanitized copy the client receives carries this same snapshotVersion.
    const built = await service.readSnapshot({
      desktopSessionId: 'ses_relay_desktop',
      workspaceRoots: [fixture.workspaceRoot],
    })
    const shippedVersion = built.snapshotVersion
    assert.equal(typeof shippedVersion, 'string')

    const snapshotService = { readSnapshot: async () => built } as unknown as MobileControlSnapshotService
    const dispatch = (payload: Record<string, unknown>) =>
      dispatchSnapshotRequest({
        command: snapshotRequestCommand(payload),
        snapshotService,
        desktopSessionId: 'ses_relay_desktop',
        workspaceRootsProvider: async () => [fixture.workspaceRoot],
      })

    const unchanged = await dispatch({ knownSnapshotVersion: shippedVersion })
    const full = await dispatch({})
    const stale = await dispatch({ knownSnapshotVersion: 'snap_000000000000000000000000' })

    assert.equal(unchanged.ok, true)
    assert.equal(full.ok, true)
    assert.equal(stale.ok, true)
    if (!unchanged.ok || !full.ok || !stale.ok) return

    // Match: tiny change token, and nothing else — the result-summary rules forbid
    // content-bearing keys, so only the boolean and the hash token may ride.
    const unchangedData = unchanged.data as Record<string, unknown>
    assert.deepEqual(Object.keys(unchangedData).sort(), ['snapshotVersion', 'unchanged'])
    assert.equal(unchangedData.unchanged, true)
    assert.equal(unchangedData.snapshotVersion, shippedVersion)

    // Absent and stale versions both return the full snapshot exactly as today.
    assert.equal((full.data as { backlog?: { items: unknown[] }[] }).backlog?.[0]?.items.length, 40)
    assert.equal((stale.data as { backlog?: { items: unknown[] }[] }).backlog?.[0]?.items.length, 40)

    // The relay ships and ledgers the summarized result, so measure that.
    const unchangedBytes = relaySummaryByteLength(summarizeCommandResult(unchanged))
    const fullBytes = relaySummaryByteLength(summarizeCommandResult(full))
    assert.equal(unchangedBytes < 512, true)
    assert.equal(fullBytes > unchangedBytes * 8, true)
    console.log(
      `[1599] unchanged result ${unchangedBytes} B vs full snapshot ${fullBytes} B (${(fullBytes / unchangedBytes).toFixed(1)}x)`,
    )
  }

  function snapshotRequestCommand(payload: Record<string, unknown>): MobileControlCommand {
    return {
      protocolVersion: mobileControlProtocolVersion,
      commandId: 'cmd_conditional_snapshot',
      type: 'snapshot.request',
      issuedAt: now.toISOString(),
      deviceId: 'pdv_phone_1',
      payload,
    } as MobileControlCommand
  }

  async function assertMobileDeviceCannotRevokeSiblingDevice(): Promise<void> {
    const fixture = await writeBridgeFixture()
    const relay = new FakeRelayTransport([
      commandDelivery('cmd_revoke_sibling', {
        desktopRelaySessionId: 'drs_desktop_1',
        commandType: 'device.revoke',
        payload: { deviceId: 'pdv_phone_2', reason: 'Compromised sibling revoke attempt' },
        device: pairedDevice({ deviceId: 'pdv_phone_1', scopes: ['relay:device:revoke'] }),
      }),
    ])
    const bridge = new MobileBridge(
      async () => ({
        authenticated: true,
        session: { id: 'ses_seed_usr_seed_pro', expiresAt: new Date(now.getTime() + 60_000).toISOString() },
      }),
      {
        relayUrl: 'https://relay.test',
        storePath: join(fixture.workspaceRoot, 'mobile-bridge.json'),
        accessTokenProvider: async () => 'desktop-access-token',
        relayTransport: relay,
        workspaceRootsProvider: async () => [fixture.workspaceRoot],
        commandPollIntervalMs: 10_000,
      },
    )

    await bridge.updateSettings({ enabled: true })
    await waitFor(() => relay.results.some((result) => result.commandId === 'cmd_revoke_sibling'))
    bridge.shutdown()

    const result = relay.results.find((candidate) => candidate.commandId === 'cmd_revoke_sibling')
    assert.equal(result?.status, 'failed')
    assert.equal(result?.resultCode, 'UNAUTHORIZED')
    assert.equal(result?.summary.ok, false)
    assert.equal(result?.summary.code, 'unauthorized')
    assert.equal(relay.revocations.length, 0)
  }

  // Item 1598, acceptance 1: an enabled+configured bridge with zero paired devices must
  // hold no relay session and issue no requests — no connect, no command poll — however
  // long it sits enabled. Proven by counting transport calls across several base intervals.
  async function assertEnabledBridgeWithNoPairedDevicesIssuesNoRelayTraffic(): Promise<void> {
    const fixture = await writeBridgeFixture({ pairDevice: false })
    const relay = new ProgrammableRelayTransport()
    const bridge = new MobileBridge(
      async () => ({
        authenticated: true,
        session: { id: 'ses_seed_usr_seed_pro', expiresAt: new Date(now.getTime() + 60_000).toISOString() },
      }),
      {
        relayUrl: 'https://relay.test',
        storePath: join(fixture.workspaceRoot, 'mobile-bridge.json'),
        accessTokenProvider: async () => 'desktop-access-token',
        relayTransport: relay,
        workspaceRootsProvider: async () => [fixture.workspaceRoot],
        commandPollIntervalMs: 250,
      },
    )

    await bridge.updateSettings({ enabled: true })
    // Let several base intervals elapse; any incorrectly-scheduled connect or poll fires.
    await delay(400)
    const state = await bridge.getState()
    bridge.shutdown()

    assert.equal(relay.connects.length, 0)
    assert.equal(relay.pollCount, 0)
    assert.equal(state.relayStatus, 'idle')
    assert.deepEqual(state.commandPollCadence, { intervalMs: 0, state: 'paused' })
  }

  // Item 1598, acceptance 2 & 3: with a device paired but no commands arriving, the poll
  // interval decays x2 per tick up to the ceiling; a newly delivered command snaps it
  // back to the fast base cadence within one ceiling interval. Compressed timings.
  async function assertPairedIdleCadenceBacksOffToCeilingAndSnapsBackOnCommand(): Promise<void> {
    const fixture = await writeBridgeFixture()
    const relay = new ProgrammableRelayTransport()
    const bridge = new MobileBridge(
      async () => ({
        authenticated: true,
        session: { id: 'ses_seed_usr_seed_pro', expiresAt: new Date(now.getTime() + 60_000).toISOString() },
      }),
      {
        relayUrl: 'https://relay.test',
        storePath: join(fixture.workspaceRoot, 'mobile-bridge.json'),
        accessTokenProvider: async () => 'desktop-access-token',
        relayTransport: relay,
        workspaceRootsProvider: async () => [fixture.workspaceRoot],
        commandPollIntervalMs: 250,
        commandPollCeilingMs: 1000,
        // Wide enough that the post-command snap-back to fast is reliably observable
        // (snapshot dispatch fits inside it), small enough that decay reaches the
        // ceiling well within the state timeout.
        commandPollAttentionWindowMs: 200,
      },
    )

    await bridge.updateSettings({ enabled: true })
    // Quiet: interval doubles 250 -> 500 -> 1000 and holds at the ceiling.
    await waitForState(
      bridge,
      (state) => state.commandPollCadence.state === 'decayed' && state.commandPollCadence.intervalMs === 1000,
    )

    // A delivered command snaps the cadence back to fast within one ceiling interval.
    relay.queue(
      commandDelivery('cmd_backoff_snap', {
        desktopRelaySessionId: 'drs_desktop_1',
        commandType: 'snapshot.request',
        payload: {},
        device: pairedDevice({ scopes: ['relay:snapshot:read'] }),
      }),
    )
    await waitForState(
      bridge,
      (state) => state.commandPollCadence.state === 'fast' && state.commandPollCadence.intervalMs === 250,
    )
    bridge.shutdown()
  }

  // Item 1598: revoking the last active device stops the poll loop and drops the bridge
  // to idle — no further relay traffic — instead of holding the old flat cadence.
  async function assertRevokingLastDeviceStopsPollingAndGoesIdle(): Promise<void> {
    const fixture = await writeBridgeFixture()
    const relay = new ProgrammableRelayTransport()
    const bridge = new MobileBridge(
      async () => ({
        authenticated: true,
        session: { id: 'ses_seed_usr_seed_pro', expiresAt: new Date(now.getTime() + 60_000).toISOString() },
      }),
      {
        relayUrl: 'https://relay.test',
        storePath: join(fixture.workspaceRoot, 'mobile-bridge.json'),
        accessTokenProvider: async () => 'desktop-access-token',
        relayTransport: relay,
        workspaceRootsProvider: async () => [fixture.workspaceRoot],
        commandPollIntervalMs: 500,
      },
    )

    await bridge.updateSettings({ enabled: true })
    await waitForState(
      bridge,
      (state) => state.relayStatus === 'connected' && state.commandPollCadence.state !== 'paused',
    )

    await bridge.revokeDevice('pdv_seed', 'Lost phone')
    const afterRevoke = await bridge.getState()
    const pollsAtRevoke = relay.pollCount
    assert.equal(afterRevoke.relayStatus, 'idle')
    assert.deepEqual(afterRevoke.commandPollCadence, { intervalMs: 0, state: 'paused' })

    // No further polls after the last device is gone.
    await delay(700)
    assert.equal(relay.pollCount, pollsAtRevoke)
    bridge.shutdown()
  }

  // Item 1598: pairing from idle must leave the bridge connected and polling. The
  // connect-time poll can fire during the (real, multi-turn) createPairingChallenge and
  // find no device/challenge yet, dropping to idle; the challenge then arms polling and
  // the retained session must be restored to connected. A delayed challenge forces the race.
  async function assertPairingFromIdleKeepsConnectionAfterRaceWithConnectPoll(): Promise<void> {
    const fixture = await writeBridgeFixture({ pairDevice: false })
    const relay = new SlowPairingChallengeRelayTransport()
    const bridge = new MobileBridge(
      async () => ({
        authenticated: true,
        session: { id: 'ses_seed_usr_seed_pro', expiresAt: new Date(now.getTime() + 60_000).toISOString() },
      }),
      {
        relayUrl: 'https://relay.test',
        storePath: join(fixture.workspaceRoot, 'mobile-bridge.json'),
        accessTokenProvider: async () => 'desktop-access-token',
        relayTransport: relay,
        workspaceRootsProvider: async () => [fixture.workspaceRoot],
        commandPollIntervalMs: 500,
      },
    )

    await bridge.updateSettings({ enabled: true })
    await bridge.requestPairingCode()
    const state = await bridge.getState()
    bridge.shutdown()

    assert.equal(relay.connects.length, 1)
    assert.equal(state.relayStatus, 'connected')
    assert.notEqual(state.commandPollCadence.state, 'paused')
  }

  // shutdown() is sync and the poll loop is not: an in-flight poll's finally used
  // to call scheduleNextCommandPoll after the timer was cleared, which kept this
  // file's Node process alive when the suite ran it last (serial) and a sibling's
  // CPU load stretched the poll past shutdown. The process then never exited and
  // the runner had no per-file timeout, so verify:app sat until an outer cap.
  async function assertShutdownDoesNotReschedulePolling(): Promise<void> {
    const fixture = await writeBridgeFixture()
    const relay = new ProgrammableRelayTransport()
    const bridge = new MobileBridge(
      async () => ({
        authenticated: true,
        session: { id: 'ses_seed_usr_seed_pro', expiresAt: new Date(now.getTime() + 60_000).toISOString() },
      }),
      {
        relayUrl: 'https://relay.test',
        storePath: join(fixture.workspaceRoot, 'mobile-bridge.json'),
        accessTokenProvider: async () => 'desktop-access-token',
        relayTransport: relay,
        workspaceRootsProvider: async () => [fixture.workspaceRoot],
        commandPollIntervalMs: 50,
      },
    )

    await bridge.updateSettings({ enabled: true })
    await waitForState(
      bridge,
      (state) => state.relayStatus === 'connected' && state.commandPollCadence.state !== 'paused',
    )
    bridge.shutdown()
    await delay(50)
    const pollsAfterShutdown = relay.pollCount
    await delay(200)
    assert.equal(relay.pollCount, pollsAfterShutdown, 'shutdown must not let an in-flight poll reschedule')
  }

  class FakeRelayTransport implements MobileRelayTransport {
    readonly connects: Array<{ accessToken: string; commands: string[] }> = []
    readonly results: Array<{
      commandId: string
      status: 'completed' | 'failed'
      resultCode: string
      summary: Record<string, unknown>
    }> = []
    readonly revocations: Parameters<MobileRelayTransport['revokeDevice']>[0][] = []
    readonly snapshots: Array<{ snapshot: object }> = []
    private delivered = false

    constructor(private readonly deliveries: Awaited<ReturnType<MobileRelayTransport['listPendingCommands']>>) {}

    async connectDesktop(input: Parameters<MobileRelayTransport['connectDesktop']>[0]) {
      this.connects.push({ accessToken: input.accessToken, commands: input.commands })
      return {
        desktopRelaySessionId: 'drs_desktop_1',
        relayToken: 'relay-token',
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        heartbeatAfterSeconds: 30,
      }
    }

    async createPairingChallenge() {
      return {
        pairingChallengeId: 'pcha_1',
        pairingUri: 'multicode://mobile/pair?secret=pair-secret',
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      }
    }

    async listPendingCommands() {
      if (this.delivered) return []
      this.delivered = true
      return this.deliveries
    }

    async postCommandResult(input: Parameters<MobileRelayTransport['postCommandResult']>[0]) {
      this.results.push({
        commandId: input.commandId,
        status: input.status,
        resultCode: input.resultCode,
        summary: input.summary,
      })
    }

    async revokeDevice(input: Parameters<MobileRelayTransport['revokeDevice']>[0]) {
      this.revocations.push(input)
      return { revoked: true as const }
    }

    async publishSnapshot(input: Parameters<NonNullable<MobileRelayTransport['publishSnapshot']>>[0]) {
      this.snapshots.push({ snapshot: input.snapshot })
    }
  }

  // Counts every command poll and lets a test hand a command to the next poll on demand,
  // so idle backoff (quiet -> decay) and snap-back (deliver -> fast) are both observable.
  class ProgrammableRelayTransport extends FakeRelayTransport {
    pollCount = 0
    private queued: Awaited<ReturnType<MobileRelayTransport['listPendingCommands']>> = []

    constructor() {
      super([])
    }

    queue(delivery: Awaited<ReturnType<MobileRelayTransport['listPendingCommands']>>[number]): void {
      this.queued.push(delivery)
    }

    override async listPendingCommands(): Promise<Awaited<ReturnType<MobileRelayTransport['listPendingCommands']>>> {
      this.pollCount++
      const pending = this.queued
      this.queued = []
      return pending
    }
  }

  class PairingChallengeRelayTransport extends FakeRelayTransport {
    constructor() {
      super([])
    }

    override async createPairingChallenge() {
      const expiresAt = new Date(now.getTime() + 60_000).toISOString()

      return {
        pairingChallengeId: 'pcha_current',
        manualPairingCode: '123456',
        pairingUri: [
          'multicode://mobile/pair?',
          new URLSearchParams({
            relayUrl: 'https://relay.test',
            pairingSecret: 'psec_current',
            expiresAt,
            pairingChallengeId: 'pcha_current',
            desktopName: 'Relay desktop',
            desktopInstanceId: 'desktop-instance-current',
          }).toString(),
        ].join(''),
        pairingPayload: {
          mobileControlProtocolVersion,
          pairingChallengeId: 'pcha_current',
          relayUrl: 'https://relay.test',
          pairingSecret: 'psec_current',
          expiresAt,
          desktop: {
            displayName: 'Relay desktop',
            desktopInstanceId: 'desktop-instance-current',
            desktopRelaySessionId: 'drs_desktop_1',
          },
        },
        expiresAt,
      }
    }
  }

  // Delays the challenge across a macrotask boundary so the connect-time poll (setTimeout 0)
  // fires while the challenge is still in flight — the idle-flip race requestPairingCode guards.
  // Uses a real (not fixture-clock) future expiry so the bridge's Date.now()-based expiry check
  // keeps the challenge live long enough for the assertion.
  class SlowPairingChallengeRelayTransport extends PairingChallengeRelayTransport {
    override async createPairingChallenge() {
      await new Promise((resolve) => setTimeout(resolve, 20))
      const base = await super.createPairingChallenge()
      return { ...base, expiresAt: new Date(Date.now() + 60_000).toISOString() }
    }
  }

  class LegacyPairingChallengeRelayTransport extends FakeRelayTransport {
    constructor() {
      super([])
    }

    override async createPairingChallenge() {
      return {
        pairingChallengeId: 'pcha_legacy',
        pairingUri: 'multicode://mobile/pair?secret=legacy-secret',
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      }
    }
  }

  // A workspace root the bridge serves, plus the paired-device store the command
  // poller needs. `backlogItems` inflates the snapshot for the size tests;
  // `nonAsciiPayload` rides one item's title so the byte cap (not the character
  // cap) is what the relay sizing measures.
  async function writeBridgeFixture(
    options: { backlogItems?: number; nonAsciiPayload?: string; pairDevice?: boolean } = {},
  ): Promise<{ workspaceRoot: string }> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-bridge-'))
    const itemCount = options.backlogItems ?? 1
    await mkdir(join(workspaceRoot, 'backlog'), { recursive: true })
    await mkdir(join(workspaceRoot, '.sprintengine', 'backlog'), { recursive: true })
    const items: Record<string, unknown>[] = []
    for (let index = 0; index < itemCount; index += 1) {
      const itemId = `backlog_${String(index).padStart(4, '0')}`
      const title = index === 0 && options.nonAsciiPayload ? options.nonAsciiPayload : `Backlog item ${index}`
      await writeFile(
        join(workspaceRoot, 'backlog', `${itemId}.md`),
        `---\ntype: feature\n---\n\n# ${title}\n\nBody text.\n`,
        'utf8',
      )
      items.push({
        id: itemId,
        source: { type: 'file', relativePath: `backlog/${itemId}.md` },
        status: 'ready',
        type: 'feature',
        metadata: {},
        links: [],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      })
    }
    await writeFile(
      join(workspaceRoot, '.sprintengine', 'backlog', 'items.json'),
      JSON.stringify({ schemaVersion: 1, items }),
      'utf8',
    )
    // Command polling is now gated on an active paired device, so fixtures that drive
    // the bridge through connect/poll seed one by default. Pairing-flow tests pass
    // `pairDevice: false` to exercise the idle → connect-on-demand path.
    if (options.pairDevice !== false) {
      await writeFile(
        join(workspaceRoot, 'mobile-bridge.json'),
        `${JSON.stringify(
          {
            enabled: false,
            relayUrl: null,
            desktopInstanceId: 'mdi_fixture',
            pairedDevices: [
              {
                protocolVersion: mobileControlProtocolVersion,
                deviceId: 'pdv_seed',
                displayName: 'Seeded phone',
                platform: 'ios',
                appVersion: '1.0.0',
                pairedAt: now.toISOString(),
                capabilities: [],
              },
            ],
            pushRegistrations: [],
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
    }
    return { workspaceRoot }
  }

  function createNonAsciiPayloadBelowCharacterCapAboveByteCap(): string {
    const payload = 'é'.repeat(140_000)
    assert.equal(JSON.stringify({ payload }).length < relayResultSummaryMaxBytes, true)
    assert.equal(relaySummaryByteLength({ payload }) > relayResultSummaryMaxBytes, true)
    return payload
  }

  function commandDelivery(
    commandId: string,
    input: {
      desktopRelaySessionId: string
      commandType: RelayCommandType
      payload: Record<string, unknown>
      device: MobileRelayAuthenticatedDevice | null
    },
  ): Awaited<ReturnType<MobileRelayTransport['listPendingCommands']>>[number] {
    const envelope = {
      desktopRelaySessionId: input.desktopRelaySessionId,
      commandId,
      commandType: input.commandType,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30_000).toISOString(),
      payload: input.payload,
    }
    return { envelope, device: input.device }
  }

  function pairedDevice(overrides: Partial<MobileRelayAuthenticatedDevice>): MobileRelayAuthenticatedDevice {
    return {
      deviceId: 'pdv_phone_1',
      userId: 'usr_seed_pro',
      organizationId: 'org_seed_pro_personal',
      mobileSessionId: 'ses_mobile_1',
      desktopRelaySessionId: 'drs_desktop_1',
      displayName: 'Dev phone',
      platform: 'ios',
      appVersion: '1.0.0',
      status: 'active',
      pairedAt: now.toISOString(),
      ...overrides,
    }
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    const startedAt = Date.now()
    while (!predicate()) {
      if (Date.now() - startedAt > 2_000) {
        throw new Error('Timed out waiting for fake relay integration.')
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function waitForState(
    bridge: MobileBridge,
    predicate: (state: Awaited<ReturnType<MobileBridge['getState']>>) => boolean,
    timeoutMs = 4_000,
  ): Promise<void> {
    const startedAt = Date.now()
    for (;;) {
      const state = await bridge.getState()
      if (predicate(state)) return
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error('Timed out waiting for bridge state.')
      }
      await delay(20)
    }
  }

  await suiteRun
})
