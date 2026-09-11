// The app-owned launch home: the plugin directories this app hands a CLI at
// launch time, instead of writing its skills, its MCP bridge and its
// agent-state hook into the user's repository.
//
// Why it exists. Everything this app shipped a workspace used to live in that
// workspace — `.multicode/studio-plugin`, `.multicode/hooks/agent-state.mjs`,
// hook entries in `.claude/settings.local.json`. That has three costs a person
// actually feels: the files show up in their repository, a colleague who never
// ran this app inherits hook commands naming paths that do not exist on their
// machine, and anyone running `claude` in that checkout OUTSIDE this app gets
// this app's hooks and skills. Handing the CLI a `--plugin-dir` at launch has
// none of them: the copy lives here, the flag applies to that one session, and
// a CLI started any other way sees nothing.
//
// What the directory holds, and why here rather than `~/.multicode`. One
// materialised copy of the bundled marketplace per PLUGIN VERSION, under this
// profile's userData directory. Two of the values substituted into it — the
// node binary that runs the MCP bridge, and the bridge script itself — belong
// to the build that wrote them, so the copy cannot be shared across builds; a
// dev build (whose userData is its own `multicode-dev-<port>` directory) and a
// packaged build therefore never overwrite each other's, which is exactly the
// collision the shared workspace file had.
//
// The socket is substituted too, but the reporter prefers
// `MULTICODE_AGENT_STATE_SOCKET` from the launch env over the baked value, so a
// copy written by one app instance still reports to the instance that actually
// launched the agent.

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  materialiseStudioPluginInto,
  readStudioPluginTemplate,
  STUDIO_PLUGIN_ID,
  type StudioPluginTokens,
} from './skills/studio-plugin'

/** The directory under userData that holds every version's copy. */
export const AGENT_INTEGRATION_DIR = 'agent-integration'

/**
 * Where the agent-state reporter lands inside the materialised copy: next to
 * the `hooks.json` that names it, so the plugin directory is self-contained and
 * a person reading it can see what the hook runs.
 */
export const LAUNCH_REPORTER_REL = join(STUDIO_PLUGIN_ID, 'hooks', 'agent-state.mjs')

/**
 * The status-line forwarder, beside the reporter.
 *
 * It is not a hook and no plugin can declare it — Claude Code takes a status
 * line only from a settings file or from `--settings` at launch. It lives here
 * anyway because the launch names it in that setting, and a path under the
 * person's workspace is exactly what this whole arrangement stops writing.
 */
export const LAUNCH_STATUS_LINE_REL = join(STUDIO_PLUGIN_ID, 'hooks', 'status-line.mjs')

/** Written last, so a half-finished copy is never mistaken for a usable one. */
const MARKER_FILE = '.installed.json'

/** The version-keyed root. Sibling versions coexist; see `prune`. */
export function agentIntegrationRoot(userDataDir: string, version: string): string {
  return resolve(userDataDir, AGENT_INTEGRATION_DIR, version)
}

/**
 * The directories a launch passes as `--plugin-dir`, in order.
 *
 * One flag per plugin, never the marketplace root: measured against Claude Code
 * 2.1.268 on 2026-09-11, `--plugin-dir <marketplace root>` loaded NEITHER child
 * plugin (the model could not see either plugin's skill), while two directories
 * passed as two flags loaded both. The `--help` text reads as though a
 * directory of plugins loads each child; it does not.
 *
 * `studio-skills` is deliberately NOT passed, though the copy holds it.
 * `builtin-skills.ts` still installs debug, backlog and frontend-design into
 * `{{workspaceRoot}}/.claude/skills` at spawn, so passing that plugin too would
 * put the same skill id in front of one session twice — once from here and once
 * from the workspace. It joins this list when those skills stop being written
 * into the repository.
 */
export function launchPluginDirs(root: string): string[] {
  return [join(root, STUDIO_PLUGIN_ID)]
}

export type AgentIntegrationHome = {
  /** The version-keyed marketplace root. */
  root: string
  /** The `--plugin-dir` arguments for this launch. */
  pluginDirs: string[]
  version: string
}

export type EnsureAgentIntegrationHomeOptions = {
  /** `resources/studio-plugin` in this build, or null when it did not ship. */
  templateRoot: string | null
  /** The bundled stdin-filter reporter, or null when it did not ship. */
  reporterSourcePath: string | null
  /**
   * The bundled status-line forwarder, or null when it did not ship.
   *
   * Optional in the strong sense: a build without it still gets hooks, skills
   * and its MCP server. It is how the app reads a session's context-window
   * usage, not how agent state works, and a missing forwarder must never cost a
   * launch the rest of the plugin.
   */
  statusLineSourcePath?: string | null
  userDataDir: string
  /** The three build-and-moment values the template cannot carry. */
  tokens: Omit<StudioPluginTokens, 'agentStateReporterPath'>
}

/**
 * Materialise this build's copy if it is not already there, and return the
 * directories to launch with.
 *
 * Idempotent and cheap on the settled path: an existing marker naming this
 * version is taken at its word, because the copy landed by atomic rename and
 * the marker is written after it. A build that shipped no template says so
 * rather than handing back a directory that would load nothing.
 */
export async function ensureAgentIntegrationHome(
  options: EnsureAgentIntegrationHomeOptions
): Promise<{ ok: true; home: AgentIntegrationHome } | { ok: false; message: string }> {
  const templateRoot = options.templateRoot
  if (!templateRoot) return { ok: false, message: 'The SprintEngine Studio plugin did not ship with this build.' }
  const reporterSourcePath = options.reporterSourcePath
  if (!reporterSourcePath || !existsSync(reporterSourcePath)) {
    return { ok: false, message: 'The agent-state reporter did not ship with this build.' }
  }
  const userDataDir = options.userDataDir.trim()
  if (userDataDir === '') return { ok: false, message: 'A userData directory is required.' }

  const read = await readStudioPluginTemplate(templateRoot)
  if (!read.ok) return read
  const { template } = read

  const root = agentIntegrationRoot(userDataDir, template.version)
  const home: AgentIntegrationHome = { root, pluginDirs: launchPluginDirs(root), version: template.version }
  if (await isUsable(root, template.version)) return { ok: true, home }

  const materialised = await materialiseStudioPluginInto({
    template,
    destination: root,
    tokens: { ...options.tokens, agentStateReporterPath: join(root, LAUNCH_REPORTER_REL) },
    // The opposite of the workspace copy: this one IS the registration, so its
    // hook declaration is what makes agent state work at all.
    neuterHooks: false,
  })
  if (!materialised.ok) return materialised

  try {
    const reporterPath = join(root, LAUNCH_REPORTER_REL)
    await mkdir(resolve(reporterPath, '..'), { recursive: true })
    await copyFile(reporterSourcePath, reporterPath)
  } catch (error) {
    return { ok: false, message: `The agent-state reporter could not be copied: ${describe(error)}` }
  }

  // Best-effort, and deliberately after the reporter: the launch names this
  // script in its `--settings` status line, which is how the app reads context
  // usage, cost and lines changed. A build that shipped none simply sends no
  // status line — the hooks, the skills and the MCP server are unaffected.
  const statusLineSourcePath = options.statusLineSourcePath
  if (statusLineSourcePath && existsSync(statusLineSourcePath)) {
    await copyFile(statusLineSourcePath, join(root, LAUNCH_STATUS_LINE_REL)).catch(() => undefined)
  }

  await writeMarker(root, template.version)
  return { ok: true, home }
}

/**
 * Delete every version directory except the one in use.
 *
 * Safe at startup and nowhere else: a CLI reads a plugin directory as it
 * starts, and every agent this app launches dies with the app that launched it,
 * so at startup no live session is reading a sibling version. Failures are
 * swallowed — a stale directory costs disk, and nothing else.
 */
export async function pruneAgentIntegrationHomes(userDataDir: string, keepVersion: string): Promise<void> {
  const base = resolve(userDataDir, AGENT_INTEGRATION_DIR)
  const entries = await readdir(base, { withFileTypes: true }).catch(() => null)
  if (entries === null) return
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keepVersion) continue
    await rm(join(base, entry.name), { recursive: true, force: true }).catch(() => undefined)
  }
}

/** A copy is usable when its marker names the version this build ships. */
async function isUsable(root: string, version: string): Promise<boolean> {
  const raw = await readFile(join(root, MARKER_FILE), 'utf8').catch(() => null)
  if (raw === null) return false
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
    return (parsed as Record<string, unknown>).version === version
  } catch {
    return false
  }
}

async function writeMarker(root: string, version: string): Promise<void> {
  const path = join(root, MARKER_FILE)
  const temp = `${path}.${process.pid}.tmp`
  const body = `${JSON.stringify({ plugin: STUDIO_PLUGIN_ID, version, installedAt: new Date().toISOString() }, null, 2)}\n`
  await writeFile(temp, body, 'utf8')
  await rename(temp, path)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
