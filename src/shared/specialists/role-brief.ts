/**
 * Role-brief helpers shared by the main-process file reader and the launch
 * prompt / host-context builders.
 *
 * A role is a SKILL.md whose frontmatter carries `metadata.sprintengine-role`.
 * The engine walks the same harness directories in this order (first hit wins).
 * The packaged workflow-roles tree is an install source, not a discovery layer:
 * a workspace with no installed role skills is a named missing-role error
 * (owner ruling 2026-09-08). Paths in launch copy are workspace-relative so the
 * CLI loads the skill the same way it loads any other workspace skill.
 */

/** Walk order matching sprintengine_core/role_registry.py. First hit wins. */
export const ROLE_HARNESS_DIRECTORIES: readonly string[] = [
  '.claude',
  '.agents',
  '.codex',
  '.cursor',
  '.gemini',
  '.opencode',
  '.grok',
]

export const ROLE_METADATA_KEY = 'sprintengine-role'

export {
  missingRoleMessage,
  NO_WORKFLOW_ROLES_REMEDIES as MISSING_ROLE_REMEDIES,
} from '../workflow-roles'

/** Hyphen and underscore spellings of a role id are the same name. */
export function normalizeRoleId(value: string): string {
  return value.trim().toLowerCase().replaceAll('-', '_')
}

/** Skill directories are kebab-case; role ids are snake_case. */
export function kebabRoleDirectory(roleId: string): string {
  return normalizeRoleId(roleId).replaceAll('_', '-')
}

/**
 * Conventional workspace path a specialist prompt names when discovery has not
 * yet resolved a file. The harness installs the pack into every skill
 * directory it finds; `.claude` is first in the walk, so this is the path a
 * freshly installed pack actually occupies.
 */
export function defaultWorkspaceRoleSkillRel(roleId: string): string {
  return `.claude/skills/${kebabRoleDirectory(roleId)}/SKILL.md`
}

/**
 * The Role section body for the host-context document. A pointer, not the
 * brief: the CLI loads the skill from the workspace; pasting the body would
 * duplicate it and would blow Codex's argv channel on Windows.
 */
export function buildRoleAssignmentText(roleId: string, skillRel: string): string {
  return [
    `You are acting as the \`${roleId}\` role for this session. Its brief is the`,
    `skill at \`${skillRel}\`; read it now and treat it as your`,
    'role, judgment and quality bar. Acknowledge briefly that you are ready in this',
    'role, then wait for the user\'s task.',
  ].join('\n')
}

/** The extra sentence an autonomous specialist launch keeps in the *prompt*. */
export const AUTONOMOUS_SPECIALIST_DIRECTIVE_LEAD =
  'Carry out the directive below in this role. Do not wait for further input — this is an autonomous run.'

/** Opening `---` fence, YAML, closing fence; remainder is the body. */
export function stripSkillFrontmatter(raw: string): string | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  return match ? match[2] : null
}
