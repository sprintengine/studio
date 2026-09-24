import type {
  AgentCli,
  AgentCliAvailabilityMap,
  CliAvailability,
  CliDetectResult,
  CliRuntimeSettings,
  PluginDetectAvailabilityInput,
  TerminalSpawnResult,
} from '../shared/electron-api'
import type { PluginRegistryListEntry } from '../shared/plugin-manifest'
import { detectCli, detectCliBatch, invalidateLoginShellPath, resolveInstallPlatform } from './cli-runtime-install'
import { userShellProbeSupported } from './login-shell-path'
import { LOCAL_HOST_ID, isWslHostId, type ExecutionHostId } from '../shared/execution-host'
import { listPluginRegistryEntries } from './plugin-registry-instance'

// Binary detection starts a process per installed CLI (its `--version`) on macOS
// and Linux, after one login shell per app session has said what PATH the
// person has; on Windows it is one process per target (see `detectCliBatch`).
// Probing every registered agent CLI on each renderer focus refresh would be
// heavy either way. We cache successful probes, keyed by the exact (cli,
// command, machine) the probe ran against, and bypass the cache on `force`
// (used right after an install) so a freshly installed CLI appears immediately.
//
// macOS and Linux hold the answer for fifteen minutes. The refreshes come from
// window focus and visibility, so a shorter life meant a person switching
// between this window and another re-ran every `--version` (a Node start
// each, for most CLIs) about once a minute to learn nothing: a CLI installed
// from the app forces its own refresh, and one installed from a terminal is
// rare enough to wait, or to be picked up by the re-check button in Settings.
//
// Windows holds the answer longer. There a probe is a `powershell.exe` (or a
// `wsl.exe` login shell), each one boots for a second or more, and
// Windows can show its working-in-background cursor over the app while a
// process it started is still starting. At a minute, a person moving between
// this window and another paid for that burst every minute. An
// install from the app still shows at once (it forces), and one made outside
// it waits five minutes instead of one.
const DEFAULT_CACHE_TTL_MS = process.platform === 'win32' ? 5 * 60_000 : 15 * 60_000

const KEY_SEP = '\0'

type CacheEntry = { availability: CliAvailability; expiresAt: number }

const cache = new Map<string, CacheEntry>()

// Probes still running, keyed like the cache. A probe is a process start per CLI
// — on Windows a `powershell.exe` or `wsl.exe`, each of which takes a second or
// more to boot — and the callers are
// many and uncoordinated: window focus and visibility both refresh the pickers
// in every window, and boot discovery, model discovery and the version advisory
// all ask as well. Without this, each of those arriving before the first probe
// has answered started its own, and a burst of focus changes stacked them up.
const inFlight = new Map<string, Promise<CliDetectResult>>()

function cacheKey(cli: AgentCli, command: string, hostId: ExecutionHostId): string {
  return [cli, command, hostId].join(KEY_SEP)
}

function hostIdOf(runtime: Partial<CliRuntimeSettings> | undefined): ExecutionHostId {
  const hostId = runtime?.hostId
  return isWslHostId(hostId) ? hostId : LOCAL_HOST_ID
}

function normalizeCommand(runtime: Partial<CliRuntimeSettings> | undefined): string {
  return typeof runtime?.command === 'string' ? runtime.command.trim() : ''
}

// Drop cached availability for a CLI (every command and machine) or, with no
// argument, the whole cache. Called after a successful install so the next
// probe re-detects instead of returning a stale "not installed".
export function invalidateCliAvailability(cli?: AgentCli): void {
  // An install is what adds a directory to the person's shell config, so the
  // login-shell PATH is asked again as well.
  invalidateLoginShellPath()
  // A probe already running was started before whatever made the caller
  // invalidate, so its answer is as stale as the cache entry: forget it too.
  if (!cli) {
    cache.clear()
    inFlight.clear()
    return
  }
  const prefix = `${cli}${KEY_SEP}`
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
  for (const key of [...inFlight.keys()]) {
    if (key.startsWith(prefix)) inFlight.delete(key)
  }
}

// Drop cached availability for everything on one machine: a WSL helper saw a
// PATH directory change there (a CLI installed or removed from a terminal).
export function invalidateCliAvailabilityOnHost(hostId: ExecutionHostId): void {
  const suffix = `${KEY_SEP}${hostId}`
  for (const key of [...cache.keys()]) {
    if (key.endsWith(suffix)) cache.delete(key)
  }
}

// Test seam: reset module state between cases.
export function clearCliAvailabilityCache(): void {
  cache.clear()
  inFlight.clear()
  maxConcurrentProbes = DEFAULT_MAX_CONCURRENT_PROBES
}

// Test seam: the Windows probe limit, asserted from any platform.
export function setMaxConcurrentCliProbes(limit: number): void {
  maxConcurrentProbes = limit
}

// How many probes run at once. On Windows each is a `powershell.exe` (or a
// `wsl.exe` login shell) that costs tens of megabytes and a second or more of
// CPU to start, and the registry holds around ten CLIs: all of them at once is
// a spike of process starts every time the cache runs out, arriving on window
// focus — the moment the person is about to type. A few at a time spreads that
// out; the answer is for background pickers, so it can afford to arrive later.
// POSIX probes are a directory walk and one `--version` each, sharing one
// login-shell PATH, and stay unbounded.
const DEFAULT_MAX_CONCURRENT_PROBES = process.platform === 'win32' ? 3 : Number.POSITIVE_INFINITY
let maxConcurrentProbes = DEFAULT_MAX_CONCURRENT_PROBES

let runningProbes = 0
const probeQueue: Array<() => void> = []

async function withProbeSlot<T>(run: () => Promise<T>): Promise<T> {
  // A finished probe hands its slot straight to the next waiter rather than
  // freeing it, so a caller arriving in between cannot take it as well.
  if (runningProbes >= maxConcurrentProbes) await new Promise<void>((resolve) => probeQueue.push(resolve))
  else runningProbes += 1
  try {
    return await run()
  } finally {
    const next = probeQueue.shift()
    if (next) next()
    else runningProbes -= 1
  }
}

// One probe per key at a time. A `force` caller (right after an install) must
// not be handed a probe that started before the install finished, so it starts
// its own — and becomes the one later callers join.
function probeOnce(key: string, force: boolean, run: () => Promise<CliDetectResult>): Promise<CliDetectResult> {
  const running = force ? undefined : inFlight.get(key)
  if (running) return running
  return trackInFlight(key, withProbeSlot(run))
}

// Registers a probe as the one in flight for `key` until it settles.
function trackInFlight(key: string, running: Promise<CliDetectResult>): Promise<CliDetectResult> {
  const probe = running.finally(() => {
    if (inFlight.get(key) === probe) inFlight.delete(key)
  })
  inFlight.set(key, probe)
  return probe
}

export type DetectAgentCliAvailabilityDeps = {
  listEntries?: () => PluginRegistryListEntry[]
  detect?: (cli: AgentCli, runtime?: Partial<CliRuntimeSettings>) => Promise<CliDetectResult>
  // Probes many CLIs of one target in one process. Used on Windows, where each
  // probe process costs a second or more; a caller that injects only `detect`
  // (a test) keeps the per-CLI path.
  detectBatch?: (
    requests: Array<{ cli: AgentCli; runtime?: Partial<CliRuntimeSettings> }>,
  ) => Promise<CliDetectResult[]>
  platform?: NodeJS.Platform
  now?: () => number
  ttlMs?: number
}

function probeFailure(
  cli: AgentCli,
  runtime: Partial<CliRuntimeSettings> | undefined,
  error: unknown,
): CliDetectResult {
  return {
    cli,
    binary: normalizeCommand(runtime) || cli,
    installed: false,
    version: null,
    resolvedPath: null,
    hostId: hostIdOf(runtime),
    error: error instanceof Error ? error.message : String(error),
  }
}

// Probe every registered agent CLI and report which binaries are actually
// installed. Honors per-CLI command overrides, and the machine each names,
// forwarded by the renderer so detection matches the launch path. Probes run concurrently;
// only successful probes (no error) are cached.
//
// On Windows the cache misses are grouped by machine — each WSL distribution,
// and this PC natively — and each group is ONE probe process, however
// many CLIs it holds. Each CLI's key is still registered as in flight, so a
// caller arriving while the batch runs joins it rather than starting another.
export async function detectAgentCliAvailability(
  input?: PluginDetectAvailabilityInput,
  deps: DetectAgentCliAvailabilityDeps = {},
): Promise<AgentCliAvailabilityMap> {
  const listEntries = deps.listEntries ?? listPluginRegistryEntries
  const detect = deps.detect ?? detectCli
  const platform = deps.platform ?? process.platform
  const detectBatch =
    platform === 'win32'
      ? (deps.detectBatch ?? (deps.detect ? undefined : (requests) => detectCliBatch(requests)))
      : undefined
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? DEFAULT_CACHE_TTL_MS
  const runtimes = input?.cliRuntimes ?? {}
  const force = input?.force ?? false

  const entries = listEntries()
  const result: AgentCliAvailabilityMap = {}
  // A forced refresh is "look again, something changed": the PATH is part of
  // what may have. Dropped once, before any probe starts, so every probe in
  // this refresh shares the one shell that answers it.
  if (force) invalidateLoginShellPath()

  const record = (cli: AgentCli, key: string, detected: CliDetectResult): void => {
    // A transient probe failure (shell spawn error, not a clean "not found")
    // reports installed:false, which the renderer cannot distinguish from a
    // real absence. Treating it as "not installed" would wrongly HIDE an
    // actually-installed CLI from deployment pickers. So on error we omit the
    // CLI from the map entirely — the renderer treats a missing entry as
    // "unknown" and keeps it visible — and skip the cache so the next refresh
    // re-probes. Only a definitive probe (error === null) decides installed.
    if (detected.error !== null) return
    const availability: CliAvailability = {
      cli,
      installed: detected.installed,
      resolvedPath: detected.resolvedPath,
      version: detected.version,
    }
    result[cli] = availability
    cache.set(key, { availability, expiresAt: now() + ttlMs })
  }

  const tasks: Promise<void>[] = []
  const batches = new Map<string, Array<{ cli: AgentCli; runtime?: Partial<CliRuntimeSettings>; key: string }>>()
  for (const entry of entries) {
    const cli = entry.id
    const runtime = runtimes[cli]
    const command = normalizeCommand(runtime)
    const hostId = hostIdOf(runtime)
    const key = cacheKey(cli, command, hostId)

    if (!force) {
      const cached = cache.get(key)
      if (cached && cached.expiresAt > now()) {
        result[cli] = cached.availability
        continue
      }
      const running = inFlight.get(key)
      if (running) {
        tasks.push(running.then((detected) => record(cli, key, detected)))
        continue
      }
    }

    if (detectBatch) {
      const group = hostId
      const members = batches.get(group) ?? []
      members.push({ cli, ...(runtime ? { runtime } : {}), key })
      batches.set(group, members)
      continue
    }

    tasks.push(probeOnce(key, force, () => detect(cli, runtime)).then((detected) => record(cli, key, detected)))
  }

  for (const members of batches.values()) {
    const batch = withProbeSlot(() => detectBatch!(members.map(({ cli, runtime }) => ({ cli, runtime }))))
    for (const member of members) {
      const probe = batch
        .then(
          (results) =>
            results.find((detected) => detected.cli === member.cli) ??
            probeFailure(member.cli, member.runtime, 'The batch returned no answer for this CLI.'),
        )
        .catch((error: unknown) => probeFailure(member.cli, member.runtime, error))
      trackInFlight(member.key, probe)
      tasks.push(probe.then((detected) => record(member.cli, member.key, detected)))
    }
  }

  await Promise.all(tasks)
  return result
}

// Exit code reported for a spawn refused because its agent CLI binary could not
// be resolved. 127 is the shell's own "command not found", and the in-script
// guard exits with it too, so both halves of the failure read alike.
const AGENT_CLI_NOT_FOUND_EXIT = 127

// What the launch path learned about an agent CLI's binary before spawning it.
// `unknown` is a real answer, not a soft failure: the probe could not decide, so
// the launch proceeds exactly as it did before this pre-flight existed.
export type AgentCliLaunchPreflight =
  { status: 'resolved'; binaryPath: string } | { status: 'unknown' } | { status: 'missing'; message: string }

// Resolves the binary a launch should execute, and refuses the launch when the
// CLI is definitively absent.
//
// Why the launch cannot just render the manifest binary name: availability is
// looked up on the PATH the user's own interactive shell reports (`$SHELL -ilc`,
// which sources ~/.zshrc) while agents launch in a non-interactive login shell
// that does not. A CLI whose PATH entry lives only in ~/.zshrc — the common
// fresh-Mac nvm/installer setup — is therefore detected as installed and then
// invisible at launch. Executing the probe's own absolute `resolvedPath` closes
// that gap.
//
// The verdict rides `detectAgentCliAvailability`'s cache (invalidated after an
// install), so repeat spawns do not re-probe; only this CLI is probed on a
// cache miss.
export async function preflightAgentCliLaunch(
  input: {
    cli: AgentCli
    cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
    platform?: NodeJS.Platform
    shell?: string
  },
  deps: DetectAgentCliAvailabilityDeps = {},
): Promise<AgentCliLaunchPreflight> {
  const listEntries = deps.listEntries ?? listPluginRegistryEntries
  const runtime = input.cliRuntimes?.[input.cli]
  const target = resolveInstallPlatform(input.platform ?? process.platform, runtime?.hostId)
  // Without the user's own shell to ask for a PATH (Windows, WSL, fish, no
  // $SHELL) an "absent" verdict only means a plain `bash -lc` could not see the
  // binary — not that it is missing. Blocking on that would refuse launches that
  // work today, so those setups keep their existing behaviour.
  if (!userShellProbeSupported(target, input.shell ?? process.env.SHELL)) return { status: 'unknown' }

  const entry = listEntries().find((candidate) => candidate.id === input.cli)
  if (!entry) return { status: 'unknown' }

  const availability = await detectAgentCliAvailability(
    { cliRuntimes: input.cliRuntimes },
    { ...deps, listEntries: () => [entry] },
  )
  const detected = availability[input.cli]
  // Absent from the map means the probe errored (see above) — never a verdict.
  if (!detected) return { status: 'unknown' }
  if (!detected.installed) {
    return {
      status: 'missing',
      message:
        `${entry.displayName} is not installed on this machine, so nothing was started. ` +
        'Install it from Settings → Agents, or set its command there.',
    }
  }
  // The probe only reports an absolute executable path, so a resolved path is
  // spawnable as-is; an installed CLI with no path still launches by name,
  // exactly as before.
  const binaryPath = detected.resolvedPath?.trim()
  if (!binaryPath || !binaryPath.startsWith('/')) return { status: 'unknown' }
  return { status: 'resolved', binaryPath }
}

// The spawn IPC's failure value for a refused launch. Lives beside the verdict
// so the shape the renderer receives is asserted where the verdict is produced;
// `terminal-runtime` returns exactly this.
export function agentCliLaunchFailureResult(
  preflight: AgentCliLaunchPreflight,
  sessionId: string,
): TerminalSpawnResult | null {
  if (preflight.status !== 'missing') return null
  return { ok: false, sessionId, message: preflight.message, exitCode: AGENT_CLI_NOT_FOUND_EXIT }
}
