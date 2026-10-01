// An agent CLI's stdio child on the machine its runtime names: this one, or a
// WSL distribution.
//
// Every chat runtime that drives a CLI over stdio (Claude Code through the
// SDK, Codex's app-server, the ACP agents) starts it here, so a chat on a WSL
// machine runs that machine's CLI the same way whichever CLI it is. On this
// machine the child is started directly, through its shim on Windows
// (`cliSpawnTarget`). On a WSL machine it becomes one `wsl.exe` whose stdio is
// the child's, and what runs inside is the person's own login shell
// (`bash -lic`, as a WSL terminal's startup does): the CLI sees exactly what
// the one in their terminal sees, their PATH, the login and settings under
// their Linux home, and whatever their profile exports (proxies, CA bundles,
// a gateway). Nothing of this PC's environment is carried in except the
// variables the runtime names, because a Windows PATH, `APPDATA` or a
// Windows-side setting would only mislead a Linux CLI.
//
// Two things keep the stream clean. A profile that prints (a greeting, a
// version manager's notice) would write into the protocol on stdout, so the
// shell's stdout and stdin are parked on spare descriptors while the profile
// runs and handed back only to the CLI. They are 57 and 58 because an
// interactive login bash closes 3 through 19 as it starts. And the script
// travels base64-encoded in a single argument: `wsl.exe` re-reads its command
// line, and a quote or a `%` inside an argument is not guaranteed to survive
// that.

import type { SpawnOptionsWithStdioTuple, StdioPipe } from 'node:child_process'
import { homedir } from 'node:os'

import { distroOfHostId, isWslHostId, type ExecutionHostId } from '../../shared/execution-host'
import { isWindowsPath, toWslPath } from '../../shared/host-paths'
import type { ConversationMcpServer } from '../../shared/conversation-runtime'
import { argvToPosixShellCommand } from '../agent-launch-render'
import { wslDistroArgs } from '../hosts/wsl-distro'
import { cliSpawnTarget } from './cli-child-process'

/**
 * The variables that say which chat a child belongs to, carried into a
 * distribution for every runtime. The agent-state socket is not among them:
 * this PC's socket path means nothing in Linux, and the distribution's own
 * comes from its helper (`WslCliTarget.agentStateSocketPath`).
 */
export const CONVERSATION_IDENTITY_ENV_KEYS = [
  'SPRINTENGINE_WORKSPACE_ID',
  'SPRINTENGINE_AGENT_ID',
  'SPRINTENGINE_AGENT_NAME',
  'SPRINTENGINE_AGENT_CLI',
  'SPRINTENGINE_CONVERSATION_SESSION_ID',
] as const

/** Where a WSL chat's child runs, resolved once per spawn. */
export type WslCliTarget = {
  distro: string
  /** The helper's agent-state socket there, for the hooks a chat's CLI runs; null when unknown. */
  agentStateSocketPath: string | null
}

/** A WSL target with what a runtime carries into it of the child's environment. */
export type WslCliChild = WslCliTarget & {
  /** The names whose values in `env` are set inside the distribution; nothing else goes in. */
  forwardEnv: readonly string[]
  /**
   * Variables removed from the login shell's environment before the CLI
   * starts: auth a runtime keeps its child off (an API key the profile
   * exports would take the chat off the person's login, as it would here).
   */
  unsetEnv?: readonly string[]
}

/**
 * The `wsl.exe` argv that runs `command args` in `cwd` (as Linux names it)
 * inside `distro`, through the person's login shell.
 */
export function wslCliLaunchArgs(input: {
  distro: string
  cwd: string
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  forwardEnv: readonly string[]
  unsetEnv?: readonly string[]
  agentStateSocketPath?: string | null
}): string[] {
  const assignments: string[] = []
  for (const key of input.forwardEnv) {
    const value = input.env[key]
    if (value !== undefined && value !== '') assignments.push(`${key}=${value}`)
  }
  if (input.agentStateSocketPath) assignments.push(`SPRINTENGINE_AGENT_STATE_SOCKET=${input.agentStateSocketPath}`)
  const unset = (input.unsetEnv ?? []).flatMap((key) => ['-u', key])
  // Runs after the profile: stdio back to the CLI, then the folder (a
  // profile may `cd`), then the CLI itself with the chat's variables.
  const inner = [
    'exec 1>&57 57>&- 0<&58 58<&-',
    input.cwd === '~' ? 'cd' : `cd -- ${argvToPosixShellCommand([input.cwd])} || exit 1`,
    `exec ${argvToPosixShellCommand(['env', ...unset, ...assignments, input.command, ...input.args])}`,
  ].join('\n')
  // Parks stdout and stdin while the login shell reads the profile; anything
  // it prints lands on stderr, which the providers only keep a tail of.
  const outer = [
    'exec 57>&1 1>&2 58<&0 0</dev/null',
    `exec ${argvToPosixShellCommand(['bash', '-lic', inner, 'bash'])}`,
  ].join('\n')
  const encoded = Buffer.from(outer, 'utf8').toString('base64')
  // `set -f` and an empty IFS make the decoded script one word, unglobbed, so
  // `eval` runs it exactly as written.
  return [
    ...wslDistroArgs(input.distro),
    '--cd',
    '~',
    '--exec',
    'bash',
    '-c',
    `set -f;IFS=;eval $(echo ${encoded}|base64 -d)`,
  ]
}

type PipedSpawnOptions = SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe> & {
  windowsVerbatimArguments?: boolean
}

/** What `spawn` is called with for one CLI child. */
export type CliHostSpawn = { file: string; args: string[]; options: PipedSpawnOptions }

/**
 * How to start a CLI as a stdio child on its machine. `command` is the path the
 * runtime's CLI detection found on that machine (a Linux path for WSL), and
 * `cwd` the workspace folder as this machine names it; a WSL child gets it as
 * the distribution names it (`/home/…`, `/mnt/c/…`).
 */
export function cliHostSpawn(
  input: {
    command: string
    args: readonly string[]
    cwd: string
    env: NodeJS.ProcessEnv
    wsl?: WslCliChild | null
  },
  deps: { platform?: NodeJS.Platform; homedir?: () => string } = {},
): CliHostSpawn {
  const base = {
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'] as [StdioPipe, StdioPipe, StdioPipe],
    windowsHide: true,
  }
  if (!input.wsl) {
    const target = cliSpawnTarget(input.command, [...input.args], { platform: deps.platform, env: input.env })
    return {
      file: target.file,
      args: target.args,
      options: {
        ...base,
        cwd: input.cwd,
        ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      },
    }
  }
  return {
    file: 'wsl.exe',
    args: wslCliLaunchArgs({
      distro: input.wsl.distro,
      cwd: input.cwd ? toWslPath(input.cwd) : '~',
      command: input.command,
      args: input.args,
      env: input.env,
      forwardEnv: input.wsl.forwardEnv,
      unsetEnv: input.wsl.unsetEnv,
      agentStateSocketPath: input.wsl.agentStateSocketPath,
    }),
    // `wsl.exe` itself needs nothing of the folder, and a `\\wsl.localhost`
    // path is not a directory every Windows process can start in.
    options: { ...base, cwd: (deps.homedir ?? homedir)() },
  }
}

/**
 * Gets a WSL machine ready for a chat: the helper started (so a broken
 * distribution fails here, with the reason) and its agent-state socket known.
 */
export async function prepareWslCliTarget(hostId: ExecutionHostId): Promise<WslCliTarget> {
  const distro = distroOfHostId(hostId)
  if (!distro) throw new Error(`"${hostId}" is not a WSL machine.`)
  const { hostRegistry } = await import('../hosts/host-registry')
  const host = hostRegistry().get(hostId)
  await host.prepare()
  return { distro, agentStateSocketPath: host.agentIntegration()?.agentStateSocketPath ?? null }
}

/**
 * The WSL target for a runtime's host id, or null when it runs on this
 * machine. `prepare` stands in for the host registry in tests.
 */
export async function wslTargetForHost(
  hostId: string | null | undefined,
  prepare: (hostId: ExecutionHostId) => Promise<WslCliTarget> = prepareWslCliTarget,
): Promise<WslCliTarget | null> {
  return isWslHostId(hostId) ? prepare(hostId) : null
}

/** The machine a runtime's host id names, as an error message says it. */
export function hostMachineName(hostId: string): string {
  return hostId.replace(/^wsl:/u, 'WSL: ')
}

/**
 * A chat's MCP servers as a CLI in WSL is handed them. Their entries were
 * built on this PC, so a stdio server's `command` and `args` may name `C:\…`
 * or `\\wsl.localhost\…` paths, which a Linux process cannot open; each such
 * path becomes the path in the distribution. Anything else (a bare `npx`, a
 * flag, a URL) is left exactly as written.
 */
export function mcpServersOnWsl(servers: readonly ConversationMcpServer[]): ConversationMcpServer[] {
  return servers.map((server) =>
    server.transport === 'stdio'
      ? {
          ...server,
          ...(server.command ? { command: wslArg(server.command) } : {}),
          ...(server.args ? { args: server.args.map(wslArg) } : {}),
        }
      : server,
  )
}

/** One argument as a Linux process in WSL needs it: a Windows path translated, anything else as it is. */
export function wslArg(value: string): string {
  return isWindowsPath(value) ? toWslPath(value) : value
}
