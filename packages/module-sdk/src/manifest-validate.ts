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

import type {
  CapabilityManifest,
  CapabilityPermission,
  ModuleEntry,
  ModuleFileDigests,
  ModuleSignature,
} from './index.js'
import type { HostCapability } from './host-api.js'

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

// ── Code digests (`files`) ──────────────────────────────────────────────────
// `files` sits inside the canonical payload like any other field, which is what
// makes a signature cover the code; a manifest without it keeps the exact
// payload it was signed over before the field existed.

// The file a module's digests can never cover: it carries them, so hashing it
// would make the signature depend on its own output.
export const MODULE_MANIFEST_FILENAME = 'manifest.json'

// Paths `sprintengine-module pack` never ships: dependency trees, version
// control and key material. Signing leaves them out for the same reason, so a
// packed copy digests exactly as its source did — and an installed module that
// has one of them was not installed from a pack. Shared with the plugin bundle
// digest walk, which refuses the same paths.
export function isPackExcludedPath(path: string): boolean {
  const segments = path.split('/')
  const name = segments[segments.length - 1] ?? ''
  return (
    segments.includes('node_modules') || segments.includes('.git') || name.endsWith('.key') || name.endsWith('.pem')
  )
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

export type ModuleFileDigestsValidation =
  { ok: true; files: ModuleFileDigests } | { ok: false; issues: ThirdPartyManifestIssue[] }

// Validate a manifest's `files` map. Every key is a path a module folder could
// really hold and the app could really load: relative, inside the root, not
// manifest.json, not a path pack leaves out. The result is re-keyed in sorted
// order so the written manifest reads the same however it was produced.
export function validateModuleFileDigests(value: unknown, path = 'files'): ModuleFileDigestsValidation {
  if (!isObject(value)) {
    return { ok: false, issues: [{ path, message: `${path} must be an object of relative path → sha256 hex.` }] }
  }
  const issues: ThirdPartyManifestIssue[] = []
  const files: ModuleFileDigests = {}
  for (const key of Object.keys(value).sort()) {
    const digest = value[key]
    const entryPath = `${path}.${key}`
    if (!isSafeManifestRelativePath(key)) {
      issues.push({
        path: entryPath,
        message: 'must be a safe relative path inside the module (no absolute paths or "..").',
      })
    } else if (key === MODULE_MANIFEST_FILENAME) {
      issues.push({ path: entryPath, message: 'manifest.json cannot list a digest of itself.' })
    } else if (isPackExcludedPath(key)) {
      issues.push({ path: entryPath, message: 'node_modules, .git and key files are never part of a module.' })
    } else if (!isSha256Hex(digest)) {
      issues.push({ path: entryPath, message: 'must be a lowercase 64-character sha256 hex digest.' })
    } else {
      files[key] = digest
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, files }
}

// Exact-set comparison of the digests a module is held to against the ones
// its folder has now. A listed file that is missing or changed, and a file
// that is there but not listed, are all mismatches: an unlisted file is code
// the listed code can load without anybody having vouched for it.
export function compareModuleFileDigests(
  expected: ModuleFileDigests,
  actual: ModuleFileDigests,
  label = 'signed digests',
): ThirdPartyManifestIssue[] {
  const issues: ThirdPartyManifestIssue[] = []
  for (const path of Object.keys(expected).sort()) {
    const digest = actual[path]
    if (digest === undefined) {
      issues.push({ path: `files.${path}`, message: `listed in the ${label} but missing.` })
    } else if (digest !== expected[path]) {
      issues.push({ path: `files.${path}`, message: `does not match the ${label}.` })
    }
  }
  for (const path of Object.keys(actual).sort()) {
    if (expected[path] === undefined) {
      issues.push({ path: `files.${path}`, message: `is not listed in the ${label}.` })
    }
  }
  return issues
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

// `engines.hostApi` is checked for shape here and signed with the rest of the
// manifest. Whether a module may omit it is the host's call, not the
// validator's (checkHostApiCompatibility in host-api.ts): this validator also
// reads plugin bundle manifests and registry entries, which carry no host API.
function validateEngines(value: unknown, issues: ThirdPartyManifestIssue[]): { hostApi: number } | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) {
    issues.push({ path: 'engines', message: 'engines must be an object.' })
    return undefined
  }
  for (const key of Object.keys(value)) {
    if (key !== 'hostApi') issues.push({ path: `engines.${key}`, message: 'unsupported engines field.' })
  }
  const hostApi = value.hostApi
  if (typeof hostApi !== 'number' || !Number.isInteger(hostApi) || hostApi < 1) {
    issues.push({ path: 'engines.hostApi', message: 'engines.hostApi must be a positive integer.' })
    return undefined
  }
  return { hostApi }
}

// `requires.hostCapabilities`: names a module's main half cannot run without
// (today only `electron-main`). Unknown names are kept, not refused: a host
// that does not know a name does not support it, which is the answer the
// module needs.
function validateRequires(
  value: unknown,
  issues: ThirdPartyManifestIssue[],
): { hostCapabilities?: HostCapability[] } | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) {
    issues.push({ path: 'requires', message: 'requires must be an object.' })
    return undefined
  }
  for (const key of Object.keys(value)) {
    if (key !== 'hostCapabilities') issues.push({ path: `requires.${key}`, message: 'unsupported requires field.' })
  }
  const hostCapabilities = validateStringArray(value.hostCapabilities, 'requires.hostCapabilities', issues)
  return hostCapabilities && hostCapabilities.length > 0 ? { hostCapabilities } : undefined
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
  let files: ModuleFileDigests | undefined
  if (value.files !== undefined) {
    const filesResult = validateModuleFileDigests(value.files)
    if (filesResult.ok) files = filesResult.files
    else issues.push(...filesResult.issues)
  }
  const signature = validateSignature(value.signature, issues)
  const engines = validateEngines(value.engines, issues)
  const requires = validateRequires(value.requires, issues)

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
  if (engines) manifest.engines = engines
  if (requires) manifest.requires = requires
  if (entry) manifest.entry = entry
  if (files) manifest.files = files
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
