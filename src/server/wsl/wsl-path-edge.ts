import type { ExecutionHostId } from '../../shared/execution-host'
import { distroOfUncPath, isWindowsPath, toWslPath, wslToWindowsPath } from '../../shared/host-paths'

// Paths at the edge between the Windows front door and a WSL server (phase 7
// spec, 5.6). The server speaks Linux paths end to end; the front door's
// callers speak the workspace root as Windows spells it. Only the typed path
// fields the router forwards are translated: a chat's root and key, the
// commands and arguments of a stdio MCP server, a mention or a skill named by
// a Windows path, and the few typed paths that come back (a plan's file, a
// handoff's root, an approval rule's root). Free text and tool inputs inside
// events are left as the agent wrote them.

export class WslEdgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WslEdgeError'
  }
}

export type WslPathEdge = {
  readonly distro: string
  /** A workspace root as the server spells it. Throws `WslEdgeError` for a drive path when the distribution mounts none. */
  rootIn(root: string): string
  /** A Linux path from the server as Windows opens it: the root it was handed back in its own spelling. */
  pathOut(path: string): string
  /** A call's arguments as the server takes them. */
  args(member: string, args: unknown[]): unknown[]
  /** A call's answer as the front door's callers read it. */
  result(member: string, value: unknown): unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createWslPathEdge(input: { distro: string; driveMountRoot: string | null }): WslPathEdge {
  const { distro, driveMountRoot } = input
  // Each root handed in, by its Linux spelling, so a root handed back reads
  // exactly as its caller wrote it (`\\wsl$\…` stays `\\wsl$\…`).
  const spelled = new Map<string, string>()

  const toLinux = (path: string): string => {
    if (!isWindowsPath(path)) return path
    const uncDistro = distroOfUncPath(path)
    if (uncDistro !== null) {
      if (uncDistro.toLowerCase() !== distro.toLowerCase())
        throw new WslEdgeError(`${path} is in WSL: ${uncDistro}, not in ${distro}.`)
      return toWslPath(path)
    }
    if (path.startsWith('\\\\')) throw new WslEdgeError(`${path} is a network share, which WSL: ${distro} cannot open.`)
    if (driveMountRoot === null)
      throw new WslEdgeError(
        `WSL: ${distro} mounts no Windows drives (automount is off in its /etc/wsl.conf), so a chat in ${path} cannot run there.`,
      )
    return toWslPath(path, { driveMountRoot })
  }

  const rootIn = (root: string): string => {
    const linux = toLinux(root)
    spelled.set(linux, root)
    return linux
  }

  const pathOut = (path: string): string => {
    if (!path.startsWith('/')) return path
    const exact = spelled.get(path)
    if (exact) return exact
    for (const [linux, windows] of spelled) {
      if (path.startsWith(`${linux}/`)) {
        const rest = path.slice(linux.length + 1)
        const separator = windows.includes('\\') ? '\\' : '/'
        return `${windows.replace(/[\\/]+$/u, '')}${separator}${rest.split('/').join(separator)}`
      }
    }
    return wslToWindowsPath(path, { distro, ...(driveMountRoot ? { driveMountRoot } : {}) })
  }

  const keyIn = (key: unknown): unknown =>
    isRecord(key) && typeof key.workspaceRoot === 'string' ? { ...key, workspaceRoot: rootIn(key.workspaceRoot) } : key

  const mcpServersIn = (servers: unknown): unknown =>
    Array.isArray(servers)
      ? servers.map((server) =>
          isRecord(server) && server.transport === 'stdio'
            ? {
                ...server,
                ...(typeof server.command === 'string' ? { command: toLinux(server.command) } : {}),
                ...(Array.isArray(server.args)
                  ? {
                      args: server.args.map((arg) =>
                        typeof arg === 'string' && isWindowsPath(arg) ? toLinux(arg) : arg,
                      ),
                    }
                  : {}),
              }
            : server,
        )
      : servers

  const firstIn = (member: string, first: unknown): unknown => {
    if (!isRecord(first)) return first
    let next: Record<string, unknown> = first
    if (typeof next.workspaceRoot === 'string') next = { ...next, workspaceRoot: rootIn(next.workspaceRoot) }
    if (isRecord(next.key)) next = { ...next, key: keyIn(next.key) }
    if (member === 'startSession' && next.mcpServers !== undefined)
      next = { ...next, mcpServers: mcpServersIn(next.mcpServers) }
    if (member === 'sendTurn') {
      if (Array.isArray(next.mentions))
        next = {
          ...next,
          mentions: next.mentions.map((mention) =>
            isRecord(mention) && typeof mention.path === 'string' && isWindowsPath(mention.path)
              ? { ...mention, path: toLinux(mention.path) }
              : mention,
          ),
        }
      if (Array.isArray(next.skills))
        next = {
          ...next,
          skills: next.skills.map((skill) =>
            isRecord(skill) && typeof skill.sourcePath === 'string' && isWindowsPath(skill.sourcePath)
              ? { ...skill, sourcePath: toLinux(skill.sourcePath) }
              : skill,
          ),
        }
    }
    return next
  }

  return {
    distro,
    rootIn,
    pathOut,
    args(member, args) {
      if (args.length === 0) return args
      return [firstIn(member, args[0]), ...args.slice(1)]
    },
    result(member, value) {
      if (!isRecord(value)) return value
      if (member === 'planDocument' && value.ok === true && typeof value.path === 'string')
        return { ...value, path: pathOut(value.path) }
      if (member === 'terminalHandoffTarget' && value.ok === true && isRecord(value.target)) {
        const target = value.target
        const cliRuntimes = isRecord(target.cliRuntimes)
          ? Object.fromEntries(
              Object.entries(target.cliRuntimes).map(([cli, runtime]) => [
                cli,
                // The server ran it locally; the terminal that takes over runs it in this distribution.
                isRecord(runtime) ? { ...runtime, hostId: `wsl:${distro}` as ExecutionHostId } : runtime,
              ]),
            )
          : target.cliRuntimes
        return {
          ...value,
          target: {
            ...target,
            ...(typeof target.workspaceRoot === 'string' ? { workspaceRoot: pathOut(target.workspaceRoot) } : {}),
            ...(cliRuntimes ? { cliRuntimes } : {}),
          },
        }
      }
      if (member === 'listApprovalRules' && value.ok === true && Array.isArray(value.rules))
        return {
          ...value,
          rules: value.rules.map((rule) =>
            isRecord(rule) && typeof rule.workspaceRoot === 'string'
              ? { ...rule, workspaceRoot: pathOut(rule.workspaceRoot) }
              : rule,
          ),
        }
      return value
    },
  }
}
