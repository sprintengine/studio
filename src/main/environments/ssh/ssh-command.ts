import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// How Studio runs the system `ssh` for an SSH machine (phase 8 spec, 5.1).
//
// The person's own `ssh`, config, agent and keys: Studio never implements
// SSH, never reads `ssh_config` itself (`ssh -G` resolves an alias, with its
// `Include`, `Match` and `ProxyJump`), and overrides only what would break it
// or what is unsafe for a long-lived server:
//
// - `RemoteCommand=none`, `RequestTTY=no`, `ClearAllForwardings=yes`: a
//   config with a tmux-attach `RemoteCommand` or `LocalForward` lines would
//   otherwise refuse Studio's command (spec E1.7, E1.8);
// - `ForwardAgent=no`, `ForwardX11=no`: a server that outlives the session
//   would hold a forwarded agent socket that dies with it anyway, and remote
//   root could use it meanwhile;
// - keepalive (15 s × 3), so a dead path is noticed within 45 s;
// - `BatchMode=yes` for background reconnects only, so they never raise a
//   prompt over whatever the person is doing (spec E1.4).
//
// Never ours: `ProxyJump`, `ProxyCommand`, `IdentityFile`, `User`, `Port`,
// `UserKnownHostsFile`, `StrictHostKeyChecking`, `ControlMaster`. Studio never
// sets `StrictHostKeyChecking=no` or `accept-new`: a new host key is asked
// about, with its fingerprint, and a changed one is a hard failure.
//
// The destination is argv after `--`, and validated first, so a pasted or
// deep-linked `-oProxyCommand=…` is never an option, and no `%` token or shell
// character reaches a `ProxyCommand` expansion.

/** What a person typed for a machine, as ssh takes it. */
export type SshDestination = {
  /** What ssh is given after `--`: an alias, `user@host`, or `ssh://user@host:port`. */
  argv: string
  /** The words shown back: what they typed. */
  display: string
}

const FORBIDDEN = /[\s;|&$`'"<>()\\*?{}[\]!#~^,]/u
const CONTROL = /\p{Cc}/u
const USER = /^[\p{L}\p{N}._-]{1,64}$/u
const HOST = /^[\p{L}\p{N}._-]{1,253}$/u
const IPV6 = /^[0-9A-Fa-f:.]{2,45}(%[A-Za-z0-9_.-]{1,32})?$/u

export type DestinationCheck = { ok: true; destination: SshDestination } | { ok: false; message: string }

/**
 * A destination: an alias from the person's config, `user@host`, `host:port`,
 * `user@host:port`, or an IPv6 literal in brackets with a port. Refused when
 * it could be read as an option or carries a shell or ssh token character.
 */
export function parseDestination(input: string): DestinationCheck {
  const text = input.trim()
  const refuse = (why: string): DestinationCheck => ({ ok: false, message: `"${text}" ${why}` })
  if (!text) return { ok: false, message: 'Type an SSH host or an alias from your SSH config.' }
  if (text.length > 300) return refuse('is too long to be a host.')
  if (text.startsWith('-')) return refuse('starts with "-", which ssh would read as an option.')
  if (CONTROL.test(text)) return refuse('has control characters in it.')
  if (text.includes('%')) {
    // Only an IPv6 zone may carry one, and only inside brackets.
    if (!/^(?:[^@\s]+@)?\[[^\]]+%[A-Za-z0-9_.-]+\](?::\d+)?$/u.test(text)) return refuse('has a "%" in it.')
  }
  let user: string | null = null
  let rest = text
  const at = rest.lastIndexOf('@')
  if (at !== -1) {
    user = rest.slice(0, at)
    rest = rest.slice(at + 1)
    if (!USER.test(user)) return refuse('has a user name ssh would not take.')
  }
  let host = rest
  let port: number | null = null
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/u.exec(rest)
  if (bracketed) {
    host = bracketed[1]!
    if (!IPV6.test(host)) return refuse('has an address in brackets that is not IPv6.')
    if (bracketed[2]) port = Number(bracketed[2])
  } else {
    const colon = rest.lastIndexOf(':')
    if (colon !== -1 && rest.indexOf(':') === colon) {
      host = rest.slice(0, colon)
      const portText = rest.slice(colon + 1)
      if (!/^\d{1,5}$/u.test(portText)) return refuse('has a port that is not a number.')
      port = Number(portText)
    } else if (colon !== -1) {
      // A bare IPv6 address: no port can be told apart from it.
      if (!IPV6.test(rest)) return refuse('is not a host ssh can reach.')
      host = rest
    }
    if (!host.includes(':') && FORBIDDEN.test(host)) return refuse('has characters a host name cannot have.')
    if (!host.includes(':') && !HOST.test(host)) return refuse('is not a host name.')
  }
  if (port !== null && (port < 1 || port > 65_535)) return refuse('has a port outside 1–65535.')
  if (host.startsWith('-') || host.startsWith('.')) return refuse('is not a host name.')
  const hostPart = host.includes(':') ? `[${host}]` : host
  // ssh takes a port only as `-p` or in a URI; the URI keeps it one argv word after `--`.
  const argv = port !== null ? `ssh://${user ? `${user}@` : ''}${hostPart}:${port}` : `${user ? `${user}@` : ''}${host}`
  return { ok: true, destination: { argv, display: text } }
}

/** The fixed options every Studio session runs with, before the destination. */
export const SSH_FIXED_OPTIONS = [
  '-T',
  '-o',
  'RemoteCommand=none',
  '-o',
  'RequestTTY=no',
  '-o',
  'ClearAllForwardings=yes',
  '-o',
  'ForwardAgent=no',
  '-o',
  'ForwardX11=no',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=3',
  '-o',
  'ConnectTimeout=20',
] as const

/**
 * The argv of one session: `ssh <fixed> [-o BatchMode=yes] -- <destination> sh -s`.
 * `configFile` is `-F`: a config other than the person's own (the
 * integration suites' fixture; never set in the app today).
 */
export function buildSshArgs(
  destination: SshDestination,
  options: { batch: boolean; configFile?: string | null },
): string[] {
  return [
    ...(options.configFile ? ['-F', options.configFile] : []),
    ...SSH_FIXED_OPTIONS,
    ...(options.batch ? ['-o', 'BatchMode=yes'] : []),
    '--',
    destination.argv,
    'sh',
    '-s',
  ]
}

/** The argv that only resolves: `ssh -G -- <destination>`, which connects to nothing. */
export function buildResolveArgs(destination: SshDestination, configFile?: string | null): string[] {
  return [...(configFile ? ['-F', configFile] : []), '-G', '--', destination.argv]
}

export type SshAskpassEnv = { program: string; socket: string; token: string }

/**
 * The environment of one ssh spawn: the person's own (their agent socket, their
 * HOME), with prompts sent to Studio's askpass shim, and messages in the C
 * locale so they can be read. Nothing from the remote is ever put here.
 */
export function sshEnvironment(
  base: NodeJS.ProcessEnv,
  askpass: SshAskpassEnv | null,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, LC_ALL: 'C' }
  // What the app sets for its own children has no business in the person's ssh.
  for (const name of Object.keys(env)) if (name.startsWith('ELECTRON_')) delete env[name]
  delete env.SSH_ASKPASS
  delete env.SSH_ASKPASS_REQUIRE
  if (askpass) {
    env.SSH_ASKPASS = askpass.program
    env.SSH_ASKPASS_REQUIRE = 'force'
    env.SPRINTENGINE_ASKPASS_SOCKET = askpass.socket
    env.SPRINTENGINE_ASKPASS_TOKEN = askpass.token
  } else {
    // A background reconnect: nothing may ask (BatchMode says the same to ssh).
    env.SSH_ASKPASS_REQUIRE = 'never'
  }
  return env
}

/** Which ssh: the system's own first, then PATH; a Settings override wins. */
export function findSshBinary(
  options: {
    platform?: NodeJS.Platform
    override?: string | null
    env?: NodeJS.ProcessEnv
    exists?: (path: string) => boolean
  } = {},
): string {
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  if (options.override) return options.override
  if (platform === 'win32') {
    const root = (options.env ?? process.env).SystemRoot ?? 'C:\\Windows'
    const system = join(root, 'System32', 'OpenSSH', 'ssh.exe')
    return exists(system) ? system : 'ssh.exe'
  }
  return exists('/usr/bin/ssh') ? '/usr/bin/ssh' : 'ssh'
}

/** What `ssh -G` resolved: shown before a first connect, never used to connect. */
export type SshResolved = {
  hostname: string
  user: string
  port: number
  proxyJump: string | null
  strictHostKeyChecking: string | null
  forwardAgent: string | null
  controlMaster: string | null
  userKnownHostsFile: string | null
}

/** `ssh -G`'s `key value` lines as the fields Settings shows. */
export function parseSshG(output: string): SshResolved | null {
  const fields = new Map<string, string>()
  for (const line of output.split(/\r?\n/u)) {
    const space = line.indexOf(' ')
    if (space <= 0) continue
    const key = line.slice(0, space).toLowerCase()
    if (!fields.has(key)) fields.set(key, line.slice(space + 1).trim())
  }
  const hostname = fields.get('hostname')
  const user = fields.get('user')
  const port = Number(fields.get('port'))
  if (!hostname || !user || !Number.isInteger(port)) return null
  const proxy = fields.get('proxyjump')
  return {
    hostname,
    user,
    port,
    proxyJump: proxy && proxy !== 'none' ? proxy : null,
    strictHostKeyChecking: fields.get('stricthostkeychecking') ?? null,
    forwardAgent: fields.get('forwardagent') ?? null,
    controlMaster: fields.get('controlmaster') ?? null,
    userKnownHostsFile: fields.get('userknownhostsfile') ?? null,
  }
}

/** Resolve a destination with `ssh -G`, within five seconds. */
export function resolveDestination(
  ssh: string,
  destination: SshDestination,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; configFile?: string | null } = {},
): Promise<{ ok: true; resolved: SshResolved } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    const child = spawn(ssh, buildResolveArgs(destination, options.configFile), {
      env: sshEnvironment(options.env ?? process.env, null),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 5_000)
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, message: `Studio couldn't run ssh (${error.message}). Is OpenSSH installed?` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const resolved = code === 0 ? parseSshG(stdout) : null
      if (resolved) resolve({ ok: true, resolved })
      else
        resolve({
          ok: false,
          message: `${destination.display} isn't in your SSH config and isn't a host name${stderr.trim() ? ` (${stderr.trim().split('\n').at(-1)})` : ''}.`,
        })
    })
  })
}

/** The non-wildcard `Host` names in an ssh config: suggestions only, never what is connected to. */
export function configHostNames(config: string): string[] {
  const names = new Set<string>()
  for (const line of config.split(/\r?\n/u)) {
    const match = /^\s*Host\s+(.+)$/iu.exec(line)
    if (!match) continue
    for (const name of match[1]!.split(/\s+/u)) {
      if (!name || /[*?!]/u.test(name)) continue
      if (parseDestination(name).ok) names.add(name)
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

export type SshFailureCode =
  | 'host-key-changed'
  | 'host-key-refused'
  | 'permission-denied'
  | 'name-not-resolved'
  | 'connection-refused'
  | 'timed-out'
  | 'unreachable'
  | 'jump-failed'
  | 'remote-command'
  | 'stdio-forwarding'
  | 'needs-sign-in'
  | 'closed'
  | 'unknown'

export type SshFailure = { code: SshFailureCode; message: string; detail?: string }

/**
 * What a failed ssh said, as a sentence about `label` a person can act on.
 * Read from ssh's own fixed messages in the C locale, never from text the
 * remote could have chosen.
 */
export function classifySshFailure(stderr: string, label: string, options: { batch?: boolean } = {}): SshFailure {
  const text = stderr.replace(/\r/gu, '')
  const last = text.trim().split('\n').filter(Boolean).at(-1) ?? ''
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/u.test(text)) {
    const line = /Offending \S+ key in (\S+):(\d+)/u.exec(text)
    const knownHosts = line ? `${line[1]} line ${line[2]}` : 'your known_hosts file'
    const host = /Host key for (\S+) has changed/u.exec(text)?.[1]
    return {
      code: 'host-key-changed',
      message:
        `${label}'s host key has changed since you last connected, so Studio did not connect: someone may be ` +
        `intercepting the connection, or the machine was reinstalled. Check with whoever runs it. If the new key is ` +
        `right, remove the old one (${knownHosts}) with: ssh-keygen -R ${host ?? label}`,
      detail: knownHosts,
    }
  }
  if (/Host key verification failed/u.test(text)) {
    if (options.batch)
      return {
        code: 'needs-sign-in',
        message: `${label} isn't a known host yet. Connect to check its fingerprint.`,
      }
    return { code: 'host-key-refused', message: `${label}'s host key was not trusted, so Studio did not connect.` }
  }
  if (/Permission denied \(([^)]*)\)/u.test(text)) {
    const methods = /Permission denied \(([^)]*)\)/u.exec(text)![1]!
    if (options.batch && /password|keyboard-interactive/u.test(methods))
      return { code: 'needs-sign-in', message: `${label} needs you to sign in.` }
    return {
      code: 'permission-denied',
      message: `${label} turned the sign-in down (it accepts: ${methods.split(',').join(', ')}). Check the user name and that your key or password is the right one.`,
    }
  }
  // A jump host forwards with stdio (`-W`): its refusals come back as a
  // channel that did not open, or a connection closed by "UNKNOWN port 65535".
  if (/channel \d+: open failed|UNKNOWN port 65535/u.test(text))
    return { code: 'jump-failed', message: `The jump host on the way to ${label} did not let Studio through: ${last}` }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname provided/u.test(text))
    return {
      code: 'name-not-resolved',
      message: `${label}'s address could not be found. Check the host name, or your network or VPN.`,
    }
  if (/Connection refused/u.test(text))
    return {
      code: 'connection-refused',
      message: `${label} refused the connection. Is SSH running there, on that port?`,
    }
  if (/Connection timed out|Operation timed out|Timeout, server .* not responding/u.test(text))
    return {
      code: 'timed-out',
      message: `${label} did not answer in time. It may be off, asleep, or behind a network you are not on.`,
    }
  if (/No route to host|Network is unreachable/u.test(text))
    return { code: 'unreachable', message: `${label} can't be reached from this network.` }
  if (/Cannot execute command-line and remote command/u.test(text))
    return {
      code: 'remote-command',
      message: `${label}'s SSH config runs a command of its own (RemoteCommand) that Studio could not turn off.`,
    }
  if (/stdio forwarding failed/u.test(text))
    return {
      code: 'stdio-forwarding',
      message: `${label} does not allow forwarding to a socket (AllowStreamLocalForwarding).`,
    }
  if (/Connection closed|Connection reset|Broken pipe|closed by remote host/u.test(text))
    return { code: 'closed', message: `The connection to ${label} was lost.` }
  return { code: 'unknown', message: `Studio could not reach ${label}${last ? `: ${last}` : '.'}` }
}

/** What a spawned session needs from the askpass broker (askpass.ts), kept structural here. */
export type AskpassIssuer = { issue(label: string): { env: SshAskpassEnv; revoke(): void } }

/**
 * One session's ssh: interactive ones get an askpass token, revoked when the
 * process ends; background ones run BatchMode with no way to ask.
 */
export function spawnSshSession(input: {
  ssh: string
  destination: SshDestination
  label: string
  interactive: boolean
  askpass: AskpassIssuer | null
  configFile?: string | null
  env?: NodeJS.ProcessEnv
}) {
  const issued = input.interactive && input.askpass ? input.askpass.issue(input.label) : null
  const child = spawn(
    input.ssh,
    buildSshArgs(input.destination, { batch: !input.interactive, configFile: input.configFile ?? null }),
    {
      env: sshEnvironment(input.env ?? process.env, issued?.env ?? null),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  child.once('close', () => issued?.revoke())
  child.once('error', () => issued?.revoke())
  child.stdin.on('error', () => undefined)
  return child
}
