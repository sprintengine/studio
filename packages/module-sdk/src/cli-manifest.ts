// @sprintengine/module-sdk — BYO-CLI plugin authoring contract.
//
// A CLI plugin is a folder containing a `plugin.json` that tells Multicode how
// to launch, resume, drive and complete an agent CLI (e.g. claude-code, codex,
// opencode). Drop it into `~/.multicode/plugins/<id>/` or install it from
// Settings → Agents → "Install CLI from folder". The plugin id must equal the
// containing folder name; a user plugin with the same id as a bundled CLI
// overrides the bundled one.
//
// This is the SINGLE SOURCE OF TRUTH for CLI manifest validation: the running
// Multicode app validates a plugin.json by delegating to validateCliPluginManifest
// here (src/main/plugin-manifest-validate.ts imports it directly from the SDK
// source, the same way the third-party module manifest validator is shared), so
// the published authoring contract and the app's loader cannot drift. It is pure
// (no Node or DOM APIs), safe in any runtime, and runnable as a pre-flight check
// in an author's own tooling.

// ── Manifest shape ───────────────────────────────────────────────────────────

export type CliVariableType = 'string' | 'enum' | 'boolean' | 'number'

export type CliVariableDecl = {
  type: CliVariableType
  label: string
  description?: string
  default?: string | number | boolean
  required?: boolean
  options?: string[]
}

export type CliPermissionPreset = {
  label: string
  args: string[]
}

/**
 * A launch/resume argv token: a literal string, or a directive that the host
 * expands from caller variables at spawn time.
 * - `{ spread }` — splice an array variable in place.
 * - `{ spreadIf }` — splice a variable only when it is set.
 * - `{ valueIf, value }` — emit `value` only when the named variable is set.
 */
export type CliArgvToken =
  | string
  | { spread: string }
  | { spreadIf: string }
  | { valueIf: string; value: string }

export type CliLaunchSpec = {
  argv: CliArgvToken[]
  cwd?: string
  env?: Record<string, string>
}

export type CliResumeSpec = {
  supported: boolean
  argv?: CliArgvToken[]
}

export type CliPromptInjectionMode = 'positional-arg' | 'stdin-pipe' | 'send-after-ready' | 'file'

export type CliReadinessSignal = {
  type: 'output-match'
  pattern: string
  timeoutMs: number
}

export type CliPromptInjection = {
  mode: CliPromptInjectionMode
  readiness?: CliReadinessSignal
}

export type CliCompletionMode = 'process-exit' | 'output-sentinel' | 'mcp-signal' | 'idle-at-prompt'

export type CliCompletionSpec = {
  mode: CliCompletionMode
  sentinel?: string
  signalTool?: string
  idleMs?: number
  promptPattern?: string
  fallback?: CliCompletionSpec
}

export type CliMcpConfigFormat = 'claude-code' | 'codex' | 'opencode' | 'generic'

export type CliMcpConfigSpec = {
  path: string
  userPath?: string
  format: CliMcpConfigFormat
}

export type CliCapabilities = {
  resumeSession: boolean
  sessionIdFromCaller: boolean
  toolUse: boolean
  mcpServers: boolean
  imageInput?: boolean
  chatHistoryFile?: string
}

export type CliModelOption = {
  id: string
  label?: string
}

export type CliModelSelectionSpec = {
  args: string[]
  options?: CliModelOption[]
  allowCustomId?: boolean
}

// Declares that the CLI supports reasoning-effort selection. Mirrors
// `modelSelection`: `args` are substituted templates spread into launch argv as
// `reasoningArgs`, with `{{reasoning}}` resolving to the selected level id
// (e.g. Codex: ["-c", "model_reasoning_effort=\"{{reasoning}}\""]). Args render
// only when a level is selected and differs from `default`, so an unset or
// default level passes no flag. `levels` is the closed set the CLI accepts.
type CliReasoningOption = {
  id: string
  label?: string
}

type CliReasoningSelectionSpec = {
  args: string[]
  levels: CliReasoningOption[]
  default?: string
}

// Declares that the CLI can be launched matching the host's light/dark color
// scheme. `args` are substituted templates spread into launch/resume argv as
// `themeArgs`, with `{{colorScheme}}` resolving to 'light' or 'dark'
// (e.g. ["--settings", "{\"theme\":\"{{colorScheme}}\"}"] for Claude Code).
//
// `schemes` is for CLIs that have no literal "light"/"dark" value and instead
// take a named theme per scheme. When set, the active scheme resolves through
// this map and is exposed to `args` as `{{themeName}}`
// (e.g. Codex's syntect theme names: ["-c", "tui.theme=\"{{themeName}}\""] with
// { light: "catppuccin-latte", dark: "catppuccin-mocha" }). A scheme absent
// from the map renders no theme args, so the CLI keeps its own detection.
type CliThemeSelectionSpec = {
  args: string[]
  schemes?: { light: string; dark: string }
}

/**
 * How the host's out-of-band context document reaches this CLI.
 *
 * `promptInjection` says how the USER's request gets in; this says how
 * everything the HOST wants the agent to know gets in without pretending to be
 * the user (an attached design system, the project's knowledge graph).
 *
 * - `argv` — the CLI takes a system-prompt flag. `args` are substituted
 *   templates spread into LAUNCH and RESUME argv as `contextArgs`, so a resumed
 *   session is re-told (e.g. ["--append-system-prompt-file", "{{contextFile}}"]).
 * - `env` — the CLI reads instructions out of an environment variable; `env` is
 *   merged into the launch env.
 * - `prompt` — the CLI has no out-of-band channel, so the host wraps the
 *   document in `<host-context>` tags and places it BEFORE the user's prompt.
 *
 * Omitted ⇒ `prompt`. Templates may reference `{{contextFile}}` (absolute path
 * of the document the host wrote), `{{contextFileJson}}` (that path as a JSON
 * string literal, quotes included, for a template that embeds it in a JSON
 * document), `{{contextText}}` (the document itself) and
 * `{{contextToml}}` (the document as a TOML basic-string literal, quoted and
 * escaped, for a CLI that takes it through a config override). Nothing renders
 * when the host has nothing to say.
 */
export type CliContextInjectionMode = 'argv' | 'env' | 'prompt'

export type CliContextInjection = {
  mode: CliContextInjectionMode
  args?: string[]
  env?: Record<string, string>
}

export type CliSkillSupport = 'native' | 'prompt-shim' | 'unsupported'
export type CliSkillInstallScope = 'workspace' | 'user'
export type CliSkillFormat = 'agent-skills-v1' | 'claude-code' | 'codex' | 'opencode' | 'generic'

export type CliSkillInstallTarget = {
  scope: CliSkillInstallScope
  path: string
  format: CliSkillFormat
  restartRequired?: boolean
}

export type CliSkillInvocation = {
  fileDropTemplate?: string
  explicitTemplate?: string
  nativeSlashCommand?: boolean
  explicitMention?: boolean
  implicitInvocation?: boolean
  /**
   * The character typed to name a skill mid-prompt (`/`, `$`). Omit when the
   * CLI has no in-prompt form — surfaces then offer a picker instead of a
   * type-ahead rather than borrowing another CLI's trigger.
   */
  mentionPrefix?: string
  /** What a picked skill inserts; defaults to `{{mentionPrefix}}{{skillId}}`. */
  mentionTemplate?: string
}

export type CliSkillIntegration = {
  support: CliSkillSupport
  harnessId: string
  installTargets?: CliSkillInstallTarget[]
  invocation?: CliSkillInvocation
}

export type CliSoulsSpec = {
  directory: string
}

/**
 * Authoritative agent-state integration: how the CLI's lifecycle hooks are
 * registered and how its native event names map to Multicode's shared agent
 * phase vocabulary. A manifest without this spec declares that the CLI cannot
 * report authoritative agent state. Mirrors the app's `PluginAgentStateSpec`.
 */
type CliAgentStatePhase =
  | 'starting'
  | 'thinking'
  | 'tool_use'
  | 'awaiting_input'
  | 'idle'
  | 'exited'

/** Payload fields the reporter forwards for discriminators to consult. */
type CliAgentStateDiscriminatorField = 'notificationType' | 'status'

type CliAgentStateEventSpec = {
  /** Native event name exactly as the CLI's hook payload names it. */
  event: string
  /** Registration matcher (Claude-style `matcher` key), when the CLI wants one. */
  matcher?: string
  phase: CliAgentStatePhase
  /**
   * Payload discriminator: the phase applies only when the named frame field's
   * value is in `oneOf`; any other (or absent) value drops the frame.
   */
  when?: { field: CliAgentStateDiscriminatorField; oneOf: string[] }
  /**
   * Failure discriminator: the event additionally counts as a failed turn when
   * the named frame field's value is in `oneOf` (a turn-end whose payload
   * carries the outcome). Absent/unlisted values leave declared flags as-is.
   */
  failureWhen?: { field: CliAgentStateDiscriminatorField; oneOf: string[] }
  /** Registered in the CLI's hook config (default true); false = map-only. */
  register?: boolean
  /** This event is the session's turn end. */
  turnEnd?: boolean
  /** This event signals a failed turn. */
  failure?: boolean
  /**
   * This event opens (`start`) or closes (`stop`) background work the session
   * still owns (a subagent). A turn end arriving with work open is held as
   * working until the turn end that arrives with nothing outstanding.
   */
  background?: 'start' | 'stop'
}

/** Where `path` resolves from: the workspace root (default) or the user's home. */
type CliAgentStateRegistrationScope = 'workspace' | 'user'

type CliAgentStateRegistrationSpec = (
  | { kind: 'settings-json'; path: string }
  | { kind: 'flat-hooks-json'; path: string }
  | { kind: 'toml-block'; path: string }
  | { kind: 'toml-array-block'; path: string }
  | { kind: 'owned-json'; path: string }
  | { kind: 'plugin-file'; path: string; template: string }
) & { scope?: CliAgentStateRegistrationScope }

type CliAgentStateSpec = {
  registration: CliAgentStateRegistrationSpec
  events: CliAgentStateEventSpec[]
  /**
   * Opt in to the status-line forwarder: this CLI supports Claude Code's
   * `statusLine` setting, so the install also writes one into the same settings
   * file, wrapping whatever status line the person already configured. It is
   * how Multicode learns a session's context-window usage; no hook event
   * carries that number. Only meaningful for a `settings-json` registration.
   */
  statusLine?: boolean
}

/**
 * A credential the CLI needs to reach an authenticated endpoint. Multicode
 * stores the value in its shared, encrypted credential store and exposes it to
 * `launch.env` as `{{secret}}` at spawn time — the token never appears in argv
 * or the manifest. `env` optionally names an environment variable consulted as a
 * fallback source. Most CLIs use the user's own logged-in account and declare no
 * `auth`; declare it only when the CLI talks to a keyed endpoint (e.g. an
 * Anthropic-compatible provider such as Z.AI).
 */
export type CliAuthSpec = {
  type: 'api-key'
  label: string
  env?: string
}

/**
 * The authoring contract for a BYO-CLI plugin (`kind: 'cli'`). This is the
 * public mirror of the app's internal CLI plugin manifest. Fields the app adds
 * later are accepted leniently by the validator so a forward-compatible plugin
 * still loads.
 */
export type CliPluginManifest = {
  kind?: 'cli'
  id: string
  displayName: string
  publisher?: string
  version: number
  binary: string
  variables?: Record<string, CliVariableDecl>
  permissionPresets: Record<string, CliPermissionPreset>
  launch: CliLaunchSpec
  resume?: CliResumeSpec
  promptInjection: CliPromptInjection
  /** How the host-context document reaches this CLI. Omitted ⇒ `prompt`. */
  contextInjection?: CliContextInjection
  completion: CliCompletionSpec
  mcpConfig?: CliMcpConfigSpec
  capabilities: CliCapabilities
  souls?: CliSoulsSpec
  modelSelection?: CliModelSelectionSpec
  reasoningSelection?: CliReasoningSelectionSpec
  themeSelection?: CliThemeSelectionSpec
  /** Plugin directories the CLI accepts at launch, one flag per directory. */
  launchPlugins?: CliLaunchPluginsSpec
  /** A settings document the CLI accepts at launch, as one merged value. */
  launchSettings?: CliLaunchSettingsSpec
  skillIntegration?: CliSkillIntegration
  agentStateSpec?: CliAgentStateSpec
  auth?: CliAuthSpec
}

// Plugin directories handed to the CLI on its command line, one flag per
// directory: `args` is rendered once per directory with `{{pluginDir}}` bound
// to it. It is how a host ships its own skills, hooks and MCP server to a
// session without installing anything into the user's repository.
export type CliLaunchPluginsSpec = {
  args: string[]
}

// A settings document handed to the CLI on its command line, for settings a
// plugin cannot carry. `args` is rendered once with `{{launchSettingsJson}}`
// bound to every setting the launch wants, merged into ONE value — a host that
// passed two such flags would be relying on repeat behaviour no CLI documents.
export type CliLaunchSettingsSpec = {
  args: string[]
}

// ── Validator ────────────────────────────────────────────────────────────────

export type CliManifestIssue = { path: string; message: string }

export type CliManifestResult =
  | { ok: true; manifest: CliPluginManifest }
  | { ok: false; issues: CliManifestIssue[] }

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/
const INJECTION_MODES: CliPromptInjectionMode[] = ['positional-arg', 'stdin-pipe', 'send-after-ready', 'file']
const CONTEXT_INJECTION_MODES: CliContextInjectionMode[] = ['argv', 'env', 'prompt']
/** The variables a `contextInjection` template may spend the document through. */
const CONTEXT_TEMPLATE_VARIABLES = ['contextFile', 'contextFileJson', 'contextText', 'contextToml'] as const
const COMPLETION_MODES: CliCompletionMode[] = ['process-exit', 'output-sentinel', 'mcp-signal', 'idle-at-prompt']
const MCP_FORMATS: CliMcpConfigFormat[] = ['claude-code', 'codex', 'opencode', 'generic']
const VARIABLE_TYPES: CliVariableType[] = ['string', 'enum', 'boolean', 'number']
const SKILL_SUPPORTS: CliSkillSupport[] = ['native', 'prompt-shim', 'unsupported']
const SKILL_INSTALL_SCOPES = ['workspace', 'user'] as const
const SKILL_FORMATS = ['agent-skills-v1', 'claude-code', 'codex', 'opencode', 'generic'] as const
// Fields that only belong on provider manifests (kind: 'provider'); a CLI
// manifest carrying any of them is malformed. Mirrors the app's loader. `auth`
// is intentionally NOT here: it is a shared credential descriptor a CLI plugin
// may declare when it proxies an authenticated endpoint (e.g. Z.AI).
const PROVIDER_ONLY_FIELDS = ['providerType', 'models', 'adapter', 'openaiCompatible', 'signature'] as const
const AUTH_TYPES = ['api-key'] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate an untrusted value as a CLI plugin manifest. Pure structural check
 * mirroring the app's required-field rules: a manifest that passes here is
 * accepted by Multicode's loader (which re-validates and additionally checks
 * deep skill/template details). Provider manifests (`kind: 'provider'`) are not
 * handled here.
 */
export function validateCliPluginManifest(value: unknown): CliManifestResult {
  const issues: CliManifestIssue[] = []
  if (!isObject(value)) {
    return { ok: false, issues: [{ path: '', message: 'CLI plugin manifest must be a JSON object.' }] }
  }

  if (value.kind !== undefined && value.kind !== 'cli') {
    issues.push({ path: 'kind', message: "kind must be 'cli' when present (provider manifests are validated separately)." })
  }
  for (const field of PROVIDER_ONLY_FIELDS) {
    if (field in value) {
      issues.push({ path: field, message: `${field} is only valid on provider manifests with kind "provider".` })
    }
  }

  requireString(value, 'id', issues, ID_PATTERN)
  requireString(value, 'displayName', issues)
  requireString(value, 'binary', issues)
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1) {
    issues.push({ path: 'version', message: 'version must be a positive integer.' })
  }
  if (value.publisher !== undefined) {
    // Present ⇒ must be a non-empty string (matches the app's requireString).
    requireString(value, 'publisher', issues)
  }

  validatePermissionPresets(value.permissionPresets, issues)
  validateLaunch(value.launch, issues)
  if (value.resume !== undefined) validateResume(value.resume, issues)
  validatePromptInjection(value.promptInjection, issues)
  if (value.contextInjection !== undefined) validateContextInjection(value.contextInjection, issues)
  validateCompletion(value.completion, 'completion', issues)
  if (value.mcpConfig !== undefined) validateMcpConfig(value.mcpConfig, issues)
  validateCapabilities(value.capabilities, issues)
  if (value.variables !== undefined) validateVariables(value.variables, issues)
  if (value.souls !== undefined) validateSouls(value.souls, issues)
  if (value.modelSelection !== undefined) validateModelSelection(value.modelSelection, issues)
  if (value.reasoningSelection !== undefined) validateReasoningSelection(value.reasoningSelection, issues)
  if (value.themeSelection !== undefined) validateThemeSelection(value.themeSelection, issues)
  if (value.launchPlugins !== undefined) validateLaunchPlugins(value.launchPlugins, issues)
  if (value.launchSettings !== undefined) validateLaunchSettings(value.launchSettings, issues)
  if (value.skillIntegration !== undefined) validateSkillIntegration(value.skillIntegration, issues)
  if (value.agentStateSpec !== undefined) validateAgentStateSpec(value.agentStateSpec, issues)
  if (value.auth !== undefined) validateAuth(value.auth, issues)

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, manifest: value as unknown as CliPluginManifest }
}

/** Parse and validate plugin.json source text. */
export function parseCliPluginManifest(source: string): CliManifestResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: '', message: `Invalid JSON: ${error instanceof Error ? error.message : 'parse error'}.` }],
    }
  }
  return validateCliPluginManifest(parsed)
}

function validatePermissionPresets(value: unknown, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'permissionPresets', message: 'permissionPresets must be an object.' })
    return
  }
  if (Object.keys(value).length === 0) {
    issues.push({ path: 'permissionPresets', message: 'permissionPresets must declare at least one preset.' })
    return
  }
  for (const [name, preset] of Object.entries(value)) {
    const path = `permissionPresets.${name}`
    if (!isObject(preset)) {
      issues.push({ path, message: 'Preset must be an object.' })
      continue
    }
    requireString(preset, 'label', issues, undefined, path)
    if (!Array.isArray(preset.args) || preset.args.some((arg) => typeof arg !== 'string')) {
      issues.push({ path: `${path}.args`, message: 'args must be an array of strings.' })
    }
  }
}

function validateArgv(value: unknown, path: string, issues: CliManifestIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: `${path} must be a non-empty array of argv tokens.` })
    return
  }
  value.forEach((token, index) => {
    const tokenPath = `${path}[${index}]`
    if (typeof token === 'string') return
    if (!isObject(token)) {
      issues.push({ path: tokenPath, message: 'argv tokens must be strings or directive objects.' })
      return
    }
    const directives = ['spread', 'spreadIf', 'valueIf'].filter((key) => key in token)
    if (directives.length !== 1) {
      issues.push({ path: tokenPath, message: 'argv directive must use exactly one of: spread, spreadIf, valueIf.' })
      return
    }
    if (directives[0] === 'valueIf') {
      if (typeof token.valueIf !== 'string') issues.push({ path: `${tokenPath}.valueIf`, message: 'valueIf must be a string variable name.' })
      if (typeof token.value !== 'string') issues.push({ path: `${tokenPath}.value`, message: 'value must be a string template.' })
    } else if (typeof token[directives[0]] !== 'string') {
      issues.push({ path: `${tokenPath}.${directives[0]}`, message: `${directives[0]} must be a string variable name.` })
    }
  })
}

function validateLaunch(value: unknown, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'launch', message: 'launch must be an object.' })
    return
  }
  validateArgv(value.argv, 'launch.argv', issues)
  if (value.cwd !== undefined && typeof value.cwd !== 'string') {
    issues.push({ path: 'launch.cwd', message: 'launch.cwd must be a string when present.' })
  }
  if (value.env !== undefined) {
    if (!isObject(value.env) || Object.values(value.env).some((v) => typeof v !== 'string')) {
      issues.push({ path: 'launch.env', message: 'launch.env must be an object of string values.' })
    }
  }
}

function validateResume(value: unknown, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'resume', message: 'resume must be an object when present.' })
    return
  }
  if (typeof value.supported !== 'boolean') {
    issues.push({ path: 'resume.supported', message: 'resume.supported must be a boolean.' })
  }
  if (value.argv !== undefined) validateArgv(value.argv, 'resume.argv', issues)
}

function validatePromptInjection(value: unknown, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'promptInjection', message: 'promptInjection must be an object.' })
    return
  }
  if (typeof value.mode !== 'string' || !INJECTION_MODES.includes(value.mode as CliPromptInjectionMode)) {
    issues.push({ path: 'promptInjection.mode', message: `mode must be one of: ${INJECTION_MODES.join(', ')}.` })
  }
  if (value.mode === 'send-after-ready') {
    if (!isObject(value.readiness)) {
      issues.push({ path: 'promptInjection.readiness', message: 'send-after-ready requires a readiness signal.' })
    } else {
      if (value.readiness.type !== 'output-match') {
        issues.push({ path: 'promptInjection.readiness.type', message: 'Only "output-match" readiness is supported.' })
      }
      if (typeof value.readiness.pattern !== 'string' || value.readiness.pattern.length === 0) {
        issues.push({ path: 'promptInjection.readiness.pattern', message: 'readiness.pattern must be a non-empty string.' })
      }
      if (typeof value.readiness.timeoutMs !== 'number' || value.readiness.timeoutMs <= 0) {
        issues.push({ path: 'promptInjection.readiness.timeoutMs', message: 'readiness.timeoutMs must be a positive number.' })
      }
    }
  }
}

function validateContextInjection(value: unknown, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'contextInjection', message: 'contextInjection must be an object when present.' })
    return
  }
  if (typeof value.mode !== 'string' || !CONTEXT_INJECTION_MODES.includes(value.mode as CliContextInjectionMode)) {
    issues.push({
      path: 'contextInjection.mode',
      message: `mode must be one of: ${CONTEXT_INJECTION_MODES.join(', ')}.`,
    })
    return
  }

  const hasArgs = Array.isArray(value.args) && value.args.length > 0
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== 'string')) {
      issues.push({ path: 'contextInjection.args', message: 'contextInjection.args must be an array of string templates.' })
    } else {
      value.args.forEach((template, index) => {
        validateTemplateVariables(
          template as string,
          `contextInjection.args[${index}]`,
          CONTEXT_TEMPLATE_VARIABLES,
          issues,
        )
      })
    }
  }

  const hasEnv = isObject(value.env) && Object.keys(value.env).length > 0
  if (value.env !== undefined) {
    if (!isObject(value.env) || Object.values(value.env).some((entry) => typeof entry !== 'string')) {
      issues.push({ path: 'contextInjection.env', message: 'contextInjection.env must be an object of string templates.' })
    } else {
      for (const [name, template] of Object.entries(value.env)) {
        validateTemplateVariables(template as string, `contextInjection.env.${name}`, CONTEXT_TEMPLATE_VARIABLES, issues)
      }
    }
  }

  // A declared channel with nothing to send down it is the failure that would
  // otherwise be silent: the manifest reads as "this CLI takes a system prompt"
  // and the CLI is told nothing.
  if (value.mode === 'argv' && !hasArgs) {
    issues.push({ path: 'contextInjection.args', message: 'argv context injection requires a non-empty args array.' })
  }
  if (value.mode === 'env' && !hasEnv) {
    issues.push({ path: 'contextInjection.env', message: 'env context injection requires a non-empty env object.' })
  }
  // And the reverse: args/env on a `prompt` manifest would never render, so the
  // author is saying one thing and getting another.
  if (value.mode === 'prompt' && (hasArgs || hasEnv)) {
    issues.push({
      path: 'contextInjection',
      message: 'prompt context injection renders no args and no env; remove them or declare argv/env.',
    })
  }
}

function validateCompletion(value: unknown, path: string, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path, message: `${path} must be an object.` })
    return
  }
  if (typeof value.mode !== 'string' || !COMPLETION_MODES.includes(value.mode as CliCompletionMode)) {
    issues.push({ path: `${path}.mode`, message: `mode must be one of: ${COMPLETION_MODES.join(', ')}.` })
    return
  }
  if (value.mode === 'output-sentinel' && typeof value.sentinel !== 'string') {
    issues.push({ path: `${path}.sentinel`, message: 'output-sentinel completion requires a sentinel string.' })
  }
  if (value.mode === 'mcp-signal' && typeof value.signalTool !== 'string') {
    issues.push({ path: `${path}.signalTool`, message: 'mcp-signal completion requires a signalTool name.' })
  }
  if (value.mode === 'idle-at-prompt') {
    if (typeof value.idleMs !== 'number' || value.idleMs <= 0) {
      issues.push({ path: `${path}.idleMs`, message: 'idle-at-prompt requires a positive idleMs.' })
    }
    if (typeof value.promptPattern !== 'string' || value.promptPattern.length === 0) {
      issues.push({ path: `${path}.promptPattern`, message: 'idle-at-prompt requires a non-empty promptPattern.' })
    }
  }
  if (value.fallback !== undefined) validateCompletion(value.fallback, `${path}.fallback`, issues)
}

function validateMcpConfig(value: unknown, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'mcpConfig', message: 'mcpConfig must be an object.' })
    return
  }
  if (typeof value.path !== 'string' || value.path.length === 0) {
    issues.push({ path: 'mcpConfig.path', message: 'mcpConfig.path must be a non-empty string.' })
  }
  if (value.userPath !== undefined && (typeof value.userPath !== 'string' || value.userPath.length === 0)) {
    issues.push({ path: 'mcpConfig.userPath', message: 'mcpConfig.userPath must be a non-empty string when present.' })
  }
  if (typeof value.format !== 'string' || !MCP_FORMATS.includes(value.format as CliMcpConfigFormat)) {
    issues.push({ path: 'mcpConfig.format', message: `mcpConfig.format must be one of: ${MCP_FORMATS.join(', ')}.` })
  }
}

const AGENT_STATE_PHASES: CliAgentStatePhase[] = [
  'starting',
  'thinking',
  'tool_use',
  'awaiting_input',
  'idle',
  'exited',
]
const AGENT_STATE_REGISTRATION_KINDS = ['settings-json', 'flat-hooks-json', 'toml-block', 'toml-array-block', 'owned-json', 'plugin-file'] as const
const AGENT_STATE_REGISTRATION_SCOPES = ['workspace', 'user'] as const
const AGENT_STATE_DISCRIMINATOR_FIELDS = ['notificationType', 'status'] as const

// Registration paths are written inside their scope root (the workspace, or
// the user's home for scope: user) at install time, so they must stay strictly
// relative — no traversal, no absolute paths, no backslashes, and no `:` in
// any segment: on Windows a `C:`-style segment makes path.resolve()
// drive-relative and escapes the scope root entirely.
function isSafeWorkspaceRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.includes('\0') || value.includes('\\') || value.includes(':') || value.startsWith('/')) return false
  const segments = value.split('/')
  return !segments.some((segment) => segment === '..' || segment === '.' || segment.length === 0)
}

function validateAgentStateSpec(value: unknown, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'agentStateSpec', message: 'agentStateSpec must be an object when present.' })
    return
  }
  const registration = value.registration
  if (!isObject(registration)) {
    issues.push({ path: 'agentStateSpec.registration', message: 'agentStateSpec.registration must be an object.' })
  } else {
    if (
      typeof registration.kind !== 'string'
      || !(AGENT_STATE_REGISTRATION_KINDS as readonly string[]).includes(registration.kind)
    ) {
      issues.push({
        path: 'agentStateSpec.registration.kind',
        message: `registration.kind must be one of: ${AGENT_STATE_REGISTRATION_KINDS.join(', ')}.`,
      })
    }
    if (!isSafeWorkspaceRelativePath(registration.path)) {
      issues.push({
        path: 'agentStateSpec.registration.path',
        message: 'registration.path must be a safe workspace-relative path (forward slashes, no traversal).',
      })
    }
    if (registration.kind === 'plugin-file') {
      if (typeof registration.template !== 'string' || registration.template.length === 0) {
        issues.push({
          path: 'agentStateSpec.registration.template',
          message: 'plugin-file registration requires a bundled reporter template name.',
        })
      }
    } else if (registration.template !== undefined) {
      issues.push({
        path: 'agentStateSpec.registration.template',
        message: 'registration.template is only valid for plugin-file registrations.',
      })
    }
    if (
      registration.scope !== undefined
      && !(AGENT_STATE_REGISTRATION_SCOPES as readonly string[]).includes(registration.scope as string)
    ) {
      issues.push({
        path: 'agentStateSpec.registration.scope',
        message: `registration.scope must be one of: ${AGENT_STATE_REGISTRATION_SCOPES.join(', ')}.`,
      })
    }
  }
  if (value.statusLine !== undefined) {
    if (typeof value.statusLine !== 'boolean') {
      issues.push({ path: 'agentStateSpec.statusLine', message: 'statusLine must be a boolean when present.' })
    } else if (value.statusLine && isObject(registration) && registration.scope === 'user') {
      // A user-global registration has no project `.claude/` to read the
      // person's own status line out of, so the install skips it entirely.
      issues.push({
        path: 'agentStateSpec.statusLine',
        message: 'statusLine is not supported for a user-scoped registration.',
      })
    } else if (value.statusLine && isObject(registration) && registration.kind !== 'settings-json') {
      // The setting being written is Claude Code's `statusLine`, which lives in
      // the same settings JSON the hooks do. Declaring it against any other
      // registration kind is an authoring error, not a silent no-op.
      issues.push({
        path: 'agentStateSpec.statusLine',
        message: 'statusLine is only supported for a settings-json registration.',
      })
    }
  }
  if (!Array.isArray(value.events) || value.events.length === 0) {
    issues.push({ path: 'agentStateSpec.events', message: 'agentStateSpec.events must be a non-empty array.' })
    return
  }
  const seen = new Set<string>()
  value.events.forEach((entry, index) => {
    const path = `agentStateSpec.events[${index}]`
    if (!isObject(entry)) {
      issues.push({ path, message: 'Event spec must be an object.' })
      return
    }
    if (typeof entry.event !== 'string' || entry.event.length === 0) {
      issues.push({ path: `${path}.event`, message: 'event must be a non-empty string.' })
    } else if (seen.has(entry.event)) {
      issues.push({ path: `${path}.event`, message: `duplicate event "${entry.event}".` })
    } else {
      seen.add(entry.event)
    }
    if (typeof entry.phase !== 'string' || !(AGENT_STATE_PHASES as readonly string[]).includes(entry.phase)) {
      issues.push({ path: `${path}.phase`, message: `phase must be one of: ${AGENT_STATE_PHASES.join(', ')}.` })
    }
    if (entry.matcher !== undefined && typeof entry.matcher !== 'string') {
      issues.push({ path: `${path}.matcher`, message: 'matcher must be a string when present.' })
    }
    for (const flag of ['register', 'turnEnd', 'failure'] as const) {
      if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') {
        issues.push({ path: `${path}.${flag}`, message: `${flag} must be a boolean when present.` })
      }
    }
    if (entry.background !== undefined && entry.background !== 'start' && entry.background !== 'stop') {
      issues.push({ path: `${path}.background`, message: "background must be 'start' or 'stop' when present." })
    }
    for (const clause of ['when', 'failureWhen'] as const) {
      const value = entry[clause]
      if (value === undefined) continue
      if (
        !isObject(value)
        || !(AGENT_STATE_DISCRIMINATOR_FIELDS as readonly string[]).includes(value.field as string)
      ) {
        issues.push({
          path: `${path}.${clause}.field`,
          message: `${clause}.field must be one of: ${AGENT_STATE_DISCRIMINATOR_FIELDS.join(', ')}.`,
        })
      } else if (
        !Array.isArray(value.oneOf)
        || value.oneOf.length === 0
        || value.oneOf.some((v: unknown) => typeof v !== 'string' || v.length === 0)
      ) {
        issues.push({ path: `${path}.${clause}.oneOf`, message: `${clause}.oneOf must be a non-empty array of strings.` })
      }
    }
  })
}

function validateCapabilities(value: unknown, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'capabilities', message: 'capabilities must be an object.' })
    return
  }
  for (const name of ['resumeSession', 'sessionIdFromCaller', 'toolUse', 'mcpServers'] as const) {
    if (typeof value[name] !== 'boolean') {
      issues.push({ path: `capabilities.${name}`, message: `${name} must be a boolean.` })
    }
  }
  if (value.imageInput !== undefined && typeof value.imageInput !== 'boolean') {
    issues.push({ path: 'capabilities.imageInput', message: 'imageInput must be a boolean when present.' })
  }
  if (value.chatHistoryFile !== undefined && typeof value.chatHistoryFile !== 'string') {
    issues.push({ path: 'capabilities.chatHistoryFile', message: 'chatHistoryFile must be a string when present.' })
  }
}

// The host renders these args once per plugin directory, with `{{pluginDir}}`
// bound to it, so a manifest that never spends that variable would pass the
// same flag twice and hand the CLI one directory it was not given.
function validateLaunchPlugins(value: unknown, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'launchPlugins', message: 'launchPlugins must be an object when present.' })
    return
  }
  if (!Array.isArray(value.args) || value.args.length === 0 || value.args.some((arg) => typeof arg !== 'string')) {
    issues.push({ path: 'launchPlugins.args', message: 'launchPlugins.args must be a non-empty array of string templates.' })
    return
  }
  if (!value.args.some((arg) => typeof arg === 'string' && arg.includes('{{pluginDir}}'))) {
    issues.push({ path: 'launchPlugins.args', message: 'launchPlugins.args must reference {{pluginDir}} — it is rendered once per directory.' })
  }
}

// Rendered once with the whole document bound to `{{launchSettingsJson}}`, so a
// manifest that never spends that variable would pass a flag with no settings
// in it — and, because declaring this suppresses the separate theme flag, would
// silently drop the theme as well.
function validateLaunchSettings(value: unknown, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'launchSettings', message: 'launchSettings must be an object when present.' })
    return
  }
  if (!Array.isArray(value.args) || value.args.length === 0 || value.args.some((arg) => typeof arg !== 'string')) {
    issues.push({ path: 'launchSettings.args', message: 'launchSettings.args must be a non-empty array of string templates.' })
    return
  }
  if (!value.args.some((arg) => typeof arg === 'string' && arg.includes('{{launchSettingsJson}}'))) {
    issues.push({ path: 'launchSettings.args', message: 'launchSettings.args must reference {{launchSettingsJson}} — it carries the merged settings document.' })
  }
}

function validateThemeSelection(value: unknown, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'themeSelection', message: 'themeSelection must be an object when present.' })
    return
  }
  if (!Array.isArray(value.args) || value.args.length === 0 || value.args.some((arg) => typeof arg !== 'string')) {
    issues.push({ path: 'themeSelection.args', message: 'themeSelection.args must be a non-empty array of string templates.' })
  }
  if (value.schemes !== undefined) {
    if (!isObject(value.schemes)) {
      issues.push({ path: 'themeSelection.schemes', message: 'themeSelection.schemes must be an object mapping "light" and "dark" to theme names.' })
    } else {
      for (const scheme of ['light', 'dark'] as const) {
        const name = (value.schemes as Record<string, unknown>)[scheme]
        if (typeof name !== 'string' || name.length === 0) {
          issues.push({ path: `themeSelection.schemes.${scheme}`, message: `themeSelection.schemes.${scheme} must be a non-empty string when schemes is present.` })
        }
      }
    }
  }
}

function validateReasoningSelection(value: unknown, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'reasoningSelection', message: 'reasoningSelection must be an object when present.' })
    return
  }
  if (!Array.isArray(value.args) || value.args.length === 0 || value.args.some((arg) => typeof arg !== 'string')) {
    issues.push({ path: 'reasoningSelection.args', message: 'reasoningSelection.args must be a non-empty array of string templates.' })
  }
  const levelIds: string[] = []
  if (!Array.isArray(value.levels) || value.levels.length === 0) {
    issues.push({ path: 'reasoningSelection.levels', message: 'reasoningSelection.levels must be a non-empty array of level options.' })
  } else {
    value.levels.forEach((level, index) => {
      const path = `reasoningSelection.levels[${index}]`
      if (!isObject(level)) {
        issues.push({ path, message: 'Reasoning level must be an object.' })
        return
      }
      requireString(level, 'id', issues, undefined, path)
      if (typeof level.id === 'string') levelIds.push(level.id)
      // Present ⇒ non-empty string (matches the app's requireString).
      if (level.label !== undefined) requireString(level, 'label', issues, undefined, path)
    })
  }
  if (value.default !== undefined) {
    if (typeof value.default !== 'string' || value.default.length === 0) {
      issues.push({ path: 'reasoningSelection.default', message: 'reasoningSelection.default must be a non-empty string when present.' })
    } else if (levelIds.length > 0 && !levelIds.includes(value.default)) {
      issues.push({ path: 'reasoningSelection.default', message: 'reasoningSelection.default must be one of the declared level ids.' })
    }
  }
}

function validateModelSelection(value: unknown, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'modelSelection', message: 'modelSelection must be an object when present.' })
    return
  }
  if (!Array.isArray(value.args) || value.args.length === 0 || value.args.some((arg) => typeof arg !== 'string')) {
    issues.push({ path: 'modelSelection.args', message: 'modelSelection.args must be a non-empty array of string templates.' })
  }
  if (value.options !== undefined) {
    if (!Array.isArray(value.options)) {
      issues.push({ path: 'modelSelection.options', message: 'modelSelection.options must be an array.' })
    } else {
      value.options.forEach((option, index) => {
        const path = `modelSelection.options[${index}]`
        if (!isObject(option)) {
          issues.push({ path, message: 'Model option must be an object.' })
          return
        }
        requireString(option, 'id', issues, undefined, path)
        // Present ⇒ non-empty string (matches the app's requireString).
        if (option.label !== undefined) requireString(option, 'label', issues, undefined, path)
      })
    }
  }
  if (value.allowCustomId !== undefined && typeof value.allowCustomId !== 'boolean') {
    issues.push({ path: 'modelSelection.allowCustomId', message: 'modelSelection.allowCustomId must be a boolean when present.' })
  }
}

function validateVariables(value: unknown, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'variables', message: 'variables must be an object.' })
    return
  }
  for (const [name, decl] of Object.entries(value)) {
    const path = `variables.${name}`
    if (!isObject(decl)) {
      issues.push({ path, message: 'Variable declaration must be an object.' })
      continue
    }
    if (typeof decl.type !== 'string' || !(VARIABLE_TYPES as readonly string[]).includes(decl.type)) {
      issues.push({ path: `${path}.type`, message: `type must be one of: ${VARIABLE_TYPES.join(', ')}.` })
    }
    if (typeof decl.label !== 'string') {
      issues.push({ path: `${path}.label`, message: 'label must be a string.' })
    }
    if (decl.type === 'enum') {
      if (!Array.isArray(decl.options) || decl.options.length === 0) {
        issues.push({ path: `${path}.options`, message: 'enum variables require a non-empty options array.' })
      } else if (decl.options.some((option) => typeof option !== 'string')) {
        issues.push({ path: `${path}.options`, message: 'enum options must be strings.' })
      }
    }
  }
}

function validateAuth(value: unknown, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'auth', message: 'auth must be an object when present.' })
    return
  }
  if (typeof value.type !== 'string' || !(AUTH_TYPES as readonly string[]).includes(value.type)) {
    issues.push({ path: 'auth.type', message: `auth.type must be one of: ${AUTH_TYPES.join(', ')}.` })
  }
  requireString(value, 'label', issues, undefined, 'auth')
  if (value.env !== undefined) requireString(value, 'env', issues, undefined, 'auth')
}

function validateSouls(value: unknown, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'souls', message: 'souls must be an object when present.' })
    return
  }
  if (typeof value.directory !== 'string' || value.directory.length === 0) {
    issues.push({ path: 'souls.directory', message: 'souls.directory must be a non-empty string.' })
  }
}

function validateSkillIntegration(value: unknown, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'skillIntegration', message: 'skillIntegration must be an object when present.' })
    return
  }
  if (typeof value.support !== 'string' || !SKILL_SUPPORTS.includes(value.support as CliSkillSupport)) {
    issues.push({ path: 'skillIntegration.support', message: `skillIntegration.support must be one of: ${SKILL_SUPPORTS.join(', ')}.` })
  }
  requireString(value, 'harnessId', issues, ID_PATTERN, 'skillIntegration')

  if (value.support === 'native') {
    if (!Array.isArray(value.installTargets) || value.installTargets.length === 0) {
      issues.push({ path: 'skillIntegration.installTargets', message: 'native skillIntegration requires at least one install target.' })
    } else {
      value.installTargets.forEach((target, index) =>
        validateSkillInstallTarget(target, `skillIntegration.installTargets[${index}]`, issues)
      )
    }
  } else if (value.installTargets !== undefined) {
    issues.push({ path: 'skillIntegration.installTargets', message: 'installTargets are only valid when skillIntegration.support is "native".' })
  }

  if (value.invocation !== undefined) validateSkillInvocation(value.invocation, issues)
}

function validateSkillInstallTarget(value: unknown, path: string, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path, message: 'Skill install target must be an object.' })
    return
  }
  if (typeof value.scope !== 'string' || !(SKILL_INSTALL_SCOPES as readonly string[]).includes(value.scope)) {
    issues.push({ path: `${path}.scope`, message: `scope must be one of: ${SKILL_INSTALL_SCOPES.join(', ')}.` })
  }
  if (typeof value.format !== 'string' || !(SKILL_FORMATS as readonly string[]).includes(value.format)) {
    issues.push({ path: `${path}.format`, message: `format must be one of: ${SKILL_FORMATS.join(', ')}.` })
  }
  if (value.restartRequired !== undefined && typeof value.restartRequired !== 'boolean') {
    issues.push({ path: `${path}.restartRequired`, message: 'restartRequired must be a boolean when present.' })
  }
  if (typeof value.path !== 'string' || value.path.length === 0) {
    issues.push({ path: `${path}.path`, message: 'path must be a non-empty string template.' })
    return
  }
  if (!value.path.includes('{{skillId}}')) {
    issues.push({ path: `${path}.path`, message: 'path must include {{skillId}} so each skill has its own directory.' })
  }
  validateTemplateVariables(value.path, `${path}.path`, ['workspaceRoot', 'home', 'skillId'], issues)
  if (value.path.includes('\0')) {
    issues.push({ path: `${path}.path`, message: 'path must not contain NUL bytes.' })
  }
  if (value.scope === 'workspace' && !isWorkspaceSkillPathTemplate(value.path)) {
    issues.push({ path: `${path}.path`, message: 'workspace skill paths must be relative or start with {{workspaceRoot}}/.' })
  }
  if (value.scope === 'user' && !value.path.startsWith('{{home}}/')) {
    issues.push({ path: `${path}.path`, message: 'user skill paths must start with {{home}}/.' })
  }
}

function validateSkillInvocation(value: unknown, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'skillIntegration.invocation', message: 'invocation must be an object when present.' })
    return
  }
  for (const [key, template] of Object.entries({
    fileDropTemplate: value.fileDropTemplate,
    explicitTemplate: value.explicitTemplate,
  })) {
    if (template === undefined) continue
    if (typeof template !== 'string' || template.length === 0) {
      issues.push({ path: `skillIntegration.invocation.${key}`, message: `${key} must be a non-empty string.` })
      continue
    }
    validateTemplateVariables(template, `skillIntegration.invocation.${key}`, ['skillId', 'skillName', 'path'], issues)
  }
  for (const key of ['nativeSlashCommand', 'explicitMention', 'implicitInvocation'] as const) {
    if (key in value && typeof value[key] !== 'boolean') {
      issues.push({ path: `skillIntegration.invocation.${key}`, message: `${key} must be a boolean when present.` })
    }
  }
  // A trigger is one character the user types, not a word: a multi-character
  // "prefix" would fire the type-ahead partway through ordinary typing.
  if ('mentionPrefix' in value) {
    const prefix = value.mentionPrefix
    if (typeof prefix !== 'string' || prefix.trim().length !== 1) {
      issues.push({
        path: 'skillIntegration.invocation.mentionPrefix',
        message: 'mentionPrefix must be a single non-space character when present.',
      })
    }
  }
  if ('mentionTemplate' in value) {
    const template = value.mentionTemplate
    if (typeof template !== 'string' || template.length === 0) {
      issues.push({
        path: 'skillIntegration.invocation.mentionTemplate',
        message: 'mentionTemplate must be a non-empty string.',
      })
    } else {
      validateTemplateVariables(
        template,
        'skillIntegration.invocation.mentionTemplate',
        ['skillId', 'skillName', 'mentionPrefix'],
        issues,
      )
      if (!('mentionPrefix' in value)) {
        issues.push({
          path: 'skillIntegration.invocation.mentionTemplate',
          message: 'mentionTemplate needs a mentionPrefix — without one there is no trigger to insert it from.',
        })
      }
    }
  }
}

function validateTemplateVariables(
  template: string,
  path: string,
  allowed: readonly string[],
  issues: CliManifestIssue[]
): void {
  const variablePattern = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g
  let match: RegExpExecArray | null
  while ((match = variablePattern.exec(template)) !== null) {
    const name = match[1]
    if (!allowed.includes(name)) {
      issues.push({
        path,
        message: `Unsupported template variable {{${name}}}. Allowed variables: ${allowed.map((item) => `{{${item}}}`).join(', ')}.`,
      })
    }
  }
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/')) return false
  return !value.split('/').some((segment) => segment === '..' || segment === '.' || segment.length === 0)
}

function isWorkspaceSkillPathTemplate(value: string): boolean {
  if (value.startsWith('{{workspaceRoot}}/')) return !value.includes('/../') && !value.endsWith('/..')
  if (value.startsWith('/') || value.startsWith('{{home}}/')) return false
  return isSafeRelativePath(value.replace(/\{\{skillId\}\}/g, 'skill'))
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  issues: CliManifestIssue[],
  pattern?: RegExp,
  rootPath?: string
): void {
  const path = rootPath ? `${rootPath}.${key}` : key
  const v = value[key]
  if (typeof v !== 'string' || v.length === 0) {
    issues.push({ path, message: `${path} is required and must be a non-empty string.` })
    return
  }
  if (pattern && !pattern.test(v)) {
    issues.push({ path, message: `${path} does not match the required pattern ${pattern}.` })
  }
}
