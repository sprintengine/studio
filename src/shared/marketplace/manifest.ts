// Extension marketplace bundle + registry contracts.
//
// A marketplace plugin is a thin bundle over primitives Multicode already owns:
// MCP configs, skill packs, capability modules, and agent CLI plugins. The
// bundle manifest validator lives in the published SDK so authoring tools and
// the app cannot drift on the signing-critical plugin.json shape, including
// component file digests. This module re-exports that plugin contract and adds
// the marketplace.json registry index contract used by the app.

import type { ModuleSignature } from '../modules/manifest'
import type { McpServerConfig } from '../electron-api'
// Inline-MCP registry entries carry raw MCP server configs; validate them through
// the same normalizer the app uses everywhere else (shared/mcp, node-free) so an
// inline entry cannot express a server the app would reject.
import { normalizeMcpServerConfig } from '../mcp/normalize-server'
import {
  validateThirdPartyModuleManifest as validateSdkThirdPartyModuleManifest,
  type ThirdPartyManifestIssue,
} from '../../../packages/module-sdk/src/manifest-validate'
import {
  MARKETPLACE_COMPONENT_KINDS,
  type MarketplaceComponentKind,
  type MarketplaceManifestIssue,
} from '../../../packages/module-sdk/src/plugin-manifest'

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

export {
  MARKETPLACE_COMPONENT_KINDS,
  parseMarketplacePluginAuthoringManifest,
  parseMarketplacePluginManifest,
  validateMarketplacePluginAuthoringManifest,
  validateMarketplacePluginManifest,
  type MarketplaceComponent,
  type MarketplaceComponentFileDigest,
  type MarketplaceComponentKind,
  type MarketplaceManifestIssue,
  type MarketplacePluginAuthoringManifest,
  type MarketplacePluginAuthoringManifestResult,
  type MarketplacePluginComponents,
  type MarketplacePluginManifest,
  type MarketplacePluginManifestResult,
} from '../../../packages/module-sdk/src/plugin-manifest'

export type MarketplacePublisher = {
  name: string
  verified: boolean
}

// Inline-MCP registry entries ship MCP server configs directly (modeled on
// resources/mcps/catalog.json server entries) instead of a signed bundle.
export type MarketplaceInlineMcp = {
  servers: McpServerConfig[]
}

// Digest of one file inside a bundled skill payload (captured at
// catalogue-snapshot build time; bytes ship under resources/marketplace/
// skills/<entryId>/<skill folder>/).
export type MarketplacePluginSkillFile = {
  // Posix path relative to the skill folder, e.g. `SKILL.md`.
  path: string
  // Lowercase hex sha256 of the file bytes.
  sha256: string
  // File size in bytes.
  size: number
}

// One Agent Skill a plugin bundles, enumerated from its source repo at
// catalogue-snapshot build time. `files` + `contentDigest` are present when
// the snapshot shipped the skill folder's content — the install verifies the
// bundled bytes against them; without them the skill is display metadata only
// and cannot be installed offline.
export type MarketplacePluginSkill = {
  name: string
  description: string
  // Repo-relative path of the skill folder, e.g. `skills/hf-cli`.
  path?: string
  // Complete per-file digests of the bundled payload (always with contentDigest).
  files?: MarketplacePluginSkillFile[]
  // Folder digest: sha256 over the sorted `<path>\0<sha256>` lines of `files`,
  // joined with `\n` (the catalogue-snapshot skillContentDigest formula).
  contentDigest?: string
}

// A registry entry is either a bundle entry (has `source`) or an inline-MCP
// entry (has `mcp`, `provides` is exactly ['mcp']), never both. `signature` is
// optional; trust classification is decided downstream, not by the schema.
export type MarketplacePluginEntry = {
  id: string
  name: string
  publisher: MarketplacePublisher
  summary: string
  category: string
  categories?: string[]
  tags?: string[]
  icon: string
  latest: number
  provides: MarketplaceComponentKind[]
  source?: string
  signature?: ModuleSignature
  mcp?: MarketplaceInlineMcp
  skills?: MarketplacePluginSkill[]
}

export type MarketplaceIndex = {
  schemaVersion: 1
  plugins: MarketplacePluginEntry[]
}

// Machine tag the generated catalogue stamps on Claude Code plugin entries
// (content in Claude's plugin format — `.claude-plugin/plugin.json` + skills
// dirs — not a Multicode bundle). Both the storefront affordance and the
// install pipeline branch on it, so the check lives here, once.
export const CLAUDE_PLUGIN_TAG = 'claude-plugin'

export function isClaudeCodePluginEntry(entry: Pick<MarketplacePluginEntry, 'tags'>): boolean {
  return entry.tags?.includes(CLAUDE_PLUGIN_TAG) ?? false
}

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

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/

// Payload file paths (and the skill folder path used to locate the payload
// dir) are joined into filesystem paths at install time, so they must be plain
// forward-slash relative paths — no traversal, no absolute paths, no
// backslashes (a backslash segment survives a '/'-only split and escapes on
// Windows join()), no empty segments.
function isSafeSkillFilePath(value: unknown): value is string {
  if (!isNonEmptyString(value) || value.includes('\\')) return false
  const path = value.trim()
  if (path.startsWith('/')) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function validateSkillFiles(
  value: unknown,
  path: string,
  issues: MarketplaceManifestIssue[]
): MarketplacePluginSkillFile[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: 'skill files, when present, must be a non-empty array.' })
    return undefined
  }
  const files: MarketplacePluginSkillFile[] = []
  const seenPaths = new Set<string>()
  let ok = true
  value.forEach((file, index) => {
    if (
      !isObject(file) ||
      !isSafeSkillFilePath(file.path) ||
      typeof file.sha256 !== 'string' ||
      !SHA256_HEX_PATTERN.test(file.sha256) ||
      typeof file.size !== 'number' ||
      !Number.isInteger(file.size) ||
      file.size < 0
    ) {
      issues.push({
        path: `${path}[${index}]`,
        message: 'each skill file must carry a safe relative path, a lowercase 64-hex sha256, and a non-negative integer size.',
      })
      ok = false
      return
    }
    const filePath = file.path.trim()
    if (seenPaths.has(filePath)) {
      issues.push({ path: `${path}[${index}].path`, message: 'skill file paths must be unique.' })
      ok = false
      return
    }
    seenPaths.add(filePath)
    files.push({ path: filePath, sha256: file.sha256, size: file.size })
  })
  return ok ? files : undefined
}

function validateSkills(
  value: unknown,
  path: string,
  issues: MarketplaceManifestIssue[]
): MarketplacePluginSkill[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'skills must be an array.' })
    return undefined
  }
  const skills: MarketplacePluginSkill[] = []
  value.forEach((skill, index) => {
    if (!isObject(skill) || !isNonEmptyString(skill.name) || typeof skill.description !== 'string') {
      issues.push({
        path: `${path}[${index}]`,
        message: 'each skill must be an object with a non-empty name and a string description.',
      })
      return
    }
    if (skill.path !== undefined && !isNonEmptyString(skill.path)) {
      issues.push({ path: `${path}[${index}].path`, message: 'skill path, when present, must be a non-empty string.' })
      return
    }
    // The path locates the bundled payload folder (its basename), so it must
    // be a safe relative path even for metadata-only skills — a backslash or
    // traversal segment would escape the payload root on the install side.
    if (skill.path !== undefined && !isSafeSkillFilePath(skill.path)) {
      issues.push({ path: `${path}[${index}].path`, message: 'skill path must be a safe relative path (no traversal, absolute, or backslash segments).' })
      return
    }
    // Payload digests come as a unit: files + contentDigest + the folder path
    // needed to locate the bundled bytes. A digest listing that could not be
    // fully validated must fail the index, never ship half-verified.
    const hasFiles = skill.files !== undefined
    const hasDigest = skill.contentDigest !== undefined
    if (hasFiles !== hasDigest) {
      issues.push({
        path: `${path}[${index}]`,
        message: 'skill files and contentDigest must be present together.',
      })
      return
    }
    let files: MarketplacePluginSkillFile[] | undefined
    let contentDigest: string | undefined
    if (hasFiles) {
      if (!isNonEmptyString(skill.path)) {
        issues.push({ path: `${path}[${index}].path`, message: 'a skill with bundled content digests requires a path.' })
        return
      }
      if (typeof skill.contentDigest !== 'string' || !SHA256_HEX_PATTERN.test(skill.contentDigest)) {
        issues.push({
          path: `${path}[${index}].contentDigest`,
          message: 'contentDigest must be a lowercase 64-hex sha256.',
        })
        return
      }
      files = validateSkillFiles(skill.files, `${path}[${index}].files`, issues)
      if (files === undefined) return
      contentDigest = skill.contentDigest
    }
    skills.push({
      name: skill.name.trim(),
      description: skill.description.trim(),
      ...(isNonEmptyString(skill.path) ? { path: skill.path.trim() } : {}),
      ...(files !== undefined && contentDigest !== undefined ? { files, contentDigest } : {}),
    })
  })
  return skills
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

function validateStringArray(value: unknown, path: string, field: string, issues: MarketplaceManifestIssue[]): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: `${field} must be an array of strings.` })
    return undefined
  }
  const items: string[] = []
  value.forEach((entry, index) => {
    if (!isNonEmptyString(entry)) {
      issues.push({ path: `${path}[${index}]`, message: `${field} entries must be non-empty strings.` })
      return
    }
    items.push(entry.trim())
  })
  return items.length === value.length ? items : undefined
}

function validateInlineMcp(value: unknown, path: string, issues: MarketplaceManifestIssue[]): MarketplaceInlineMcp | undefined {
  if (!isObject(value)) {
    issues.push({ path, message: 'mcp must be an object.' })
    return undefined
  }
  if (!Array.isArray(value.servers) || value.servers.length === 0) {
    issues.push({ path: `${path}.servers`, message: 'mcp.servers must be a non-empty array.' })
    return undefined
  }
  const servers: McpServerConfig[] = []
  value.servers.forEach((server, index) => {
    const normalized = normalizeMcpServerConfig(server, {
      enabled: true,
      clients: ['codex', 'claude-code'],
      scope: 'workspace',
      source: 'custom',
    })
    if (!normalized) {
      issues.push({ path: `${path}.servers[${index}]`, message: 'mcp server must normalize through the app MCP parser.' })
      return
    }
    servers.push(normalized)
  })
  return servers.length === value.servers.length ? { servers } : undefined
}

function validateMarketplaceEntry(value: unknown, index: number, issues: MarketplaceManifestIssue[]): MarketplacePluginEntry | undefined {
  const path = `plugins[${index}]`
  if (!isObject(value)) {
    issues.push({ path, message: 'marketplace plugin entry must be an object.' })
    return undefined
  }
  const startIssues = issues.length

  // signature is optional here; the SDK probe validates its shape when present.
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

  const publisher = validatePublisher(value.publisher, `${path}.publisher`, issues)
  for (const key of ['summary', 'icon'] as const) {
    if (!isNonEmptyString(value[key])) {
      issues.push({ path: `${path}.${key}`, message: `${key} is required and must be a non-empty string.` })
    }
  }
  const provides = validateProvides(value.provides, `${path}.provides`, issues)

  // Categories: accept the legacy singular `category` and/or a `categories[]`
  // array, and keep `category` populated (from categories[0]) for back-compat.
  const categories = value.categories !== undefined
    ? validateStringArray(value.categories, `${path}.categories`, 'categories', issues)
    : undefined
  const tags = value.tags !== undefined
    ? validateStringArray(value.tags, `${path}.tags`, 'tags', issues)
    : undefined
  let category: string | undefined
  if (value.category !== undefined && !isNonEmptyString(value.category)) {
    issues.push({ path: `${path}.category`, message: 'category must be a non-empty string.' })
  } else if (isNonEmptyString(value.category)) {
    category = value.category.trim()
  }
  if (category === undefined && categories && categories.length > 0) category = categories[0]
  if (category === undefined) {
    issues.push({ path: `${path}.category`, message: 'category or categories[] is required.' })
  }

  // Bundle (source) XOR inline-MCP (mcp): exactly one shape.
  const hasSource = value.source !== undefined
  const hasMcp = value.mcp !== undefined
  if (hasSource && hasMcp) {
    issues.push({ path, message: 'entry must be a bundle entry (source) or an inline-MCP entry (mcp), not both.' })
  } else if (!hasSource && !hasMcp) {
    issues.push({ path, message: 'entry must declare a bundle source or an inline mcp block.' })
  }

  let source: string | undefined
  if (hasSource) {
    if (!isNonEmptyString(value.source)) {
      issues.push({ path: `${path}.source`, message: 'source is required and must be a non-empty string.' })
    } else {
      source = value.source.trim()
    }
  }

  let mcp: MarketplaceInlineMcp | undefined
  if (hasMcp) {
    mcp = validateInlineMcp(value.mcp, `${path}.mcp`, issues)
    if (provides && (provides.length !== 1 || provides[0] !== 'mcp')) {
      issues.push({ path: `${path}.provides`, message: "inline-MCP entries must set provides to ['mcp']." })
    }
  }

  // Bundled-skill summaries (optional, generated by the catalogue snapshot):
  // validated here so they survive the field-by-field entry rebuild below —
  // an unknown key would otherwise be silently dropped.
  const skills = value.skills !== undefined ? validateSkills(value.skills, `${path}.skills`, issues) : undefined

  if (!moduleProbe.ok || !publisher || !provides || category === undefined || issues.length > startIssues) {
    return undefined
  }

  const entry: MarketplacePluginEntry = {
    id: moduleProbe.manifest.id,
    name: moduleProbe.manifest.displayName,
    publisher,
    summary: (value.summary as string).trim(),
    category,
    icon: (value.icon as string).trim(),
    latest: moduleProbe.manifest.version,
    provides,
  }
  if (categories && categories.length > 0) entry.categories = categories
  if (tags && tags.length > 0) entry.tags = tags
  if (source !== undefined) entry.source = source
  if (moduleProbe.manifest.signature) entry.signature = moduleProbe.manifest.signature as ModuleSignature
  if (mcp) entry.mcp = mcp
  if (skills && skills.length > 0) entry.skills = skills
  return entry
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
