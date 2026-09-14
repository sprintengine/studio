// Marketplace plugin bundle manifest: validator + authoring helpers.
//
// A marketplace plugin is a thin bundle over primitives the studio already
// owns. It reuses the capability module manifest validator and canonical
// signing payload so the app and authoring CLI sign/verify the same normalized
// plugin.json shape, including the bundle `components` declaration and signed
// component file digests.

import type { CapabilityManifest, CapabilityPermission, ModuleSignature } from './index.js'
import {
  isSafeManifestRelativePath,
  validateThirdPartyModuleManifest as validateSdkThirdPartyModuleManifest,
  type ThirdPartyManifestIssue,
} from './manifest-validate.js'

export type MarketplaceComponentKind = 'mcp' | 'skills' | 'module' | 'cli' | 'automation'

export const MARKETPLACE_COMPONENT_KINDS: readonly MarketplaceComponentKind[] = ['mcp', 'skills', 'module', 'cli', 'automation']

export type MarketplaceComponentFileDigest = {
  path: string
  sha256: string
}

export type MarketplaceComponent = {
  path: string
  files?: MarketplaceComponentFileDigest[]
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

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function componentFilePathBelongsToComponent(componentPath: string, filePath: string): boolean {
  return filePath === componentPath || filePath.startsWith(`${componentPath}/`)
}

function validateComponentFileDigests(
  value: unknown,
  componentPath: string,
  path: string,
  issues: MarketplaceManifestIssue[],
  required: boolean
): MarketplaceComponentFileDigest[] | undefined {
  if (value === undefined) {
    if (required) issues.push({ path: `${path}.files`, message: 'component file digests are required.' })
    return undefined
  }
  if (!Array.isArray(value)) {
    issues.push({ path: `${path}.files`, message: 'component file digests must be an array.' })
    return undefined
  }
  if (value.length === 0) {
    issues.push({ path: `${path}.files`, message: 'component file digests must contain at least one file.' })
    return undefined
  }

  const files: MarketplaceComponentFileDigest[] = []
  const seenPaths = new Set<string>()
  value.forEach((entry, index) => {
    const entryPath = `${path}.files[${index}]`
    if (!isObject(entry)) {
      issues.push({ path: entryPath, message: 'component file digest must be an object.' })
      return
    }
    for (const field of Object.keys(entry)) {
      if (field !== 'path' && field !== 'sha256') {
        issues.push({ path: `${entryPath}.${field}`, message: 'unsupported component file digest field.' })
      }
    }
    if (!isSafeManifestRelativePath(entry.path)) {
      issues.push({
        path: `${entryPath}.path`,
        message: 'file path must be a safe relative path inside the plugin bundle (no absolute paths or "..").',
      })
      return
    }
    if (!componentFilePathBelongsToComponent(componentPath, entry.path)) {
      issues.push({ path: `${entryPath}.path`, message: 'file path must be inside the declared component path.' })
      return
    }
    if (seenPaths.has(entry.path)) {
      issues.push({ path: `${entryPath}.path`, message: 'component file digest paths must be unique.' })
      return
    }
    if (!isSha256Hex(entry.sha256)) {
      issues.push({ path: `${entryPath}.sha256`, message: 'sha256 must be a lowercase 64-character hex digest.' })
      return
    }
    seenPaths.add(entry.path)
    files.push({ path: entry.path, sha256: entry.sha256 })
  })

  return files.length > 0 ? files.sort((a, b) => a.path.localeCompare(b.path)) : undefined
}

function validateComponents(
  value: unknown,
  issues: MarketplaceManifestIssue[],
  requireFileDigests: boolean
): MarketplacePluginComponents | undefined {
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
      if (field !== 'path' && field !== 'files') {
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
    const files = validateComponentFileDigests(component.files, component.path, path, issues, requireFileDigests)
    components[kind as MarketplaceComponentKind] = {
      path: component.path,
      ...(files ? { files } : {}),
    }
  }

  if (Object.keys(components).length === 0) {
    issues.push({ path: 'components', message: 'components must declare at least one component.' })
    return undefined
  }
  return components
}

const AUTOMATION_ISSUE_PATH = 'components.automation'

// Structural check on the bytes an `automation` component points at. An
// automation payload is a JSON automation definition draft (name + trigger +
// action); this tier proves only that shape, because the authoritative parse —
// trigger and action kinds, cadence, per-action config schemas — lives in the
// app's single automation write path, which this package cannot import. The
// bundle gates run this so a mis-authored bundle is refused at pack, stage, and
// install-preflight time; the installer still runs the authoritative parse
// before anything is written.
export function marketplaceAutomationPayloadIssues(source: string): MarketplaceManifestIssue[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    return [{
      path: AUTOMATION_ISSUE_PATH,
      message: `automation payload must be valid JSON: ${error instanceof Error ? error.message : 'parse error'}.`,
    }]
  }
  if (!isObject(parsed)) {
    return [{ path: AUTOMATION_ISSUE_PATH, message: 'automation payload must be a JSON object.' }]
  }

  const issues: MarketplaceManifestIssue[] = []
  if (typeof parsed.name !== 'string' || parsed.name.trim().length === 0) {
    issues.push({ path: `${AUTOMATION_ISSUE_PATH}.name`, message: 'automation payload name is required and must be a non-empty string.' })
  }
  for (const field of ['trigger', 'action'] as const) {
    const value = parsed[field]
    if (!isObject(value)) {
      issues.push({ path: `${AUTOMATION_ISSUE_PATH}.${field}`, message: `automation payload ${field} is required and must be an object.` })
      continue
    }
    if (typeof value.kind !== 'string' || value.kind.trim().length === 0) {
      issues.push({
        path: `${AUTOMATION_ISSUE_PATH}.${field}.kind`,
        message: `automation payload ${field}.kind is required and must be a non-empty string.`,
      })
    }
  }
  return issues
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

  const components = validateComponents(value.components, issues, requireSignature)
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
