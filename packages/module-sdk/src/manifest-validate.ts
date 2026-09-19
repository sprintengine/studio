// Third-party capability module manifest: validator + canonical signing payload.
//
// This is the single source of truth for what a valid third-party manifest is
// and for the exact bytes a module signature covers. The studio imports
// this module (via src/shared/modules/third-party-manifest.ts and
// src/shared/modules/permissions.ts) and the `sprintengine-module` CLI ships it in
// the published tarball, so the app and external authors can never disagree.
//
// A third-party module is a folder containing a manifest.json. The manifest is
// untrusted input and is validated strictly before it is allowed anywhere near
// the resolver or the trust UI. Notably the validator FORCES
// `source: 'third-party'` and strips `core`: a third-party module can never be
// a core/always-on module, and can never masquerade as bundled. This validates
// the declaration only; main-process loading still happens exclusively through
// the trusted third-party main loader inside the app.
//
// Everything here is pure (no Node or DOM APIs) so it is safe in any runtime.

import type { CapabilityManifest, CapabilityPermission, ModuleEntry, ModuleSignature } from './index.js'

export type PermissionValidationIssue = { path: string; message: string }

export type PermissionValidationResult =
  { ok: true; permissions: CapabilityPermission[] } | { ok: false; issues: PermissionValidationIssue[] }

// Validate a manifest's declared permissions array: every entry must be a
// non-empty string. Unknown scopes are allowed (forward-compatible) but the
// caller can flag them via isKnownCapabilityPermission for the consent UI.
// Duplicates are collapsed.
export function validateCapabilityPermissions(value: unknown, path = 'permissions'): PermissionValidationResult {
  if (value === undefined) return { ok: true, permissions: [] }
  if (!Array.isArray(value)) {
    return { ok: false, issues: [{ path, message: 'permissions must be an array of strings.' }] }
  }
  const issues: PermissionValidationIssue[] = []
  const seen = new Set<string>()
  const permissions: CapabilityPermission[] = []
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      issues.push({ path: `${path}[${index}]`, message: 'permission must be a non-empty string.' })
      return
    }
    if (seen.has(entry)) return
    seen.add(entry)
    permissions.push(entry)
  })
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, permissions }
}

export type ThirdPartyManifestIssue = { path: string; message: string }

export type ThirdPartyManifestResult =
  { ok: true; manifest: CapabilityManifest } | { ok: false; issues: ThirdPartyManifestIssue[] }

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A path that stays inside the manifest root: relative, no traversal, no NUL.
export function isSafeManifestRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.includes('\0') || value.includes('\\')) return false
  if (value.startsWith('/')) return false
  const segments = value.split('/')
  return !segments.some((segment) => segment === '..' || segment === '.' || segment.length === 0)
}

function validateStringArray(value: unknown, path: string, issues: ThirdPartyManifestIssue[]): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    issues.push({ path, message: `${path} must be an array of strings.` })
    return undefined
  }
  const out: string[] = []
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !ID_PATTERN.test(entry)) {
      issues.push({ path: `${path}[${index}]`, message: 'must be a valid module id.' })
      return
    }
    out.push(entry)
  })
  return out
}

function validateEntry(value: unknown, issues: ThirdPartyManifestIssue[]): ModuleEntry | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) {
    issues.push({ path: 'entry', message: 'entry must be an object.' })
    return undefined
  }
  const entry: ModuleEntry = {}
  for (const key of ['main', 'preload', 'renderer'] as const) {
    if (value[key] === undefined) continue
    if (!isSafeManifestRelativePath(value[key])) {
      issues.push({
        path: `entry.${key}`,
        message: 'must be a safe relative path inside the module (no absolute paths or "..").',
      })
      continue
    }
    entry[key] = value[key] as string
  }
  return Object.keys(entry).length > 0 ? entry : undefined
}

function isBase64(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
}

function validateSignature(value: unknown, issues: ThirdPartyManifestIssue[]): ModuleSignature | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) {
    issues.push({ path: 'signature', message: 'signature must be an object.' })
    return undefined
  }
  if (value.algorithm !== 'ed25519') {
    issues.push({ path: 'signature.algorithm', message: "signature.algorithm must be 'ed25519'." })
  }
  if (!isBase64(value.publicKey)) {
    issues.push({ path: 'signature.publicKey', message: 'signature.publicKey must be base64.' })
  }
  if (!isBase64(value.signature)) {
    issues.push({ path: 'signature.signature', message: 'signature.signature must be base64.' })
  }
  if (value.algorithm !== 'ed25519' || !isBase64(value.publicKey) || !isBase64(value.signature)) {
    return undefined
  }
  return { algorithm: 'ed25519', publicKey: value.publicKey as string, signature: value.signature as string }
}

export function validateThirdPartyModuleManifest(value: unknown): ThirdPartyManifestResult {
  const issues: ThirdPartyManifestIssue[] = []
  if (!isObject(value)) {
    return { ok: false, issues: [{ path: '', message: 'Module manifest must be a JSON object.' }] }
  }

  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) {
    issues.push({ path: 'id', message: 'id must be lowercase (a–z, 0–9, hyphen), 1–63 chars.' })
  }
  if (typeof value.displayName !== 'string' || value.displayName.trim().length === 0) {
    issues.push({ path: 'displayName', message: 'displayName is required and must be a non-empty string.' })
  }
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1) {
    issues.push({ path: 'version', message: 'version must be a positive integer.' })
  }
  for (const key of ['publisher', 'category', 'summary'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      issues.push({ path: key, message: `${key} must be a string when present.` })
    }
  }
  if (value.defaultEnabled !== undefined && typeof value.defaultEnabled !== 'boolean') {
    issues.push({ path: 'defaultEnabled', message: 'defaultEnabled must be a boolean when present.' })
  }

  const dependsOn = validateStringArray(value.dependsOn, 'dependsOn', issues)
  const conflictsWith = validateStringArray(value.conflictsWith, 'conflictsWith', issues)

  const permissionResult = validateCapabilityPermissions(value.permissions)
  if (!permissionResult.ok) issues.push(...permissionResult.issues)

  const entry = validateEntry(value.entry, issues)
  const signature = validateSignature(value.signature, issues)

  if (issues.length > 0) return { ok: false, issues }

  // Force third-party provenance and strip core: a third-party module is never
  // a core/always-on module and never claims to be bundled.
  const manifest: CapabilityManifest = {
    id: value.id as string,
    displayName: (value.displayName as string).trim(),
    version: value.version as number,
    defaultEnabled: value.defaultEnabled === true,
    source: 'third-party',
    permissions: permissionResult.ok ? permissionResult.permissions : [],
  }
  if (typeof value.publisher === 'string') manifest.publisher = value.publisher
  if (typeof value.category === 'string') manifest.category = value.category
  if (typeof value.summary === 'string') manifest.summary = value.summary
  if (dependsOn && dependsOn.length > 0) manifest.dependsOn = dependsOn
  if (conflictsWith && conflictsWith.length > 0) manifest.conflictsWith = conflictsWith
  if (entry) manifest.entry = entry
  if (signature) manifest.signature = signature
  return { ok: true, manifest }
}

export function parseThirdPartyModuleManifest(source: string): ThirdPartyManifestResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: '', message: `Invalid JSON: ${error instanceof Error ? error.message : 'parse error'}.` }],
    }
  }
  return validateThirdPartyModuleManifest(parsed)
}

// The canonical byte payload a signature covers: the manifest with its own
// `signature` field removed, serialized with sorted keys so signer and verifier
// agree byte-for-byte regardless of property order. Signatures are computed
// over the VALIDATED manifest (the shape returned by
// validateThirdPartyModuleManifest), which is also what the app verifies.
export function canonicalManifestPayload(manifest: { signature?: ModuleSignature }): string {
  const { signature: _signature, ...rest } = manifest
  return canonicalJsonStringify(rest)
}

function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJsonStringify).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const entries = keys
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify((value as Record<string, unknown>)[key])}`)
  return `{${entries.join(',')}}`
}
