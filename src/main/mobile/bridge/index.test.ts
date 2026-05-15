import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MobileBridge, type MobileRelayTransport, type MobileRelayAuthenticatedDevice } from './index'
import { MobileSprintEngineCommandService } from '../sprintengine/command'

const now = new Date('2026-04-28T22:00:00.000Z')

installPgStubForMultiauthMemoryStoreTests()

void main()

async function main(): Promise<void> {
  await assertDesktopPairingDisplayUsesCurrentRelayPayload()
  await assertDesktopPairingDisplayRejectsLegacyRelayChallenge()
  await assertAuthenticatedRelayTransportDispatchesAndFailsClosed()
  await assertRelayServiceDeliveriesDispatchAndRecordResults()
  await assertDesktopRevocationUpdatesRelayAuthority()
}

async function assertDesktopPairingDisplayUsesCurrentRelayPayload(): Promise<void> {
  const fixture = await writeSprintEngineFixture()
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

  await bridge.updateSettings({ enabled: true })
  await waitFor(() => relay.connects.length === 1)
  const challenge = await bridge.requestPairingCode()
  bridge.shutdown()

  const displayedValue = new URL(challenge.pairingCode)
  assert.equal(displayedValue.searchParams.get('mobileControlProtocolVersion'), '1')
  assert.equal(displayedValue.searchParams.get('pairingChallengeId'), 'pcha_current')
  assert.equal(displayedValue.searchParams.get('relayUrl'), 'https://relay.test')
  assert.equal(displayedValue.searchParams.get('pairingSecret'), 'psec_current')
  assert.equal(displayedValue.searchParams.get('secret'), null)
  assert.equal(displayedValue.searchParams.get('expiresAt'), new Date(now.getTime() + 60_000).toISOString())
  assert.equal(displayedValue.searchParams.get('desktopName'), 'Relay desktop')
  assert.equal(displayedValue.searchParams.get('desktopInstanceId'), 'desktop-instance-current')
  assert.equal(displayedValue.searchParams.get('desktopRelaySessionId'), 'drs_desktop_1')
  assert.equal(challenge.pairingCode.includes('psec_current'), true)
  assert.notEqual(challenge.pairingCode, challenge.pairingUri)
  assert.equal(challenge.pairingUri.includes('pairingSecret=psec_current'), true)
}

async function assertDesktopPairingDisplayRejectsLegacyRelayChallenge(): Promise<void> {
  const fixture = await writeSprintEngineFixture()
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

  await bridge.updateSettings({ enabled: true })
  await waitFor(() => relay.connects.length === 1)
  await assert.rejects(
    () => bridge.requestPairingCode(),
    /Relay pairing challenge did not include a mobile-compatible pairing payload/u
  )
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
  await waitFor(() => relay.results.length === 6 && relay.snapshots.length === 1)
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
  assert.equal(approveAudit.statePath, fixture.statePath)
  assert.equal(approveAudit.artifactId, 'A1')
  assert.equal(approveAudit.exitCode, 0)
  assert.equal(typeof approveAudit.recordedAt, 'string')

  const requestChangesSummary = resultByCommand.get('cmd_request_changes')?.summary ?? {}
  const requestChangesAudit = requestChangesSummary.audit as Record<string, unknown>
  assert.equal(requestChangesAudit.commandId, 'cmd_request_changes')
  assert.deepEqual(requestChangesAudit.toolArgs, [
    '--state',
    fixture.statePath,
    'artifact',
    'request-changes',
    '--artifact-id',
    'A1',
    '--id',
    'mobile:pdv_phone_1',
    '--feedback',
    '[redacted]',
  ])
  assert.equal(JSON.stringify(requestChangesSummary).includes('Sensitive reviewer feedback.'), false)
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

class FakeRelayTransport implements MobileRelayTransport {
  readonly connects: Array<{ accessToken: string; commands: string[] }> = []
  readonly results: Array<{
    commandId: string
    status: 'completed' | 'failed'
    resultCode: string
    summary: Record<string, unknown>
  }> = []
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

  async revokeDevice(_input: Parameters<MobileRelayTransport['revokeDevice']>[0]) {
    return { revoked: true as const }
  }

  async publishSnapshot(input: Parameters<NonNullable<MobileRelayTransport['publishSnapshot']>>[0]) {
    this.snapshots.push({ snapshot: input.snapshot })
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
        mobileControlProtocolVersion: 1 as const,
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
  private readonly requestedScopes = ['relay:artifact:review']
  private desktopRelayToken = ''
  private mobileRelayToken = ''
  private desktopRelaySessionId = ''
  private pairedDeviceIdValue = ''
  private readonly relayStore: unknown

  constructor() {
    const { AuthService, MemoryAuthStore } = require('../../../../../multiauth/src/auth') as {
      AuthService: new (input: Record<string, unknown>) => RelayServiceBackedTransport['auth']
      MemoryAuthStore: new () => unknown
    }
    const { MemoryRelayStore, RelayService } = require('../../../../../multiauth/src/relay') as {
      MemoryRelayStore: new () => unknown
      RelayService: new (input: Record<string, unknown>) => RelayServiceBackedTransport['relay']
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
        mobileControlProtocolVersion: 1,
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
      store: this.relayStore,
      now: () => now,
    })
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
}

async function writeSprintEngineFixture(): Promise<{ workspaceRoot: string; statePath: string }> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-bridge-'))
  const teamDirectory = join(workspaceRoot, '.multi-code', 'sprintengine', 'relay-team')
  await mkdir(join(teamDirectory, 'documents'), { recursive: true })
  await writeFile(join(teamDirectory, 'documents', 'requirements.md'), '# Requirements\n', 'utf8')
  const statePath = join(teamDirectory, 'state.yaml')
  await writeFile(statePath, `${JSON.stringify({
    sprintengine: {
      name: 'relay-team',
      updatedAt: now.toISOString(),
    },
    tasks: [
      {
        id: 'T1',
        title: 'Ready task',
        role: 'developer',
        status: 'todo',
        ownerAgentId: null,
        dependsOn: [],
      },
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
  }, null, 2)}\n`, 'utf8')
  return { workspaceRoot, statePath }
}

function commandDelivery(
  commandId: string,
  input: {
    desktopRelaySessionId: string
    commandType: 'artifact.approve' | 'artifact.requestChanges' | 'task.start'
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
