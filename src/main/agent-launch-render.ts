import { applyDebugDirective } from '../shared/debug-directive'
import type { AgentCli, CliRuntimeSettings, ColorScheme, CliPermissionPreset } from '../shared/electron-api'
import type { LoadedPlugin, PluginRenderContext } from '../shared/plugin-manifest'
import { resolveSkillInvocation } from '../shared/skill-invocation'

import { getPluginById } from './plugin-registry-instance'
import { renderPluginLaunch, renderPluginResume } from './plugin-render'

export function pluginIdForCli(cli: AgentCli): string {
  return cli
}

/**
 * Whether this CLI is handed the app's own plugin directories at launch.
 *
 * The one question both halves of the arrangement ask: the launch path, to
 * decide whether to pass `--plugin-dir`, and the workspace installers, to
 * decide whether to write the same skills and the same hook into the person's
 * repository. They must never disagree — a CLI answering true here and getting
 * a workspace install too would register the reporter twice and fire it twice
 * per event, which is the doubling the studio-plugin notes describe.
 *
 * Answers false for a CLI whose manifest is missing, so an unresolvable plugin
 * degrades to the behaviour that was there before this flag existed.
 */
export function cliTakesLaunchPlugins(cli: string): boolean {
  const plugin = getPluginById(cli)
  const args = plugin?.manifest.launchPlugins?.args
  return Array.isArray(args) && args.length > 0
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
  return resolveSkillInvocation(plugin.manifest.skillIntegration, DEBUG_SKILL_ID)
}

// Resolves the effective command/WSL override for a launch. Uses the plugin-id
// key only; a blank command means "use the manifest binary".
export function resolveCliRuntimeSettings(
  cli: AgentCli,
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
): CliRuntimeSettings {
  const direct = cliRuntimes?.[cli]
  const command = (typeof direct?.command === 'string' ? direct.command : undefined) ?? ''
  const useWsl = direct?.useWsl ?? false
  return { command: command.trim(), useWsl }
}

export type AgentLaunchRenderInput = {
  cli: AgentCli
  sessionId: string
  resume?: boolean
  // The workspace this launch runs in, so Debug Mode's directive names the
  // sidecar directory that workspace actually uses. Absent leaves the current
  // name, which is right for a launch with no workspace behind it.
  workspaceRoot?: string
  initialPrompt?: string
  cliRuntime?: CliRuntimeSettings
  cliPermissionPreset?: CliPermissionPreset
  cliModel?: string
  // Selected reasoning-effort level. Consumed only by manifests declaring
  // reasoningSelection (today: Codex and Claude Code); rendered as
  // `reasoningArgs` only when it differs from the manifest's declared default,
  // so unset/default levels leave the launch argv unchanged. Claude Code
  // declares no default, so every explicitly picked level renders there.
  cliReasoning?: string
  // Orthogonal Debug Mode flag. When true the launch boundary prepends the debug
  // directive to the initial prompt; it never affects permission/session/model
  // flags (the orthogonality invariant). See applyDebugDirective.
  debugMode?: boolean
  // Host light/dark scheme to launch the CLI matching the app surface. Consumed
  // only by manifests declaring themeSelection (today: Claude Code); undefined
  // leaves the CLI on its own configured theme.
  colorScheme?: ColorScheme
  // Resolved provider auth token for CLIs whose manifest redirects the agent at
  // an alternate API endpoint (e.g. the Z.AI runtime, which runs the `claude`
  // binary against Z.AI's Anthropic-compatible endpoint). Exposed to the
  // manifest's `launch.env` templates as `{{secret}}` so the token is injected
  // into the spawned process env without ever appearing in argv. Undefined for
  // the ordinary CLIs (claude-code/codex/opencode), which declare no auth.
  secretToken?: string
  // Absolute path the availability probe resolved this CLI to, supplied by the
  // launch pre-flight (`preflightAgentCliLaunch`). Executing it is the whole
  // point: the probe consults the user's interactive shell, the launch shell
  // does not, so a binary on a ~/.zshrc-only PATH is otherwise detected and then
  // not found at launch. Undefined when the probe could not decide, which leaves
  // the bare name below.
  resolvedBinaryPath?: string
  // This launch's host-context document, in the two shapes a manifest's
  // `contextInjection` templates can spend it: the absolute path main wrote
  // (a markdown file, or for Cursor a plugin directory — already in the
  // launched shell's path style), and the document itself.
  // Both absent — the ordinary case, a project with no design system and no
  // knowledge graph — render no context args and no context env, so the launch
  // is byte-identical to what it was.
  contextFile?: string
  contextText?: string
  // The app-owned plugin directories this launch hands the CLI (its skills, its
  // agent-state hook and its MCP server), for manifests declaring
  // `launchPlugins`. Absent or empty renders no flag — which is what a build
  // whose plugin has not been materialised yet, or a CLI that takes no plugin
  // directory, gets.
  pluginDirs?: string[]
  // Settings this launch sends in the manifest's `launchSettings` document
  // (Claude Code's `--settings`), merged with the theme by `renderPluginLaunch`.
  // Today that is the status line the app reads a session's context-window
  // usage, cost and lines-changed from — the ONLY channel for it once the
  // workspace install is skipped, so a launch that drops it is a context ring
  // that never fills and nothing in the terminal to say so. Absent renders the
  // document the theme alone would have.
  launchSettings?: Record<string, unknown>
}

export type RenderedAgentLaunch = {
  argv: string[]
  binary: string
  plugin: LoadedPlugin
  // Environment variables the manifest's `launch.env` resolves to (with
  // `{{secret}}` and other variables substituted). Empty for manifests that
  // declare no `launch.env`. The caller injects these into the spawned PTY env
  // (and the WSL bootstrap) — they are intentionally NOT folded into argv.
  env: Record<string, string>
}

class AgentLaunchRenderError extends Error {}

export function renderAgentLaunchArgv(input: AgentLaunchRenderInput): RenderedAgentLaunch {
  const pluginId = pluginIdForCli(input.cli)
  const plugin = getPluginById(pluginId)
  if (!plugin) {
    throw new AgentLaunchRenderError(
      `No plugin manifest found for "${input.cli}" (looked up as "${pluginId}"). ` +
        `Check that resources/plugins/${pluginId}/plugin.json is bundled.`,
    )
  }

  // The probed path wins over a `cliRuntimes` command override because the probe
  // ran against that same override (detection is keyed by it) — the resolved
  // path is that command, made absolute. The bare name is the last resort.
  const binary = input.resolvedBinaryPath?.trim() || input.cliRuntime?.command?.trim() || plugin.manifest.binary
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
    reasoning: input.cliReasoning,
    colorScheme: input.colorScheme,
    // Only expose the secret variable when a token was resolved, so manifests
    // without auth render no `{{secret}}` value (renderEnv drops empty results,
    // so an unconfigured endpoint injects no empty token).
    variables: input.secretToken ? { secret: input.secretToken } : undefined,
    ...(input.contextFile ? { contextFile: input.contextFile } : {}),
    ...(input.contextText ? { contextText: input.contextText } : {}),
    // Only when there are directories to pass, so a launch before the app has
    // materialised its copy renders the argv it always did rather than an
    // empty flag.
    ...(input.pluginDirs && input.pluginDirs.length > 0 ? { pluginDirs: input.pluginDirs } : {}),
    // Same rule as the directories above: only when there is something to send,
    // so a launch with no settings of its own renders the theme-only document
    // the manifest always rendered.
    ...(input.launchSettings && Object.keys(input.launchSettings).length > 0
      ? { launchSettings: input.launchSettings }
      : {}),
  }

  const rendered = input.resume
    ? renderPluginResume(plugin.manifest, context)
    : renderPluginLaunch(plugin.manifest, context)

  if (!rendered) {
    throw new AgentLaunchRenderError(
      `Plugin "${pluginId}" does not declare a resume command. ` +
        `Set resume.supported = true and resume.argv in its plugin.json.`,
    )
  }

  return { argv: rendered.argv, binary, plugin, env: rendered.env }
}

// Decides whether a CLI launch must be blocked because the CLI declares a
// required credential (`auth`) that isn't configured. Returns a user-facing
// message when blocked, or null to proceed. Pure — the caller resolves the
// manifest + whether a secret is configured. A CLI without `auth` never blocks,
// so the ordinary CLIs are unaffected. This lets the spawn path show a clear
// "needs an API key" message instead of launching the agent into an auth error.
export function cliCredentialLaunchBlock(input: {
  displayName: string
  auth?: { label: string }
  secretConfigured: boolean
}): { message: string } | null {
  if (!input.auth || input.secretConfigured) return null
  return {
    message: `${input.displayName} needs an API key before it can start. Add it in Settings → Agents.`,
  }
}

// Renders just the launch-env a CLI manifest declares (with `{{secret}}` and
// other variables substituted), for callers that inject it into the spawned
// process env rather than argv. Returns an empty object for manifests with no
// `launch.env`. Resume vs launch only affects argv, so the env is identical;
// this always renders the launch spec.
export function renderCliLaunchEnv(input: AgentLaunchRenderInput): Record<string, string> {
  return renderAgentLaunchArgv({ ...input, resume: false }).env
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

function quotePosixForced(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export function argvToPosixShellCommand(argv: string[]): string {
  return argv.map(quotePosixToken).join(' ')
}

/**
 * The invocation a spawn WOULD make, rendered for display before it happens
 * (the new-agent tab's receipt line).
 *
 * It goes through `renderAgentLaunchArgv` — the same call the spawn makes — for
 * the reason the surface exists: a hand-written preview of `--permission-mode`
 * flags is a promise the launch path is free to break, and the first flag that
 * moved would turn the receipt into a lie. Sharing the renderer means a manifest
 * change reaches the preview and the spawn in one step.
 *
 * The prompt is deliberately NOT rendered: it is visible in the composer a line
 * above, it would re-render the preview on every keystroke, and on the CLIs that
 * pass it as argv it would bury the flags the line exists to show. `binary` is
 * the resolved command; callers show it plus `args`.
 *
 * `debugMode` is absent from the input for the same reason, and it is the
 * orthogonality invariant showing through: debug mode prepends a directive to
 * the PROMPT and never touches a flag, so on a prompt-free preview it has
 * nothing to say — and rendering it anyway would print a multi-line directive
 * into a one-line receipt. The row's own Debug chip carries that state.
 */
export function renderAgentLaunchPreview(
  input: Omit<AgentLaunchRenderInput, 'sessionId' | 'resume' | 'initialPrompt' | 'debugMode'>,
): { binary: string; args: string[]; display: string } {
  const { argv, binary } = renderAgentLaunchArgv({
    ...input,
    // A stable placeholder: session ids are rendered into argv by some
    // manifests, and a real one would make the preview churn per keystroke
    // while telling the reader nothing.
    sessionId: 'preview',
    resume: false,
    initialPrompt: undefined,
    debugMode: false,
  })
  // argv[0] is the binary; the receipt shows the command name and its flags.
  const args = argv.slice(1)
  return { binary, args, display: argvToPosixShellCommand(argv) }
}

// Exit status the launch script reports when its agent binary is not there —
// the shell's own "command not found", matching AGENT_CLI_NOT_FOUND_EXIT.
const AGENT_BINARY_NOT_FOUND_EXIT = 127

// Builds the shell snippet emitted by the manual terminal
// launch path: a `command -v` guard followed by the actual agent invocation.
// Pulled here so it can be unit-tested without touching the Electron-dependent
// `terminal-launch.ts` module.
//
// The guard EXITS rather than falling through. This snippet is joined ahead of
// an `exec $SHELL -l`, so a guard that only echoed left the user in a bare
// interactive shell with no agent — while the pty spawn itself succeeded, and
// the IPC reported `ok: true`. The pre-flight in `terminal-runtime` is the
// authority; this is the second line of defence for a binary that disappears
// between the pre-flight and the spawn, and it must fail visibly.
export function buildAgentShellCommand(input: AgentLaunchRenderInput): string {
  const { argv, binary, plugin } = renderAgentLaunchArgv(input)
  const shellCommand = argvToPosixShellCommand(argv)
  const displayName = plugin.manifest.displayName
  const shortName = displayName.split(/\s+/)[0] || displayName
  const message = `${shortName} CLI was not found. Check the ${input.cli} command in Settings.`
  const guard = [
    `if ! command -v ${quotePosixToken(binary)} >/dev/null 2>&1; then`,
    `echo ${quotePosixForced(message)} >&2;`,
    `exit ${AGENT_BINARY_NOT_FOUND_EXIT};`,
    'fi',
  ].join(' ')
  return [guard, shellCommand].join('; ')
}
