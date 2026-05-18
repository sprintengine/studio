import type {
  PluginArgvToken,
  PluginCompletionMode,
  PluginCompletionSpec,
  PluginManifest,
  PluginManifestValidationIssue,
  PluginManifestValidationResult,
  PluginPromptInjectionMode,
} from '../shared/plugin-manifest'

const INJECTION_MODES: PluginPromptInjectionMode[] = [
  'positional-arg',
  'stdin-pipe',
  'send-after-ready',
  'file',
]

const COMPLETION_MODES: PluginCompletionMode[] = [
  'process-exit',
  'output-sentinel',
  'mcp-signal',
  'idle-at-prompt',
]

const MCP_FORMATS = ['claude-code', 'codex', 'opencode', 'generic'] as const
const VARIABLE_TYPES = ['string', 'enum', 'boolean', 'number'] as const

export function validateManifestStructure(value: unknown): PluginManifestValidationResult {
  const issues: PluginManifestValidationIssue[] = []
  if (!isObject(value)) {
    return { ok: false, issues: [{ path: '', message: 'Manifest must be an object.' }] }
  }

  requireString(value, 'id', issues, /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/)
  requireString(value, 'displayName', issues)
  requireString(value, 'binary', issues)
  requireNumber(value, 'version', issues)

  if ('publisher' in value) requireString(value, 'publisher', issues)

  validatePermissionPresets(value.permissionPresets, issues)
  validateLaunchSpec(value.launch, issues)
  if ('resume' in value && value.resume !== undefined) {
    validateResumeSpec(value.resume, issues)
  }
  validatePromptInjection(value.promptInjection, issues)
  validateCompletion(value.completion, 'completion', issues)
  if ('mcpConfig' in value && value.mcpConfig !== undefined) {
    validateMcpConfig(value.mcpConfig, issues)
  }
  validateCapabilities(value.capabilities, issues)
  if ('variables' in value && value.variables !== undefined) {
    validateVariables(value.variables, issues)
  }
  if ('souls' in value && value.souls !== undefined) {
    validateSouls(value.souls, issues)
  }

  if (issues.length > 0) {
    return { ok: false, issues }
  }

  return { ok: true, manifest: value as unknown as PluginManifest }
}

function validatePermissionPresets(value: unknown, issues: PluginManifestValidationIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'permissionPresets', message: 'permissionPresets must be an object.' })
    return
  }
  if (Object.keys(value).length === 0) {
    issues.push({
      path: 'permissionPresets',
      message: 'permissionPresets must declare at least one preset.',
    })
    return
  }
  for (const [presetName, preset] of Object.entries(value)) {
    const path = `permissionPresets.${presetName}`
    if (!isObject(preset)) {
      issues.push({ path, message: 'Preset must be an object.' })
      continue
    }
    requireString(preset, 'label', issues, undefined, path)
    if (!Array.isArray(preset.args)) {
      issues.push({ path: `${path}.args`, message: 'args must be an array of strings.' })
      continue
    }
    for (const [index, arg] of preset.args.entries()) {
      if (typeof arg !== 'string') {
        issues.push({
          path: `${path}.args[${index}]`,
          message: 'Permission preset args must be strings.',
        })
      }
    }
  }
}

function validateLaunchSpec(value: unknown, issues: PluginManifestValidationIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'launch', message: 'launch must be an object.' })
    return
  }
  validateArgvList(value.argv, 'launch.argv', issues)
  if ('cwd' in value && typeof value.cwd !== 'string') {
    issues.push({ path: 'launch.cwd', message: 'launch.cwd must be a string when present.' })
  }
  if ('env' in value && value.env !== undefined) {
    if (!isObject(value.env)) {
      issues.push({ path: 'launch.env', message: 'launch.env must be an object.' })
    } else {
      for (const [name, val] of Object.entries(value.env)) {
        if (typeof val !== 'string') {
          issues.push({ path: `launch.env.${name}`, message: 'env values must be strings.' })
        }
      }
    }
  }
}

function validateResumeSpec(value: unknown, issues: PluginManifestValidationIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'resume', message: 'resume must be an object when present.' })
    return
  }
  if (typeof value.supported !== 'boolean') {
    issues.push({ path: 'resume.supported', message: 'resume.supported must be a boolean.' })
  }
  if ('argv' in value && value.argv !== undefined) {
    validateArgvList(value.argv, 'resume.argv', issues)
  }
}

function validateArgvList(
  value: unknown,
  path: string,
  issues: PluginManifestValidationIssue[]
): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: `${path} must be an array.` })
    return
  }
  if (value.length === 0) {
    issues.push({ path, message: `${path} must contain at least one token.` })
    return
  }
  for (const [index, token] of value.entries()) {
    validateArgvToken(token, `${path}[${index}]`, issues)
  }
}

function validateArgvToken(
  token: unknown,
  path: string,
  issues: PluginManifestValidationIssue[]
): void {
  if (typeof token === 'string') return
  if (!isObject(token)) {
    issues.push({ path, message: 'argv tokens must be strings or directive objects.' })
    return
  }
  const directiveKeys = ['spread', 'spreadIf', 'valueIf']
  const presentKeys = directiveKeys.filter((k) => k in token)
  if (presentKeys.length === 0) {
    issues.push({
      path,
      message: `argv directive must use one of: ${directiveKeys.join(', ')}.`,
    })
    return
  }
  if (presentKeys.length > 1) {
    issues.push({
      path,
      message: `argv directive must use exactly one of: ${directiveKeys.join(', ')}.`,
    })
    return
  }
  const key = presentKeys[0] as keyof PluginArgvToken & string
  if (key === 'valueIf') {
    if (typeof (token as Record<string, unknown>).valueIf !== 'string') {
      issues.push({ path: `${path}.valueIf`, message: 'valueIf must be a string variable name.' })
    }
    if (typeof (token as Record<string, unknown>).value !== 'string') {
      issues.push({ path: `${path}.value`, message: 'value must be a string template.' })
    }
    return
  }
  if (typeof (token as Record<string, unknown>)[key] !== 'string') {
    issues.push({ path: `${path}.${key}`, message: `${key} must be a string variable name.` })
  }
}

function validatePromptInjection(
  value: unknown,
  issues: PluginManifestValidationIssue[]
): void {
  if (!isObject(value)) {
    issues.push({ path: 'promptInjection', message: 'promptInjection must be an object.' })
    return
  }
  if (typeof value.mode !== 'string' || !INJECTION_MODES.includes(value.mode as PluginPromptInjectionMode)) {
    issues.push({
      path: 'promptInjection.mode',
      message: `mode must be one of: ${INJECTION_MODES.join(', ')}.`,
    })
  }
  if (value.mode === 'send-after-ready') {
    if (!isObject(value.readiness)) {
      issues.push({
        path: 'promptInjection.readiness',
        message: 'send-after-ready requires a readiness signal.',
      })
    } else {
      if (value.readiness.type !== 'output-match') {
        issues.push({
          path: 'promptInjection.readiness.type',
          message: 'Only "output-match" readiness is supported in v1.',
        })
      }
      if (typeof value.readiness.pattern !== 'string' || value.readiness.pattern.length === 0) {
        issues.push({
          path: 'promptInjection.readiness.pattern',
          message: 'readiness.pattern must be a non-empty string.',
        })
      }
      if (typeof value.readiness.timeoutMs !== 'number' || value.readiness.timeoutMs <= 0) {
        issues.push({
          path: 'promptInjection.readiness.timeoutMs',
          message: 'readiness.timeoutMs must be a positive number.',
        })
      }
    }
  }
}

function validateCompletion(
  value: unknown,
  path: string,
  issues: PluginManifestValidationIssue[]
): void {
  if (!isObject(value)) {
    issues.push({ path, message: `${path} must be an object.` })
    return
  }
  if (typeof value.mode !== 'string' || !COMPLETION_MODES.includes(value.mode as PluginCompletionMode)) {
    issues.push({
      path: `${path}.mode`,
      message: `mode must be one of: ${COMPLETION_MODES.join(', ')}.`,
    })
    return
  }
  const mode = value.mode as PluginCompletionMode
  if (mode === 'output-sentinel' && typeof value.sentinel !== 'string') {
    issues.push({
      path: `${path}.sentinel`,
      message: 'output-sentinel completion requires a sentinel string.',
    })
  }
  if (mode === 'mcp-signal' && typeof value.signalTool !== 'string') {
    issues.push({
      path: `${path}.signalTool`,
      message: 'mcp-signal completion requires a signalTool name.',
    })
  }
  if (mode === 'idle-at-prompt') {
    if (typeof value.idleMs !== 'number' || value.idleMs <= 0) {
      issues.push({
        path: `${path}.idleMs`,
        message: 'idle-at-prompt requires a positive idleMs.',
      })
    }
    if (typeof value.promptPattern !== 'string' || value.promptPattern.length === 0) {
      issues.push({
        path: `${path}.promptPattern`,
        message: 'idle-at-prompt requires a non-empty promptPattern.',
      })
    }
  }
  if ('fallback' in value && value.fallback !== undefined) {
    validateCompletion(value.fallback as PluginCompletionSpec, `${path}.fallback`, issues)
  }
}

function validateMcpConfig(value: unknown, issues: PluginManifestValidationIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'mcpConfig', message: 'mcpConfig must be an object.' })
    return
  }
  if (typeof value.path !== 'string' || value.path.length === 0) {
    issues.push({ path: 'mcpConfig.path', message: 'mcpConfig.path must be a non-empty string.' })
  }
  if ('userPath' in value && value.userPath !== undefined) {
    if (typeof value.userPath !== 'string' || value.userPath.length === 0) {
      issues.push({
        path: 'mcpConfig.userPath',
        message: 'mcpConfig.userPath must be a non-empty string when present.',
      })
    }
  }
  if (typeof value.format !== 'string' || !(MCP_FORMATS as readonly string[]).includes(value.format)) {
    issues.push({
      path: 'mcpConfig.format',
      message: `mcpConfig.format must be one of: ${MCP_FORMATS.join(', ')}.`,
    })
  }
}

function validateCapabilities(value: unknown, issues: PluginManifestValidationIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'capabilities', message: 'capabilities must be an object.' })
    return
  }
  const requiredBooleans = ['resumeSession', 'sessionIdFromCaller', 'toolUse', 'mcpServers'] as const
  for (const name of requiredBooleans) {
    if (typeof value[name] !== 'boolean') {
      issues.push({ path: `capabilities.${name}`, message: `${name} must be a boolean.` })
    }
  }
  if ('imageInput' in value && typeof value.imageInput !== 'boolean') {
    issues.push({ path: 'capabilities.imageInput', message: 'imageInput must be a boolean.' })
  }
  if ('chatHistoryFile' in value && typeof value.chatHistoryFile !== 'string') {
    issues.push({
      path: 'capabilities.chatHistoryFile',
      message: 'chatHistoryFile must be a string when present.',
    })
  }
}

function validateVariables(value: unknown, issues: PluginManifestValidationIssue[]): void {
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
      issues.push({
        path: `${path}.type`,
        message: `type must be one of: ${VARIABLE_TYPES.join(', ')}.`,
      })
    }
    if (typeof decl.label !== 'string') {
      issues.push({ path: `${path}.label`, message: 'label must be a string.' })
    }
    if (decl.type === 'enum') {
      if (!Array.isArray(decl.options) || decl.options.length === 0) {
        issues.push({
          path: `${path}.options`,
          message: 'enum variables require a non-empty options array.',
        })
      } else {
        for (const [index, option] of decl.options.entries()) {
          if (typeof option !== 'string') {
            issues.push({
              path: `${path}.options[${index}]`,
              message: 'enum options must be strings.',
            })
          }
        }
      }
    }
  }
}

function validateSouls(value: unknown, issues: PluginManifestValidationIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'souls', message: 'souls must be an object when present.' })
    return
  }
  if (typeof value.directory !== 'string' || value.directory.length === 0) {
    issues.push({
      path: 'souls.directory',
      message: 'souls.directory must be a non-empty string.',
    })
  }
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  issues: PluginManifestValidationIssue[],
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

function requireNumber(
  value: Record<string, unknown>,
  key: string,
  issues: PluginManifestValidationIssue[]
): void {
  const v = value[key]
  if (typeof v !== 'number') {
    issues.push({ path: key, message: `${key} is required and must be a number.` })
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
