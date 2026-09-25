// Moving what an earlier build wrote onto the Studio launcher, in place.
//
// A hook or gateway entry written before the launcher names a Node and a
// script directly — `node "<repo>/.sprintengine/hooks/agent-state.mjs" …`, the
// app's executable and its bridge, or a distribution's pinned Node and a
// versioned payload folder. Every such entry carries the app's marker (a block
// marker, a tag, or a command shape nothing else writes), so it is rewritten to
// the launcher form where it stands, with its socket, wrapped status line and
// environment carried over. Each file is read, changed only where an entry of
// ours is found, and written back only when something changed.
//
// Runs at every start over the files the ledger lists: the launch-time
// installers already write the new form, and this reaches the checkouts nobody
// launches in again — which are exactly the ones an uninstall would otherwise
// leave broken.

import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { STUDIO_MCP_SERVER_ID } from '../../shared/product-identity'
import { isRecord } from '../../shared/records'
import { AGENT_STATE_TOML_END, AGENT_STATE_TOML_START, isStatusLineForwarderCommand } from '../agent-state'
import { withConfigFileLock, writeFileAtomically } from '../config-file-write'
import { isManagedStudioGatewayEntry, MANAGED_END, MANAGED_START } from '../mcp-config-service'
import {
  buildLauncherCommand,
  buildLauncherMcpServer,
  isLauncherMcpServer,
  launcherRefForHome,
  type LauncherShell,
  type LauncherTarget,
  type StudioLauncherRef,
} from './launcher'
import type { IntegrationLedgerEntry } from './ledger'

/** Mirrors the install's `MAX_STATUS_LINE_RENDERED_COMMAND_LENGTH` (agent-state.ts). */
const MAX_MIGRATED_STATUS_LINE_LENGTH = 7000

/** Where a distribution's app data lives; a path under it names the home it is in. */
const WSL_DATA_MARKER = '/.local/share/sprintengine-studio/'

/**
 * Split a command line the way the shells our commands were written for read
 * it: whitespace separates, `'…'` is literal, and `"…"` is literal too — the
 * Windows pipe name inside one keeps its backslashes, which is how the command
 * was written.
 */
export function splitCommandLine(command: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: "'" | '"' | null = null
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (/\s/u.test(char)) {
      if (started) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += char
    started = true
  }
  if (quote) return null
  if (started) tokens.push(current)
  return tokens
}

export type LegacyHookCommand = {
  /** Which launcher target the script was. */
  target: Extract<LauncherTarget, 'agent-state' | 'status-line' | 'knowledge-activity'>
  /** Variables set in front (a WSL command's own). */
  env: Record<string, string>
  /** The Node the command ran; null for a bare `node`. */
  node: string | null
  args: string[]
}

const LEGACY_SCRIPT_TARGETS: ReadonlyArray<[RegExp, LegacyHookCommand['target']]> = [
  [/(?:^|\/)\.sprintengine\/hooks\/agent-state\.mjs$/u, 'agent-state'],
  [/(?:^|\/)\.sprintengine\/hooks\/status-line\.mjs$/u, 'status-line'],
  [/(?:^|\/)\.sprintengine\/hooks\/knowledge-activity\.mjs$/u, 'knowledge-activity'],
]

/** A hook command from before the launcher, taken apart; null for anything else. */
export function parseLegacyHookCommand(command: string): LegacyHookCommand | null {
  const tokens = splitCommandLine(command)
  if (!tokens || tokens.length < 2) return null
  let index = 0
  const env: Record<string, string> = {}
  let node: string | null = null
  if (tokens[0] === 'node') {
    index = 1
  } else if (tokens[0] === 'env') {
    index = 1
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index])) {
      const at = tokens[index].indexOf('=')
      env[tokens[index].slice(0, at)] = tokens[index].slice(at + 1)
      index += 1
    }
    node = tokens[index] ?? null
    index += 1
    if (!node) return null
  } else {
    return null
  }
  const script = (tokens[index] ?? '').split('\\').join('/')
  const target = LEGACY_SCRIPT_TARGETS.find(([pattern]) => pattern.test(script))?.[1]
  if (!target) return null
  return { target, env, node, args: tokens.slice(index + 1) }
}

/** The home a distribution path sits under (`/home/me` for `/home/me/.local/share/sprintengine-studio/…`). */
export function wslHomeFromDataPath(path: string): string | null {
  const at = path.indexOf(WSL_DATA_MARKER)
  return at > 0 ? path.slice(0, at) : null
}

export type MigrationContext = {
  /** This machine's launcher (what a bare `node` command becomes). */
  localLauncher: StudioLauncherRef
}

/** The launcher a legacy command should run instead, from the Node it named. */
function launcherForLegacy(node: string | null, context: MigrationContext): StudioLauncherRef | null {
  if (node === null) return context.localLauncher
  const home = wslHomeFromDataPath(node)
  return home ? launcherRefForHome(home, 'posix') : null
}

/** A legacy hook command in the launcher form, or null when it is not one of ours from before. */
export function migrateHookCommand(command: string, context: MigrationContext): string | null {
  const parsed = parseLegacyHookCommand(command)
  if (!parsed) return null
  const launcher = launcherForLegacy(parsed.node, context)
  if (!launcher) return null
  const args = [...parsed.args]
  // The wrap envelope is base64 and re-quoted the way every writer quotes it.
  const wrapAt = args.indexOf('--wrap')
  let wrap = ''
  if (wrapAt >= 0) {
    wrap = ` --wrap "${args[wrapAt + 1] ?? ''}"`
    args.splice(wrapAt, 2)
  }
  return `${buildLauncherCommand(launcher, parsed.target, args, parsed.env)}${wrap}`
}

/** A legacy MCP gateway `{command, args, env}` in the launcher form, or null when it is not one. */
export function migrateGatewayServer(
  entry: Record<string, unknown>,
  context: MigrationContext,
): Record<string, unknown> | null {
  if (!isManagedStudioGatewayEntry(entry) || isLauncherMcpServer(entry)) return null
  const command = typeof entry.command === 'string' ? entry.command : ''
  const home = wslHomeFromDataPath(command.split('\\').join('/'))
  const launcher = home ? launcherRefForHome(home, 'posix') : context.localLauncher
  const env = isRecord(entry.env) ? { ...entry.env } : {}
  // The launcher sets it for the app's own Electron; a Linux Node never needed it.
  delete env.ELECTRON_RUN_AS_NODE
  const next: Record<string, unknown> = { ...entry, ...buildLauncherMcpServer(launcher) }
  if (Object.keys(env).length > 0) next.env = env
  else delete next.env
  return next
}

// ── Per file format ─────────────────────────────────────────────────────────

/** Rewrite every `command` string in a JSON value that is one of our legacy hook commands. */
function migrateJsonCommands(value: unknown, context: MigrationContext): boolean {
  let changed = false
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (!isRecord(node)) return
    if (typeof node.command === 'string') {
      const next = migrateHookCommand(node.command, context)
      if (next !== null && next !== node.command) {
        node.command = next
        changed = true
      }
    }
    for (const child of Object.values(node)) visit(child)
  }
  visit(value)
  return changed
}

/** Rewrite the `command = "…"` lines inside our marked TOML block. */
export function migrateTomlHookBlock(text: string, context: MigrationContext): string | null {
  const start = text.indexOf(AGENT_STATE_TOML_START)
  const end = start >= 0 ? text.indexOf(AGENT_STATE_TOML_END, start) : -1
  if (start < 0 || end < 0) return null
  const block = text.slice(start, end)
  let changed = false
  const next = block.replace(/^command = (".*")$/gmu, (line, quoted: string) => {
    let value: unknown
    try {
      value = JSON.parse(quoted)
    } catch {
      return line
    }
    if (typeof value !== 'string') return line
    const migrated = migrateHookCommand(value, context)
    if (migrated === null) return line
    changed = true
    return `command = ${JSON.stringify(migrated)}`
  })
  return changed ? text.slice(0, start) + next + text.slice(end) : null
}

/** Rewrite the gateway's table inside the managed Codex MCP block. */
export function migrateCodexGatewayBlock(text: string, context: MigrationContext): string | null {
  const start = text.indexOf(MANAGED_START)
  const end = start >= 0 ? text.indexOf(MANAGED_END, start) : -1
  if (start < 0 || end < 0) return null
  const lines = text.slice(start, end).split('\n')
  const header = lines.findIndex((line) => line.trim() === `[mcp_servers.${STUDIO_MCP_SERVER_ID}]`)
  if (header < 0) return null
  let stop = lines.findIndex((line, index) => index > header && /^\s*\[/u.test(line))
  if (stop < 0) stop = lines.length
  const read = (key: string): unknown => {
    const line = lines.slice(header + 1, stop).find((candidate) => candidate.startsWith(`${key} = `))
    if (!line) return undefined
    try {
      return JSON.parse(line.slice(key.length + 3))
    } catch {
      return undefined
    }
  }
  const envLine = lines.slice(header + 1, stop).find((line) => line.startsWith('env = '))
  const env: Record<string, string> = {}
  for (const match of envLine?.matchAll(/("(?:[^"\\]|\\.)*") = ("(?:[^"\\]|\\.)*")/gu) ?? []) {
    env[JSON.parse(match[1]) as string] = JSON.parse(match[2]) as string
  }
  const migrated = migrateGatewayServer({ command: read('command'), args: read('args'), env }, context)
  if (!migrated) return null
  const rendered: string[] = []
  for (const line of lines.slice(header + 1, stop)) {
    if (line.startsWith('command = ')) rendered.push(`command = ${JSON.stringify(migrated.command)}`)
    else if (line.startsWith('args = ')) {
      rendered.push(`args = [${(migrated.args as string[]).map((arg) => JSON.stringify(arg)).join(', ')}]`)
    } else if (line.startsWith('env = ')) {
      const nextEnv = isRecord(migrated.env) ? migrated.env : {}
      if (Object.keys(nextEnv).length > 0) {
        rendered.push(
          `env = { ${Object.entries(nextEnv)
            .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
            .join(', ')} }`,
        )
      }
    } else rendered.push(line)
  }
  const nextLines = [...lines.slice(0, header + 1), ...rendered, ...lines.slice(stop)]
  return text.slice(0, start) + nextLines.join('\n') + text.slice(end)
}

async function rewriteJson(path: string, change: (value: Record<string, unknown>) => boolean): Promise<boolean> {
  return withConfigFileLock(path, async () => {
    const raw = await readFile(path, 'utf8').catch(() => null)
    if (raw === null || raw.trim() === '') return false
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return false
    }
    if (!isRecord(parsed) || !change(parsed)) return false
    await writeFileAtomically(path, `${JSON.stringify(parsed, null, 2)}\n`)
    return true
  })
}

async function rewriteText(path: string, change: (text: string) => string | null): Promise<boolean> {
  return withConfigFileLock(path, async () => {
    const raw = await readFile(path, 'utf8').catch(() => null)
    if (raw === null) return false
    const next = change(raw)
    if (next === null || next === raw) return false
    await writeFileAtomically(path, next)
    return true
  })
}

function migrateGatewayIn(servers: unknown, context: MigrationContext): boolean {
  if (!isRecord(servers) || !isRecord(servers[STUDIO_MCP_SERVER_ID])) return false
  const next = migrateGatewayServer(servers[STUDIO_MCP_SERVER_ID], context)
  if (!next) return false
  servers[STUDIO_MCP_SERVER_ID] = next
  return true
}

function migrateOpencodeGateway(mcp: unknown, context: MigrationContext): boolean {
  if (!isRecord(mcp) || !isRecord(mcp[STUDIO_MCP_SERVER_ID])) return false
  const entry = mcp[STUDIO_MCP_SERVER_ID]
  if (!Array.isArray(entry.command)) return false
  const [command, ...args] = entry.command as unknown[]
  const environment = isRecord(entry.environment) ? entry.environment : {}
  const next = migrateGatewayServer({ command, args, env: environment }, context)
  if (!next) return false
  entry.command = [next.command, ...(next.args as string[])]
  if (isRecord(next.env)) entry.environment = next.env
  else delete entry.environment
  return true
}

/**
 * Bring one ledger entry's file onto the launcher. Returns whether the file
 * changed. Never throws: an entry that cannot be migrated keeps working as it
 * did (it is no worse than before), and the removal still recognises it.
 */
export async function migrateLedgerEntry(entry: IntegrationLedgerEntry, context: MigrationContext): Promise<boolean> {
  try {
    switch (entry.kind) {
      case 'agent-state-hooks':
        if (entry.marker === 'toml-block' || entry.marker === 'toml-array-block') {
          return await rewriteText(entry.path, (text) => migrateTomlHookBlock(text, context))
        }
        if (entry.marker === 'plugin-file') return false
        return await rewriteJson(entry.path, (value) => migrateJsonCommands(value.hooks, context))
      case 'status-line':
        return await rewriteJson(entry.path, (value) => {
          if (!isRecord(value.statusLine) || typeof value.statusLine.command !== 'string') return false
          if (!isStatusLineForwarderCommand(value.statusLine.command)) return false
          const next = migrateHookCommand(value.statusLine.command, context)
          // The same ceiling the install holds a rendered status line to:
          // cmd.exe refuses a command line past 8191 characters.
          if (next === null || next.length > MAX_MIGRATED_STATUS_LINE_LENGTH) return false
          value.statusLine.command = next
          return true
        })
      case 'knowledge-activity-hook':
        return await rewriteJson(entry.path, (value) => migrateJsonCommands(value.hooks, context))
      case 'mcp-gateway':
        if (entry.path.endsWith('.toml'))
          return await rewriteText(entry.path, (text) => migrateCodexGatewayBlock(text, context))
        if (entry.path.endsWith('opencode.json')) {
          return await rewriteJson(entry.path, (value) => migrateOpencodeGateway(value.mcp, context))
        }
        return await rewriteJson(entry.path, (value) => migrateGatewayIn(value.mcpServers, context))
      case 'studio-plugin-copy':
        return await rewriteJson(join(entry.path, 'sprintengine-studio', '.mcp.json'), (value) =>
          migrateGatewayIn(value.mcpServers, context),
        )
      default:
        return false
    }
  } catch {
    return false
  }
}

/**
 * Delete a reporter copy an earlier build left, once nothing in its checkout
 * (or home) names it any more. `namers` are the files that could: every hook
 * config the ledger lists for the same checkout.
 */
export async function removeUnnamedHookScript(scriptPath: string, namers: readonly string[]): Promise<boolean> {
  const name = scriptPath.split(/[\\/]/u).pop() ?? ''
  if (!name) return false
  for (const path of namers) {
    const text = await readFile(path, 'utf8').catch(() => null)
    if (text?.includes(`/hooks/${name}`) || text?.includes(`\\hooks\\${name}`)) return false
  }
  await rm(resolve(scriptPath), { force: true })
  return true
}

export function localMigrationContext(home: string, shell: LauncherShell): MigrationContext {
  return { localLauncher: launcherRefForHome(home, shell) }
}
