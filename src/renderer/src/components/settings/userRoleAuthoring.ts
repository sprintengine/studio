// DOM-free view-model for the Settings -> Roles custom-role authoring form.
//
// All validation, id-collision detection, capability disclosure mapping, and the
// idle/validating/saving/saved/error state machine live here so they can be unit
// tested under the Node runner without rendering (mirroring extensionsInstalled.ts).
// The renderer holds the draft in component state, calls these pure helpers, and
// hands the resulting UserRoleSaveInput to the T2 save bridge.
//
// The single manifest validator (validateRoleManifest) stays canonical: this
// module assembles the authored input, runs it through buildAuthoredRoleManifest +
// validateRoleManifest, and maps the issue paths back onto form fields. Two checks
// the manifest validator does not own — an empty soul body and an id that collides
// with an already-registered role/alias — are enforced here so they surface inline
// before any write, exactly as the save service would reject them on disk.

import {
  buildAuthoredRoleManifest,
  isValidRoleId,
  roleIdCollision,
  starterSoulTemplate,
  validateRoleManifest,
  type RoleCapability,
  type RoleManifest,
  type RoleManifestValidationIssue,
  type UserRoleSaveInput,
} from '../../../../shared/sprintengine/role-manifest'

// Create seeds a fresh soul body; edit locks the id and prefills from the get
// bridge. The mode also gates id-collision (only meaningful when creating).
export type RoleAuthoringMode = { kind: 'create' } | { kind: 'edit'; id: string }

export type RoleCapabilityPhase = NonNullable<RoleCapability['phase']>

export const CAPABILITY_PHASES: readonly RoleCapabilityPhase[] = ['review', 'testing', 'product']

// The optional single review capability, disclosed behind a switch (default off
// per plan D4). When disabled no capability is emitted at all.
export type RoleCapabilityDraft = {
  enabled: boolean
  phase: RoleCapabilityPhase
  defaultFocus: string
}

// The editable form state. Aliases are a single free-text field parsed to an
// array on save; body is the SKILL.md soul document.
export type RoleAuthoringDraft = {
  id: string
  label: string
  summary: string
  aliasesText: string
  capability: RoleCapabilityDraft
  body: string
}

// Inline errors keyed by the form control they belong to. `form` carries any
// issue with no obvious field home (it should not normally appear, since soul is
// auto-assembled from the id).
export type RoleAuthoringFieldErrors = {
  id?: string
  label?: string
  aliases?: string
  capability?: string
  body?: string
  form?: string
}

export type RoleAuthoringValidation =
  | { ok: true; input: UserRoleSaveInput }
  | { ok: false; errors: RoleAuthoringFieldErrors }

export function emptyCapabilityDraft(): RoleCapabilityDraft {
  return { enabled: false, phase: 'review', defaultFocus: '' }
}

// A brand-new draft: the body is seeded with the starter soul template so the
// author edits a labelled scaffold rather than a blank textarea.
export function createRoleAuthoringDraft(): RoleAuthoringDraft {
  return {
    id: '',
    label: '',
    summary: '',
    aliasesText: '',
    capability: emptyCapabilityDraft(),
    body: starterSoulTemplate(''),
  }
}

// Prefill a draft from an existing user-authored role (manifest + SKILL.md body)
// for editing. The id is preserved verbatim and the caller keeps it locked.
export function editRoleAuthoringDraft(manifest: RoleManifest, body: string): RoleAuthoringDraft {
  const capability = manifest.capabilities?.[0]
  return {
    id: manifest.id,
    label: manifest.label,
    summary: manifest.summary ?? '',
    aliasesText: (manifest.aliases ?? []).join(', '),
    capability: capability
      ? { enabled: true, phase: capability.phase ?? 'review', defaultFocus: capability.defaultFocus ?? '' }
      : emptyCapabilityDraft(),
    body,
  }
}

// Split the aliases free-text field on commas/whitespace into trimmed entries.
export function parseAliasesText(text: string): string[] {
  return text
    .split(/[\s,]+/u)
    .map((alias) => alias.trim())
    .filter(Boolean)
}

// Assemble the save payload from the draft, omitting empty optional fields so the
// serialized manifest stays minimal. Mirrors buildAuthoredRoleManifest's
// omit-when-absent shape, plus the body the save service writes to SKILL.md.
export function toUserRoleSaveInput(draft: RoleAuthoringDraft): UserRoleSaveInput {
  const input: UserRoleSaveInput = {
    id: draft.id.trim(),
    label: draft.label.trim(),
    body: draft.body,
  }
  const summary = draft.summary.trim()
  if (summary) input.summary = summary
  const aliases = parseAliasesText(draft.aliasesText)
  if (aliases.length > 0) input.aliases = aliases
  if (draft.capability.enabled) {
    input.capability = { phase: draft.capability.phase }
    const focus = draft.capability.defaultFocus.trim()
    if (focus) input.capability.defaultFocus = focus
  }
  return input
}

function fieldForIssuePath(path: string): keyof RoleAuthoringFieldErrors {
  if (path === 'id') return 'id'
  if (path === 'label') return 'label'
  if (path.startsWith('aliases')) return 'aliases'
  if (path.startsWith('capabilities')) return 'capability'
  if (path === 'body') return 'body'
  return 'form'
}

// Fold manifest validation issues onto form fields, keeping the first message per
// field (the form shows one message per control).
export function mapIssuesToFieldErrors(
  issues: readonly RoleManifestValidationIssue[],
): RoleAuthoringFieldErrors {
  const errors: RoleAuthoringFieldErrors = {}
  for (const issue of issues) {
    const field = fieldForIssuePath(issue.path)
    if (!errors[field]) errors[field] = issue.message
  }
  return errors
}

// Validate a draft fully before any write. Runs the assembled manifest through
// the canonical validator, then layers the two write-blocking checks the
// validator does not own: a non-empty soul body, and (create mode only) an id
// that does not collide with an already-registered role id or alias.
export function validateRoleAuthoringDraft(
  draft: RoleAuthoringDraft,
  context: { mode: RoleAuthoringMode; existingIdsAndAliases: Iterable<string> },
): RoleAuthoringValidation {
  const input = toUserRoleSaveInput(draft)
  const errors: RoleAuthoringFieldErrors = {}

  const manifestResult = validateRoleManifest(buildAuthoredRoleManifest(input))
  if (!manifestResult.ok) {
    Object.assign(errors, mapIssuesToFieldErrors(manifestResult.issues))
  }

  if (input.body.trim().length === 0) {
    errors.body = 'Soul body is required; describe what this role does.'
  }

  // Edit locks the id, so a collision can only be authored when creating.
  if (context.mode.kind === 'create' && isValidRoleId(input.id) && !errors.id) {
    if (roleIdCollision(input.id, context.existingIdsAndAliases)) {
      errors.id = `A role or alias named "${input.id}" already exists. Choose a different id.`
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, input }
}

// Save lifecycle. The component dispatches events as it drives validation and the
// async save; the reducer keeps the surface a single discriminated union so the
// renderer renders one settled state at a time.
export type RoleAuthoringStatus =
  | { status: 'idle' }
  | { status: 'validating' }
  | { status: 'saving' }
  | { status: 'saved'; id: string }
  | { status: 'error'; errors: RoleAuthoringFieldErrors }

export type RoleAuthoringEvent =
  | { type: 'submit' }
  | { type: 'invalid'; errors: RoleAuthoringFieldErrors }
  | { type: 'valid' }
  | { type: 'saved'; id: string }
  | { type: 'failed'; errors: RoleAuthoringFieldErrors }
  | { type: 'reset' }

export const idleAuthoringStatus: RoleAuthoringStatus = { status: 'idle' }

export function authoringStatusReducer(
  state: RoleAuthoringStatus,
  event: RoleAuthoringEvent,
): RoleAuthoringStatus {
  switch (event.type) {
    case 'submit':
      // A re-entrant submit while a save is in flight is ignored; otherwise any
      // settled state begins a fresh validation pass.
      return state.status === 'saving' ? state : { status: 'validating' }
    case 'invalid':
      return state.status === 'validating' ? { status: 'error', errors: event.errors } : state
    case 'valid':
      return state.status === 'validating' ? { status: 'saving' } : state
    case 'saved':
      return state.status === 'saving' ? { status: 'saved', id: event.id } : state
    case 'failed':
      return state.status === 'saving' ? { status: 'error', errors: event.errors } : state
    case 'reset':
      return idleAuthoringStatus
    default:
      return state
  }
}

// The form is busy (Save disabled, controls locked) during validation and save.
export function isAuthoringBusy(status: RoleAuthoringStatus): boolean {
  return status.status === 'validating' || status.status === 'saving'
}

// Inline field errors to render, empty unless the lifecycle settled on error.
export function authoringFieldErrors(status: RoleAuthoringStatus): RoleAuthoringFieldErrors {
  return status.status === 'error' ? status.errors : {}
}
