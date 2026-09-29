// A Claude chat on a WSL machine: its `claude` runs inside the distribution.
//
// The SDK builds the command line (`claude --output-format stream-json …`)
// and hands it to `spawnClaudeCodeProcess`; for a WSL chat that becomes one
// `wsl.exe` whose stdio is the child's. What runs inside is the person's own
// login shell (`bash -lic`, as a WSL terminal's startup does), so the chat's
// `claude` sees exactly what the one in their terminal sees: their PATH, the
// login and org settings under their Linux home, and whatever their profile
// exports (proxies, CA bundles, a gateway). Nothing of this PC's environment
// is carried in except the few variables that say which chat this is.
//
// Two things keep the stream clean. A profile that prints (a greeting, a
// version manager's notice) would write into the SDK's JSON stream, so the
// shell's stdout and stdin are parked on spare descriptors while the profile
// runs and handed back only to `claude`. They are 57 and 58 because an
// interactive login bash closes 3 through 19 as it starts. And the script travels base64-encoded in
// a single argument: `wsl.exe` re-reads its command line, and a quote or a
// `%` inside an argument is not guaranteed to survive that.

import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'

import { distroOfHostId, type ExecutionHostId } from '../../shared/execution-host'
import { toWslPath } from '../../shared/host-paths'
import { argvToPosixShellCommand } from '../agent-launch-render'
import { wslDistroArgs } from '../hosts/wsl-distro'

/**
 * The variables of the SDK's environment that go into the distribution: the
 * SDK's own marks and the chat's identity. Everything else is this PC's
 * (a Windows PATH, `APPDATA`, a Windows-side Claude setting) and would only
 * mislead a Linux `claude`.
 */
export const WSL_FORWARDED_ENV_KEYS = [
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_AGENT_SDK_CLIENT_APP',
  'SPRINTENGINE_WORKSPACE_ID',
  'SPRINTENGINE_AGENT_ID',
  'SPRINTENGINE_AGENT_NAME',
  'SPRINTENGINE_AGENT_CLI',
  'SPRINTENGINE_CONVERSATION_SESSION_ID',
] as const

/** Where a WSL chat's child runs, resolved once per spawn. */
export type WslClaudeTarget = {
  distro: string
  /** The helper's agent-state socket there, for the hooks a chat's `claude` runs; null when unknown. */
  agentStateSocketPath: string | null
}

/**
 * The `wsl.exe` argv that runs `command args` in `cwd` (as Linux names it)
 * inside `distro`, through the person's login shell.
 */
export function wslClaudeLaunchArgs(input: {
  distro: string
  cwd: string
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  agentStateSocketPath?: string | null
}): string[] {
  const assignments: string[] = []
  for (const key of WSL_FORWARDED_ENV_KEYS) {
    const value = input.env[key]
    if (value !== undefined && value !== '') assignments.push(`${key}=${value}`)
  }
  if (input.agentStateSocketPath) assignments.push(`SPRINTENGINE_AGENT_STATE_SOCKET=${input.agentStateSocketPath}`)
  // Runs after the profile: stdio back to `claude`, then the folder (a
  // profile may `cd`), then `claude` itself with the chat's variables.
  const inner = [
    'exec 1>&57 57>&- 0<&58 58<&-',
    input.cwd === '~' ? 'cd' : `cd -- ${argvToPosixShellCommand([input.cwd])} || exit 1`,
    `exec ${argvToPosixShellCommand(['env', ...assignments, input.command, ...input.args])}`,
  ].join('\n')
  // Parks stdout and stdin while the login shell reads the profile; anything
  // it prints lands on stderr, which the provider only keeps a tail of.
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

/** What the SDK asks the provider to spawn, in the fields this module reads. */
export type ClaudeSpawnRequest = {
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string | undefined>
  signal?: AbortSignal
}

/**
 * Spawns the SDK's request inside the distribution. `request.command` is
 * already the Linux path of `claude` (the WSL host's CLI detection found it
 * there) and `request.cwd` the native workspace folder.
 */
export function spawnWslClaude(target: WslClaudeTarget, request: ClaudeSpawnRequest): ChildProcess {
  const args = wslClaudeLaunchArgs({
    distro: target.distro,
    cwd: request.cwd ? toWslPath(request.cwd) : '~',
    command: request.command,
    args: request.args,
    env: request.env,
    agentStateSocketPath: target.agentStateSocketPath,
  })
  return spawn('wsl.exe', args, {
    // `wsl.exe` itself needs nothing of the folder, and a `\\wsl.localhost`
    // path is not a directory every Windows process can start in.
    cwd: homedir(),
    env: request.env as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: request.signal,
    windowsHide: true,
  })
}

/**
 * Gets a WSL machine ready for a chat: the helper started (so a broken
 * distribution fails here, with the reason) and its agent-state socket known.
 */
export async function prepareWslClaudeTarget(hostId: ExecutionHostId): Promise<WslClaudeTarget> {
  const distro = distroOfHostId(hostId)
  if (!distro) throw new Error(`"${hostId}" is not a WSL machine.`)
  const { hostRegistry } = await import('../hosts/host-registry')
  const host = hostRegistry().get(hostId)
  await host.prepare()
  return { distro, agentStateSocketPath: host.agentIntegration()?.agentStateSocketPath ?? null }
}
