// Installing a plugin into a workspace (backlog/2026-09-05-plugin-sources.md,
// "What install means, per kind and per harness").
//
// Three things can happen, and the result says which did:
//
//  1. **Claude Code enables it natively.** When the plugin came from a
//     marketplace on GitHub and Claude Code reads this workspace, the
//     marketplace is registered under `extraKnownMarketplaces` and the plugin
//     under `enabledPlugins` in `<workspace>/.claude/settings.json`. Claude
//     Code then loads its commands, agents, hooks and MCP servers itself —
//     the same two keys `/plugin install name@marketplace` writes. Nothing is
//     copied for it; a second loader that drifted from Claude Code's own was
//     the rejected alternative.
//  2. **Every harness gets the skills.** Copied through the existing skill
//     installer with a provenance marker, so Sync owns them afterwards.
//  3. **The MCP servers are handed back.** MCP settings live in the renderer
//     store and sync into each CLI's own config from there; the install
//     returns the configs and the surface adds them.
//
// The settings file is merged, never replaced: only the two keys are touched,
// only the entries this install adds, and uninstall removes only those.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { McpServerConfig, SkillHarness } from '../../shared/electron-api'
import { mcpServerConfigFromScanned } from '../../shared/mcp/server-from-scanned'
import type { ScannedPlugin, ScannedSkill, SkillFileRef } from '../../shared/skills'
import { installSkill, uninstallSkill, type SkillInstallProvenance } from './install'

// The mapping is shared with the renderer's own "Add this server" row, so both
// stamp the same provenance; re-exported here because this module was where it
// lived and the install tests read it from here.
export { mcpServerConfigFromScanned }

export const CLAUDE_SETTINGS_RELATIVE_PATH = '.claude/settings.json'

/** What Claude Code's settings call a plugin: `name@marketplace`. */
export function claudePluginKey(pluginId: string, marketplaceName: string): string {
  return `${pluginId}@${marketplaceName}`
}

export type PluginInstallHarnessOutcome = {
  harness: SkillHarness
  /** `native` — enabled in Claude Code's own settings; `skills` — skill dirs copied; `nothing` — the plugin has nothing this harness reads. */
  mode: 'native' | 'skills' | 'nothing'
  skillDirNames: string[]
  message: string
}

export type PluginInstallOptions = {
  workspaceRoot: string
  sourceId: string
  /** '' when the source is not a marketplace, which rules out native enablement. */
  marketplaceName: string
  /** `owner/name` of the source repository, '' for a non-GitHub source. */
  marketplaceRepo: string
  plugin: ScannedPlugin
  harnesses: readonly SkillHarness[]
  /** The commit the plugin's bytes are read at — the source's, or a linked plugin's own. */
  commitSha: string
  readSkillFile: (skill: ScannedSkill, file: SkillFileRef) => Promise<Buffer>
  /** Which CLIs the returned MCP configs should target; the renderer may widen it. */
  mcpClients: readonly string[]
  /** Test seam. */
  now?: () => Date
}

export type PluginInstallResult =
  | {
      ok: true
      pluginId: string
      harnesses: PluginInstallHarnessOutcome[]
      /** Ready for the MCP settings store; empty when the plugin declares none. */
      mcpServers: McpServerConfig[]
      /** The `name@marketplace` key when Claude Code enabled it natively, else ''. */
      claudePluginKey: string
      /** Failures that did not stop the install (one skill of several). */
      warnings: string[]
    }
  | { ok: false; message: string }

export async function installPlugin(options: PluginInstallOptions): Promise<PluginInstallResult> {
  const { plugin } = options
  if (!plugin.componentsKnown) {
    return { ok: false, message: `${plugin.name} has not been read yet. Open it so its contents can be read, then install.` }
  }
  const outcomes: PluginInstallHarnessOutcome[] = []
  const warnings: string[] = []
  const skillHarnesses: SkillHarness[] = []
  let nativeKey = ''

  // Native enablement needs a marketplace Claude Code can fetch: a name and a
  // GitHub repository. A plugin-only repository has neither, and gets the
  // skills copy every other harness gets.
  const nativeEligible =
    options.marketplaceName !== '' && options.marketplaceRepo !== '' && plugin.origin.kind !== 'registry'
  for (const harness of options.harnesses) {
    if (harness === 'claude' && nativeEligible) {
      const key = claudePluginKey(plugin.id, options.marketplaceName)
      const enabled = await enableClaudePlugin({
        workspaceRoot: options.workspaceRoot,
        marketplaceName: options.marketplaceName,
        marketplaceRepo: options.marketplaceRepo,
        pluginKey: key,
      })
      if (!enabled.ok) return enabled
      nativeKey = key
      outcomes.push({
        harness,
        mode: 'native',
        skillDirNames: [],
        message: `Enabled as ${key} in ${CLAUDE_SETTINGS_RELATIVE_PATH}. Claude Code loads its commands, agents, hooks and MCP servers itself.`,
      })
      continue
    }
    if (plugin.components.skills.length === 0) {
      outcomes.push({ harness, mode: 'nothing', skillDirNames: [], message: nothingMessage(plugin) })
      continue
    }
    skillHarnesses.push(harness)
  }

  // Skills: one copy per skill, into every harness that takes skills, through
  // the installer that stages, checks paths and writes provenance.
  const copiedByHarness = new Map<SkillHarness, string[]>()
  if (skillHarnesses.length > 0) {
    for (const skill of plugin.components.skills) {
      const provenance: SkillInstallProvenance = {
        sourceId: options.sourceId,
        skillId: skill.id,
        commitSha: options.commitSha,
      }
      const result = await installSkill({
        workspaceRoot: options.workspaceRoot,
        skill,
        harnesses: skillHarnesses,
        readFile: (file) => options.readSkillFile(skill, file),
        provenance,
      })
      if (!result.ok) {
        warnings.push(`${skill.name} did not install: ${result.message}`)
        continue
      }
      for (const harness of result.harnesses) {
        const dirs = copiedByHarness.get(harness) ?? []
        dirs.push(result.dirName)
        copiedByHarness.set(harness, dirs)
      }
    }
    for (const harness of skillHarnesses) {
      const dirs = copiedByHarness.get(harness) ?? []
      outcomes.push({
        harness,
        mode: 'skills',
        skillDirNames: dirs,
        message:
          dirs.length === 0
            ? 'No skill could be copied.'
            : `${dirs.length} ${dirs.length === 1 ? 'skill' : 'skills'} copied. ${unsupportedComponents(plugin)}`.trim(),
      })
    }
  }

  if (nativeKey === '' && [...copiedByHarness.values()].every((dirs) => dirs.length === 0)) {
    if (plugin.components.skills.length > 0 && warnings.length > 0) {
      return { ok: false, message: warnings[0] }
    }
    if (plugin.components.mcpServers.length === 0) {
      return { ok: false, message: `${plugin.name} has nothing the agent CLIs on this machine can use. ${nothingMessage(plugin)}` }
    }
  }

  return {
    ok: true,
    pluginId: plugin.id,
    harnesses: outcomes,
    // Provenance, so a later Sync of this source can refresh exactly these
    // entries: the source, the server's id in that source's scan, and the
    // commit the declaration was read at.
    mcpServers: plugin.components.mcpServers.map((server) =>
      mcpServerConfigFromScanned(server, options.mcpClients, {
        sourceId: options.sourceId,
        itemId: server.id,
        commitSha: options.commitSha,
      })
    ),
    claudePluginKey: nativeKey,
    warnings,
  }
}

export type PluginUninstallOptions = {
  workspaceRoot: string
  pluginId: string
  marketplaceName: string
  /** Skill directory names the install copied; swept from every harness dir. */
  skillDirNames: readonly string[]
  allHarnesses: readonly SkillHarness[]
}

export type PluginUninstallResult =
  | { ok: true; removedPaths: string[]; disabledClaudePluginKey: string }
  | { ok: false; message: string }

export async function uninstallPlugin(options: PluginUninstallOptions): Promise<PluginUninstallResult> {
  const removedPaths: string[] = []
  for (const dirName of options.skillDirNames) {
    const result = await uninstallSkill({
      workspaceRoot: options.workspaceRoot,
      dirName,
      harnesses: options.allHarnesses,
    })
    if (!result.ok) return result
    removedPaths.push(...result.removedPaths)
  }
  let disabledKey = ''
  if (options.marketplaceName !== '') {
    const key = claudePluginKey(options.pluginId, options.marketplaceName)
    const disabled = await disableClaudePlugin({ workspaceRoot: options.workspaceRoot, pluginKey: key })
    if (!disabled.ok) return disabled
    if (disabled.removed) disabledKey = key
  }
  return { ok: true, removedPaths, disabledClaudePluginKey: disabledKey }
}

// ── Claude Code settings ────────────────────────────────────────────────────

type ClaudeSettings = Record<string, unknown> & {
  extraKnownMarketplaces?: Record<string, unknown>
  enabledPlugins?: Record<string, unknown>
}

/**
 * Register the marketplace and enable the plugin — the two keys Claude Code
 * documents for team-shared plugins. Merged into whatever the file already
 * holds: a person's own hooks, permissions and other marketplaces survive
 * byte-for-byte in meaning, and an existing marketplace entry of the same
 * name is left as they wrote it.
 */
export async function enableClaudePlugin(input: {
  workspaceRoot: string
  marketplaceName: string
  marketplaceRepo: string
  pluginKey: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const path = join(input.workspaceRoot, CLAUDE_SETTINGS_RELATIVE_PATH)
  const read = await readClaudeSettings(path)
  if (!read.ok) return read
  const settings = read.settings
  const marketplaces = isRecord(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {}
  if (!(input.marketplaceName in marketplaces)) {
    marketplaces[input.marketplaceName] = { source: { source: 'github', repo: input.marketplaceRepo } }
  }
  const enabled = isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {}
  enabled[input.pluginKey] = true
  settings.extraKnownMarketplaces = marketplaces
  settings.enabledPlugins = enabled
  return writeClaudeSettings(path, settings)
}

export async function disableClaudePlugin(input: {
  workspaceRoot: string
  pluginKey: string
}): Promise<{ ok: true; removed: boolean } | { ok: false; message: string }> {
  const path = join(input.workspaceRoot, CLAUDE_SETTINGS_RELATIVE_PATH)
  const read = await readClaudeSettings(path)
  if (!read.ok) return read
  const enabled = read.settings.enabledPlugins
  if (!isRecord(enabled) || !(input.pluginKey in enabled)) return { ok: true, removed: false }
  delete enabled[input.pluginKey]
  // The marketplace registration stays: other plugins from it may be enabled,
  // and a registration is harmless on its own.
  const written = await writeClaudeSettings(path, read.settings)
  return written.ok ? { ok: true, removed: true } : written
}

/** Which plugins the workspace's Claude settings enable, `name@marketplace` → true. */
export async function readEnabledClaudePlugins(workspaceRoot: string): Promise<Set<string>> {
  const read = await readClaudeSettings(join(workspaceRoot, CLAUDE_SETTINGS_RELATIVE_PATH))
  if (!read.ok || !isRecord(read.settings.enabledPlugins)) return new Set()
  return new Set(
    Object.entries(read.settings.enabledPlugins)
      .filter(([, value]) => value === true)
      .map(([key]) => key)
  )
}

async function readClaudeSettings(
  path: string
): Promise<{ ok: true; settings: ClaudeSettings } | { ok: false; message: string }> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, settings: {} }
    return { ok: false, message: `${CLAUDE_SETTINGS_RELATIVE_PATH} could not be read: ${describe(error)}` }
  }
  if (raw.trim() === '') return { ok: true, settings: {} }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) {
      return { ok: false, message: `${CLAUDE_SETTINGS_RELATIVE_PATH} is not a JSON object, so it was left alone.` }
    }
    return { ok: true, settings: parsed as ClaudeSettings }
  } catch (error) {
    // A file that does not parse is someone's work in progress; writing over
    // it would destroy whatever they were typing.
    return { ok: false, message: `${CLAUDE_SETTINGS_RELATIVE_PATH} is not valid JSON, so it was left alone: ${describe(error)}` }
  }
}

async function writeClaudeSettings(path: string, settings: ClaudeSettings): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await rename(temp, path)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: `${CLAUDE_SETTINGS_RELATIVE_PATH} could not be written: ${describe(error)}` }
  }
}

// ── Words ───────────────────────────────────────────────────────────────────

function nothingMessage(plugin: ScannedPlugin): string {
  const parts: string[] = []
  const c = plugin.components
  if (c.commands.length > 0) parts.push('commands')
  if (c.agents.length > 0) parts.push('agents')
  if (c.hooks.length > 0) parts.push('hooks')
  if (parts.length === 0) return 'It declares no skills.'
  return `Its ${parts.join(', ')} are Claude Code-format and have no equivalent here.`
}

function unsupportedComponents(plugin: ScannedPlugin): string {
  const c = plugin.components
  const parts: string[] = []
  if (c.commands.length > 0) parts.push('commands')
  if (c.agents.length > 0) parts.push('agents')
  if (c.hooks.length > 0) parts.push('hooks')
  return parts.length > 0 ? `Its ${parts.join(', ')} have no equivalent here.` : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
