// The app's Claude plugin copy, made for a WSL distribution.
//
// On this machine the launch hands Claude Code `--plugin-dir` pointing at a copy
// materialised under userData (`agent-integration-home.ts`), with this build's
// absolute paths substituted into it: the Node that runs the MCP bridge, the
// bridge, the agent-state reporter and its socket. Those are paths on this
// machine, so the same copy is useless to a Claude running in Linux.
//
// This builds the same copy with the distribution's paths instead (the pinned
// Linux Node, the bridge and reporter the helper installed, the helper's Unix
// socket), in memory, for the helper to write into the distribution. The hook
// commands in the template start with a bare `node`, which in Linux would be
// whatever Node the person has, if any; they are pointed at the pinned Node.

import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

import { LAUNCH_REPORTER_REL, LAUNCH_STATUS_LINE_REL, launchPluginDirs } from '../agent-integration-home'
import { materialiseStudioPluginInto, readStudioPluginTemplate } from '../skills/studio-plugin'

export type WslPluginSources = {
  templateRoot: string | null
  reporterSourcePath: string | null
  statusLineSourcePath: string | null
}

export type WslPluginTokens = {
  /** The pinned Linux Node. */
  nodeCommand: string
  /** The installed app directory in the distribution (`…/sprintengine-studio/<version>`). */
  appDir: string
  /** The Linux stand-in user-data directory the bridge reads its discovery file from. */
  userDataDir: string
  agentStateSocketPath: string
}

export type WslPluginCopy = {
  files: Array<{ path: string; b64: string }>
  digest: string
  /** Where the copy lands in the distribution. */
  root: string
  pluginDirs: string[]
  statusLineScriptPath: string | null
}

/** The tree name the helper writes the copy under, inside the app directory. */
export const WSL_PLUGIN_TREE = 'plugin'

function posixJoin(...parts: string[]): string {
  return parts.join('/').replace(/\/+/gu, '/')
}

function posixRel(path: string): string {
  return path.split(sep).join('/')
}

/** `node "<script>"` hook commands pointed at `nodeCommand` instead of PATH's node. */
export function pinHookNode(hooksJson: string, nodeCommand: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(hooksJson)
  } catch {
    return hooksJson
  }
  const quoted = `'${nodeCommand.replace(/'/g, `'\\''`)}'`
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (typeof record.command === 'string' && record.command.startsWith('node "')) {
        record.command = `${quoted}${record.command.slice('node'.length)}`
      }
      Object.values(record).forEach(visit)
    }
  }
  visit(parsed)
  return `${JSON.stringify(parsed, null, 2)}\n`
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(path)))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/**
 * The copy as files for the helper's `files.ensureTree`, or null when this
 * build shipped no plugin (the workspace install then carries agent state).
 */
export async function buildWslPluginCopy(
  sources: WslPluginSources,
  tokens: WslPluginTokens,
): Promise<WslPluginCopy | null> {
  if (!sources.templateRoot || !sources.reporterSourcePath) return null
  const read = await readStudioPluginTemplate(sources.templateRoot)
  if (!read.ok) return null
  const root = posixJoin(tokens.appDir, WSL_PLUGIN_TREE)
  const staging = await mkdtemp(join(tmpdir(), 'sprintengine-wsl-plugin-'))
  try {
    const destination = join(staging, 'copy')
    const materialised = await materialiseStudioPluginInto({
      template: read.template,
      destination,
      tokens: {
        nodeCommand: tokens.nodeCommand,
        bridgeScriptPath: posixJoin(tokens.appDir, 'automation', 'mcp-stdio-bridge.mjs'),
        userDataDir: tokens.userDataDir,
        agentStateReporterPath: posixJoin(root, posixRel(LAUNCH_REPORTER_REL)),
        agentStateSocketPath: tokens.agentStateSocketPath,
      },
      neuterHooks: false,
    })
    if (!materialised.ok) return null
    const files = new Map<string, Buffer>()
    for (const path of await walk(destination)) {
      const rel = posixRel(relative(destination, path))
      const data = await readFile(path)
      files.set(
        rel,
        rel.endsWith('hooks/hooks.json') ? Buffer.from(pinHookNode(data.toString('utf8'), tokens.nodeCommand)) : data,
      )
    }
    files.set(posixRel(LAUNCH_REPORTER_REL), await readFile(sources.reporterSourcePath))
    // Optional, as on this machine: without it the launch sends no status line.
    const statusLine = sources.statusLineSourcePath
      ? await readFile(sources.statusLineSourcePath).catch(() => null)
      : null
    if (statusLine) files.set(posixRel(LAUNCH_STATUS_LINE_REL), statusLine)
    const sorted = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const hash = createHash('sha256')
    for (const [path, data] of sorted) hash.update(path).update('\0').update(data).update('\0')
    return {
      files: sorted.map(([path, data]) => ({ path, b64: data.toString('base64') })),
      digest: hash.digest('hex'),
      root,
      pluginDirs: launchPluginDirs(root).map(posixRel),
      statusLineScriptPath: statusLine ? posixJoin(root, posixRel(LAUNCH_STATUS_LINE_REL)) : null,
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}
