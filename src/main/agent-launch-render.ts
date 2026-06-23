import { applyDebugDirective } from '../shared/debug-directive'
import type { AgentCli, CliRuntimeSettings, ColorScheme, SprintEngineCliPermissionPreset } from '../shared/electron-api'
import type { LoadedPlugin, PluginRenderContext } from '../shared/plugin-manifest'

import { getPluginById } from './plugin-registry-instance'
import { renderPluginLaunch, renderPluginResume } from './plugin-render'

export function pluginIdForCli(cli: AgentCli): string {
  return cli
}

const DEBUG_SKILL_ID = 'debug'

// Resolves the CLI-native explicit invocation for the debug skill from the
// plugin manifest (e.g. "/debug" for Claude Code, "Use $debug." for Codex), or
// undefined when the plugin does not natively support skills (so Debug Mode
// falls back to the inline directive alone). Debug Mode prepends this so the
// skill is triggered through the CLI's first-class mechanism; the spawn path
// ensure-installs the skill (see terminal-runtime) so the invocation always
// resolves to a skill that is actually present.
export function resolveDebugSkillInvocation(plugin: LoadedPlugin): string | undefined {
  const integration = plugin.manifest.skillIntegration
  if (!integration || integration.support !== 'native') return undefined
  const template = integration.invocation?.explicitTemplate
  if (!template) return undefined
  return template.replace(/\{\{\s*skillId\s*\}\}/g, DEBUG_SKILL_ID)
}

// Resolves the effective command/WSL override for a launch. Uses the plugin-id
// key only; a blank command means "use the manifest binary".
export function resolveCliRuntimeSettings(
  cli: AgentCli,
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
): CliRuntimeSettings {
  const direct = cliRuntimes?.[cli]
  const command =
    (typeof direct?.command === 'string' ? direct.command : undefined)
    ?? ''
  const useWsl = direct?.useWsl ?? false
  return { command: command.trim(), useWsl }
}

export type AgentLaunchRenderInput = {
  cli: AgentCli
  sessionId: string
  resume?: boolean
  initialPrompt?: string
  cliRuntime?: CliRuntimeSettings
  cliPermissionPreset?: SprintEngineCliPermissionPreset
  cliModel?: string
  // Orthogonal Debug Mode flag. When true the launch boundary prepends the debug
  // directive to the initial prompt; it never affects permission/session/model
  // flags (the orthogonality invariant). See applyDebugDirective.
  debugMode?: boolean
  // Host light/dark scheme to launch the CLI matching the app surface. Consumed
  // only by manifests declaring themeSelection (today: Claude Code); undefined
  // leaves the CLI on its own configured theme.
  colorScheme?: ColorScheme
}

export type RenderedAgentLaunch = {
  argv: string[]
  binary: string
  plugin: LoadedPlugin
}

export class AgentLaunchRenderError extends Error {}

export function renderAgentLaunchArgv(input: AgentLaunchRenderInput): RenderedAgentLaunch {
  const pluginId = pluginIdForCli(input.cli)
  const plugin = getPluginById(pluginId)
  if (!plugin) {
    throw new AgentLaunchRenderError(
      `No plugin manifest found for "${input.cli}" (looked up as "${pluginId}"). ` +
        `Check that resources/plugins/${pluginId}/plugin.json is bundled.`
    )
  }

  const binary = input.cliRuntime?.command?.trim() || plugin.manifest.binary
  // Debug Mode is applied here, at the single render boundary every spawn path
  // converges on, so the directive (led by the CLI-native skill invocation when
  // the plugin supports it) lands in the rendered prompt token for any CLI. Only
  // touched when debugMode is set, preserving an undefined prompt (and thus the
  // no-prompt argv shape) for ordinary launches.
  const prompt = input.debugMode
    ? applyDebugDirective(input.initialPrompt ?? '', true, resolveDebugSkillInvocation(plugin))
    : input.initialPrompt
  const context: PluginRenderContext = {
    binary,
    sessionId: input.sessionId,
    prompt,
    permissionPreset: input.cliPermissionPreset ?? 'default',
    model: input.cliModel,
    colorScheme: input.colorScheme,
  }

  const rendered = input.resume
    ? renderPluginResume(plugin.manifest, context)
    : renderPluginLaunch(plugin.manifest, context)

  if (!rendered) {
    throw new AgentLaunchRenderError(
      `Plugin "${pluginId}" does not declare a resume command. ` +
        `Set resume.supported = true and resume.argv in its plugin.json.`
    )
  }

  return { argv: rendered.argv, binary, plugin }
}

// Quote rules match the legacy buildAgentLaunchCommand: tokens that are safe
// as bare shell words (alphanumeric and a small punctuation set) are passed
// through, everything else is single-quoted. Semantically identical to the
// pre-plugin output, though session-ids and simple prompts may render
// without surrounding quotes where the legacy code always quoted them.
const SAFE_POSIX_TOKEN = /^[A-Za-z0-9._/-]+$/

export function quotePosixToken(value: string): string {
  return SAFE_POSIX_TOKEN.test(value) ? value : quotePosixForced(value)
}

export function quotePosixForced(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export function argvToPosixShellCommand(argv: string[]): string {
  return argv.map(quotePosixToken).join(' ')
}

// Builds the shell snippet emitted by the Sprint Engine / manual terminal
// launch path: a `command -v` guard, the actual agent invocation, and a
// closing `fi`. Pulled here so it can be unit-tested without touching the
// Electron-dependent `terminal-launch.ts` module.
export function buildAgentShellCommand(input: AgentLaunchRenderInput): string {
  const { argv, binary, plugin } = renderAgentLaunchArgv(input)
  const shellCommand = argvToPosixShellCommand(argv)
  const displayName = plugin.manifest.displayName
  const shortName = displayName.split(/\s+/)[0] || displayName
  const message = `${shortName} CLI was not found. Check the ${input.cli} command in Multicode Settings.`
  const guard = [
    `if ! command -v ${quotePosixToken(binary)} >/dev/null 2>&1; then`,
    `echo ${quotePosixForced(message)};`,
    'else',
  ].join(' ')
  return [guard, `${shellCommand};`, 'fi'].join(' ')
}
