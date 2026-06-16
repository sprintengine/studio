// Extension marketplace bundle + registry contracts.
//
// A marketplace plugin is a thin bundle over primitives Multicode already owns:
// MCP configs, skill packs, capability modules, and agent CLI plugins. The
// bundle manifest reuses the module manifest validator/signing payload so the
// app and authoring tooling cannot drift on trust-critical fields.

import type { CapabilityManifest, ModuleSignature } from '../modules/manifest'
import type { CapabilityPermission } from '../modules/permissions'
import {
  isSafeManifestRelativePath,
  validateThirdPartyModuleManifest as validateSdkThirdPartyModuleManifest,
  type ThirdPartyManifestIssue,
} from '../../../packages/module-sdk/src/manifest-validate'

export {
  canonicalManifestPayload,
  parseThirdPartyModuleManifest,
  validateCapabilityPermissions,
  validateThirdPartyModuleManifest,
  type PermissionValidationIssue,
  type PermissionValidationResult,
  type ThirdPartyManifestIssue,
  type ThirdPartyManifestResult,
} from '../../../packages/module-sdk/src/manifest-validate'

export type MarketplaceComponentKind = 'mcp' | 'skills' | 'module' | 'cli'

export const MARKETPLACE_COMPONENT_KINDS: readonly MarketplaceComponentKind[] = ['mcp', 'skills', 'module', 'cli']

export type MarketplaceComponent = {
  path: string
}

export type MarketplacePluginComponents = {
  [K in MarketplaceComponentKind]?: MarketplaceComponent
}

export type MarketplacePluginManifest = Omit<CapabilityManifest, 'signature'> & {
  components: MarketplacePluginComponents
  permissions: CapabilityPermission[]
  signature: ModuleSignature
}

export type MarketplacePublisher = {
  name: string
  verified: boolean
}

export type MarketplacePluginEntry = {
  id: string
  name: string
  publisher: MarketplacePublisher
  summary: string
  category: string
  icon: string
  latest: number
  source: string
  provides: MarketplaceComponentKind[]
  signature: ModuleSignature
}

export type MarketplaceIndex = {
  schemaVersion: 1
  plugins: MarketplacePluginEntry[]
}

export type MarketplaceManifestIssue = { path: string; message: string }

export type MarketplacePluginManifestResult =
  | { ok: true; manifest: MarketplacePluginManifest }
  | { ok: false; issues: MarketplaceManifestIssue[] }

export type MarketplaceIndexResult =
  | { ok: true; marketplace: MarketplaceIndex }
  | { ok: false; issues: MarketplaceManifestIssue[] }

const COMPONENT_KIND_SET = new Set<string>(MARKETPLACE_COMPONENT_KINDS)

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
}

function pushSdkIssues(
  issues: MarketplaceManifestIssue[],
  sdkIssues: ThirdPartyManifestIssue[],
  pathPrefix = '',
  remap: Record<string, string> = {}
): void {
  for (const issue of sdkIssues) {
    const mappedPath = remap[issue.path] ?? issue.path
    issues.push({ path: pathPrefix ? `${pathPrefix}.${mappedPath}` : mappedPath, message: issue.message })
  }
}

function validateComponents(value: unknown, issues: MarketplaceManifestIssue[]): MarketplacePluginComponents | undefined {
  if (!isObject(value)) {
    issues.push({ path: 'components', message: 'components must be an object.' })
    return undefined
  }

  const components: MarketplacePluginComponents = {}
  for (const [kind, component] of Object.entries(value)) {
    if (!COMPONENT_KIND_SET.has(kind)) {
      issues.push({ path: `components.${kind}`, message: `component kind must be one of: ${MARKETPLACE_COMPONENT_KINDS.join(', ')}.` })
      continue
    }
    const path = `components.${kind}`
    if (!isObject(component)) {
      issues.push({ path, message: 'component must be an object.' })
      continue
    }
    for (const field of Object.keys(component)) {
      if (field !== 'path') {
        issues.push({ path: `${path}.${field}`, message: 'unsupported component field.' })
      }
    }
    if (!isSafeManifestRelativePath(component.path)) {
      issues.push({
        path: `${path}.path`,
        message: 'path must be a safe relative path inside the plugin bundle (no absolute paths or "..").',
      })
      continue
    }
    components[kind as MarketplaceComponentKind] = { path: component.path }
  }

  if (Object.keys(components).length === 0) {
    issues.push({ path: 'components', message: 'components must declare at least one component.' })
    return undefined
  }
  return components
}

export function validateMarketplacePluginManifest(value: unknown): MarketplacePluginManifestResult {
  const issues: MarketplaceManifestIssue[] = []
  if (!isObject(value)) {
    return { ok: false, issues: [{ path: '', message: 'Plugin manifest must be a JSON object.' }] }
  }

  const moduleResult = validateSdkThirdPartyModuleManifest(value)
  if (!moduleResult.ok) pushSdkIssues(issues, moduleResult.issues)
  if (value.signature === undefined) {
    issues.push({ path: 'signature', message: 'signature is required.' })
  }

  const components = validateComponents(value.components, issues)
  if (issues.length > 0 || !moduleResult.ok || !components) return { ok: false, issues }
  const signature = moduleResult.manifest.signature
  if (!signature) {
    return { ok: false, issues: [{ path: 'signature', message: 'signature is required.' }] }
  }

  return {
    ok: true,
    manifest: {
      ...moduleResult.manifest,
      signature,
      components,
      permissions: moduleResult.manifest.permissions ?? [],
    },
  }
}

export function parseMarketplacePluginManifest(source: string): MarketplacePluginManifestResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: '', message: `Invalid JSON: ${error instanceof Error ? error.message : 'parse error'}.` }],
    }
  }
  return validateMarketplacePluginManifest(parsed)
}

function validatePublisher(value: unknown, path: string, issues: MarketplaceManifestIssue[]): MarketplacePublisher | undefined {
  if (!isObject(value)) {
    issues.push({ path, message: 'publisher must be an object.' })
    return undefined
  }
  if (!isNonEmptyString(value.name)) {
    issues.push({ path: `${path}.name`, message: 'publisher.name is required and must be a non-empty string.' })
  }
  if (typeof value.verified !== 'boolean') {
    issues.push({ path: `${path}.verified`, message: 'publisher.verified must be a boolean.' })
  }
  if (!isNonEmptyString(value.name) || typeof value.verified !== 'boolean') return undefined
  return { name: value.name.trim(), verified: value.verified }
}

function validateProvides(value: unknown, path: string, issues: MarketplaceManifestIssue[]): MarketplaceComponentKind[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'provides must be an array.' })
    return undefined
  }
  if (value.length === 0) {
    issues.push({ path, message: 'provides must contain at least one component kind.' })
    return undefined
  }
  const seen = new Set<MarketplaceComponentKind>()
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !COMPONENT_KIND_SET.has(entry)) {
      issues.push({ path: `${path}[${index}]`, message: `provides entries must be one of: ${MARKETPLACE_COMPONENT_KINDS.join(', ')}.` })
      return
    }
    seen.add(entry as MarketplaceComponentKind)
  })
  return seen.size > 0 ? Array.from(seen) : undefined
}

function validateMarketplaceEntry(value: unknown, index: number, issues: MarketplaceManifestIssue[]): MarketplacePluginEntry | undefined {
  const path = `plugins[${index}]`
  if (!isObject(value)) {
    issues.push({ path, message: 'marketplace plugin entry must be an object.' })
    return undefined
  }

  const moduleProbe = validateSdkThirdPartyModuleManifest({
    id: value.id,
    displayName: value.name,
    version: value.latest,
    permissions: [],
    signature: value.signature,
  })
  if (!moduleProbe.ok) {
    pushSdkIssues(issues, moduleProbe.issues, path, { displayName: 'name', version: 'latest' })
  }
  if (value.signature === undefined) {
    issues.push({ path: `${path}.signature`, message: 'signature is required.' })
  }

  const publisher = validatePublisher(value.publisher, `${path}.publisher`, issues)
  for (const key of ['summary', 'category', 'icon', 'source'] as const) {
    if (!isNonEmptyString(value[key])) {
      issues.push({ path: `${path}.${key}`, message: `${key} is required and must be a non-empty string.` })
    }
  }
  const provides = validateProvides(value.provides, `${path}.provides`, issues)

  if (!moduleProbe.ok || !publisher || !provides || issues.some((issue) => issue.path.startsWith(`${path}.`))) {
    return undefined
  }

  return {
    id: moduleProbe.manifest.id,
    name: moduleProbe.manifest.displayName,
    publisher,
    summary: (value.summary as string).trim(),
    category: (value.category as string).trim(),
    icon: (value.icon as string).trim(),
    latest: moduleProbe.manifest.version,
    source: (value.source as string).trim(),
    provides,
    signature: moduleProbe.manifest.signature as ModuleSignature,
  }
}

export function validateMarketplaceIndex(value: unknown): MarketplaceIndexResult {
  const issues: MarketplaceManifestIssue[] = []
  if (!isObject(value)) {
    return { ok: false, issues: [{ path: '', message: 'Marketplace index must be a JSON object.' }] }
  }
  if (value.schemaVersion !== 1) {
    issues.push({ path: 'schemaVersion', message: 'schemaVersion must be 1.' })
  }
  if (!Array.isArray(value.plugins)) {
    issues.push({ path: 'plugins', message: 'plugins must be an array.' })
  }

  const plugins = Array.isArray(value.plugins)
    ? value.plugins
      .map((entry, index) => validateMarketplaceEntry(entry, index, issues))
      .filter((entry): entry is MarketplacePluginEntry => entry !== undefined)
    : []

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, marketplace: { schemaVersion: 1, plugins } }
}

export function parseMarketplaceIndex(source: string): MarketplaceIndexResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: '', message: `Invalid JSON: ${error instanceof Error ? error.message : 'parse error'}.` }],
    }
  }
  return validateMarketplaceIndex(parsed)
}
