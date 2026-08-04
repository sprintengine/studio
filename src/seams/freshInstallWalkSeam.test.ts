import assert from 'node:assert/strict'
import Module from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { WebContents } from 'electron'
import type {
  AgentCli,
  AgentCliAvailabilityMap,
  CliDetectResult,
  CliRuntimeSettings,
  McpSettings,
  TerminalSpawnResult,
} from '../shared/electron-api'
import type { PluginRegistryListEntry } from '../shared/plugin-manifest'
import type { AgentCliCatalogOption } from '../renderer/src/components/workspace/newWorkspace/cliRuntimeOptions'

// ── Seam: the fresh-install walk (T3 + T5 + T6, epic 2091) ───────────────────
//
// The owner fresh-installed on a Mac and hit one continuous failure: the app
// opened a creation hub, the hub offered eight CLIs none of which were on the
// machine, picking one produced a bare zsh, and the IPC called that success.
// Three tasks fixed it in three modules that never call each other:
//
//  * T3 (MC-2092) — main resolves the probed absolute path and refuses a spawn
//    whose binary is absent. Its suite pins the verdict it wants and asserts the
//    IPC result; it never asks what the renderer would have offered.
//  * T6 (MC-2093) — the renderer's catalog filter stops handing back the whole
//    uninstalled catalog when nothing is installed. Its suite hand-writes the
//    availability map; it never runs the probe that produces one.
//  * T5 (MC-2094) — the first-run CLI card wins the first-run window from the
//    hub auto-open. Its suite drives the predicates over a map it invents too.
//
// Every one of them is verified against a machine state it wrote itself. This
// suite writes ONE machine state — which binaries the user's interactive shell
// can resolve — and runs it through all three: main's real availability
// aggregation produces the map, that same map drives the renderer's catalog and
// the first-run precedence, and the same machine drives the real spawn IPC.
//
// What is executed and what is simulated: the epic's acceptance names a fresh
// macOS machine with an empty profile, which no test can reproduce. The
// simulated part is exactly two things — the shell probe (a stub standing in for
// `detectCli`, which spawns login shells) and the pty (the usual mock). The
// registry is the real bundled one, the availability aggregation, the catalog
// filter, the precedence predicates, the pre-flight, the launch render and the
// spawn IPC are all the real code. No claim below is about an unverified
// first-run walk on real hardware.

type SentEvent = { channel: string, payload: unknown }

type MockPtyProcess = {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(callback: (data: string) => void): { dispose(): void }
  onExit(callback: (event: { exitCode: number, signal?: number }) => void): { dispose(): void }
  writes: string[]
  killed: boolean
}

type SpawnCall = { command: string, args: string[], options: Record<string, unknown> }

const mockPty = {
  spawnCalls: [] as SpawnCall[],
  spawn(command: string, args: string[], options: Record<string, unknown>): MockPtyProcess {
    mockPty.spawnCalls.push({ command, args, options })
    return createMockPtyProcess()
  },
}

const mockSender = createMockWebContents()
const mockElectron = {
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => join(tmpdir(), 'multicode-fresh-install-seam-user-data'),
    isPackaged: false,
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: mockSender }],
  },
}

const moduleWithLoad = Module as typeof Module & {
  _load(request: string, parent: NodeModule | null, isMain: boolean): unknown
}
const originalLoad = moduleWithLoad._load
moduleWithLoad._load = function loadWithMainProcessMocks(
  request: string,
  parent: NodeModule | null,
  isMain: boolean,
): unknown {
  if (request === 'electron') return mockElectron
  if (request === 'node-pty') return mockPty
  return originalLoad.call(this, request, parent, isMain)
}

// One machine, described the way a machine actually differs: which binaries the
// user's INTERACTIVE shell resolves. Availability is probed through `$SHELL
// -ilc` (which sources ~/.zshrc); agents launch through a login shell that does
// not. Keying on binary NAME rather than plugin id is what makes the two hosted
// runtimes (zai, kimi-claude — both `binary: "claude"`) behave the way they do
// on a real machine: installing claude installs all three.
type Machine = {
  what: string
  interactiveShell: Record<string, string>
}

// Any Mac has these; no agent CLI has been installed.
const MACOS_BASELINE: Record<string, string> = { sh: '/bin/sh', zsh: '/bin/zsh' }

const FRESH_MAC: Machine = {
  what: 'a fresh Mac with no agent CLI installed',
  interactiveShell: { ...MACOS_BASELINE },
}

// The common fresh-Mac setup the epic names: the installer appended nvm's bin
// directory to ~/.zshrc, so the probe sees `claude` and a login shell does not.
const NVM_CLAUDE_PATH = '/Users/dev/.nvm/versions/node/v22.3.0/bin/claude'
const ZSHRC_ONLY_CLAUDE: Machine = {
  what: 'a Mac whose claude binary is on a ~/.zshrc-only PATH',
  interactiveShell: { ...MACOS_BASELINE, claude: NVM_CLAUDE_PATH },
}

// What the launch shell can resolve without the interactive config: the
// baseline, and nothing else. An absolute path needs no PATH lookup at all,
// which is the entire reason the launch executes the probed one.
function loginShellResolves(command: string): boolean {
  return command.startsWith('/') || Object.hasOwn(MACOS_BASELINE, command)
}

async function main(): Promise<void> {
  try {
    await testFreshMacOffersNothingHoldsTheHubAndRefusesTheSpawn()
    await testZshrcOnlyCliIsOfferedAndLaunchesThroughItsProbedPath()
    console.log('all fresh-install walk seam tests passed')
  } finally {
    moduleWithLoad._load = originalLoad
  }
}

// The bundled registry as shipped, not a fixture list: a plugin added to
// `resources/plugins` joins this walk automatically, which is how the
// always-present-binary case below stays caught rather than re-appearing under a
// new id. User-installed plugins are excluded so the result does not depend on
// the developer's own machine.
async function bundledRegistryEntries(): Promise<PluginRegistryListEntry[]> {
  const { listPluginRegistryEntries } = await import('../main/plugin-registry-instance')
  const entries = listPluginRegistryEntries().filter((entry) => entry.source === 'bundled')
  assert.ok(
    entries.some((entry) => entry.id === 'claude-code'),
    'the bundled plugin registry failed to load — every assertion below would pass vacuously',
  )
  return entries
}

// Stands in for `detectCli`, which spawns a login shell per CLI. Everything it
// answers comes from the machine above; the aggregation, caching and error
// contract around it are the real `detectAgentCliAvailability`.
function probeAgainst(
  machine: Machine,
  entries: PluginRegistryListEntry[],
): (cli: AgentCli, runtime?: Partial<CliRuntimeSettings>) => Promise<CliDetectResult> {
  return async (cli, runtime) => {
    const binary = runtime?.command?.trim() || entries.find((entry) => entry.id === cli)?.binary || cli
    const resolvedPath = machine.interactiveShell[binary] ?? null
    return {
      cli,
      binary,
      installed: resolvedPath !== null,
      version: resolvedPath === null ? null : '2.0.0',
      resolvedPath,
      useWsl: false,
      error: null,
    }
  }
}

// Main's real probe aggregation over the machine — the map the renderer receives
// from `plugins:detect-availability`.
async function detectOn(
  machine: Machine,
  entries: PluginRegistryListEntry[],
): Promise<AgentCliAvailabilityMap> {
  const { clearCliAvailabilityCache, detectAgentCliAvailability } = await import('../main/cli-availability')
  clearCliAvailabilityCache()
  return detectAgentCliAvailability(
    {},
    { listEntries: () => entries, detect: probeAgainst(machine, entries), ttlMs: 0 },
  )
}

type RendererSurfaces = {
  catalog: AgentCliCatalogOption[]
  launchableCli: AgentCli | null
  showsFirstRunCliCard: boolean
  autoOpensCreationHub: boolean
}

// The renderer half, driven off the map main just produced: what the pickers
// offer, what a spawn would launch, and which surface owns the first-run window.
async function rendererSurfacesFor(input: {
  availability: AgentCliAvailabilityMap
  entries: PluginRegistryListEntry[]
  status?: 'loading' | 'ready' | 'error'
  workspaceCount?: number
}): Promise<RendererSurfaces> {
  const { resolveLaunchableAgentCli, selectAgentCliCatalog } = await import(
    '../renderer/src/components/workspace/newWorkspace/cliRuntimeOptions'
  )
  const { shouldAutoOpenCreationHub, shouldShowFirstRunCliCard } = await import(
    '../renderer/src/store/onboardingState'
  )
  const status = input.status ?? 'ready'
  const catalog = selectAgentCliCatalog(
    'ready',
    input.entries,
    {},
    { map: input.availability, status },
  )
  const onboarding = {
    cliAvailabilityStatus: status,
    cliAvailability: input.availability,
    firstRunCliCardDismissed: false,
  }
  return {
    catalog,
    launchableCli: resolveLaunchableAgentCli('claude-code', catalog),
    showsFirstRunCliCard: shouldShowFirstRunCliCard(onboarding),
    autoOpensCreationHub: shouldAutoOpenCreationHub({
      ...onboarding,
      workspaceCount: input.workspaceCount ?? 0,
    }),
  } satisfies RendererSurfaces
}

type TerminalRuntimeModule = typeof import('../main/terminal-runtime')

// The real spawn IPC over the same machine: only the pre-flight's shell probe
// and the pty are stubbed, so the refusal message, the exit code, the rendered
// launch script and the IPC result shape are all produced by the real path.
async function spawnAgentOn(input: {
  machine: Machine
  entries: PluginRegistryListEntry[]
  cli: AgentCli
  sessionId: string
}): Promise<{ result: TerminalSpawnResult, spawnCalls: SpawnCall[], startupScript: string | null }> {
  const runtimeModule = (await import('../main/terminal-runtime')) as TerminalRuntimeModule
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-fresh-install-seam-'))
  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
  })
  runtimeModule.__setAgentCliPreflightForTest({
    platform: 'darwin',
    shell: '/bin/zsh',
    deps: {
      listEntries: () => input.entries,
      detect: probeAgainst(input.machine, input.entries),
      ttlMs: 0,
    },
  })
  mockPty.spawnCalls = []
  try {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: input.sessionId,
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      cli: input.cli,
      kind: 'agent',
      shellOnly: false,
      workspaceId: 'ws-fresh-install-seam',
      agentId: input.sessionId,
      visible: false,
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })
    const spawnCalls = [...mockPty.spawnCalls]
    const scriptPath = spawnCalls[0]?.args.at(-1)
    const startupScript = scriptPath === undefined ? null : await readFile(String(scriptPath), 'utf8')
    if (result.ok) runtime.ipcHandlers.killTerminal(input.sessionId)
    return { result, spawnCalls, startupScript }
  } finally {
    runtimeModule.__setAgentCliPreflightForTest(null)
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

// --- The walk the epic describes, on the machine it describes ----------------

async function testFreshMacOffersNothingHoldsTheHubAndRefusesTheSpawn(): Promise<void> {
  const entries = await bundledRegistryEntries()
  const availability = await detectOn(FRESH_MAC, entries)

  // Nothing is launchable, so no picker offers anything: the whole point of
  // MC-2093 is that the answer here is an empty catalog, not the eight
  // uninstalled CLIs the escape hatch used to hand back.
  const surfaces = await rendererSurfacesFor({ availability, entries })
  assert.deepEqual(
    surfaces.catalog.map((option) => option.value),
    [],
    `${FRESH_MAC.what} must offer no agent CLI`,
  )
  assert.equal(surfaces.launchableCli, null, 'a spawn on this machine has nothing to launch')

  // And the one surface that may run is the CLI question, not the hub. This is
  // the assertion that spans T5 and T6: the card's predicate reads the same map
  // the catalog filter just emptied, and a CLI the pickers refuse to offer must
  // not count as the machine having one.
  assert.equal(
    surfaces.showsFirstRunCliCard,
    true,
    'the first-run CLI surface must be reachable on the machine it exists for',
  )
  assert.equal(
    surfaces.autoOpensCreationHub,
    false,
    'the creation hub must not take the first-run window from the CLI question',
  )

  // Neither surface flashes while the probe is unresolved — and the catalog
  // keeps its own answer to the same uncertainty: an unresolved probe leaves
  // every CLI visible, so a transient failure on a machine that HAS CLIs never
  // empties a picker. "Nothing installed" and "we could not find out" are
  // different answers on all three surfaces, and only the first empties them.
  for (const status of ['loading', 'error'] as const) {
    const pending = await rendererSurfacesFor({ availability, entries, status })
    assert.equal(pending.showsFirstRunCliCard, false, `no card on ${status}`)
    assert.equal(pending.autoOpensCreationHub, false, `no hub on ${status}`)
    assert.ok(pending.catalog.length > 0, `an unresolved probe must not empty the picker on ${status}`)
  }

  // A spawn attempted anyway — a remembered CLI, a template, a Sprint Engine
  // launch — is refused with a message, not reported as a started agent.
  const spawn = await spawnAgentOn({
    machine: FRESH_MAC,
    entries,
    cli: 'claude-code',
    sessionId: 'fresh-mac-refused',
  })
  assert.equal(spawn.result.ok, false, 'an absent CLI must not report a successful start')
  assert.equal(spawn.spawnCalls.length, 0, 'nothing is spawned — least of all a bare shell')
  if (spawn.result.ok) return
  assert.match(spawn.result.message, /Claude Code/, 'the failure names the CLI the user picked')
  assert.equal(spawn.result.exitCode, 127)
}

async function testZshrcOnlyCliIsOfferedAndLaunchesThroughItsProbedPath(): Promise<void> {
  const entries = await bundledRegistryEntries()
  const availability = await detectOn(ZSHRC_ONLY_CLAUDE, entries)

  const surfaces = await rendererSurfacesFor({ availability, entries })
  const offered = surfaces.catalog.map((option) => option.value)
  assert.ok(offered.includes('claude-code'), `an installed CLI must be offered: ${offered.join(', ')}`)
  assert.equal(surfaces.launchableCli, 'claude-code')
  assert.equal(
    surfaces.catalog.find((option) => option.value === 'claude-code')?.resolvedPath,
    NVM_CLAUDE_PATH,
    'the probed path rides the catalog option',
  )

  // The machine has a CLI, so the first-run question is answered and the hub
  // opens with no card and no nagging.
  assert.equal(surfaces.showsFirstRunCliCard, false)
  assert.equal(surfaces.autoOpensCreationHub, true)
  // …and once a workspace exists, the hub stops auto-opening at all.
  const returning = await rendererSurfacesFor({ availability, entries, workspaceCount: 3 })
  assert.equal(returning.autoOpensCreationHub, false)

  // The launch executes the probed absolute path. `claude` by name is what the
  // pre-fix launch ran, and this machine's login shell cannot resolve it — the
  // silent bare shell in the epic.
  assert.equal(loginShellResolves('claude'), false, 'the fixture must model the ~/.zshrc-only PATH')
  const spawn = await spawnAgentOn({
    machine: ZSHRC_ONLY_CLAUDE,
    entries,
    cli: 'claude-code',
    sessionId: 'zshrc-only-launch',
  })
  assert.equal(spawn.result.ok, true, JSON.stringify(spawn.result))
  assert.equal(spawn.spawnCalls.length, 1)
  const script = spawn.startupScript ?? ''
  const guarded = /command -v (\S+) >\/dev\/null/.exec(script)?.[1]
  assert.equal(guarded, NVM_CLAUDE_PATH, `the guard must test the probed path: ${script}`)
  assert.ok(loginShellResolves(guarded), 'the launch shell can resolve what the guard tests')
  assert.ok(
    script.includes(`${NVM_CLAUDE_PATH} --session-id zshrc-only-launch`),
    `the launch must invoke the probed path: ${script}`,
  )
  assert.ok(/exit 127; fi;/.test(script), `the guard must exit rather than fall through: ${script}`)
}

function createMockWebContents(): { isDestroyed(): boolean, send(channel: string, payload: unknown): void, sent: SentEvent[] } {
  return {
    sent: [],
    isDestroyed: () => false,
    send(channel: string, payload: unknown): void {
      this.sent.push({ channel, payload })
    },
  }
}

let nextMockPtyPid = 70_000

function createMockPtyProcess(): MockPtyProcess {
  const dataCallbacks = new Set<(data: string) => void>()
  const exitCallbacks = new Set<(event: { exitCode: number, signal?: number }) => void>()
  return {
    pid: nextMockPtyPid++,
    writes: [],
    killed: false,
    write(data: string): void {
      this.writes.push(data)
    },
    resize: () => undefined,
    kill(): void {
      this.killed = true
    },
    onData(callback) {
      dataCallbacks.add(callback)
      return { dispose: () => dataCallbacks.delete(callback) }
    },
    onExit(callback) {
      exitCallbacks.add(callback)
      return { dispose: () => exitCallbacks.delete(callback) }
    },
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
