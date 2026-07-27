// Tier 1 third-party contribution: declarative Sprint Engine role manifests.
//
// A role manifest is pure data — an id, a display label, and directive packs of
// referenced skill ids. Nothing here is executed; the Sprint Engine runtime
// reads these to assemble an agent's prompt from the named skills. That's what
// makes a third-party role safe to install with zero code-execution risk (the
// Tier 1 stance in future-plans/2026-05-28-feature-level-pluggable-architecture.md).
//
// v2 schema (MC-1542): a role is routing + directive packs. `directives.implement`
// composes the owner's startup brief (this replaced `soul`); `directives.<phase>`
// adds role-scoped content to that phase's shared base pack. `soul` and
// `capabilities` are rejected by name.
//
// MC-1831: a role's capabilities are prose. `description` says what the role
// does and when to staff it, the architect reads it verbatim when planning, and
// no engine behaviour is derived from it. Write one for every role; it is
// optional here only so a manifest predating the field still loads (its
// one-line predecessor `summary` is ignored).
//
// This validator mirrors sprintengine_core/role_registry.py and the hand-rolled
// style of plugin-manifest-validate.ts (the repo has no JSON-schema runtime);
// resources/sprintengine/role-manifest.schema.json is the human/marketplace-facing
// schema kept in sync with these types.

export type RoleDirectiveEntry = { skill: string }

// Shipped post-implementation phase vocabulary. Keyed maps, so a future phase
// slots in without a schema change.
export const DIRECTIVE_PHASES = ['review'] as const
export type RoleDirectivePhase = (typeof DIRECTIVE_PHASES)[number]

export type RoleDirectives = { implement: RoleDirectiveEntry[] } & Partial<
  Record<RoleDirectivePhase, RoleDirectiveEntry[]>
>

export type RoleManifest = {
  id: string
  label: string
  // The role's whole capability statement, in prose (MC-1831): what it does and
  // when to staff it. The architect reads it verbatim when planning; nothing
  // derives behaviour from its text, and there are no capability flags. Absent
  // only for a manifest written before the field existed, which still loads.
  description?: string
  aliases?: string[]
  directives: RoleDirectives
}

// The authoring surface (renderer form -> main install path) collects one
// authored skill per role, so `directives.implement` is always [{ skill: id }].
// buildAuthoredRoleManifest below turns this into a RoleManifest;
// validateRoleManifest stays the one validator.
export type AuthoredRoleInput = {
  id: string
  label: string
  description: string
  aliases?: string[]
}

export type RoleManifestValidationIssue = { path: string; message: string }

export type RoleManifestValidationResult =
  | { ok: true; manifest: RoleManifest }
  | { ok: false; issues: RoleManifestValidationIssue[] }

// snake_case ids (architect, production_readiness_reviewer). Aliases additionally
// allow hyphens (ui-ux-review). Bounded length so a manifest can't carry pathological keys.
const ID_PATTERN = /^[a-z][a-z0-9_]{0,62}$/
const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/
const DIRECTIVE_KEYS = ['implement', ...DIRECTIVE_PHASES] as const

// Keys removed by earlier manifest revisions. Rejected by name so a stale pack
// fails loudly with its replacement named, rather than silently losing meaning.
const REMOVED_MANIFEST_KEYS: Record<string, string> = {
  soul: `'soul' was removed in the v2 role manifest. Use "directives": { "implement": [{ "skill": "<id>" }] }.`,
  capabilities: `'capabilities' was removed in the v2 role manifest. Review-only roles no longer exist: a reviewer is an ordinary implementer, and role-scoped review content goes in "directives": { "review": [{ "skill": "<id>" }] }.`,
}

// `summary` (MC-1831's renamed predecessor of `description`) is deliberately NOT
// listed above: an installed pack predating the rename must keep loading. It is
// ignored here and warned about by the engine's discovery
// (RENAMED_MANIFEST_KEYS in role_registry.py); re-saving a role through the
// authoring form drops it and writes a `description`.

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A directive list: non-empty array of exactly-{ skill } objects. Pushes issues
// under `directives.<key>` so a malformed pack points at the offending entry.
function validateDirectiveEntries(
  value: unknown,
  key: string,
  issues: RoleManifestValidationIssue[]
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({
      path: `directives.${key}`,
      message: `directives.${key} must be a non-empty array of { "skill": id } entries.`,
    })
    return
  }
  value.forEach((entry, index) => {
    const keys = isObject(entry) ? Object.keys(entry) : []
    if (!isObject(entry) || keys.length !== 1 || typeof entry.skill !== 'string' || !ID_PATTERN.test(entry.skill)) {
      issues.push({
        path: `directives.${key}[${index}].skill`,
        message: 'each directive entry must be { "skill": "<snake_case id>" }.',
      })
    }
  })
}

function validateDirectives(value: unknown, issues: RoleManifestValidationIssue[]): void {
  if (!isObject(value) || Object.keys(value).length === 0) {
    issues.push({
      path: 'directives',
      message: 'directives must be an object with a non-empty "implement" list.',
    })
    return
  }
  const unsupported = Object.keys(value).find((key) => !(DIRECTIVE_KEYS as readonly string[]).includes(key))
  if (unsupported) {
    issues.push({
      path: `directives.${unsupported}`,
      message: `unsupported directive key; expected one of: ${DIRECTIVE_KEYS.join(', ')}.`,
    })
  }
  if (!('implement' in value)) {
    issues.push({ path: 'directives.implement', message: 'directives.implement is required.' })
  }
  for (const key of DIRECTIVE_KEYS) {
    if (key in value) validateDirectiveEntries(value[key], key, issues)
  }
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

  if ('description' in value && value.description !== undefined) {
    if (typeof value.description !== 'string' || value.description.trim().length === 0) {
      issues.push({
        path: 'description',
        message: 'description must be non-empty prose: what this role does and when a sprint should staff it.',
      })
    }
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

  for (const [removedKey, guidance] of Object.entries(REMOVED_MANIFEST_KEYS)) {
    if (removedKey in value) issues.push({ path: removedKey, message: guidance })
  }

  validateDirectives(value.directives, issues)

  if (issues.length > 0) return { ok: false, issues }

  const rawDirectives = value.directives as Record<string, RoleDirectiveEntry[]>
  const directives = { implement: rawDirectives.implement.map((entry) => ({ skill: entry.skill })) } as RoleDirectives
  for (const phase of DIRECTIVE_PHASES) {
    const entries = rawDirectives[phase]
    if (entries) directives[phase] = entries.map((entry) => ({ skill: entry.skill }))
  }

  const manifest: RoleManifest = {
    id: id as string,
    label: (value.label as string).trim(),
    directives,
  }
  if (typeof value.description === 'string') manifest.description = value.description.trim()
  if (Array.isArray(value.aliases)) manifest.aliases = value.aliases as string[]
  return { ok: true, manifest }
}

// Role-registry IPC contracts (shared so the preload/electron-api surface can
// reference them without importing main-process code).
export type RoleRegistryRejection = { path: string; issues: RoleManifestValidationIssue[] }

export type UserRoleListResult = {
  roles: Array<Pick<RoleManifest, 'id' | 'label' | 'description'>>
  rejected: RoleRegistryRejection[]
}

export type RoleInstallResult = {
  ok: boolean
  installedRoles: string[]
  installedSkills: string[]
  rejected: RoleRegistryRejection[]
  message?: string
}

// Authoring service IPC contracts (save/delete/get a single user-authored role).
// Shared here, next to the install contracts, so preload and electron-api can
// reference them without importing main-process code.
export type UserRoleSaveInput = AuthoredRoleInput & { body: string }

export type UserRoleSaveResult = {
  ok: boolean
  id?: string
  issues?: RoleManifestValidationIssue[]
}

export type UserRoleDeleteResult = { ok: boolean }

export type UserRoleGetResult =
  | { ok: true; manifest: RoleManifest; body: string }
  | { ok: false; issues?: RoleManifestValidationIssue[] }

// Exposed so the install/authoring path can reject an unsafe id (path traversal)
// before any filesystem work, using the same pattern validateRoleManifest enforces.
export function isValidRoleId(id: string): boolean {
  return ID_PATTERN.test(id)
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

// Canonical on-disk form for a role manifest: pretty-printed JSON (2-space
// indent) with a trailing newline, matching the on-disk role-manifest shape
// (e.g. resources/specialist-pack/roles/*.json). Round-trips through parseRoleManifest.
export function serializeRoleManifest(manifest: RoleManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

// Assemble a RoleManifest from the authoring form. `directives.implement` is
// fixed to the single authored skill (id == role id); baseline skills are layered
// later at spawn by sprintengine_core/skill_layers.py, not stored here. Optional
// fields are omitted (not emitted as null/empty) when absent so the serialized
// manifest stays minimal. The result still flows through validateRoleManifest at
// install.
export function buildAuthoredRoleManifest(input: AuthoredRoleInput): RoleManifest {
  const manifest: RoleManifest = {
    id: input.id,
    label: input.label,
    directives: { implement: [{ skill: input.id }] },
  }
  const description = input.description.trim()
  if (description) manifest.description = description
  const aliases = input.aliases?.filter((alias) => alias.trim().length > 0)
  if (aliases && aliases.length > 0) manifest.aliases = aliases
  return manifest
}

// Seed text for a brand-new authored soul. The runtime reads the <what-to-do>
// block as the mandatory core and <supporting-info> as reference detail (see the
// soul-legend the composer wraps these in), so the scaffold gives authors both
// sections pre-labelled with their role name to fill in.
export function starterSoulTemplate(roleLabel: string): string {
  const label = roleLabel.trim() || 'this role'
  return `<what-to-do>

# Role

You are ${label}, a specialist agent in a Sprint Engine team. Replace this line with one or two sentences naming ${label}'s mandate and where it fits in the team.

# Core Principles

- State the non-negotiable behaviours ${label} must always follow.
- Keep work scoped to what the task asks for; do not expand beyond it.
- Prefer correctness over speed, and verify before claiming work is done.

</what-to-do>

<supporting-info>

# How ${label} Works

- Document the conventions, edge cases, and reference detail ${label} should consult when the work touches them.
- Replace this scaffold with the real guidance for the role before relying on it.

</supporting-info>
`
}

// True when a candidate role id would collide with an already-registered id or
// alias. Ids and aliases are lowercase, so the comparison is case-sensitive.
// Pass the union of existing ids and aliases as the second argument.
export function roleIdCollision(candidateId: string, existingIdsAndAliases: Iterable<string>): boolean {
  return new Set(existingIdsAndAliases).has(candidateId)
}
