import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MobileBridge, type MobileRelayTransport, type MobileRelayAuthenticatedDevice, type MobileRelayScope } from './index'
import { MobileSprintEngineCommandService, type MobileControlCommand } from '../sprintengine/command'
import { relaySummaryByteLength, relayResultSummaryMaxBytes, summarizeCommandResult } from './command-results'
import { dispatchSnapshotRequest } from './snapshot-request'
import { MobileSprintEngineSnapshotService } from '../sprintengine/snapshot'
import { validateMobileControlSnapshot } from '../../../shared/mobile-control/protocol'

const now = new Date('2026-04-28T22:00:00.000Z')

installPgStubForMultiauthMemoryStoreTests()

void main()

async function main(): Promise<void> {
  await assertLegacyLocalRelayUrlMigratesToProductionDefault()
  await assertDesktopPairingDisplayUsesManualRelayCode()
  await assertDesktopPairingDisplayRejectsLegacyRelayChallenge()
  await assertAuthenticatedRelayTransportDispatchesAndFailsClosed()
  await assertOversizedSnapshotRequestReturnsBoundedSnapshotWithoutTruncatedSuccess()
  await assertNonAsciiSnapshotRequestUsesUtf8ByteCapForBoundedSnapshot()
  await assertSnapshotRequestSkipsUnchangedWhenKnownVersionMatches()
  await assertMobileDeviceCannotRevokeSiblingDevice()
  await assertEnabledBridgeWithNoPairedDevicesIssuesNoRelayTraffic()
  await assertPairedIdleCadenceBacksOffToCeilingAndSnapsBackOnCommand()
  await assertRevokingLastDeviceStopsPollingAndGoesIdle()
  await assertPairingFromIdleKeepsConnectionAfterRaceWithConnectPoll()
  await assertRelayBackedMobileDeviceRevokeCommandRevokesIssuingDevice()
  await assertRelayServiceDeliveriesDispatchAndRecordResults()
  await assertDesktopRevocationUpdatesRelayAuthority()
}

async function assertLegacyLocalRelayUrlMigratesToProductionDefault(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-bridge-store-'))
  const storePath = join(workspaceRoot, 'mobile-bridge.json')
  await writeFile(storePath, `${JSON.stringify({
    enabled: false,
    relayUrl: 'http://localhost:3000',
    desktopInstanceId: 'mdi_existing',
    pairedDevices: [],
    pushRegistrations: [],
  }, null, 2)}\n`, 'utf8')
  const bridge = new MobileBridge(
    async () => ({ authenticated: false }),
    { storePath }
  )

  const state = await bridge.getState()
  bridge.shutdown()

  assert.equal(state.relayUrl, 'https://multiauth-production.up.railway.app')
}

async function assertDesktopPairingDisplayUsesManualRelayCode(): Promise<void> {
  const fixture = await writeSprintEngineFixture({ pairDevice: false })
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
      statePathsProvider: async () => [fixture.statePath],
      commandPollIntervalMs: 10_000,
    }
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
  const fixture = await writeSprintEngineFixture({ pairDevice: false })
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
      statePathsProvider: async () => [fixture.statePath],
      commandPollIntervalMs: 10_000,
    }
  )

  // Enabling stays idle with no paired device; requestPairingCode connects on demand,
  // then rejects the legacy challenge shape.
  await bridge.updateSettings({ enabled: true })
  await assert.rejects(
    () => bridge.requestPairingCode(),
    /Relay pairing challenge did not include a mobile-compatible pairing link/u
  )
  assert.equal(relay.connects.length, 1)
  bridge.shutdown()
}

async function assertAuthenticatedRelayTransportDispatchesAndFailsClosed(): Promise<void> {
  const fixture = await writeSprintEngineFixture()
  const serviceWorkspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-bridge-command-cwd-'))
  const toolInvocations: Array<{ args: string[]; cwd: string }> = []
  const relay = new FakeRelayTransport([
    commandDelivery('cmd_approve', {
      desktopRelaySessionId: 'drs_desktop_1',
      commandType: 'artifact.approve',
      payload: { sprintEngineId: 'relay-team', artifactId: 'A1' },
      device: pairedDevice({ scopes: ['relay:artifact:review'] }),
    }),
    commandDelivery('cmd_request_changes', {
      desktopRelaySessionId: 'drs_desktop_1',
      commandType: 'artifact.requestChanges',
      payload: { sprintEngineId: 'relay-team', artifactId: 'A1', feedback: 'Sensitive reviewer feedback.' },
      device: pairedDevice({ scopes: ['relay:artifact:review'] }),
    }),
    commandDelivery('cmd_snapshot', {
      desktopRelaySessionId: 'drs_desktop_1',
      commandType: 'snapshot.request',
      payload: {},
      device: pairedDevice({ scopes: ['relay:snapshot:read'] }),
    }),
    commandDelivery('cmd_artifact_read', {
      desktopRelaySessionId: 'drs_desktop_1',
      commandType: 'artifact.read',
      payload: { sprintEngineId: 'relay-team', artifactId: 'A1', previewMode: 'markdown' },
      device: pairedDevice({ scopes: ['relay:artifact:read'] }),
    }),
    commandDelivery('cmd_missing_device', {
      desktopRelaySessionId: 'drs_desktop_1',
      commandType: 'artifact.approve',
      payload: { sprintEngineId: 'relay-team', artifactId: 'A1' },
      device: null,
    }),
    commandDelivery('cmd_revoked', {
      desktopRelaySessionId: 'drs_desktop_1',
      commandType: 'artifact.requestChanges',
      payload: { sprintEngineId: 'relay-team', artifactId: 'A1', feedback: 'Needs more detail.' },
      device: pairedDevice({ revokedAt: now.toISOString(), scopes: ['relay:artifact:review'] }),
    }),
    commandDelivery('cmd_wrong_session', {
      desktopRelaySessionId: 'drs_other',
      commandType: 'artifact.approve',
      payload: { sprintEngineId: 'relay-team', artifactId: 'A1' },
      device: pairedDevice({ scopes: ['relay:artifact:review'] }),
    }),
    commandDelivery('cmd_missing_capability', {
      desktopRelaySessionId: 'drs_desktop_1',
      commandType: 'task.start',
      payload: { sprintEngineId: 'relay-team', taskId: 'T1', role: 'developer', worktreeIsolation: 'preferred' },
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
      commandService: new MobileSprintEngineCommandService({
        workspaceRoot: serviceWorkspaceRoot,
        now: () => now,
        execute: async (invocation) => {
          toolInvocations.push(invocation)
          return { exitCode: 0, stdout: '{"ok":true,"action":"approved"}', stderr: '' }
        },
      }),
      statePathsProvider: async () => [fixture.statePath],
      commandPollIntervalMs: 10_000,
    }
  )

  await bridge.updateSettings({ enabled: true })
  await waitFor(() => relay.results.length === 8 && relay.snapshots.length === 1)
  bridge.shutdown()

  assert.equal(relay.connects.length, 1)
  assert.equal(relay.connects[0].accessToken, 'desktop-access-token')
  assert.equal(relay.connects[0].commands.includes('artifact.approve'), true)
  assert.equal(relay.connects[0].commands.includes('task.start'), true)
  assert.equal(toolInvocations.length, 2)
  assert.equal(toolInvocations[0].cwd, fixture.workspaceRoot)
  assert.equal(relay.snapshots[0].snapshot.sprintEngines[0].sprintEngineId, 'relay-team')

  const resultByCommand = new Map(relay.results.map((result) => [result.commandId, result]))
  assert.equal(resultByCommand.get('cmd_approve')?.status, 'completed')
  assert.equal(resultByCommand.get('cmd_request_changes')?.status, 'completed')
  assert.equal(resultByCommand.get('cmd_snapshot')?.status, 'completed')
  assert.equal(resultByCommand.get('cmd_snapshot')?.resultCode, 'OK')
  assert.equal(resultByCommand.get('cmd_artifact_read')?.status, 'completed')
  assert.equal(resultByCommand.get('cmd_artifact_read')?.resultCode, 'OK')
  assert.equal(resultByCommand.get('cmd_missing_device')?.resultCode, 'UNAUTHENTICATED')
  assert.equal(resultByCommand.get('cmd_revoked')?.resultCode, 'DEVICE_REVOKED')
  assert.equal(resultByCommand.get('cmd_wrong_session')?.resultCode, 'UNAUTHORIZED')
  assert.equal(resultByCommand.get('cmd_missing_capability')?.resultCode, 'UNAUTHORIZED')

  const approveAudit = resultByCommand.get('cmd_approve')?.summary.audit as Record<string, unknown>
  assert.equal(typeof approveAudit.auditId, 'string')
  assert.equal(approveAudit.commandId, 'cmd_approve')
  assert.equal(approveAudit.deviceId, 'pdv_phone_1')
  assert.equal(approveAudit.commandType, 'artifact.approve')
  assert.equal(approveAudit.status, 'accepted')
  assert.equal(approveAudit.artifactId, 'A1')
  assert.equal(approveAudit.exitCode, 0)
  assert.equal(typeof approveAudit.recordedAt, 'string')

  const requestChangesSummary = resultByCommand.get('cmd_request_changes')?.summary ?? {}
  const requestChangesAudit = requestChangesSummary.audit as Record<string, unknown>
  assert.equal(requestChangesAudit.commandId, 'cmd_request_changes')
  assert.equal(requestChangesAudit.artifactId, 'A1')
  assert.equal(JSON.stringify(requestChangesSummary).includes('Sensitive reviewer feedback.'), false)
  assert.equal(JSON.stringify(requestChangesSummary).includes(fixture.statePath), false)

  const snapshotSummary = resultByCommand.get('cmd_snapshot')?.summary ?? {}
  assert.equal(snapshotSummary.ok, true)
  assert.notDeepEqual((snapshotSummary as { data?: unknown }).data, { truncated: true })
  const snapshotValidation = validateMobileControlSnapshot((snapshotSummary as { data?: unknown }).data)
  assert.equal(snapshotValidation.ok, true, snapshotValidation.ok === false ? snapshotValidation.error.message : undefined)
  assert.equal(relaySummaryByteLength(snapshotSummary) < relayResultSummaryMaxBytes, true)

  const artifactReadSummary = resultByCommand.get('cmd_artifact_read')?.summary ?? {}
  assert.equal(artifactReadSummary.ok, true)
  assert.equal((artifactReadSummary as { data?: { content?: unknown } }).data?.content, '# Requirements\n')
}

async function assertOversizedSnapshotRequestReturnsBoundedSnapshotWithoutTruncatedSuccess(): Promise<void> {
  const fixture = await writeSprintEngineFixture({ extraTaskCount: 7000 })
  const relay = new FakeRelayTransport([
    commandDelivery('cmd_oversized_snapshot', {
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
      statePathsProvider: async () => [fixture.statePath],
      commandPollIntervalMs: 10_000,
    }
  )

  await bridge.updateSettings({ enabled: true })
  await waitFor(() => relay.results.some((result) => result.commandId === 'cmd_oversized_snapshot'))
  bridge.shutdown()

  const result = relay.results.find((candidate) => candidate.commandId === 'cmd_oversized_snapshot')
  assertBoundedSnapshotResult(result)
}

async function assertNonAsciiSnapshotRequestUsesUtf8ByteCapForBoundedSnapshot(): Promise<void> {
  const fixture = await writeSprintEngineFixture({ nonAsciiPayload: createNonAsciiPayloadBelowCharacterCapAboveByteCap() })
  const relay = new FakeRelayTransport([
    commandDelivery('cmd_non_ascii_snapshot', {
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
      statePathsProvider: async () => [fixture.statePath],
      commandPollIntervalMs: 10_000,
    }
  )

  await bridge.updateSettings({ enabled: true })
  await waitFor(() => relay.results.some((result) => result.commandId === 'cmd_non_ascii_snapshot'))
  bridge.shutdown()

  const result = relay.results.find((candidate) => candidate.commandId === 'cmd_non_ascii_snapshot')
  assertBoundedSnapshotResult(result)
}

// Item 1599: a snapshot.request that echoes the version the client already
// holds is answered with a tiny change token, not a re-shipped full snapshot;
// an absent or stale version returns the full snapshot exactly as before.
async function assertSnapshotRequestSkipsUnchangedWhenKnownVersionMatches(): Promise<void> {
  // Inflate the payload so the full snapshot is unmistakably larger than the
  // change-token result the fast-path returns.
  const fixture = await writeSprintEngineFixture({ extraTaskCount: 60 })
  const service = new MobileSprintEngineSnapshotService()

  // Build once and pin it: dispatchSnapshotRequest recomputes the snapshot on
  // every call (with a fresh wall-clock generatedAt), so a stub that returns the
  // same internal snapshot is what makes the version comparison deterministic.
  // The sanitized copy the client receives carries this same snapshotVersion.
  const built = await service.readSnapshot({ desktopSessionId: 'ses_relay_desktop', statePaths: [fixture.statePath] })
  const shippedVersion = built.snapshotVersion
  assert.equal(typeof shippedVersion, 'string')

  const snapshotService = { readSnapshot: async () => built } as unknown as MobileSprintEngineSnapshotService
  const dispatch = (payload: Record<string, unknown>) => dispatchSnapshotRequest({
    command: snapshotRequestCommand(payload),
    snapshotService,
    desktopSessionId: 'ses_relay_desktop',
    statePathsProvider: async () => [fixture.statePath],
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
  assert.equal((full.data as { sprintEngines?: unknown[] }).sprintEngines?.length, 1)
  assert.equal((stale.data as { sprintEngines?: unknown[] }).sprintEngines?.length, 1)

  // The relay ships and ledgers the summarized result, so measure that.
  const unchangedBytes = relaySummaryByteLength(summarizeCommandResult(unchanged))
  const fullBytes = relaySummaryByteLength(summarizeCommandResult(full))
  assert.equal(unchangedBytes < 512, true)
  assert.equal(fullBytes > unchangedBytes * 8, true)
  // eslint-disable-next-line no-console
  console.log(`[1599] unchanged result ${unchangedBytes} B vs full snapshot ${fullBytes} B (${(fullBytes / unchangedBytes).toFixed(1)}x)`)
}

function snapshotRequestCommand(payload: Record<string, unknown>): MobileControlCommand {
  return {
    protocolVersion: 2,
    commandId: 'cmd_conditional_snapshot',
    type: 'snapshot.request',
    issuedAt: now.toISOString(),
    deviceId: 'pdv_phone_1',
    payload,
  } as MobileControlCommand
}

function assertBoundedSnapshotResult(
  result: FakeRelayTransport['results'][number] | undefined,
): void {
  assert.equal(result?.status, 'completed')
  assert.equal(result?.resultCode, 'OK')
  assert.equal(result?.summary.ok, true)
  assert.equal(JSON.stringify(result?.summary).includes('"truncated":true'), false)
  assert.equal(relaySummaryByteLength(result?.summary) < relayResultSummaryMaxBytes, true)

  const snapshot = result?.summary.data
  const validation = validateMobileControlSnapshot(snapshot)
  assert.equal(validation.ok, true, validation.ok === false ? validation.error.message : undefined)
  assert.equal(relaySummaryByteLength(snapshot) < relayResultSummaryMaxBytes, true)
  assert.equal((snapshot as { sprintEngines?: unknown[] })?.sprintEngines?.length, 0)
  assert.deepEqual((snapshot as {
    snapshotLimits?: {
      sprintEngines?: {
        included: number
        omitted: number
        total: number
        reason: string
      }
    }
  })?.snapshotLimits?.sprintEngines, {
    included: 0,
    omitted: 1,
    total: 1,
    reason: 'relay_result_summary_size',
  })
}

async function assertMobileDeviceCannotRevokeSiblingDevice(): Promise<void> {
  const fixture = await writeSprintEngineFixture()
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
      statePathsProvider: async () => [fixture.statePath],
      commandPollIntervalMs: 10_000,
    }
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

async function assertRelayBackedMobileDeviceRevokeCommandRevokesIssuingDevice(): Promise<void> {
  const fixture = await writeSprintEngineFixture()
  const relay = new RelayServiceBackedTransport({ enqueueOwnDeviceRevoke: true })
  const bridge = new MobileBridge(
    async () => ({
      authenticated: true,
      session: { id: 'desktop-session-1', expiresAt: new Date(now.getTime() + 60_000).toISOString() },
    }),
    {
      relayUrl: 'https://relay.test',
      storePath: join(fixture.workspaceRoot, 'mobile-bridge.json'),
      accessTokenProvider: async () => relay.desktopAccessToken,
      relayTransport: relay,
      commandService: new MobileSprintEngineCommandService({
        workspaceRoot: fixture.workspaceRoot,
        statePaths: [fixture.statePath],
        now: () => now,
        execute: async () => ({ exitCode: 0, stdout: '{"ok":true,"action":"approved"}', stderr: '' }),
      }),
      statePathsProvider: async () => [fixture.statePath],
      commandPollIntervalMs: 10_000,
    }
  )

  await bridge.updateSettings({ enabled: true })
  await waitFor(() => relay.results.some((result) => result.commandId === 'cmd_relay_service_device_revoke'))
  bridge.shutdown()

  const result = relay.results.find((candidate) => candidate.commandId === 'cmd_relay_service_device_revoke')
  assert.equal(result?.status, 'completed')
  assert.equal(result?.resultCode, 'OK')
  assert.deepEqual((result?.summary as { data?: unknown }).data, { revoked: true, deviceId: relay.pairedDeviceId })
  await relay.assertRecreatedRelayRejectsRevokedDevice()
}

async function assertDesktopRevocationUpdatesRelayAuthority(): Promise<void> {
  const fixture = await writeSprintEngineFixture()
  const relay = new RelayServiceBackedTransport()
  const bridge = new MobileBridge(
    async () => ({
      authenticated: true,
      session: { id: 'desktop-session-1', expiresAt: new Date(now.getTime() + 60_000).toISOString() },
    }),
    {
      relayUrl: 'https://relay.test',
      storePath: join(fixture.workspaceRoot, 'mobile-bridge.json'),
      accessTokenProvider: async () => relay.desktopAccessToken,
      relayTransport: relay,
      commandService: new MobileSprintEngineCommandService({
        workspaceRoot: fixture.workspaceRoot,
        statePaths: [fixture.statePath],
        now: () => now,
        execute: async () => ({ exitCode: 0, stdout: '{"ok":true,"action":"approved"}', stderr: '' }),
      }),
      statePathsProvider: async () => [fixture.statePath],
      commandPollIntervalMs: 10_000,
    }
  )

  await bridge.updateSettings({ enabled: true })
  await waitFor(() => relay.results.some((result) => result.commandId === 'cmd_relay_service_approve'))
  const revokedDevice = await bridge.revokeDevice(relay.pairedDeviceId, 'Lost phone')
  bridge.shutdown()

  assert.equal(revokedDevice.revokedAt !== undefined, true)
  await relay.assertRecreatedRelayRejectsRevokedDevice()
}

async function assertRelayServiceDeliveriesDispatchAndRecordResults(): Promise<void> {
  const fixture = await writeSprintEngineFixture()
  const toolInvocations: Array<{ args: string[]; cwd: string }> = []
  const relay = new RelayServiceBackedTransport()
  const bridge = new MobileBridge(
    async () => ({
      authenticated: true,
      session: { id: 'desktop-session-1', expiresAt: new Date(now.getTime() + 60_000).toISOString() },
    }),
    {
      relayUrl: 'https://relay.test',
      storePath: join(fixture.workspaceRoot, 'mobile-bridge.json'),
      accessTokenProvider: async () => relay.desktopAccessToken,
      relayTransport: relay,
      commandService: new MobileSprintEngineCommandService({
        workspaceRoot: fixture.workspaceRoot,
        statePaths: [fixture.statePath],
        now: () => now,
        execute: async (invocation) => {
          toolInvocations.push(invocation)
          return { exitCode: 0, stdout: '{"ok":true,"action":"approved"}', stderr: '' }
        },
      }),
      statePathsProvider: async () => [fixture.statePath],
      commandPollIntervalMs: 10_000,
    }
  )

  await bridge.updateSettings({ enabled: true })
  await waitFor(() => relay.results.some((result) => result.commandId === 'cmd_relay_service_approve'))
  bridge.shutdown()

  assert.equal(toolInvocations.length, 1)
  assert.equal(relay.results[0].status, 'completed')
  assert.equal(relay.results[0].resultCode, 'OK')
  await assert.rejects(
    () => relay.enqueueDifferentCommandWithSameIdempotencyKey(),
    (error) => error && typeof error === 'object' && 'code' in error && error.code === 'IDEMPOTENCY_CONFLICT'
  )
}

// Item 1598, acceptance 1: an enabled+configured bridge with zero paired devices must
// hold no relay session and issue no requests — no connect, no command poll — however
// long it sits enabled. Proven by counting transport calls across several base intervals.
async function assertEnabledBridgeWithNoPairedDevicesIssuesNoRelayTraffic(): Promise<void> {
  const fixture = await writeSprintEngineFixture({ pairDevice: false })
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
      statePathsProvider: async () => [fixture.statePath],
      commandPollIntervalMs: 250,
    }
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
  const fixture = await writeSprintEngineFixture()
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
      statePathsProvider: async () => [fixture.statePath],
      commandPollIntervalMs: 250,
      commandPollCeilingMs: 1000,
      // Wide enough that the post-command snap-back to fast is reliably observable
      // (snapshot dispatch fits inside it), small enough that decay reaches the
      // ceiling well within the state timeout.
      commandPollAttentionWindowMs: 200,
    }
  )

  await bridge.updateSettings({ enabled: true })
  // Quiet: interval doubles 250 -> 500 -> 1000 and holds at the ceiling.
  await waitForState(bridge, (state) =>
    state.commandPollCadence.state === 'decayed' && state.commandPollCadence.intervalMs === 1000
  )

  // A delivered command snaps the cadence back to fast within one ceiling interval.
  relay.queue(commandDelivery('cmd_backoff_snap', {
    desktopRelaySessionId: 'drs_desktop_1',
    commandType: 'snapshot.request',
    payload: {},
    device: pairedDevice({ scopes: ['relay:snapshot:read'] }),
  }))
  await waitForState(bridge, (state) =>
    state.commandPollCadence.state === 'fast' && state.commandPollCadence.intervalMs === 250
  )
  bridge.shutdown()
}

// Item 1598: revoking the last active device stops the poll loop and drops the bridge
// to idle — no further relay traffic — instead of holding the old flat cadence.
async function assertRevokingLastDeviceStopsPollingAndGoesIdle(): Promise<void> {
  const fixture = await writeSprintEngineFixture()
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
      statePathsProvider: async () => [fixture.statePath],
      commandPollIntervalMs: 500,
    }
  )

  await bridge.updateSettings({ enabled: true })
  await waitForState(bridge, (state) =>
    state.relayStatus === 'connected' && state.commandPollCadence.state !== 'paused'
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
  const fixture = await writeSprintEngineFixture({ pairDevice: false })
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
      statePathsProvider: async () => [fixture.statePath],
      commandPollIntervalMs: 500,
    }
  )

  await bridge.updateSettings({ enabled: true })
  await bridge.requestPairingCode()
  const state = await bridge.getState()
  bridge.shutdown()

  assert.equal(relay.connects.length, 1)
  assert.equal(state.relayStatus, 'connected')
  assert.notEqual(state.commandPollCadence.state, 'paused')
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
  readonly snapshots: Array<{ snapshot: { sprintEngines: Array<{ sprintEngineId: string }> } }> = []
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
        mobileControlProtocolVersion: 2 as const,
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

class RelayServiceBackedTransport implements MobileRelayTransport {
  readonly results: Array<{
    commandId: string
    status: 'completed' | 'failed'
    resultCode: string
    summary: Record<string, unknown>
  }> = []
  private readonly auth: { tokens: { issueAccessToken(input: Record<string, unknown>): string } }
  private readonly relay: {
    connectDesktop(input: Record<string, unknown>): Promise<{
      desktopRelaySessionId: string
      relayToken: string
      expiresAt: string
      heartbeatAfterSeconds: number
    }>
    createPairingChallenge(input: Record<string, unknown>): Promise<{ pairingUri: string }>
    pairMobile(input: Record<string, unknown>): Promise<{ pairedDeviceId: string; relayToken: string }>
    mintRelayToken(input: Record<string, unknown>): Promise<unknown>
    enqueueCommand(input: Record<string, unknown>): Promise<unknown>
    listPendingCommands(input: Record<string, unknown>): Promise<{ commands: Awaited<ReturnType<MobileRelayTransport['listPendingCommands']>> }>
    recordCommandResult(input: Record<string, unknown>): Promise<unknown>
    revokeDevice(input: Record<string, unknown>): Promise<{ revoked: true }>
  }
  private readonly requestedScopes: MobileRelayScope[]
  private desktopRelayToken = ''
  private mobileRelayToken = ''
  private desktopRelaySessionId = ''
  private pairedDeviceIdValue = ''
  private readonly relayStore: unknown
  private readonly enqueueOwnDeviceRevoke: boolean

  constructor(options: { enqueueOwnDeviceRevoke?: boolean } = {}) {
    this.enqueueOwnDeviceRevoke = options.enqueueOwnDeviceRevoke === true
    this.requestedScopes = this.enqueueOwnDeviceRevoke
      ? ['relay:artifact:review', 'relay:device:revoke']
      : ['relay:artifact:review']
    const { AuthService } = require('../../../../../multiauth/src/auth') as {
      AuthService: new (input: Record<string, unknown>) => RelayServiceBackedTransport['auth']
    }
    const { RelayService } = require('../../../../../multiauth/src/relay') as {
      RelayService: new (input: Record<string, unknown>) => RelayServiceBackedTransport['relay']
    }
    const { EntitlementResolver } = require('../../../../../multiauth/src/entitlements') as {
      EntitlementResolver: new (reader: unknown, now: () => Date) => unknown
    }
    const {
      MemoryAuthStore,
      MemoryRelayStore,
      entitlementReaderForPlans,
    } = require('../../../../../multiauth/tests/support/memory-stores') as {
      MemoryAuthStore: new () => unknown
      MemoryRelayStore: new () => unknown
      entitlementReaderForPlans: (plans: Record<string, string>) => unknown
    }
    const authStore = new MemoryAuthStore()
    this.auth = new AuthService({
      issuer: 'https://auth.multiverse.local',
      sessionSecret: 'test-session-secret',
      store: authStore,
      now: () => now,
    })
    this.relayStore = new MemoryRelayStore()
    this.relay = new RelayService({
      authService: this.auth,
      entitlementResolver: new EntitlementResolver(
        entitlementReaderForPlans({ org_seed_pro_personal: 'team' }),
        () => now
      ),
      store: this.relayStore,
      now: () => now,
    })
  }

  get desktopAccessToken(): string {
    return this.auth.tokens.issueAccessToken({
      audience: 'multicode-desktop',
      userId: 'usr_seed_pro',
      sessionId: 'ses_seed_usr_seed_pro',
      organizationId: 'org_seed_pro_personal',
      scope: ['relay:desktop'],
      lifetimeSeconds: 600,
    })
  }

  get pairedDeviceId(): string {
    return this.pairedDeviceIdValue
  }

  private get mobileAccessToken(): string {
    return this.auth.tokens.issueAccessToken({
      audience: 'multicode-mobile',
      userId: 'usr_seed_pro',
      sessionId: 'ses_seed_usr_seed_pro',
      organizationId: 'org_seed_pro_personal',
      scope: ['relay:pair'],
      lifetimeSeconds: 600,
    })
  }

  async connectDesktop(input: Parameters<MobileRelayTransport['connectDesktop']>[0]) {
    const desktop = await this.relay.connectDesktop({
      accessToken: input.accessToken,
      desktopInstanceId: input.desktopInstanceId,
      displayName: input.displayName,
      capabilities: {
        mobileControlProtocolVersion: 2,
        commands: input.commands,
      },
    })
    this.desktopRelayToken = desktop.relayToken
    this.desktopRelaySessionId = desktop.desktopRelaySessionId

    const challenge = await this.relay.createPairingChallenge({
      relayToken: desktop.relayToken,
      desktopRelaySessionId: desktop.desktopRelaySessionId,
      requestedScopes: this.requestedScopes,
      relayUrl: input.relayUrl,
    })
    const paired = await this.relay.pairMobile({
      accessToken: this.mobileAccessToken,
      pairingSecret: secretFromPairingUri(challenge.pairingUri),
      deviceName: 'Relay service phone',
      platform: 'ios',
      devicePublicKey: 'relay-service-phone-key',
    })
    this.pairedDeviceIdValue = paired.pairedDeviceId as string
    this.mobileRelayToken = paired.relayToken
    await this.enqueueApproveCommand()
    if (this.enqueueOwnDeviceRevoke) {
      await this.enqueueOwnDeviceRevokeCommand()
    }

    return desktop
  }

  async createPairingChallenge(_input: Parameters<MobileRelayTransport['createPairingChallenge']>[0]) {
    return {
      pairingChallengeId: 'unused',
      pairingUri: 'multicode://mobile/pair?secret=unused',
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    }
  }

  async listPendingCommands(_input: Parameters<MobileRelayTransport['listPendingCommands']>[0]) {
    const response = await this.relay.listPendingCommands({
      relayToken: this.desktopRelayToken,
      desktopRelaySessionId: this.desktopRelaySessionId,
    })
    return response.commands
  }

  async postCommandResult(input: Parameters<MobileRelayTransport['postCommandResult']>[0]) {
    await this.relay.recordCommandResult({
      relayToken: this.desktopRelayToken,
      commandId: input.commandId,
      status: input.status,
      resultCode: input.resultCode,
      summary: input.summary,
    })
    this.results.push({
      commandId: input.commandId,
      status: input.status,
      resultCode: input.resultCode,
      summary: input.summary,
    })
  }

  async revokeDevice(input: Parameters<MobileRelayTransport['revokeDevice']>[0]) {
    return this.relay.revokeDevice({
      accessToken: input.accessToken,
      deviceId: input.deviceId,
      reason: input.reason,
    })
  }

  async assertRecreatedRelayRejectsRevokedDevice(): Promise<void> {
    const restartedRelay = this.recreateRelayService()
    await assert.rejects(
      () => restartedRelay.mintRelayToken({
        accessToken: this.mobileAccessToken,
        pairedDeviceId: this.pairedDeviceId,
        requestedScopes: ['relay:artifact:review'],
      }),
      (error) => error && typeof error === 'object' && 'status' in error && error.status === 403
    )
    await assert.rejects(
      () => restartedRelay.enqueueCommand({
        relayToken: this.mobileRelayToken,
        idempotencyKey: 'idem-after-desktop-revocation',
        envelope: {
          desktopRelaySessionId: this.desktopRelaySessionId,
          commandId: 'cmd_after_desktop_revoke',
          commandType: 'artifact.approve',
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 30_000).toISOString(),
          payload: { sprintEngineId: 'relay-team', artifactId: 'A1' },
        },
      }),
      (error) => error && typeof error === 'object' && 'status' in error && error.status === 403
    )
  }

  private recreateRelayService(): RelayServiceBackedTransport['relay'] {
    const { RelayService } = require('../../../../../multiauth/src/relay') as {
      RelayService: new (input: Record<string, unknown>) => RelayServiceBackedTransport['relay']
    }
    return new RelayService({
      authService: this.auth,
      entitlementResolver: this.entitlementResolver(),
      store: this.relayStore,
      now: () => now,
    })
  }

  private entitlementResolver(): unknown {
    const { EntitlementResolver } = require('../../../../../multiauth/src/entitlements') as {
      EntitlementResolver: new (reader: unknown, now: () => Date) => unknown
    }
    const { entitlementReaderForPlans } = require('../../../../../multiauth/tests/support/memory-stores') as {
      entitlementReaderForPlans: (plans: Record<string, string>) => unknown
    }
    return new EntitlementResolver(
      entitlementReaderForPlans({ org_seed_pro_personal: 'team' }),
      () => now
    )
  }

  async enqueueDifferentCommandWithSameIdempotencyKey(): Promise<void> {
    await this.relay.enqueueCommand({
      relayToken: this.mobileRelayToken,
      idempotencyKey: 'idem-relay-service-approve',
      envelope: {
        desktopRelaySessionId: this.desktopRelaySessionId,
        commandId: 'cmd_relay_service_approve',
        commandType: 'artifact.approve',
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30_000).toISOString(),
        payload: { sprintEngineId: 'relay-team', artifactId: 'A2' },
      },
    })
  }

  private async enqueueApproveCommand(): Promise<void> {
    await this.relay.enqueueCommand({
      relayToken: this.mobileRelayToken,
      idempotencyKey: 'idem-relay-service-approve',
      envelope: {
        desktopRelaySessionId: this.desktopRelaySessionId,
        commandId: 'cmd_relay_service_approve',
        commandType: 'artifact.approve',
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30_000).toISOString(),
        payload: { sprintEngineId: 'relay-team', artifactId: 'A1' },
      },
    })
  }

  private async enqueueOwnDeviceRevokeCommand(): Promise<void> {
    await this.relay.enqueueCommand({
      relayToken: this.mobileRelayToken,
      idempotencyKey: 'idem-relay-service-device-revoke',
      envelope: {
        desktopRelaySessionId: this.desktopRelaySessionId,
        commandId: 'cmd_relay_service_device_revoke',
        commandType: 'device.revoke',
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30_000).toISOString(),
        payload: { deviceId: this.pairedDeviceId, reason: 'Lost phone' },
      },
    })
  }
}

async function writeSprintEngineFixture(
  options: { extraTaskCount?: number; nonAsciiPayload?: string; pairDevice?: boolean } = {}
): Promise<{ workspaceRoot: string; statePath: string }> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-bridge-'))
  const teamDirectory = join(workspaceRoot, '.multi-code', 'sprintengine', 'relay-team')
  await mkdir(join(teamDirectory, 'documents'), { recursive: true })
  await writeFile(join(teamDirectory, 'documents', 'requirements.md'), '# Requirements\n', 'utf8')
  const statePath = join(teamDirectory, 'run.yaml')
  await writeFile(statePath, 'managed sprintengine fixture\n', 'utf8')
  await writeFile(join(teamDirectory, 'projection.json'), `${JSON.stringify({
    ok: true,
    projectionVersion: 1,
    source: 'folder_store',
    updatedAt: now.toISOString(),
    run: {
      id: 'relay-team',
      name: 'relay-team',
      updatedAt: now.toISOString(),
    },
    tasks: [
      {
        id: 'T1',
        title: options.nonAsciiPayload ?? 'Ready task',
        role: 'developer',
        status: 'ready',
        stateStatus: 'todo',
        ownerAgentId: null,
        dependsOn: [],
      },
      ...Array.from({ length: options.extraTaskCount ?? 0 }, (_, index) => ({
        id: `TS${index}`,
        title: `Snapshot sizing task ${index}`,
        role: 'developer',
        status: 'ready',
        stateStatus: 'todo',
        ownerAgentId: null,
        dependsOn: [],
      })),
    ],
    artifacts: [
      {
        id: 'A1',
        kind: 'requirements',
        title: 'Requirements',
        path: '.multi-code/sprintengine/relay-team/documents/requirements.md',
        status: 'ready_for_review',
        taskId: 'T1',
      },
    ],
    roster: {},
  }, null, 2)}\n`, 'utf8')
  // Command polling is now gated on an active paired device, so fixtures that drive
  // the bridge through connect/poll seed one by default. Pairing-flow tests pass
  // `pairDevice: false` to exercise the idle → connect-on-demand path.
  if (options.pairDevice !== false) {
    await writeFile(join(workspaceRoot, 'mobile-bridge.json'), `${JSON.stringify({
      enabled: false,
      relayUrl: null,
      desktopInstanceId: 'mdi_fixture',
      pairedDevices: [{
        protocolVersion: 2,
        deviceId: 'pdv_seed',
        displayName: 'Seeded phone',
        platform: 'ios',
        appVersion: '1.0.0',
        pairedAt: now.toISOString(),
        capabilities: [],
      }],
      pushRegistrations: [],
    }, null, 2)}\n`, 'utf8')
  }
  return { workspaceRoot, statePath }
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
    commandType: 'snapshot.request' | 'artifact.read' | 'artifact.approve' | 'artifact.requestChanges' | 'task.start' | 'device.revoke'
    payload: Record<string, unknown>
    device: MobileRelayAuthenticatedDevice | null
  }
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

function secretFromPairingUri(pairingUri: string): string {
  const params = new URL(pairingUri).searchParams
  const secret = params.get('pairingSecret') ?? params.get('secret')
  if (!secret) {
    throw new Error('Pairing URI did not include a secret.')
  }
  return secret
}

function installPgStubForMultiauthMemoryStoreTests(): void {
  const nodeRequire = createRequire(__filename)
  const moduleLoader = nodeRequire('node:module') as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown
  }
  const originalLoad = moduleLoader._load

  moduleLoader._load = (request, parent, isMain) => {
    if (request === 'pg') {
      class Pool {
        async query(): Promise<never> {
          throw new Error('Postgres is not available in mobile bridge memory-store tests.')
        }

        async end(): Promise<void> {
          return undefined
        }
      }
      const pg = { Pool }
      return { ...pg, default: pg }
    }
    return originalLoad(request, parent, isMain)
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
