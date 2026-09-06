import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TerminalSessionSnapshot } from '../../shared/electron-api'
import { toolSuccess, type McpToolRegistration } from '../../shared/modules/mcp-tools'
import type { TailnetScope } from '../../shared/tailnet'
import type { FleetEvent, FleetTerminalEvent } from '../../shared/tailnet-fleet'
import type { TerminalAttachTransport, TerminalRemoteHost } from '../terminal-remote-attach'
import { createTailnetDeviceStore, type TailnetDeviceStore } from './tailnet/tailnet-devices'
import { createTailnetFleetService, type TailnetFleetService } from './tailnet/tailnet-fleet-service'
import { TAILNET_FLEET_FILENAME } from './tailnet/tailnet-fleet-store'
import { createTailnetGatewayServer, type TailnetGatewayServer } from './tailnet/tailnet-gateway-server'
import { createTailnetPeerResolver } from './tailnet/tailnet-peer-identity'
import { pairingUrl } from './tailnet/tailnet-service'
import { parseTailnetEndpoint } from './tailnet/tailnet-remote-client'

// The Fleet client (MC-2167): this Studio driving another machine.
//
// Every test drives the REAL listener over a real TCP socket on loopback, with
// the real outbound client, the real pairing exchange, and the real attach
// WebSocket. The thing under test IS the wire between two machines, so a fake
// on either side would prove nothing about it.

const MUTATIONS = new Set(['terminal.create', 'agent.launch'])

// What the remote's terminal.create actually received, per call.
const terminalCreateArgs: Array<Record<string, unknown>> = []
// And agent.launch — the worktree route (checkout-and-branch-on-remote-create).
const agentLaunchArgs: Array<Record<string, unknown>> = []

type Harness = {
  server: TailnetGatewayServer
  devices: TailnetDeviceStore
  port: number
  remoteDir: string
  localDir: string
  fleet: TailnetFleetService
  terminals: StubTerminalHost
  /** Every whole-app fleet event the service broadcast, in order. */
  events: FleetEvent[]
  /** Pair the fleet service with the harness's listener under the given scopes. */
  pair(scopes: TailnetScope[]): Promise<string>
  /** Stop the listener, leaving the client dialling a dead port. */
  stopServer(): Promise<void>
  /** Bring an identical listener back on the SAME port, as a machine waking would. */
  restartServer(): Promise<void>
  close(): Promise<void>
}

async function startHarness(): Promise<Harness> {
  const remoteDir = mkdtempSync(join(tmpdir(), 'multicode-fleet-remote-'))
  const localDir = mkdtempSync(join(tmpdir(), 'multicode-fleet-local-'))
  const devices = createTailnetDeviceStore({ resolveUserDataDir: () => remoteDir })
  const terminals = createStubTerminalHost()

  const build = (port: number): TailnetGatewayServer =>
    createTailnetGatewayServer({
      bindAddress: '127.0.0.1',
      port,
      serverName: 'sprintengine-studio',
      serverVersion: '9.9.9',
      resolveTools: () => remoteTools(),
      isMutation: (name) => MUTATIONS.has(name),
      devices,
      terminals,
      // whois is injected: these tests must not depend on a Tailscale install.
      peers: createTailnetPeerResolver({ runWhois: async () => null }),
    })

  let server = build(0)
  await server.start()
  const address = server.address()
  assert.ok(address, 'the harness listener reports a bound address')
  const port = address.port

  const events: FleetEvent[] = []
  const fleet = createTailnetFleetService({
    resolveUserDataDir: () => localDir,
    resolveDeviceName: () => 'laptop',
    // No Tailscale in a test, so no name: the machine is listed by address, and
    // the point is that this degrades rather than blocking the pairing.
    resolvePeerName: async () => null,
    onEvent: (event) => events.push(event),
  })

  return {
    get server() {
      return server
    },
    devices,
    port,
    remoteDir,
    localDir,
    fleet,
    terminals,
    events,
    async pair(scopes): Promise<string> {
      const offer = devices.offerPairing({ scopes })
      const result = await fleet.pair({ pairingUrl: pairingUrl('127.0.0.1', port, offer.token) })
      assert.equal(result.ok, true, result.ok ? '' : result.message)
      assert.ok(result.ok)
      return result.connection.id
    },
    async stopServer(): Promise<void> {
      await server.stop()
    },
    async restartServer(): Promise<void> {
      server = build(port)
      await server.start()
    },
    async close(): Promise<void> {
      fleet.shutdown()
      await server.stop().catch(() => {})
      rmSync(remoteDir, { recursive: true, force: true })
      rmSync(localDir, { recursive: true, force: true })
    },
  }
}

/** The remote machine's tool surface, answering the shapes the Fleet reads. */
function remoteTools(): McpToolRegistration[] {
  void terminalCreateArgs
  const tool = (name: string, structured: Record<string, unknown>): McpToolRegistration => ({
    name,
    description: `Test tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => toolSuccess({ ok: true, ...structured }),
  })
  return [
    tool('workspace.list', {
      workspaces: [
        {
          id: 'ws-1',
          name: 'Atlas',
          mode: 'code',
          folderPath: '/repos/atlas',
          repository: { canonicalKey: 'github.com/acme/atlas', remoteUrl: 'git@github.com:acme/atlas.git', name: 'atlas' },
        },
        // An older build, or a folder with no remote: no identity, still a workspace.
        { id: 'ws-2', name: 'Scratch', mode: 'code', folderPath: '/repos/scratch' },
      ],
    }),
    tool('terminal.list', {
      terminals: [
        {
          sessionId: 'session_one',
          kind: 'agent',
          workspaceId: 'ws-1',
          agentName: 'Scout',
          cli: 'claude-code',
          cwd: '/repos/atlas',
          processAlive: true,
          suspended: false,
          agentState: { phase: 'working', source: 'hook', since: 0 },
        },
      ],
    }),
    tool('sprint.list', { runs: [{ slug: 'nightly', statePath: '.multi-code/sprintengine/nightly/run.yaml' }] }),
    tool('workspace.checkout', {
      workspaceId: 'ws-1',
      git: true,
      branch: 'main',
      defaultBranch: 'main',
      branches: [{ name: 'feat/x', current: false }, { name: 'main', current: true }],
      worktrees: [{ path: '/repos/atlas', branch: 'main', isMain: true }],
    }),
    {
      name: 'agent.launch',
      description: 'Test tool agent.launch',
      inputSchema: { type: 'object', properties: {} },
      handler: async (args: Record<string, unknown>) => {
        agentLaunchArgs.push(args)
        return toolSuccess({
          ok: true,
          agent: {
            workspaceId: 'ws-1',
            agentId: 'agent-3',
            name: 'Bishop',
            terminal: { sessionId: 'session_three', processAlive: true },
          },
          worktreePath: '/repos/.multicode-worktrees/atlas/fix',
          worktreeBranch: 'agent/fix',
        })
      },
    },
    {
      name: 'terminal.create',
      description: 'Test tool terminal.create',
      inputSchema: { type: 'object', properties: {} },
      // Records what the wire actually carried, so the launch-identity
      // pass-through (remote-sessions-ux / new-chat-on-a-remote-machine) is
      // asserted against the request the remote REALLY received.
      handler: async (args: Record<string, unknown>) => {
        terminalCreateArgs.push(args)
        return toolSuccess({
          ok: true,
          sessionId: 'session_two',
          workspaceId: 'ws-1',
          agentId: 'agent-2',
          terminal: { sessionId: 'session_two', agentName: 'Rook' },
        })
      },
    },
  ]
}

type StubTerminalHost = TerminalRemoteHost & {
  writes: Array<{ sessionId: string; data: string }>
  resizes: Array<{ sessionId: string; cols: number; rows: number }>
  emit(sessionId: string, data: string): void
  create(sessionId: string): void
  attachedCount(): number
}

function createStubTerminalHost(): StubTerminalHost {
  const replay = new Map<string, string>([['session_one', 'scrollback so far\r\n']])
  const attached = new Map<string, { sessionId: string; transport: TerminalAttachTransport }>()
  const writes: Array<{ sessionId: string; data: string }> = []
  const resizes: Array<{ sessionId: string; cols: number; rows: number }> = []

  const snapshotFor = (sessionId: string): TerminalSessionSnapshot =>
    ({
      sessionId,
      processAlive: true,
      kind: 'agent',
      agentName: 'Scout',
      cli: 'claude-code',
      cwd: '/repos/atlas',
      visible: true,
      suspended: false,
      activity: { kind: 'working', since: 0 },
    }) as unknown as TerminalSessionSnapshot

  return {
    writes,
    resizes,
    attachedCount: () => attached.size,
    create(sessionId) {
      replay.set(sessionId, '')
    },
    emit(sessionId, data) {
      replay.set(sessionId, `${replay.get(sessionId) ?? ''}${data}`)
      for (const viewer of attached.values()) {
        if (viewer.sessionId === sessionId && viewer.transport.isOpen()) {
          viewer.transport.send({ type: 'output', data })
        }
      }
    },
    listSessions: () => [...replay.keys()].map(snapshotFor),
    attach({ sessionId, scope, transport }) {
      if (!replay.has(sessionId)) {
        return { ok: false, code: 'unknown_terminal', message: `No terminal session "${sessionId}".` }
      }
      attached.set(transport.viewerId, { sessionId, transport })
      transport.send({ type: 'replay', data: replay.get(sessionId) ?? '', reason: 'attach' })
      const refuse = (verb: string) =>
        ({ ok: false as const, code: 'terminal_control_required', message: `Watch-only: cannot ${verb}.` })
      return {
        ok: true,
        attachment: {
          sessionId,
          scope,
          session: snapshotFor(sessionId),
          write: (data) => {
            if (scope !== 'control') return refuse('type')
            writes.push({ sessionId, data })
            return { ok: true }
          },
          resize: (cols, rows) => {
            if (scope !== 'control') return refuse('resize')
            resizes.push({ sessionId, cols, rows })
            return { ok: true }
          },
          detach: () => {
            attached.delete(transport.viewerId)
          },
        },
      }
    },
  }
}

/** A pane's event sink, with the waiting a real pane does implicitly. */
function createRecorder() {
  const events: FleetTerminalEvent[] = []
  const waiters: Array<{ match: (event: FleetTerminalEvent) => boolean; resolve: (event: FleetTerminalEvent) => void }> = []
  return {
    events,
    emit(event: FleetTerminalEvent): void {
      events.push(event)
      for (const waiter of [...waiters]) {
        if (!waiter.match(event)) continue
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(event)
      }
    },
    /** Resolve with the first matching event, past or future. */
    async waitFor(match: (event: FleetTerminalEvent) => boolean, what: string): Promise<FleetTerminalEvent> {
      const seen = events.find(match)
      if (seen) return seen
      return new Promise<FleetTerminalEvent>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 20_000)
        waiters.push({
          match,
          resolve: (event) => {
            clearTimeout(timer)
            resolve(event)
          },
        })
      })
    },
  }
}

const failures: string[] = []
const queued: Array<{ name: string; run: () => Promise<void> }> = []

/** Queued rather than awaited: the bundle these tests run as is CJS, which has no top-level await. */
function test(name: string, run: () => Promise<void>): void {
  queued.push({ name, run })
}

// A pairing link from another machine's Settings is redeemed over the real
// listener, and what comes back is a credential this machine keeps — at 0600,
// and never where a window could read it.
test('pairing with a machine stores a usable credential and never exposes it', async () => {
  const harness = await startHarness()
  try {
    const connectionId = await harness.pair(['workspace:read', 'terminal:control'])
    const listed = harness.fleet.listConnections()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, connectionId)
    assert.equal(listed[0].endpoint, `127.0.0.1:${harness.port}`)
    assert.deepEqual(listed[0].scopes, ['workspace:read', 'terminal:control'])
    // The public view is what IPC returns; a token in it would be a token in
    // the renderer.
    assert.equal('deviceToken' in listed[0], false)

    const storePath = join(harness.localDir, TAILNET_FLEET_FILENAME)
    const stored = JSON.parse(readFileSync(storePath, 'utf8')) as { connections: Array<{ deviceToken: string }> }
    assert.equal(typeof stored.connections[0].deviceToken, 'string')
    if (process.platform !== 'win32') {
      assert.equal(statSync(storePath).mode & 0o777, 0o600, 'the credential file is owner-only')
    }

    // The other machine sees exactly one device, named as this machine.
    const devices = harness.devices.listDevices()
    assert.equal(devices.length, 1)
    assert.equal(devices[0].name, 'laptop')
  } finally {
    await harness.close()
  }
})

// A bad link is refused with the reason, never accepted into a record that
// would fail later somewhere less explicable.
test('a link that is not a pairing link is refused before anything is dialled', async () => {
  const harness = await startHarness()
  try {
    const result = await harness.fleet.pair({ pairingUrl: 'https://example.com/pair?token=abc' })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.code === 'invalid_pairing_link')
    assert.equal(harness.fleet.listConnections().length, 0)
  } finally {
    await harness.close()
  }
})

// The browse is the Fleet's whole read: another machine's workspaces and
// terminals, over the real tool surface, behind the real scopes.
test('browsing a machine reads its workspaces and terminals', async () => {
  const harness = await startHarness()
  try {
    const connectionId = await harness.pair(['workspace:read', 'sprint:read', 'terminal:control'])
    const browse = await harness.fleet.browse(connectionId)
    assert.equal(browse.reachable, true)
    assert.equal(browse.unauthorized, false)
    assert.equal(browse.terminalAccess, 'control')
    assert.deepEqual(
      browse.workspaces.map((workspace) => workspace.name),
      ['Atlas', 'Scratch']
    )
    assert.equal(browse.terminals.length, 1)
    assert.equal(browse.terminals[0].sessionId, 'session_one')
    assert.equal(browse.terminals[0].agentName, 'Scout')
    assert.equal(browse.terminals[0].phase, 'working')
    assert.deepEqual(browse.gaps, [])

    const runs = await harness.fleet.listRuns(connectionId, 'ws-1')
    assert.ok(runs.ok)
    assert.deepEqual(runs.runs.map((run) => run.slug), ['nightly'])
    // one-project-across-machines: the identity the remote served is kept,
    // and its absence is kept as null rather than invented.
    assert.equal(browse.workspaces.find((entry) => entry.id === 'ws-1')?.repository?.canonicalKey, 'github.com/acme/atlas')
    assert.equal(browse.workspaces.find((entry) => entry.id === 'ws-2')?.repository, null)
  } finally {
    await harness.close()
  }
})

// A pairing granted terminals alone still sees its terminals, and is TOLD why
// there are no workspaces beside them. An empty list would state something
// false about the other machine.
test('a part this pairing may not read is reported as a gap, not an empty list', async () => {
  const harness = await startHarness()
  try {
    const connectionId = await harness.pair(['terminal:observe'])
    const browse = await harness.fleet.browse(connectionId)
    assert.equal(browse.reachable, true)
    assert.equal(browse.terminals.length, 1)
    assert.equal(browse.workspaces.length, 0)
    assert.equal(browse.gaps.length, 1)
    assert.equal(browse.gaps[0].part, 'workspaces')
    assert.match(browse.gaps[0].message, /may not read/u)
  } finally {
    await harness.close()
  }
})

// Revocation at the other end is the one failure re-pairing fixes, so it is
// reported as itself rather than as "unreachable".
test('a revoked pairing is reported as revoked, not as an unreachable machine', async () => {
  const harness = await startHarness()
  try {
    const connectionId = await harness.pair(['workspace:read'])
    harness.devices.revokeDevice(harness.devices.listDevices()[0].id)
    const browse = await harness.fleet.browse(connectionId)
    assert.equal(browse.reachable, false)
    assert.equal(browse.unauthorized, true)
    assert.match(browse.unreachableReason ?? '', /no longer accepts/u)
  } finally {
    await harness.close()
  }
})

// checkout-and-branch-on-remote-create: the checkout facts behind the launch
// panel's checkout · branch segments, read over the wire and parsed as the
// panel consumes them; a pairing without workspace:read gets the refusal.
test('a remote workspace\'s checkout is read over workspace.checkout, and refused without workspace:read', async () => {
  const harness = await startHarness()
  try {
    const connectionId = await harness.pair(['workspace:read'])
    const read = await harness.fleet.workspaceCheckout(connectionId, 'ws-1')
    assert.ok(read.ok, read.ok ? '' : read.message)
    assert.equal(read.checkout.branch, 'main')
    assert.equal(read.checkout.defaultBranch, 'main')
    assert.deepEqual(read.checkout.branches.map((entry) => entry.name), ['feat/x', 'main'])
    assert.equal(read.checkout.worktrees[0]?.isMain, true)

    const terminalsOnly = await harness.pair(['terminal:control'])
    const refused = await harness.fleet.workspaceCheckout(terminalsOnly, 'ws-1')
    assert.equal(refused.ok, false)
    assert.equal(refused.ok ? '' : refused.code, 'tailnet_scope_required')
    assert.match(refused.ok ? '' : refused.message, /workspace:read/u, 'the gateway names the missing scope, verbatim')

    const nameless = await harness.fleet.workspaceCheckout(connectionId, '')
    assert.equal(nameless.ok, false)
  } finally {
    await harness.close()
  }
})

// The worktree route: a create on a fresh worktree is the remote's own
// agent.launch (workspace:operate, the mutation that mints it), with the base
// ref the panel picked; the current checkout stays terminal.create. A pairing
// without workspace:operate is refused by the gateway in its own words —
// which is what makes the panel's dimmed row honest.
test('a create on a new worktree rides agent.launch with its base ref, and a terminals-only pairing is refused verbatim', async () => {
  const harness = await startHarness()
  try {
    const connectionId = await harness.pair(['workspace:operate', 'terminal:control'])
    const before = terminalCreateArgs.length
    const created = await harness.fleet.createTerminal({
      connectionId,
      workspaceId: 'ws-1',
      cli: 'claude-code',
      prompt: 'Fix the relay snapshot race',
      permissionPreset: 'auto',
      checkout: { mode: 'worktree', name: 'fix', baseRef: 'feat/x' },
    })
    assert.ok(created.ok, created.ok ? '' : created.message)
    assert.equal(created.sessionId, 'session_three', 'the session comes from the agent projection')
    assert.equal(created.title, 'Bishop')
    assert.deepEqual(created.checkout, { mode: 'worktree', branch: 'agent/fix', worktreePath: '/repos/.multicode-worktrees/atlas/fix' })
    const wire = agentLaunchArgs[agentLaunchArgs.length - 1]
    assert.deepEqual(wire?.worktree, { name: 'fix', baseRef: 'feat/x' })
    assert.equal(wire?.cli, 'claude-code')
    assert.equal(wire?.prompt, 'Fix the relay snapshot race')
    assert.equal(wire?.permissionPreset, 'auto')
    assert.equal(terminalCreateArgs.length, before, 'terminal.create was not asked')

    // The current checkout is still terminal.create, and says so.
    const current = await harness.fleet.createTerminal({ connectionId, workspaceId: 'ws-1', checkout: { mode: 'current' } })
    assert.ok(current.ok, current.ok ? '' : current.message)
    assert.deepEqual(current.checkout, { mode: 'current', branch: null, worktreePath: null })
    assert.equal(terminalCreateArgs.length, before + 1)

    const terminalsOnly = await harness.pair(['terminal:control'])
    const launches = agentLaunchArgs.length
    const refused = await harness.fleet.createTerminal({
      connectionId: terminalsOnly,
      workspaceId: 'ws-1',
      checkout: { mode: 'worktree', baseRef: 'main' },
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.ok ? '' : refused.code, 'tailnet_scope_required')
    assert.match(refused.ok ? '' : refused.message, /workspace:operate/u)
    assert.equal(agentLaunchArgs.length, launches, 'the refused handler never ran on the remote')
  } finally {
    await harness.close()
  }
})

// Create → attach → type, the round trip the whole feature exists for, over the
// real listener and the real attach socket.
test('a terminal opened on another machine attaches and takes keystrokes', async () => {
  const harness = await startHarness()
  try {
    const connectionId = await harness.pair(['workspace:read', 'terminal:control'])
    const created = await harness.fleet.createTerminal({
      connectionId,
      workspaceId: 'ws-1',
      cli: 'claude-code',
      prompt: 'Fix the relay snapshot race',
      cliModel: 'claude-fable-5',
      permissionPreset: 'auto',
    })
    assert.ok(created.ok, created.ok ? '' : created.message)
    assert.equal(created.sessionId, 'session_two')
    assert.equal(created.title, 'Rook')
    // The launch identity crossed the wire verbatim — the remote validates it,
    // never a smoothing layer here.
    const wire = terminalCreateArgs[terminalCreateArgs.length - 1]
    assert.equal(wire?.cli, 'claude-code')
    assert.equal(wire?.prompt, 'Fix the relay snapshot race')
    assert.equal(wire?.cliModel, 'claude-fable-5')
    assert.equal(wire?.permissionPreset, 'auto')
    // The remote machine really made the session the id names.
    harness.terminals.create(created.sessionId)

    const recorder = createRecorder()
    const attached = await harness.fleet.attachTerminal({
      attachId: 'pane-1',
      connectionId,
      sessionId: created.sessionId,
      emit: recorder.emit,
    })
    assert.equal(attached.ok, true)

    const header = await recorder.waitFor((event) => event.type === 'attached', 'the attach header')
    assert.ok(header.type === 'attached' && header.access === 'control')
    await recorder.waitFor((event) => event.type === 'status' && event.state === 'live', 'a live link')

    harness.fleet.sendInput('pane-1', 'ls\r')
    await waitUntil(() => harness.terminals.writes.length > 0, 'the keystroke to reach the remote pty')
    assert.deepEqual(harness.terminals.writes[0], { sessionId: 'session_two', data: 'ls\r' })

    harness.fleet.resizeTerminal('pane-1', 100, 40)
    await waitUntil(() => harness.terminals.resizes.length > 0, 'the resize to reach the remote pty')
    assert.deepEqual(harness.terminals.resizes[0], { sessionId: 'session_two', cols: 100, rows: 40 })

    harness.terminals.emit('session_two', 'total 0\r\n')
    const output = await recorder.waitFor((event) => event.type === 'output', 'remote output')
    assert.ok(output.type === 'output' && output.data === 'total 0\r\n')

    // Detaching ends the attachment on the far side too, rather than leaving a
    // pty narrating to a pane that is gone.
    harness.fleet.detachTerminal('pane-1')
    await waitUntil(() => harness.terminals.attachedCount() === 0, 'the remote attachment to be released')
  } finally {
    await harness.close()
  }
})

// An existing session is attached with its scrollback FIRST: the replay
// precedes the header, so a pane's first frame is always the screen.
test('attaching an existing session replays its scrollback before anything else', async () => {
  const harness = await startHarness()
  try {
    const connectionId = await harness.pair(['terminal:control'])
    const recorder = createRecorder()
    await harness.fleet.attachTerminal({
      attachId: 'pane-2',
      connectionId,
      sessionId: 'session_one',
      emit: recorder.emit,
    })
    const replay = await recorder.waitFor((event) => event.type === 'replay', 'the attach replay')
    assert.ok(replay.type === 'replay' && replay.data === 'scrollback so far\r\n' && replay.reason === 'attach')
    const frames = recorder.events.filter((event) => event.type === 'replay' || event.type === 'attached')
    assert.equal(frames[0].type, 'replay', 'the screen arrives before the header')
    harness.fleet.detachTerminal('pane-2')
  } finally {
    await harness.close()
  }
})

// A watch-only pairing gets a watch-only socket, and the keystroke it sends is
// refused at the far end rather than silently swallowed.
test('a watch-only pairing attaches to observe and cannot type', async () => {
  const harness = await startHarness()
  try {
    const connectionId = await harness.pair(['terminal:observe'])
    const recorder = createRecorder()
    await harness.fleet.attachTerminal({
      attachId: 'pane-3',
      connectionId,
      sessionId: 'session_one',
      emit: recorder.emit,
    })
    const header = await recorder.waitFor((event) => event.type === 'attached', 'the attach header')
    assert.ok(header.type === 'attached' && header.access === 'observe')

    harness.fleet.sendInput('pane-3', 'rm -rf /\r')
    const refusal = await recorder.waitFor((event) => event.type === 'error', 'the refusal')
    assert.ok(refusal.type === 'error' && refusal.code === 'terminal_control_required')
    assert.equal(harness.terminals.writes.length, 0, 'nothing was written to the remote pty')
    harness.fleet.detachTerminal('pane-3')
  } finally {
    await harness.close()
  }
})

// A pairing with no terminal grant is refused BEFORE a socket exists, and the
// pane is told why rather than being left dialling forever.
test('a pairing without a terminal grant is refused at the upgrade, once', async () => {
  const harness = await startHarness()
  try {
    const connectionId = await harness.pair(['workspace:read'])
    const recorder = createRecorder()
    await harness.fleet.attachTerminal({
      attachId: 'pane-4',
      connectionId,
      sessionId: 'session_one',
      emit: recorder.emit,
    })
    const error = await recorder.waitFor((event) => event.type === 'error', 'the refusal')
    assert.ok(error.type === 'error' && error.code === 'terminal_scope_required')
    await recorder.waitFor((event) => event.type === 'status' && event.state === 'closed', 'the pane to be told it ended')
    // Not a retry loop against a door that will not open.
    await delay(300)
    assert.equal(
      recorder.events.filter((event) => event.type === 'status' && event.state === 'reconnecting').length,
      0
    )
  } finally {
    await harness.close()
  }
})

// A restored layout asks for panes that may no longer exist over there. The far
// end opens the socket, refuses the attach, and closes cleanly — which without
// care looks exactly like a network blip and would retry forever.
test('an attach the far end refuses ends the pane instead of retrying', async () => {
  const harness = await startHarness()
  try {
    const connectionId = await harness.pair(['terminal:control'])
    const recorder = createRecorder()
    await harness.fleet.attachTerminal({
      attachId: 'pane-8',
      connectionId,
      sessionId: 'session_that_is_gone',
      emit: recorder.emit,
    })
    const error = await recorder.waitFor((event) => event.type === 'error', 'the refusal')
    assert.ok(error.type === 'error' && error.code === 'unknown_terminal')
    await recorder.waitFor((event) => event.type === 'status' && event.state === 'closed', 'the pane to be ended')
    await delay(1500)
    assert.equal(
      recorder.events.filter((event) => event.type === 'status' && event.state === 'reconnecting').length,
      0,
      'a session that is not there is not dialled again'
    )
  } finally {
    await harness.close()
  }
})

// The acceptance the item names: kill the network mid-session, and the pane
// reconnects and resyncs from the retained scrollback instead of losing it.
test('a dropped link reconnects and resyncs from the remote replay', async () => {
  const harness = await startHarness()
  try {
    const connectionId = await harness.pair(['terminal:control'])
    const recorder = createRecorder()
    await harness.fleet.attachTerminal({
      attachId: 'pane-5',
      connectionId,
      sessionId: 'session_one',
      emit: recorder.emit,
    })
    await recorder.waitFor((event) => event.type === 'status' && event.state === 'live', 'the first live link')
    harness.fleet.resizeTerminal('pane-5', 120, 30)
    await waitUntil(() => harness.terminals.resizes.length > 0, 'the pane size to reach the remote pty')

    // The machine goes away mid-session — a closed lid, a Wi-Fi handover.
    await harness.stopServer()
    await recorder.waitFor(
      (event) => event.type === 'status' && (event.state === 'reconnecting' || event.state === 'offline'),
      'the pane to report the drop'
    )

    // Output it missed while disconnected. The replay is a superset, so the
    // repaint carries it rather than leaving a hole.
    harness.terminals.emit('session_one', 'work done while you were away\r\n')
    await harness.restartServer()

    // Counted, not matched: `waitFor` answers from history too, and the first
    // live status is the one this test just took away.
    await waitUntil(
      () => recorder.events.filter((event) => event.type === 'status' && event.state === 'live').length >= 2,
      'the link to come back'
    )
    const replays = recorder.events.filter((event) => event.type === 'replay')
    assert.ok(replays.length >= 2, 'the reconnect brought a fresh replay')
    const last = replays[replays.length - 1]
    assert.ok(last.type === 'replay' && last.data.includes('work done while you were away'))

    // And the recovered link is a working one, not just a connected socket —
    // including the pane's size, which the remote pty would otherwise keep from
    // whichever viewer attached last.
    assert.deepEqual(harness.terminals.resizes.at(-1), { sessionId: 'session_one', cols: 120, rows: 30 })
    harness.fleet.sendInput('pane-5', 'echo back\r')
    await waitUntil(() => harness.terminals.writes.length > 0, 'typing to work after the reconnect')
    harness.fleet.detachTerminal('pane-5')
  } finally {
    await harness.close()
  }
})

// Revocation mid-stream is a decision, not a blip: the socket closes with 4401
// and the pane is ended rather than retried.
test('a revocation mid-stream ends the pane instead of reconnecting', async () => {
  const harness = await startHarness()
  try {
    const connectionId = await harness.pair(['terminal:control'])
    const recorder = createRecorder()
    await harness.fleet.attachTerminal({
      attachId: 'pane-6',
      connectionId,
      sessionId: 'session_one',
      emit: recorder.emit,
    })
    await recorder.waitFor((event) => event.type === 'status' && event.state === 'live', 'a live link')

    harness.devices.revokeDevice(harness.devices.listDevices()[0].id)
    const closed = await recorder.waitFor(
      (event) => event.type === 'status' && event.state === 'closed',
      'the pane to be closed'
    )
    assert.ok(closed.type === 'status' && /revoked/u.test(closed.detail))
    await delay(300)
    assert.equal(
      recorder.events.filter((event) => event.type === 'status' && event.state === 'reconnecting').length,
      0,
      'a revoked device is not retried'
    )
  } finally {
    await harness.close()
  }
})

// Forgetting a machine ends the panes attached to it: they have no credential
// left to reconnect with, and leaving them retrying would be a loop nobody can
// see or stop.
test('forgetting a machine ends its open panes', async () => {
  const harness = await startHarness()
  try {
    const connectionId = await harness.pair(['terminal:control'])
    const recorder = createRecorder()
    await harness.fleet.attachTerminal({
      attachId: 'pane-7',
      connectionId,
      sessionId: 'session_one',
      emit: recorder.emit,
    })
    await recorder.waitFor((event) => event.type === 'status' && event.state === 'live', 'a live link')

    const remaining = harness.fleet.forget(connectionId)
    assert.equal(remaining.length, 0)
    const closed = await recorder.waitFor(
      (event) => event.type === 'status' && event.state === 'closed',
      'the pane to be closed'
    )
    assert.ok(closed.type === 'status' && /removed from your fleet/u.test(closed.detail))
    await waitUntil(() => harness.terminals.attachedCount() === 0, 'the remote attachment to be released')
  } finally {
    await harness.close()
  }
})

// The endpoint parser is the boundary where a stored string becomes an address
// this machine dials, so what it will and will not read is worth pinning.
test('endpoints are read exactly, or refused', async () => {
  assert.deepEqual(parseTailnetEndpoint('100.64.0.5:8787'), { host: '100.64.0.5', port: 8787 })
  assert.deepEqual(parseTailnetEndpoint('[fd7a:115c:a1e0::1]:8787'), { host: 'fd7a:115c:a1e0::1', port: 8787 })
  // A bare IPv6 literal is ambiguous with the port separator; truncating it
  // would send a credential to an address nobody chose.
  assert.equal(parseTailnetEndpoint('fd7a:115c:a1e0::1:8787'), null)
  assert.equal(parseTailnetEndpoint('100.64.0.5'), null)
  assert.equal(parseTailnetEndpoint('100.64.0.5:notaport'), null)
  assert.equal(parseTailnetEndpoint('100.64.0.5:70000'), null)
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The whole-app broadcast (remote-sessions-ux / tailnet-live-state-push):
// machine paired and forgotten, per-attachment link state keyed by the PANE,
// and a snapshot read that agrees with the events — every one stamped with
// a revision that only goes up.
test('the fleet broadcasts machine paired/forgotten and attachment link state, keyed by attachId, with a matching snapshot', async () => {
  const harness = await startHarness()
  try {
    assert.deepEqual(
      harness.fleet.getLiveState(),
      { revision: 0, attachments: [], requests: [], reachability: [] },
      'nothing attached, revision 0'
    )
    const connectionId = await harness.pair(['terminal:control'])
    const paired = harness.events.find((event) => event.kind === 'machine-paired')
    assert.ok(paired && paired.kind === 'machine-paired', 'pairing is broadcast')
    assert.equal(paired.connection.id, connectionId)
    assert.equal(paired.revision, 1, 'the first broadcast is revision 1')
    assert.equal(
      'deviceToken' in paired.connection,
      false,
      'the broadcast carries the public view, never the credential'
    )

    // Two panes on ONE session: two links, announced separately.
    const first = createRecorder()
    const second = createRecorder()
    await harness.fleet.attachTerminal({ attachId: 'pane-a', connectionId, sessionId: 'session_one', emit: first.emit })
    await harness.fleet.attachTerminal({ attachId: 'pane-b', connectionId, sessionId: 'session_one', emit: second.emit })
    await first.waitFor((event) => event.type === 'status' && event.state === 'live', 'pane-a live')
    await second.waitFor((event) => event.type === 'status' && event.state === 'live', 'pane-b live')
    const attachmentEvents = harness.events.filter((event) => event.kind === 'attachment')
    const states = (attachId: string) =>
      attachmentEvents.filter((event) => event.kind === 'attachment' && event.attachId === attachId).map((event) => event.kind === 'attachment' && event.state)
    assert.deepEqual(states('pane-a'), ['connecting', 'live'], 'pane-a narrated connecting → live')
    assert.deepEqual(states('pane-b'), ['connecting', 'live'], 'pane-b narrated the same, under its own id')
    for (const event of attachmentEvents) {
      assert.ok(event.kind === 'attachment' && event.connectionId === connectionId && event.sessionId === 'session_one')
    }

    const snapshot = harness.fleet.getLiveState()
    assert.equal(snapshot.revision, harness.events[harness.events.length - 1].revision, 'the snapshot carries the latest revision')
    assert.deepEqual(
      snapshot.attachments.map((attachment) => [attachment.attachId, attachment.state]).sort(),
      [
        ['pane-a', 'live'],
        ['pane-b', 'live'],
      ],
      'the snapshot lists both panes as live'
    )

    // Closing one pane retracts ONLY that pane's link.
    harness.fleet.detachTerminal('pane-a')
    const closed = harness.events[harness.events.length - 1]
    assert.ok(closed.kind === 'attachment' && closed.attachId === 'pane-a' && closed.state === 'closed')
    assert.deepEqual(
      harness.fleet.getLiveState().attachments.map((attachment) => attachment.attachId),
      ['pane-b'],
      'the other pane is still held'
    )

    // Forgetting the machine ends the remaining pane and announces the forget.
    harness.fleet.forget(connectionId)
    const forgotten = harness.events.find((event) => event.kind === 'machine-forgotten')
    assert.ok(forgotten && forgotten.kind === 'machine-forgotten' && forgotten.connectionId === connectionId)
    assert.ok(
      harness.events.some((event) => event.kind === 'attachment' && event.attachId === 'pane-b' && event.state === 'closed'),
      'the pane on a forgotten machine is closed, and said to be'
    )
    assert.deepEqual(harness.fleet.getLiveState().attachments, [])

    harness.events.forEach((event, index) => {
      if (index === 0) return
      assert.ok(event.revision > harness.events[index - 1].revision, `revision rises at event ${index}`)
    })
  } finally {
    await harness.close()
  }
})

// When the peer stops answering the broadcast narrates reconnecting, then
// offline after the retry budget, then live again when it returns — the
// sequence the Remote glyph and the loss/recovery toasts are built on.
test('a peer going away is broadcast as reconnecting then offline, and coming back as live', async () => {
  const harness = await startHarness()
  try {
    const connectionId = await harness.pair(['terminal:observe'])
    const recorder = createRecorder()
    await harness.fleet.attachTerminal({ attachId: 'pane-x', connectionId, sessionId: 'session_one', emit: recorder.emit })
    await recorder.waitFor((event) => event.type === 'status' && event.state === 'live', 'live')
    await harness.stopServer()
    await waitUntil(
      () => harness.events.some((event) => event.kind === 'attachment' && event.state === 'offline'),
      'the broadcast to report offline'
    )
    const sequence = harness.events
      .filter((event) => event.kind === 'attachment' && event.attachId === 'pane-x')
      .map((event) => event.kind === 'attachment' && event.state)
    assert.ok(sequence.includes('reconnecting'), 'reconnecting precedes offline')
    assert.ok(sequence.indexOf('reconnecting') < sequence.indexOf('offline'))
    assert.equal(harness.fleet.getLiveState().attachments[0]?.state, 'offline', 'the snapshot agrees')
    await harness.restartServer()
    await waitUntil(
      () => {
        const last = harness.events[harness.events.length - 1]
        return last.kind === 'attachment' && last.state === 'live'
      },
      'the link to come back live'
    )
    harness.fleet.detachTerminal('pane-x')
  } finally {
    await harness.close()
  }
})

async function waitUntil(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await delay(10)
  }
}

async function runAll(): Promise<void> {
  for (const entry of queued) {
    try {
      await entry.run()
      console.log(`ok - ${entry.name}`)
    } catch (error) {
      failures.push(entry.name)
      console.error(`not ok - ${entry.name}`)
      console.error(error)
    }
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} failing: ${failures.join(', ')}`)
    process.exit(1)
  }
  console.log('\ntailnet fleet client contracts ok')
}

void runAll()
