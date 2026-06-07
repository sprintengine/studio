import type { AgentCli, CliRuntimeSettings, SprintEngineCliPermissionPreset } from '../shared/electron-api'
import type { LoadedPlugin, PluginRenderContext } from '../shared/plugin-manifest'

import { getPluginById } from './plugin-registry-instance'
import { renderPluginLaunch, renderPluginResume } from './plugin-render'

export function pluginIdForCli(cli: AgentCli): string {
  return cli
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
  const context: PluginRenderContext = {
    binary,
    sessionId: input.sessionId,
    prompt: input.initialPrompt,
    permissionPreset: input.cliPermissionPreset ?? 'default',
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
