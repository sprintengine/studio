import { STUDIO_SKILL_SOURCE_NAME } from './skills'

/**
 * The plus-menu item that adds a folder on this machine as a skill source.
 * Quoted by the empty-pack error, so the two cannot drift: a test asserts the
 * menu renders this same constant.
 *
 * The control opens a folder picker. The previous "Add from file…" copy named
 * the wrong object (owner ruling 2026-09-08).
 */
export const ADD_LOCAL_SKILL_SOURCE_LABEL = 'Add from folder…'

/**
 * The skill-page accent that copies a catalogue skill into this workspace.
 * Quoted by the empty-pack error, so the two cannot drift: a test asserts the
 * page renders this same constant.
 */
export const INSTALL_SKILL_LABEL = 'Install skill'

/** Plugin id of the published workflow-roles pack. */
export const WORKFLOW_ROLES_PACK_ID = 'workflow-roles'

/**
 * Display form of the default user skills folder named by the empty-pack error.
 * The real directory is `$HOME/.multicode/skills` (or `%USERPROFILE%\.multicode\skills`
 * on Windows); this string is what surfaces quote, so it stays the same on every
 * picker.
 */
export const DEFAULT_USER_SKILLS_DIR_DISPLAY = '~/.multicode/skills'

export const NO_WORKFLOW_ROLES_HEAD = 'No workflow roles are installed.'

export const NO_WORKFLOW_ROLES_REMEDIES = `Install the ${WORKFLOW_ROLES_PACK_ID} pack from the ${STUDIO_SKILL_SOURCE_NAME} skill source, or put your own role skills in your skills folder (${DEFAULT_USER_SKILLS_DIR_DISPLAY}) — add or change it under Extensions → Skills → "${ADD_LOCAL_SKILL_SOURCE_LABEL}", then "${INSTALL_SKILL_LABEL}" into this workspace.`

/** Exact empty-pack error, the same on every desktop picker. */
export const NO_WORKFLOW_ROLES_INSTALLED_MESSAGE = `${NO_WORKFLOW_ROLES_HEAD} ${NO_WORKFLOW_ROLES_REMEDIES}`

/** Phone cannot install a pack; it points at the desktop. */
export const NO_WORKFLOW_ROLES_INSTALLED_ON_DESKTOP_MESSAGE =
  `No workflow roles are installed. Install the ${WORKFLOW_ROLES_PACK_ID} pack from the ${STUDIO_SKILL_SOURCE_NAME} skill source on the desktop.`

export function missingRoleMessage(roleId: string, knownRoles: readonly string[] = []): string {
  const requested = roleId.trim() || roleId
  if (knownRoles.length === 0) {
    return `Unknown role '${requested}': no workflow roles are installed in this workspace. ${NO_WORKFLOW_ROLES_REMEDIES}`
  }
  return (
    `Unknown role '${requested}': no skill declaring it is installed in this workspace. ` +
    `${NO_WORKFLOW_ROLES_REMEDIES} Known roles: ${[...knownRoles].sort().join(', ')}.`
  )
}

export function workflowRolesInstalled(
  registry: { roles?: Record<string, { source?: { layer?: string } }> } | null | undefined,
): boolean {
  if (!registry?.roles) return false
  return Object.values(registry.roles).some((role) => role.source?.layer !== 'bundled')
}
