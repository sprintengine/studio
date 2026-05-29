// Tier 2 third-party capability modules: the permission vocabulary.
//
// A third-party module declares, in its manifest, the capabilities it needs. The
// list is shown to the user at install/trust time (a consent prompt) and is the
// contract the isolation runtime will enforce once it lands (utilityProcess +
// brokered channel — a later Phase 7 increment). This is deliberately separate
// from the BYO-CLI `permissionPresets` (which are opaque launch-arg bundles for a
// CLI, not capability scopes for code).
//
// See future-plans/2026-05-28-feature-level-pluggable-architecture.md (Phase 7).

export type CapabilityPermission =
  | 'filesystem:read-workspace'
  | 'filesystem:write-workspace'
  | 'filesystem:read-home'
  | 'process:spawn'
  | 'network'
  | 'ipc:invoke'
  // Extensible: unknown scopes validate structurally but are flagged as unknown
  // so the consent UI can warn rather than silently grant something opaque.
  | (string & {})

export const KNOWN_CAPABILITY_PERMISSIONS: readonly string[] = [
  'filesystem:read-workspace',
  'filesystem:write-workspace',
  'filesystem:read-home',
  'process:spawn',
  'network',
  'ipc:invoke',
]

// Plain, sentence-case descriptions for the install/trust consent prompt.
const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  'filesystem:read-workspace': 'Read files in the open workspace',
  'filesystem:write-workspace': 'Create and modify files in the open workspace',
  'filesystem:read-home': 'Read your Multicode configuration and home folder',
  'process:spawn': 'Run external programs on your machine',
  network: 'Make network requests',
  'ipc:invoke': "Call Multicode's internal APIs",
}

export function isKnownCapabilityPermission(value: string): boolean {
  return KNOWN_CAPABILITY_PERMISSIONS.includes(value)
}

// A human-readable line for the consent prompt; unknown scopes are surfaced
// verbatim with a marker so the user can see exactly what was requested.
export function describeCapabilityPermission(permission: string): string {
  return PERMISSION_DESCRIPTIONS[permission] ?? `Unrecognized capability: ${permission}`
}

export type PermissionValidationIssue = { path: string; message: string }

export type PermissionValidationResult =
  | { ok: true; permissions: CapabilityPermission[] }
  | { ok: false; issues: PermissionValidationIssue[] }

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
