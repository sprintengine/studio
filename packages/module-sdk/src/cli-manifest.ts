// @multicode/module-sdk — BYO-CLI plugin authoring contract.
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

// Declares that the CLI can be launched matching the host's light/dark color
// scheme. `args` are substituted templates spread into launch/resume argv as
// `themeArgs`, with `{{colorScheme}}` resolving to 'light' or 'dark'
// (e.g. ["--settings", "{\"theme\":\"{{colorScheme}}\"}"]).
export type CliThemeSelectionSpec = {
  args: string[]
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
  completion: CliCompletionSpec
  mcpConfig?: CliMcpConfigSpec
  capabilities: CliCapabilities
  souls?: CliSoulsSpec
  modelSelection?: CliModelSelectionSpec
  themeSelection?: CliThemeSelectionSpec
  skillIntegration?: CliSkillIntegration
}

// ── Validator ────────────────────────────────────────────────────────────────

export type CliManifestIssue = { path: string; message: string }

export type CliManifestResult =
  | { ok: true; manifest: CliPluginManifest }
  | { ok: false; issues: CliManifestIssue[] }

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/
const INJECTION_MODES: CliPromptInjectionMode[] = ['positional-arg', 'stdin-pipe', 'send-after-ready', 'file']
const COMPLETION_MODES: CliCompletionMode[] = ['process-exit', 'output-sentinel', 'mcp-signal', 'idle-at-prompt']
const MCP_FORMATS: CliMcpConfigFormat[] = ['claude-code', 'codex', 'opencode', 'generic']
const VARIABLE_TYPES: CliVariableType[] = ['string', 'enum', 'boolean', 'number']
const SKILL_SUPPORTS: CliSkillSupport[] = ['native', 'prompt-shim', 'unsupported']
const SKILL_INSTALL_SCOPES = ['workspace', 'user'] as const
const SKILL_FORMATS = ['agent-skills-v1', 'claude-code', 'codex', 'opencode', 'generic'] as const
// Fields that only belong on provider manifests (kind: 'provider'); a CLI
// manifest carrying any of them is malformed. Mirrors the app's loader.
const PROVIDER_ONLY_FIELDS = ['providerType', 'models', 'auth', 'adapter', 'openaiCompatible', 'signature'] as const

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
  validateCompletion(value.completion, 'completion', issues)
  if (value.mcpConfig !== undefined) validateMcpConfig(value.mcpConfig, issues)
  validateCapabilities(value.capabilities, issues)
  if (value.variables !== undefined) validateVariables(value.variables, issues)
  if (value.souls !== undefined) validateSouls(value.souls, issues)
  if (value.modelSelection !== undefined) validateModelSelection(value.modelSelection, issues)
  if (value.themeSelection !== undefined) validateThemeSelection(value.themeSelection, issues)
  if (value.skillIntegration !== undefined) validateSkillIntegration(value.skillIntegration, issues)

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

function validateThemeSelection(value: unknown, issues: CliManifestIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'themeSelection', message: 'themeSelection must be an object when present.' })
    return
  }
  if (!Array.isArray(value.args) || value.args.length === 0 || value.args.some((arg) => typeof arg !== 'string')) {
    issues.push({ path: 'themeSelection.args', message: 'themeSelection.args must be a non-empty array of string templates.' })
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
