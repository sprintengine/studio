import type {
  ConversationProviderAdapterKind,
  ConversationProviderManifest,
  ConversationProviderType,
  PluginManifest,
  PluginManifestValidationIssue,
  PluginManifestValidationResult,
} from '../shared/plugin-manifest'
import { validateCliPluginManifest } from '../../packages/module-sdk/src/cli-manifest'

const VARIABLE_TYPES = ['string', 'enum', 'boolean', 'number'] as const
const PROVIDER_TYPES: ConversationProviderType[] = ['model-provider', 'agent-harness']
const PROVIDER_ADAPTER_KINDS: ConversationProviderAdapterKind[] = ['declarative', 'trusted-executable']
const PROVIDER_AUTH_TYPES = ['api-key'] as const
const CLI_ONLY_FIELDS = [
  'binary',
  'permissionPresets',
  'launch',
  'resume',
  'promptInjection',
  'contextInjection',
  'completion',
  'mcpConfig',
  'capabilities',
  'souls',
  'modelSelection',
  'skillIntegration',
] as const

export function validateManifestStructure(value: unknown): PluginManifestValidationResult {
  const issues: PluginManifestValidationIssue[] = []
  if (!isObject(value)) {
    return { ok: false, issues: [{ path: '', message: 'Manifest must be an object.' }] }
  }

  if (value.kind === 'provider') {
    return validateProviderManifestStructure(value, issues)
  }

  // CLI manifest validation is single-sourced in the published SDK
  // (packages/module-sdk/src/cli-manifest.ts), the same way the third-party
  // module manifest validator is. The app and the @multicode/module-sdk
  // authoring tooling therefore validate a plugin.json identically — they
  // cannot drift, because this is the one implementation. Provider manifests
  // (above) remain app-only.
  const cli = validateCliPluginManifest(value)
  if (!cli.ok) return { ok: false, issues: cli.issues }
  return { ok: true, manifest: value as unknown as PluginManifest }
}

function validateProviderManifestStructure(
  value: Record<string, unknown>,
  issues: PluginManifestValidationIssue[]
): PluginManifestValidationResult {
  requireString(value, 'id', issues, /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/)
  requireString(value, 'displayName', issues)
  requireNumber(value, 'version', issues)

  if ('publisher' in value) requireString(value, 'publisher', issues)

  if (
    typeof value.providerType !== 'string'
    || !PROVIDER_TYPES.includes(value.providerType as ConversationProviderType)
  ) {
    issues.push({
      path: 'providerType',
      message: `providerType must be one of: ${PROVIDER_TYPES.join(', ')}.`,
    })
  }

  validateProviderModels(value.models, issues)
  if ('auth' in value && value.auth !== undefined) {
    validateProviderAuth(value.auth, issues)
  }
  if ('adapter' in value && value.adapter !== undefined) {
    validateProviderAdapter(value.adapter, issues)
  }
  if ('openaiCompatible' in value && value.openaiCompatible !== undefined) {
    validateOpenAiCompatible(value.openaiCompatible, issues)
  }
  if ('signature' in value && value.signature !== undefined) {
    validateSignature(value.signature, issues)
  }
  if ('variables' in value && value.variables !== undefined) {
    validateVariables(value.variables, issues)
  }

  for (const field of CLI_ONLY_FIELDS) {
    if (field in value) {
      issues.push({
        path: field,
        message: `${field} is only valid on CLI manifests.`,
      })
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues }
  }

  return { ok: true, manifest: value as unknown as ConversationProviderManifest }
}

function validateProviderAdapter(value: unknown, issues: PluginManifestValidationIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'adapter', message: 'adapter must be an object when present.' })
    return
  }
  if (
    typeof value.kind !== 'string'
    || !PROVIDER_ADAPTER_KINDS.includes(value.kind as ConversationProviderAdapterKind)
  ) {
    issues.push({
      path: 'adapter.kind',
      message: `adapter.kind must be one of: ${PROVIDER_ADAPTER_KINDS.join(', ')}.`,
    })
    return
  }
  if (value.kind === 'trusted-executable') {
    if (!isSafeRelativePath(value.entry)) {
      issues.push({
        path: 'adapter.entry',
        message: 'adapter.entry must be a safe relative path inside the provider package.',
      })
    }
    if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256)) {
      issues.push({
        path: 'adapter.sha256',
        message: 'adapter.sha256 must be a hex-encoded sha256 digest of the adapter entry.',
      })
    }
    return
  }
  if ('entry' in value && value.entry !== undefined) {
    issues.push({ path: 'adapter.entry', message: 'adapter.entry is only valid for trusted-executable adapters.' })
  }
}

function validateOpenAiCompatible(value: unknown, issues: PluginManifestValidationIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'openaiCompatible', message: 'openaiCompatible must be an object when present.' })
    return
  }
  if (typeof value.baseUrl !== 'string' || !value.baseUrl.trim()) {
    issues.push({ path: 'openaiCompatible.baseUrl', message: 'openaiCompatible.baseUrl is required.' })
  } else {
    try {
      const url = new URL(value.baseUrl)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        issues.push({ path: 'openaiCompatible.baseUrl', message: 'openaiCompatible.baseUrl must use http or https.' })
      }
    } catch {
      issues.push({ path: 'openaiCompatible.baseUrl', message: 'openaiCompatible.baseUrl must be a valid URL.' })
    }
  }
  if ('chatCompletionsPath' in value && value.chatCompletionsPath !== undefined) {
    if (
      typeof value.chatCompletionsPath !== 'string'
      || !value.chatCompletionsPath.startsWith('/')
      || value.chatCompletionsPath.includes('..')
    ) {
      issues.push({
        path: 'openaiCompatible.chatCompletionsPath',
        message: 'openaiCompatible.chatCompletionsPath must be an absolute URL path.',
      })
    }
  }
  if ('modelsPath' in value && value.modelsPath !== undefined) {
    if (
      typeof value.modelsPath !== 'string'
      || !value.modelsPath.startsWith('/')
      || value.modelsPath.includes('..')
    ) {
      issues.push({
        path: 'openaiCompatible.modelsPath',
        message: 'openaiCompatible.modelsPath must be an absolute URL path.',
      })
    }
  }
}

function validateSignature(value: unknown, issues: PluginManifestValidationIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'signature', message: 'signature must be an object when present.' })
    return
  }
  if (value.algorithm !== 'ed25519') {
    issues.push({ path: 'signature.algorithm', message: 'signature.algorithm must be "ed25519".' })
  }
  if (!isBase64(value.publicKey)) {
    issues.push({ path: 'signature.publicKey', message: 'signature.publicKey must be base64.' })
  }
  if (!isBase64(value.signature)) {
    issues.push({ path: 'signature.signature', message: 'signature.signature must be base64.' })
  }
}

function validateProviderModels(value: unknown, issues: PluginManifestValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push({ path: 'models', message: 'models must be an array.' })
    return
  }
  if (value.length === 0) {
    issues.push({ path: 'models', message: 'models must contain at least one model.' })
    return
  }
  for (const [index, model] of value.entries()) {
    const path = `models[${index}]`
    if (!isObject(model)) {
      issues.push({ path, message: 'Provider model must be an object.' })
      continue
    }
    requireString(model, 'id', issues, undefined, path)
    if ('displayName' in model && model.displayName !== undefined) {
      requireString(model, 'displayName', issues, undefined, path)
    }
  }
}

function validateProviderAuth(value: unknown, issues: PluginManifestValidationIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path: 'auth', message: 'auth must be an object when present.' })
    return
  }
  if (
    typeof value.type !== 'string'
    || !(PROVIDER_AUTH_TYPES as readonly string[]).includes(value.type)
  ) {
    issues.push({
      path: 'auth.type',
      message: `auth.type must be one of: ${PROVIDER_AUTH_TYPES.join(', ')}.`,
    })
  }
  requireString(value, 'label', issues, undefined, 'auth')
  if ('env' in value && value.env !== undefined) {
    requireString(value, 'env', issues, undefined, 'auth')
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

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/')) return false
  const segments = value.split('/')
  return !segments.some((segment) => segment === '..' || segment === '.' || segment.length === 0)
}

function isBase64(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
}
