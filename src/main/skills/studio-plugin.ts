// SprintEngine Studio's own plugin: the bundle the app installs into every
// workspace it opens (backlog/2026-09-06-sprintengine-studio-ships-as-a-plugin.md).
//
// The bundled bytes under `resources/studio-plugin` are a TEMPLATE, not the
// thing that gets loaded. Three values in it can only be known on this machine
// at this moment — the node binary, the absolute path of the stdio bridge in
// this app bundle, and the live agent-state socket — so install materialises a
// copy of the whole marketplace into `<workspace>/.multicode/studio-plugin`
// with those tokens replaced. That mirrors what the agent-state hook installer
// already does with its own absolute script path, and it is why the bridge is
// NOT copied into the plugin: the bridge must be the one belonging to the
// running build (it speaks that build's discovery file and connect frame), and
// a second copy inside the plugin would be a second thing to keep in step.
//
// What install writes, and why each lands where it does:
//
//   - The materialised plugin under `.multicode/`, which is the app-owned
//     per-workspace directory the agent-state reporter already lives in.
//   - The skills, copied into every harness's skill directory through the
//     ordinary skill installer, so each copy carries a provenance marker and
//     Sync can tell an app-shipped copy from someone's own edit.
//   - The agent-state hook, merged into `.claude/settings.local.json` — the
//     path the claude-code manifest names — from the command and event set the
//     plugin's OWN `hooks/hooks.json` declares. The plugin is the declaration;
//     the merge is how a workspace gets it while Claude Code is not loading the
//     plugin natively (see STUDIO_PLUGIN_NATIVE_CLAUDE_ENABLEMENT).
//   - `enabledPlugins` into `.claude/settings.json` (tracked by git in a normal
//     project, and portable: it names a plugin, not a path) and
//     `extraKnownMarketplaces` into `.claude/settings.local.json` (gitignored,
//     because a directory marketplace's source is an absolute machine path that
//     must never be committed). That split is why this module does not call
//     `enableClaudePlugin`, which writes both keys into one file.
//
// There is no uninstall of THIS plugin. It is built in: the catalogue offers
// no Remove for it, and a workspace that has had its skills deleted by hand
// gets them back the next time it is opened. `workflow-roles` is not this
// plugin. It is a marketplace entry like any other — the catalogue offers
// Install and Remove, and a workspace that has never installed it stays
// without it (owner ruling 2026-09-07).

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { SKILL_HARNESS_DIR } from '../../shared/skill-harnesses'
import type { SkillHarness } from '../../shared/skills'
import { STUDIO_PLUGIN_ID } from '../../shared/studio-plugin'
import {
  AGENT_STATE_HOOK_SCRIPT_REL,
  mergeAgentStateHooks,
  STATUS_LINE_HOOK_SCRIPT_REL,
  unmergeAgentStateHooks,
  unmergeStatusLineForwarder,
} from '../agent-state'
import { installSkillDirectory, readSkillProvenance } from './install'
import { CLAUDE_SETTINGS_RELATIVE_PATH } from './install-plugin'
import { isRecord } from '../../shared/records'

// The plugin's id — the directory it lives in, and the name in its manifest.
// Declared in shared/ because the catalogues need it too (they must not offer
// an Install for the plugin the app installs itself), and re-exported here
// because this module is where everything else about the plugin is named.
export { STUDIO_PLUGIN_ID } from '../../shared/studio-plugin'

/**
 * The resource directory the bundled marketplace ships in: `resources/…` in a
 * checkout, `<resourcesPath>/…` when packaged. One spelling, because it is both
 * the template this module materialises AND the offline seed the Skills and
 * Plugins catalogues read (studio-marketplace ruling, 2026-09-06).
 */
export const STUDIO_MARKETPLACE_RESOURCE_DIR = 'studio-plugin'

/**
 * The marketplace's OTHER plugin: the workflow skills the app ships, which
 * moved here out of `resources/skills` (studio-marketplace ruling, 2026-09-06)
 * so one source answers for them in every catalogue.
 *
 * They are a plugin of their own rather than more skills inside
 * `sprintengine-studio`, for two reasons. Every skill under that plugin is
 * copied into every workspace the app opens, and twelve general-purpose
 * workflow skills are a choice a person makes per workspace, not a manual the
 * bridge needs. And `builtin-skills.ts` already owns those directories —
 * installing them a second time from here would put two installers, with two
 * provenance markers, on the same paths.
 */
export const STUDIO_SKILLS_PLUGIN_ID = 'studio-skills'

/**
 * The sixteen Sprint Engine workflow roles. Published from the releases
 * repository as an ordinary marketplace plugin: installable, removable, never
 * force-installed (owner ruling 2026-09-07). Listed beside this plugin in the
 * marketplace; copied only when someone presses Install, and not restored on
 * the next workspace open.
 */
export const WORKFLOW_ROLES_PLUGIN_ID = 'workflow-roles'

/** The marketplace that lists it. */
const STUDIO_PLUGIN_MARKETPLACE_NAME = 'sprintengine-studio'

/**
 * The provenance `sourceId` every installed copy of a studio skill carries.
 * Deliberately not `plugin-bundle`: that id means "some bundle put this here"
 * and no sync claims it, whereas these copies ARE claimed — the app replaces
 * them whenever the version it ships moves past the version on disk.
 */
export const STUDIO_PLUGIN_SOURCE_ID = 'sprintengine-studio'

/** Where the materialised copy lives inside a workspace. */
export const STUDIO_PLUGIN_WORKSPACE_DIR = join('.multicode', 'studio-plugin')

// Re-exported rather than respelled: two constants naming the same file is how
// one of them ends up pointing somewhere else.
export { CLAUDE_SETTINGS_RELATIVE_PATH }

/** The gitignored half. Where anything machine-specific goes. */
export const CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH = '.claude/settings.local.json'

/**
 * Whether Claude Code is asked to load this plugin ITSELF (its own skill,
 * command, agent, hook and MCP loaders) rather than the app copying the pieces
 * in.
 *
 * OFF, and measured rather than assumed, twice.
 *
 * Against Claude Code 2.1.261 on 2026-09-06: a workspace `.claude/settings.json`
 * naming a `directory`-source marketplace under `extraKnownMarketplaces` plus
 * the plugin under `enabledPlugins` loaded NOTHING — no skills, no MCP server,
 * no hooks. The same workspace loaded all three the moment the marketplace also
 * appeared in Claude Code's own user-global
 * `~/.claude/plugins/known_marketplaces.json` (which
 * `claude plugin marketplace add` writes), and stopped again when that entry
 * was removed.
 *
 * The studio-marketplace ruling put our plugin in a GITHUB marketplace, which
 * is the source kind Claude Code can bootstrap for itself, so the measurement
 * was repeated against 2.1.263 on 2026-09-06 with the published repository. It
 * came out worse, in three steps:
 *
 *   1. A workspace naming `{source: "github", repo: "sprintengine/studio-releases"}`
 *      under `extraKnownMarketplaces` plus the plugin under `enabledPlugins`
 *      loaded nothing, and left `known_marketplaces.json` untouched. The source
 *      kind is not what the gate is about.
 *   2. `claude plugin marketplace add sprintengine/studio-releases` (which
 *      writes that user-global registry AND `~/.claude/settings.json`) still
 *      loaded nothing: a github marketplace also needs the plugin INSTALLED —
 *      `claude plugin install`, which clones into `~/.claude/plugins/cache/`
 *      and writes user-global `installed_plugins.json`. A directory source
 *      needed no such step, because its files were already local. So the
 *      GitHub marketplace does not remove the user-global write; it adds a
 *      second one.
 *   3. With both done, the five skills loaded — and the plugin loaded from the
 *      PUBLISHED copy, whose `.mcp.json` and `hooks/hooks.json` still carry the
 *      `__SPRINTENGINE_*` tokens. The MCP server failed to connect, and the
 *      SessionEnd hook ran `node "__SPRINTENGINE_AGENT_STATE_REPORTER__"` and
 *      died with MODULE_NOT_FOUND. That is the deeper reason this flag stays
 *      off: what we publish is a TEMPLATE, and the three values it cannot
 *      carry (this machine's node, this build's bridge, this session's socket)
 *      only exist in the copy `materialiseStudioPlugin` writes. Native loading
 *      would need Claude Code pointed at THAT directory — which is the
 *      directory source of measurement one, and back to the user-global write.
 *
 * Everything else is wired for the flip: the keys are written, the plugin is
 * materialised complete with its `.mcp.json` and `hooks/hooks.json`, and this
 * flag is the only thing between here and native loading. When it goes true,
 * the by-hand hook merge below must stop (Claude Code would then register the
 * plugin's hooks itself, and two registrations fire the reporter twice per
 * event) — `installStudioPlugin` already skips it on this flag, and
 * `studio-plugin.test.ts` holds that to it.
 *
 * THE FLAG NO LONGER DECIDES, measured against 2.1.266 on 2026-09-09. Claude
 * Code now writes a directory marketplace named under a PROJECT's
 * `extraKnownMarketplaces` into its own user-global
 * `~/.claude/plugins/known_marketplaces.json` — the entry appears by itself, the
 * second a workspace is opened, and this app has never written that file. That
 * is exactly the user-global write measurement one said was missing, so the
 * gate measurement one found is gone: for a DIRECTORY source, native loading of
 * hooks and MCP is effectively ON whatever this flag says, and no
 * `claude plugin install` is needed (measurement two's extra step is a github
 * source's, not a directory's).
 *
 * The bug that found it: the hover card's per-file ledger read exactly 2x the
 * agent's edits, because both registrations fired the reporter on every tool
 * call — which is the doubling this comment predicted, arriving without the
 * flag ever being flipped. Reproduced 2026-09-09 by rewriting each registration
 * to a distinguishable command: every event landed twice, and the two
 * PostToolUse frames carried the SAME `tool_use_id`.
 *
 * So the two halves are now decided separately, and this flag governs only the
 * half it can still govern:
 *
 *   - HOOKS: the materialised `hooks/hooks.json` is written EMPTY while this
 *     flag is false (see `materialiseStudioPlugin`), so a natively-loaded
 *     plugin registers no hook and the by-hand merge is the only one. The
 *     template's declaration stays the authority for WHAT to merge; it is read
 *     from the template, not from the neutered copy.
 *   - MCP: still double-registered, and deliberately left alone here. The
 *     plugin's own `.mcp.json` declares a server named `sprintengine-studio`,
 *     and `mcp-config-service.ts` independently writes the same id into the
 *     workspace `.mcp.json` and into `enabledMcpjsonServers`. Two loads of one
 *     stdio bridge is a wasted process, not a wrong number, so it is filed
 *     rather than fixed under this bug.
 */
export const STUDIO_PLUGIN_NATIVE_CLAUDE_ENABLEMENT = false

/**
 * The machine-and-moment values the template cannot carry. Named tokens rather
 * than positional substitution so a half-substituted file is obvious on sight
 * instead of being a plausible-looking wrong path.
 */
export type StudioPluginTokens = {
  /** The binary that runs the bridge — this app's own, so it needs no node on PATH. */
  nodeCommand: string
  /** Absolute path of `resources/automation/mcp-stdio-bridge.mjs` in this build. */
  bridgeScriptPath: string
  /** The profile's userData dir, which is where the bridge finds the discovery file. */
  userDataDir: string
  /** Absolute path of the agent-state reporter copy inside this workspace. */
  agentStateReporterPath: string
  /** The live agent-state socket (a `\\.\pipe\...` name on Windows). */
  agentStateSocketPath: string
}

const TOKEN_NAMES = {
  nodeCommand: '__SPRINTENGINE_NODE__',
  bridgeScriptPath: '__SPRINTENGINE_BRIDGE__',
  userDataDir: '__SPRINTENGINE_USER_DATA_DIR__',
  agentStateReporterPath: '__SPRINTENGINE_AGENT_STATE_REPORTER__',
  agentStateSocketPath: '__SPRINTENGINE_AGENT_STATE_SOCKET__',
} as const satisfies Record<keyof StudioPluginTokens, string>

/**
 * Replace every token in one file's text.
 *
 * Values are spliced with JSON string escaping applied by the caller's file
 * format, so paths are normalised to forward slashes first — Node accepts them
 * everywhere including `C:/...`, and a raw Windows path would otherwise put
 * unescaped backslashes inside a JSON string. The socket path is the one
 * exception and is left verbatim: a Windows named pipe's backslashes are part
 * of the name and a rewrite corrupts it into something connect() cannot open.
 */
export function substituteStudioPluginTokens(text: string, tokens: StudioPluginTokens): string {
  let out = text
  for (const key of Object.keys(TOKEN_NAMES) as (keyof StudioPluginTokens)[]) {
    const raw = tokens[key]
    const value = key === 'agentStateSocketPath' ? raw : raw.split('\\').join('/')
    out = out.split(TOKEN_NAMES[key]).join(jsonEscape(value))
  }
  return out
}

/** Escape a value for splicing inside a JSON double-quoted string. */
function jsonEscape(value: string): string {
  const quoted = JSON.stringify(value)
  return quoted.slice(1, -1)
}

/** True when a materialised file still carries a token — a bug, never shipped. */
export function hasUnsubstitutedTokens(text: string): boolean {
  return Object.values(TOKEN_NAMES).some((token) => text.includes(token))
}

// ── The template on disk ────────────────────────────────────────────────────

export type StudioPluginTemplate = {
  /** The marketplace root — the directory holding `.claude-plugin/marketplace.json`. */
  root: string
  /** The plugin directory inside it. */
  pluginDir: string
  version: string
  description: string
}

/**
 * Read the bundled template's identity. A build whose resources did not ship
 * says so by name rather than installing an empty plugin: a workspace with a
 * `.claude-plugin` holding nothing is worse than a workspace with none.
 */
export async function readStudioPluginTemplate(
  templateRoot: string
): Promise<{ ok: true; template: StudioPluginTemplate } | { ok: false; message: string }> {
  const pluginDir = join(templateRoot, STUDIO_PLUGIN_ID)
  const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json')
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch {
    return { ok: false, message: `The SprintEngine Studio plugin is missing from this build (${manifestPath}).` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, message: `The SprintEngine Studio plugin manifest is not valid JSON: ${describe(error)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'The SprintEngine Studio plugin manifest is not a JSON object.' }
  }
  const manifest = parsed as Record<string, unknown>
  if (manifest.name !== STUDIO_PLUGIN_ID) {
    return {
      ok: false,
      message: `The SprintEngine Studio plugin manifest names "${String(manifest.name)}"; it must name "${STUDIO_PLUGIN_ID}".`,
    }
  }
  const version = typeof manifest.version === 'string' ? manifest.version : ''
  if (version === '') return { ok: false, message: 'The SprintEngine Studio plugin manifest declares no version.' }
  return {
    ok: true,
    template: {
      root: templateRoot,
      pluginDir,
      version,
      description: typeof manifest.description === 'string' ? manifest.description : '',
    },
  }
}

/** The skill directory names the template ships, in listing order. */
export async function listStudioPluginSkillDirs(template: StudioPluginTemplate): Promise<string[]> {
  const skillsRoot = join(template.pluginDir, 'skills')
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => null)
  if (entries === null) return []
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
}

// ── Materialising ───────────────────────────────────────────────────────────

/**
 * Copy the whole template into the workspace with the tokens replaced.
 *
 * Written to a sibling directory and renamed into place, so a workspace never
 * holds a half-written plugin: an agent reading `skills/` mid-install would
 * otherwise find a skill whose SKILL.md is a zero-byte file.
 */
async function materialiseStudioPlugin(input: {
  template: StudioPluginTemplate
  workspaceRoot: string
  tokens: StudioPluginTokens
}): Promise<{ ok: true; root: string } | { ok: false; message: string }> {
  return materialiseStudioPluginInto({
    template: input.template,
    destination: resolve(input.workspaceRoot, STUDIO_PLUGIN_WORKSPACE_DIR),
    tokens: input.tokens,
    // A workspace copy is loaded by Claude Code natively AND registered by hand
    // in that workspace's settings, so its declaration is blanked to keep the
    // reporter from firing twice. The app-owned copy behind `--plugin-dir` is
    // the only registration there is, so that caller keeps its hooks.
    neuterHooks: !STUDIO_PLUGIN_NATIVE_CLAUDE_ENABLEMENT,
  })
}

/**
 * Materialise the template into an arbitrary directory.
 *
 * Split out of `materialiseStudioPlugin` for the app-owned copy the launch
 * passes to a CLI with `--plugin-dir` (`agent-integration-home.ts`): one copier,
 * so the workspace copy and the app copy can never drift in what they
 * substitute, what they skip, or how atomically they land.
 */
export async function materialiseStudioPluginInto(input: {
  template: StudioPluginTemplate
  /** Absolute path of the marketplace root to write. Replaced wholesale. */
  destination: string
  tokens: StudioPluginTokens
  /** Blank the copy's `hooks/hooks.json` — see `neuterMaterialisedHooks`. */
  neuterHooks: boolean
}): Promise<{ ok: true; root: string } | { ok: false; message: string }> {
  const destination = input.destination
  const staging = `${destination}.${process.pid}.tmp`
  try {
    await rm(staging, { recursive: true, force: true })
    await mkdir(dirname(destination), { recursive: true })
    await copyTree(input.template.root, staging, input.tokens)
    if (input.neuterHooks) await neuterMaterialisedHooks(staging)
    await rm(destination, { recursive: true, force: true })
    await rename(staging, destination)
    return { ok: true, root: destination }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, message: `The SprintEngine Studio plugin could not be written: ${describe(error)}` }
  }
}

/**
 * Blank the materialised plugin's hook declaration.
 *
 * Claude Code loads this plugin's hooks natively whether or not the app asks it
 * to (see STUDIO_PLUGIN_NATIVE_CLAUDE_ENABLEMENT), so while the app is ALSO
 * merging the same reporter into `.claude/settings.local.json` by hand, the
 * declaration in the copy on disk is a second registration and every tool call
 * fires the reporter twice.
 *
 * The file is written as `{ "hooks": {} }` rather than deleted. Claude Code
 * accepts both — its plugin reference makes `hooks/hooks.json` optional, and an
 * empty `hooks` object registers nothing — but a present, empty file says "this
 * plugin deliberately declares no hook" where a missing one is indistinguishable
 * from a botched copy, and `parsePluginHookRegistration` reads it as "no
 * registration" either way.
 *
 * The TEMPLATE is untouched and stays the authority for what the by-hand merge
 * registers; `installStudioPlugin` reads the declaration from there rather than
 * from the copy this blanks. When the flag flips, this stops running and the
 * substituted declaration is materialised as before.
 */
async function neuterMaterialisedHooks(pluginRoot: string): Promise<void> {
  const hooksPath = join(pluginRoot, STUDIO_PLUGIN_ID, 'hooks', 'hooks.json')
  if (!existsSync(hooksPath)) return
  await writeFile(
    hooksPath,
    `${JSON.stringify(
      {
        $comment:
          'Emptied at install: SprintEngine Studio registers the agent-state reporter itself, in this workspace\u2019s .claude/settings.local.json. Claude Code loads this plugin natively, so a declaration here would be a SECOND registration and would fire the reporter twice per tool call. The declaration lives in the app\u2019s template (resources/studio-plugin/\u2026/hooks/hooks.json), which is what the merge reads.',
        hooks: {},
      },
      null,
      2
    )}\n`,
    'utf8'
  )
}

/** Files above this are copied byte-for-byte; nothing in the template is close. */
const MAX_SUBSTITUTED_FILE_BYTES = 2 * 1024 * 1024

/**
 * The template's own documentation. It explains the tokens by NAMING them, so
 * copying it through substitution would rewrite the explanation into a list of
 * paths — and it describes this repository's tree, not the workspace's, so a
 * copy of it in a workspace would be wrong even intact.
 */
const TEMPLATE_ONLY_FILES = new Set(['README.md'])

/**
 * Substitution is textual, so it is confined to the files that actually carry
 * tokens. Every one of them is JSON; prose that mentions a token by name (the
 * README, and a skill explaining the bridge) must survive verbatim.
 */
function substitutable(name: string): boolean {
  return name.toLowerCase().endsWith('.json')
}

async function copyTree(from: string, to: string, tokens: StudioPluginTokens, depth = 0): Promise<void> {
  await mkdir(to, { recursive: true })
  const entries = await readdir(from, { withFileTypes: true })
  for (const entry of entries) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      await copyTree(source, target, tokens, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    if (depth === 0 && TEMPLATE_ONLY_FILES.has(entry.name)) continue
    const info = await stat(source)
    if (!substitutable(entry.name) || info.size > MAX_SUBSTITUTED_FILE_BYTES) {
      await copyFile(source, target)
      continue
    }
    const text = await readFile(source, 'utf8')
    await writeFile(target, substituteStudioPluginTokens(text, tokens), 'utf8')
  }
}

// ── The hook the plugin declares ────────────────────────────────────────────

export type PluginHookRegistration = {
  command: string
  events: { event: string; matcher?: string }[]
}

/**
 * The command and event set a plugin's `hooks/hooks.json` declares, in the
 * shape the agent-state hook merger takes.
 *
 * One command for the whole file: the merger registers a single command across
 * an event list, and a plugin declaring two different commands is a plugin this
 * install cannot honour — better to say so than to register half of it. Both
 * shapes Claude Code accepts are read (`{ hooks: { Event: [...] } }` and the
 * bare `{ Event: [...] }`), matching the scanner's own reading.
 */
export function parsePluginHookRegistration(raw: string): PluginHookRegistration | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const events = isRecord(parsed.hooks) ? parsed.hooks : parsed
  const out: { event: string; matcher?: string }[] = []
  let command = ''
  for (const [event, groups] of Object.entries(events)) {
    if (event.startsWith('$') || !Array.isArray(groups)) continue
    for (const group of groups) {
      if (!isRecord(group)) continue
      const matcher = typeof group.matcher === 'string' && group.matcher !== '' ? group.matcher : undefined
      const entries = Array.isArray(group.hooks) ? group.hooks : [group]
      for (const hook of entries) {
        if (!isRecord(hook)) continue
        const next = typeof hook.command === 'string' ? hook.command : ''
        if (next === '') continue
        if (command === '') command = next
        else if (command !== next) return null
        out.push(matcher === undefined ? { event } : { event, matcher })
      }
    }
  }
  return command === '' || out.length === 0 ? null : { command, events: out }
}

// ── Install ─────────────────────────────────────────────────────────────────

export type StudioPluginInstallOptions = {
  workspaceRoot: string
  /** `resources/studio-plugin` in this build. */
  templateRoot: string
  harnesses: readonly SkillHarness[]
  tokens: StudioPluginTokens
  /** The bundled reporter script, copied to `tokens.agentStateReporterPath`. */
  agentStateReporterSourcePath: string
  /**
   * Whether the person has agreed that this plugin's hook commands may run.
   * Answered once, at first run, for the app's own plugin — see
   * `studio-plugin-service.ts`. False registers no hook and installs the rest.
   */
  hooksAcknowledged: boolean
  /**
   * Whether this workspace's Claude settings are still where the plugin is
   * registered.
   *
   * False once the launch hands Claude Code its plugin directories directly
   * (`--plugin-dir`, see `agent-integration-home.ts`): the hook, the skills and
   * the MCP server all arrive with the session instead, so writing them here
   * would register the reporter a SECOND time — every event fires twice — and
   * would leave this app's files in someone's repository for a colleague who
   * never ran it to inherit.
   */
  registerWithClaude: boolean
}

export type StudioPluginInstallResult =
  | {
      ok: true
      version: string
      /** Where the materialised copy landed. */
      root: string
      /** Skill directory names copied, per the harnesses that took them. */
      skillDirNames: string[]
      harnesses: SkillHarness[]
      /** `name@marketplace` written under `enabledPlugins`. */
      claudePluginKey: string
      /** The settings file the agent-state hook was merged into, '' when it was not. */
      hookSettingsPath: string
      /** Failures that did not stop the install. */
      warnings: string[]
    }
  | { ok: false; message: string }

export async function installStudioPlugin(
  options: StudioPluginInstallOptions
): Promise<StudioPluginInstallResult> {
  const workspaceRoot = options.workspaceRoot.trim()
  if (workspaceRoot === '') return { ok: false, message: 'Workspace root is required.' }
  if (!existsSync(workspaceRoot)) return { ok: false, message: 'That workspace folder no longer exists.' }

  const read = await readStudioPluginTemplate(options.templateRoot)
  if (!read.ok) return read
  const { template } = read

  // The reporter first: the hook command the template names points at it, and a
  // registered hook whose script is absent fires MODULE_NOT_FOUND on every
  // event of every session until something reinstalls it.
  //
  // Only when this workspace is still where the hook is registered. Once the
  // launch carries it, the reporter the session runs is the copy inside the
  // app's own plugin directory, and writing a second one here would put back
  // the very file the migration above just removed.
  if (options.registerWithClaude) {
    if (!existsSync(options.agentStateReporterSourcePath)) {
      return { ok: false, message: 'The agent-state reporter is missing from this build.' }
    }
    try {
      await mkdir(dirname(options.tokens.agentStateReporterPath), { recursive: true })
      await copyFile(options.agentStateReporterSourcePath, options.tokens.agentStateReporterPath)
    } catch (error) {
      return { ok: false, message: `The agent-state reporter could not be copied: ${describe(error)}` }
    }
  }

  const materialised = await materialiseStudioPlugin({ template, workspaceRoot, tokens: options.tokens })
  if (!materialised.ok) return materialised

  const warnings: string[] = []
  const skillDirs = await listStudioPluginSkillDirs(template)
  if (skillDirs.length === 0) {
    return { ok: false, message: 'The SprintEngine Studio plugin ships no skills in this build.' }
  }

  // Skills go through the ordinary installer so a bundle cannot reach outside
  // its own directory and every copy carries provenance. Read from the
  // MATERIALISED copy, not the template, so what an agent loads is what the
  // plugin holds — one set of bytes, not two that could drift.
  const copied: string[] = []
  const harnessesThatTook = new Set<SkillHarness>()
  for (const dirName of skillDirs) {
    const result = await installSkillDirectory({
      workspaceRoot,
      sourceDir: join(materialised.root, STUDIO_PLUGIN_ID, 'skills', dirName),
      dirName,
      harnesses: options.harnesses,
      provenance: { sourceId: STUDIO_PLUGIN_SOURCE_ID, skillId: dirName, commitSha: template.version },
    })
    if (!result.ok) {
      warnings.push(`${dirName} did not install: ${result.message}`)
      continue
    }
    copied.push(result.dirName)
    for (const harness of result.harnesses) harnessesThatTook.add(harness)
  }
  if (copied.length === 0) {
    return { ok: false, message: warnings[0] ?? 'No SprintEngine Studio skill could be copied into this workspace.' }
  }

  // The hook, from the plugin's own declaration. Skipped when Claude Code loads
  // the plugin itself — it would then register these same hooks, and two
  // registrations spawn the reporter twice for every event.
  //
  // Read from the TEMPLATE, not from the materialised copy: while this flag is
  // false `materialiseStudioPlugin` blanks the copy's `hooks/hooks.json`
  // precisely so the natively-loaded plugin registers nothing, and reading the
  // blank back would leave the workspace with no reporter at all. The template
  // carries the tokens unsubstituted, so the same substitution the copy got is
  // applied to the text here — one function, so the command that is registered
  // and the command that would be materialised can never differ.
  let hookSettingsPath = ''
  if (options.registerWithClaude && !STUDIO_PLUGIN_NATIVE_CLAUDE_ENABLEMENT && options.hooksAcknowledged) {
    const hooksPath = join(template.root, STUDIO_PLUGIN_ID, 'hooks', 'hooks.json')
    const raw = await readFile(hooksPath, 'utf8').catch(() => null)
    const registration =
      raw === null ? null : parsePluginHookRegistration(substituteStudioPluginTokens(raw, options.tokens))
    if (registration === null) {
      warnings.push('The plugin declares no hook command this app can register, so agent state was left to the CLI installer.')
    } else {
      const path = resolve(workspaceRoot, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH)
      try {
        await mergeAgentStateHooks(path, registration.command, registration.events)
        hookSettingsPath = path
      } catch (error) {
        warnings.push(`The agent-state hook could not be registered: ${describe(error)}`)
      }
    }
  }

  // Naming the plugin in this workspace's Claude settings is only meaningful
  // while Claude Code is meant to load it from here. Once the launch passes the
  // directory itself, these keys would point Claude at a second copy of the
  // same plugin — and `extraKnownMarketplaces` carries an absolute machine path
  // into a file the person's colleagues read.
  const enabled = options.registerWithClaude
    ? await enableStudioPluginInClaudeSettings({ workspaceRoot, marketplacePath: materialised.root })
    : null
  if (enabled && !enabled.ok) warnings.push(enabled.message)

  return {
    ok: true,
    version: template.version,
    root: materialised.root,
    skillDirNames: copied,
    harnesses: [...harnessesThatTook],
    claudePluginKey: enabled?.ok ? enabled.pluginKey : '',
    hookSettingsPath,
    warnings,
  }
}

// ── Claude Code settings ────────────────────────────────────────────────────

/** What Claude Code's settings call a plugin: `name@marketplace`. */
export function studioClaudePluginKey(): string {
  return `${STUDIO_PLUGIN_ID}@${STUDIO_PLUGIN_MARKETPLACE_NAME}`
}

/**
 * Take this app's Claude wiring back out of a workspace it was written into.
 *
 * Every workspace opened before the launch carried these plugins still holds
 * the older arrangement: the reporter merged into `.claude/settings.local.json`
 * pointing at a script under `.multicode/hooks`, the two settings keys, and a
 * copy of each skill under `.claude/skills`. Left alone, the stale hook and the
 * one the launch now registers would BOTH fire for every event — the doubling
 * this file's notes describe — and the files would stay in the person's
 * repository, which is the thing the launch flag exists to stop.
 *
 * Deliberately narrow about what it will delete:
 *   - Only a hook entry or status line this app wrote is removed; the unmerge
 *     helpers identify ours by tag or command shape and leave everything else.
 *   - Only a skill directory carrying OUR provenance marker is removed, so a
 *     skill someone wrote by hand, or one another source installed, survives.
 *   - No file is created. A workspace that never had any of this is untouched.
 *
 * Best-effort and never throws: it runs on the path a person is waiting behind,
 * and a workspace that could not be tidied is worth strictly less than a
 * workspace that would not open. Returns what it removed, for the diagnostic.
 */
export async function removeStudioPluginClaudeRegistration(workspaceRoot: string): Promise<string[]> {
  const removed: string[] = []
  const root = workspaceRoot.trim()
  if (root === '') return removed

  const localPath = resolve(root, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH)
  if (existsSync(localPath)) {
    try {
      await unmergeAgentStateHooks(localPath)
      await unmergeStatusLineForwarder(localPath)
      removed.push(CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH)
    } catch {
      // A settings file we could not rewrite keeps its stale entry; the launch
      // still works, and the next open tries again.
    }
  }

  // The scripts those entries named. Removed after the entries, so a failure
  // half-way never leaves a registration pointing at a deleted file.
  for (const relative of [AGENT_STATE_HOOK_SCRIPT_REL, STATUS_LINE_HOOK_SCRIPT_REL]) {
    const path = resolve(root, relative)
    if (!existsSync(path)) continue
    try {
      await rm(path, { force: true })
      removed.push(relative)
    } catch {
      // Nothing reads it any more; it is disk, not behaviour.
    }
  }

  if (await removeSettingsKey(resolve(root, CLAUDE_SETTINGS_RELATIVE_PATH), 'enabledPlugins', studioClaudePluginKey())) {
    removed.push(CLAUDE_SETTINGS_RELATIVE_PATH)
  }
  await removeSettingsKey(localPath, 'extraKnownMarketplaces', STUDIO_PLUGIN_MARKETPLACE_NAME)

  // The skill copies. Claude reads these from the directory the launch passes
  // now, so a copy here is a second, ageing set of the same bytes.
  const skillsRoot = join(root, SKILL_HARNESS_DIR.claude, 'skills')
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => null)
  for (const entry of entries ?? []) {
    if (!entry.isDirectory()) continue
    const directory = join(skillsRoot, entry.name)
    const provenance = await readSkillProvenance(directory)
    if (provenance?.sourceId !== STUDIO_PLUGIN_SOURCE_ID) continue
    try {
      await rm(directory, { recursive: true, force: true })
      removed.push(join(SKILL_HARNESS_DIR.claude, 'skills', entry.name))
    } catch {
      // Leaving it costs a stale copy, never a broken workspace.
    }
  }

  return removed
}

/**
 * Delete one key from one record inside a settings file, touching nothing else.
 *
 * A file that does not exist is never created, an emptied record is removed
 * rather than left as `{}` (it would read as a deliberate empty setting), and
 * an unparseable file is left exactly as it is — it is someone's work in
 * progress, and this is a tidy-up, not a repair.
 */
async function removeSettingsKey(path: string, record: string, key: string): Promise<boolean> {
  if (!existsSync(path)) return false
  const read = await readJsonObject(path)
  if (!read.ok || read.raw.trim() === '') return false
  const holder = read.value[record]
  if (!isRecord(holder) || !(key in holder)) return false
  delete holder[key]
  if (Object.keys(holder).length === 0) delete read.value[record]
  else read.value[record] = holder
  const wrote = await writeJsonObject(path, read.value, read.raw)
  return wrote.ok
}

/**
 * Name the plugin in the workspace's Claude settings, across the two files
 * Claude Code merges.
 *
 * `enabledPlugins` goes in `.claude/settings.json`, which a project normally
 * commits: it names a plugin and nothing else, so it means the same thing on
 * every machine that opens this repository. `extraKnownMarketplaces` goes in
 * `.claude/settings.local.json`, which is gitignored: a directory marketplace's
 * source is this machine's absolute path, and committing it would hand everyone
 * else a path that does not exist.
 *
 * Both files are merged, never replaced, and only these two keys are touched.
 */
async function enableStudioPluginInClaudeSettings(input: {
  workspaceRoot: string
  /** The materialised marketplace root on this machine. */
  marketplacePath: string
}): Promise<{ ok: true; pluginKey: string } | { ok: false; message: string }> {
  const pluginKey = studioClaudePluginKey()
  const projectPath = resolve(input.workspaceRoot, CLAUDE_SETTINGS_RELATIVE_PATH)
  const project = await readJsonObject(projectPath)
  if (!project.ok) return project
  const enabledPlugins = isRecord(project.value.enabledPlugins) ? project.value.enabledPlugins : {}
  enabledPlugins[pluginKey] = true
  project.value.enabledPlugins = enabledPlugins
  const wroteProject = await writeJsonObject(projectPath, project.value, project.raw)
  if (!wroteProject.ok) return wroteProject

  const localPath = resolve(input.workspaceRoot, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH)
  const local = await readJsonObject(localPath)
  if (!local.ok) return local
  const marketplaces = isRecord(local.value.extraKnownMarketplaces) ? local.value.extraKnownMarketplaces : {}
  // Rewritten every install rather than left alone if present: the path is this
  // build's, and an app that moved would otherwise leave the old one standing.
  marketplaces[STUDIO_PLUGIN_MARKETPLACE_NAME] = {
    source: { source: 'directory', path: input.marketplacePath },
  }
  local.value.extraKnownMarketplaces = marketplaces
  const wroteLocal = await writeJsonObject(localPath, local.value, local.raw)
  if (!wroteLocal.ok) return wroteLocal
  return { ok: true, pluginKey }
}

async function readJsonObject(
  path: string
): Promise<{ ok: true; value: Record<string, unknown>; raw: string } | { ok: false; message: string }> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, value: {}, raw: '' }
    return { ok: false, message: `${path} could not be read: ${describe(error)}` }
  }
  if (raw.trim() === '') return { ok: true, value: {}, raw }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return { ok: false, message: `${path} is not a JSON object, so it was left alone.` }
    return { ok: true, value: parsed, raw }
  } catch (error) {
    // A file that does not parse is someone's work in progress; writing over it
    // would destroy whatever they were typing.
    return { ok: false, message: `${path} is not valid JSON, so it was left alone: ${describe(error)}` }
  }
}

async function writeJsonObject(
  path: string,
  value: Record<string, unknown>,
  /** What was read; an unchanged file is not rewritten. */
  before?: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const next = `${JSON.stringify(value, null, 2)}\n`
  // `.claude/settings.json` is a file a project commits. Rewriting it with
  // identical bytes on every workspace open would show up as a touched file in
  // everyone's editor for no reason.
  if (before !== undefined && before === next) return { ok: true }
  try {
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, next, 'utf8')
    await rename(temp, path)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: `${path} could not be written: ${describe(error)}` }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
