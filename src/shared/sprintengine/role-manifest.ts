// Tier 1 third-party contribution: declarative Sprint Engine role manifests.
//
// A role manifest is pure data — an id, a display label, and a "soul" composed
// of referenced skill ids. Nothing here is executed; the Sprint Engine runtime
// reads these to assemble an agent's prompt from the named skills. That's what
// makes a third-party role safe to install with zero code-execution risk (the
// Tier 1 stance in future-plans/2026-05-28-feature-level-pluggable-architecture.md).
//
// This validator mirrors the hand-rolled style of plugin-manifest-validate.ts
// (the repo has no JSON-schema runtime); resources/sprintengine/role-manifest.schema.json
// is the human/marketplace-facing schema kept in sync with these types.

export type RoleSoulEntry = { skill: string }

export type RoleCapability = {
  kind: 'review'
  phase?: 'review' | 'testing' | 'product'
  reviews?: string[]
  defaultFocus?: string
}

export type RoleManifest = {
  id: string
  label: string
  summary?: string
  aliases?: string[]
  soul: RoleSoulEntry[]
  capabilities?: RoleCapability[]
}

export type RoleManifestValidationIssue = { path: string; message: string }

export type RoleManifestValidationResult =
  | { ok: true; manifest: RoleManifest }
  | { ok: false; issues: RoleManifestValidationIssue[] }

// snake_case ids (architect, code_reviewer). Aliases additionally allow hyphens
// (code-reviewer). Bounded length so a manifest can't carry pathological keys.
const ID_PATTERN = /^[a-z][a-z0-9_]{0,62}$/
const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/
const REVIEW_TARGET_PATTERN = /^[a-z][a-z0-9_]{0,62}$/
const PHASES = ['review', 'testing', 'product'] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateRoleManifest(value: unknown): RoleManifestValidationResult {
  const issues: RoleManifestValidationIssue[] = []
  if (!isObject(value)) {
    return { ok: false, issues: [{ path: '', message: 'Role manifest must be a JSON object.' }] }
  }

  const id = value.id
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    issues.push({
      path: 'id',
      message: 'id must be lowercase snake_case (a–z, 0–9, underscore), 1–63 chars.',
    })
  }

  if (typeof value.label !== 'string' || value.label.trim().length === 0) {
    issues.push({ path: 'label', message: 'label is required and must be a non-empty string.' })
  }

  if ('summary' in value && value.summary !== undefined && typeof value.summary !== 'string') {
    issues.push({ path: 'summary', message: 'summary must be a string when present.' })
  }

  if ('aliases' in value && value.aliases !== undefined) {
    if (!Array.isArray(value.aliases)) {
      issues.push({ path: 'aliases', message: 'aliases must be an array of strings.' })
    } else {
      value.aliases.forEach((alias, index) => {
        if (typeof alias !== 'string' || !ALIAS_PATTERN.test(alias)) {
          issues.push({
            path: `aliases[${index}]`,
            message: 'alias must be lowercase (a–z, 0–9, underscore, hyphen), 1–63 chars.',
          })
        }
      })
    }
  }

  if (!Array.isArray(value.soul) || value.soul.length === 0) {
    issues.push({ path: 'soul', message: 'soul must be a non-empty array of { "skill": id } entries.' })
  } else {
    value.soul.forEach((entry, index) => {
      if (!isObject(entry) || typeof entry.skill !== 'string' || !ID_PATTERN.test(entry.skill)) {
        issues.push({
          path: `soul[${index}].skill`,
          message: 'each soul entry must be { "skill": "<snake_case id>" }.',
        })
      }
    })
  }

  if ('capabilities' in value && value.capabilities !== undefined) {
    if (!Array.isArray(value.capabilities)) {
      issues.push({ path: 'capabilities', message: 'capabilities must be an array of capability objects.' })
    } else {
      value.capabilities.forEach((capability, index) => {
        if (!isObject(capability)) {
          issues.push({ path: `capabilities[${index}]`, message: 'capability must be an object.' })
          return
        }
        const keys = Object.keys(capability)
        const allowedKeys = new Set(['kind', 'phase', 'reviews', 'defaultFocus'])
        const unsupported = keys.find((key) => !allowedKeys.has(key))
        if (unsupported) {
          issues.push({ path: `capabilities[${index}].${unsupported}`, message: 'unsupported capability field.' })
        }
        if (capability.kind !== 'review') {
          issues.push({ path: `capabilities[${index}].kind`, message: 'capability kind must be "review".' })
        }
        if ('phase' in capability && capability.phase !== undefined && !PHASES.includes(capability.phase as typeof PHASES[number])) {
          issues.push({ path: `capabilities[${index}].phase`, message: 'phase must be review, testing, or product.' })
        }
        if ('reviews' in capability && capability.reviews !== undefined) {
          if (!Array.isArray(capability.reviews)) {
            issues.push({ path: `capabilities[${index}].reviews`, message: 'reviews must be an array of ids.' })
          } else {
            capability.reviews.forEach((review, reviewIndex) => {
              if (typeof review !== 'string' || !REVIEW_TARGET_PATTERN.test(review)) {
                issues.push({
                  path: `capabilities[${index}].reviews[${reviewIndex}]`,
                  message: 'review target must be lowercase snake_case, 1-63 chars.',
                })
              }
            })
          }
        }
        if ('defaultFocus' in capability && capability.defaultFocus !== undefined && typeof capability.defaultFocus !== 'string') {
          issues.push({ path: `capabilities[${index}].defaultFocus`, message: 'defaultFocus must be a string.' })
        }
      })
    }
  }

  if (issues.length > 0) return { ok: false, issues }

  const manifest: RoleManifest = {
    id: id as string,
    label: (value.label as string).trim(),
    soul: (value.soul as RoleSoulEntry[]).map((entry) => ({ skill: entry.skill })),
  }
  if (typeof value.summary === 'string') manifest.summary = value.summary
  if (Array.isArray(value.aliases)) manifest.aliases = value.aliases as string[]
  if (Array.isArray(value.capabilities)) {
    manifest.capabilities = value.capabilities.map((capability) => {
      const record = capability as Record<string, unknown>
      const normalized: RoleCapability = { kind: 'review' }
      if (typeof record.phase === 'string') normalized.phase = record.phase as RoleCapability['phase']
      if (Array.isArray(record.reviews)) normalized.reviews = record.reviews as string[]
      if (typeof record.defaultFocus === 'string') normalized.defaultFocus = record.defaultFocus
      return normalized
    })
  }
  return { ok: true, manifest }
}

// Role-registry IPC contracts (shared so the preload/electron-api surface can
// reference them without importing main-process code).
export type RoleRegistryRejection = { path: string; issues: RoleManifestValidationIssue[] }

export type UserRoleListResult = {
  roles: Array<Pick<RoleManifest, 'id' | 'label' | 'summary'>>
  rejected: RoleRegistryRejection[]
}

export type RoleInstallResult = {
  ok: boolean
  installedRoles: string[]
  installedSkills: string[]
  rejected: RoleRegistryRejection[]
  message?: string
}

export function parseRoleManifest(source: string): RoleManifestValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: '', message: `Invalid JSON: ${error instanceof Error ? error.message : 'parse error'}.` }],
    }
  }
  return validateRoleManifest(parsed)
}
