// Marketplace plugin bundle manifest: validator + authoring helpers.
//
// A marketplace plugin is a thin bundle over existing Multicode primitives. It
// reuses the capability module manifest validator and canonical signing payload
// so the app and authoring CLI sign/verify the same normalized plugin.json
// shape, including the bundle `components` declaration.

import type { CapabilityManifest, CapabilityPermission, ModuleSignature } from './index.js'
import {
  isSafeManifestRelativePath,
  validateThirdPartyModuleManifest as validateSdkThirdPartyModuleManifest,
  type ThirdPartyManifestIssue,
} from './manifest-validate.js'

export type MarketplaceComponentKind = 'mcp' | 'skills' | 'module' | 'cli'

export const MARKETPLACE_COMPONENT_KINDS: readonly MarketplaceComponentKind[] = ['mcp', 'skills', 'module', 'cli']

export type MarketplaceComponent = {
  path: string
}

export type MarketplacePluginComponents = {
  [K in MarketplaceComponentKind]?: MarketplaceComponent
}

export type MarketplacePluginAuthoringManifest = Omit<CapabilityManifest, 'signature'> & {
  components: MarketplacePluginComponents
  permissions: CapabilityPermission[]
  signature?: ModuleSignature
}

export type MarketplacePluginManifest = Omit<MarketplacePluginAuthoringManifest, 'signature'> & {
  signature: ModuleSignature
}

export type MarketplaceManifestIssue = { path: string; message: string }

export type MarketplacePluginManifestResult =
  | { ok: true; manifest: MarketplacePluginManifest }
  | { ok: false; issues: MarketplaceManifestIssue[] }

export type MarketplacePluginAuthoringManifestResult =
  | { ok: true; manifest: MarketplacePluginAuthoringManifest }
  | { ok: false; issues: MarketplaceManifestIssue[] }

const COMPONENT_KIND_SET = new Set<string>(MARKETPLACE_COMPONENT_KINDS)

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function validateMarketplacePluginManifestBase(
  value: unknown,
  requireSignature: boolean
): MarketplacePluginAuthoringManifestResult {
  const issues: MarketplaceManifestIssue[] = []
  if (!isObject(value)) {
    return { ok: false, issues: [{ path: '', message: 'Plugin manifest must be a JSON object.' }] }
  }

  const moduleResult = validateSdkThirdPartyModuleManifest(value)
  if (!moduleResult.ok) pushSdkIssues(issues, moduleResult.issues)
  if (requireSignature && value.signature === undefined) {
    issues.push({ path: 'signature', message: 'signature is required.' })
  }

  const components = validateComponents(value.components, issues)
  if (issues.length > 0 || !moduleResult.ok || !components) return { ok: false, issues }

  return {
    ok: true,
    manifest: {
      ...moduleResult.manifest,
      components,
      permissions: moduleResult.manifest.permissions ?? [],
    },
  }
}

export function validateMarketplacePluginManifest(value: unknown): MarketplacePluginManifestResult {
  const result = validateMarketplacePluginManifestBase(value, true)
  if (!result.ok) return result
  const signature = result.manifest.signature
  if (!signature) {
    return { ok: false, issues: [{ path: 'signature', message: 'signature is required.' }] }
  }
  return { ok: true, manifest: { ...result.manifest, signature } }
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

export function validateMarketplacePluginAuthoringManifest(value: unknown): MarketplacePluginAuthoringManifestResult {
  return validateMarketplacePluginManifestBase(value, false)
}

export function parseMarketplacePluginAuthoringManifest(source: string): MarketplacePluginAuthoringManifestResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: '', message: `Invalid JSON: ${error instanceof Error ? error.message : 'parse error'}.` }],
    }
  }
  return validateMarketplacePluginAuthoringManifest(parsed)
}
