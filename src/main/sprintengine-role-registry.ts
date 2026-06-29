import { cp, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join, resolve, sep } from 'path'

import {
  buildAuthoredRoleManifest,
  isValidRoleId,
  parseRoleManifest,
  serializeRoleManifest,
  validateRoleManifest,
  type RoleInstallResult,
  type RoleRegistryRejection,
  type UserRoleDeleteResult,
  type UserRoleGetResult,
  type UserRoleListResult,
  type UserRoleSaveInput,
  type UserRoleSaveResult,
} from '../shared/sprintengine/role-manifest'

// User-global Sprint Engine role registry: third-party declarative roles the
// user installs once and gets in every workspace. Roles live under
// <root>/roles/*.json and their skills under <root>/skills/<id>/SKILL.md — the
// same shape the bundled registry and a plugin's souls directory use, so the
// existing MCP discovery enumerates them once the root is added to its search
// path (see sprintengine-artifacts.ts). This module owns validation (Tier 1:
// reject malformed manifests, copy nothing executable) and install.

export function defaultUserRoleRegistryRoot(): string {
  return join(homedir(), '.multicode', 'sprintengine-roles')
}

export type {
  RoleInstallResult,
  UserRoleDeleteResult,
  UserRoleGetResult,
  UserRoleListResult,
  UserRoleSaveInput,
  UserRoleSaveResult,
} from '../shared/sprintengine/role-manifest'

// Resolve the on-disk targets for an authored role, rejecting any id that fails
// the manifest id regex or whose basename differs (a traversal attempt), and
// double-checking the resolved paths stay under the registry root. Returns null
// on rejection so callers can bail before touching the filesystem.
function safeRoleTargets(root: string, id: string): { roleFile: string; skillDir: string } | null {
  if (!isValidRoleId(id) || basename(id) !== id) return null
  const rootResolved = resolve(root)
  const roleFile = resolve(rootResolved, 'roles', `${id}.json`)
  const skillDir = resolve(rootResolved, 'skills', id)
  const prefix = rootResolved + sep
  if (!roleFile.startsWith(prefix) || !skillDir.startsWith(prefix)) return null
  return { roleFile, skillDir }
}

async function readDirSafe(dir: string): Promise<import('fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function isJsonFile(name: string): boolean {
  return name.toLowerCase().endsWith('.json')
}

// Resolve a selected folder into role-manifest files and skill directories.
// Accepts either a registry folder (with roles/ and/or skills/ subdirs) or a
// bare roles folder of *.json. Mirrors the renderer's per-workspace resolver.
export async function resolveRoleInstallTargets(
  srcDir: string
): Promise<{ roleFiles: string[]; skillDirs: string[] }> {
  const entries = await readDirSafe(srcDir)
  const hasRolesDir = entries.some((entry) => entry.isDirectory() && entry.name === 'roles')
  const hasSkillsDir = entries.some((entry) => entry.isDirectory() && entry.name === 'skills')

  if (hasRolesDir || hasSkillsDir) {
    const roleFiles: string[] = []
    const skillDirs: string[] = []
    if (hasRolesDir) {
      const rolesPath = join(srcDir, 'roles')
      for (const entry of await readDirSafe(rolesPath)) {
        if (!entry.isDirectory() && isJsonFile(entry.name)) roleFiles.push(join(rolesPath, entry.name))
      }
    }
    if (hasSkillsDir) {
      const skillsPath = join(srcDir, 'skills')
      for (const entry of await readDirSafe(skillsPath)) {
        if (entry.isDirectory()) skillDirs.push(join(skillsPath, entry.name))
      }
    }
    if (roleFiles.length > 0 || skillDirs.length > 0) return { roleFiles, skillDirs }
  }

  // Bare folder: top-level *.json are roles; top-level directories are skills.
  const roleFiles = entries
    .filter((entry) => !entry.isDirectory() && isJsonFile(entry.name))
    .map((entry) => join(srcDir, entry.name))
  const skillDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.toLowerCase() !== 'skills')
    .map((entry) => join(srcDir, entry.name))
  return { roleFiles, skillDirs }
}

// Validate and copy a selected folder's roles + skills into the user-global
// registry root. Malformed role manifests are rejected (not copied); valid roles
// and all skill directories are copied. Skills are markdown prompt context, not
// code, so they're copied as-is.
export async function installRoleFolder(srcDir: string, root: string): Promise<RoleInstallResult> {
  const { roleFiles, skillDirs } = await resolveRoleInstallTargets(srcDir)
  if (roleFiles.length === 0 && skillDirs.length === 0) {
    return {
      ok: false,
      installedRoles: [],
      installedSkills: [],
      rejected: [],
      message: 'No role manifests or skill folders found. Select a folder with roles/ and skills/ subfolders.',
    }
  }

  const rolesDir = join(root, 'roles')
  const skillsDir = join(root, 'skills')
  const rejected: RoleRegistryRejection[] = []
  const installedRoles: string[] = []
  const installedSkills: string[] = []

  for (const roleFile of roleFiles) {
    let source: string
    try {
      source = await readFile(roleFile, 'utf8')
    } catch (error) {
      rejected.push({
        path: roleFile,
        issues: [{ path: '', message: error instanceof Error ? error.message : 'read failed' }],
      })
      continue
    }
    const result = parseRoleManifest(source)
    if (!result.ok) {
      rejected.push({ path: roleFile, issues: result.issues })
      continue
    }
    await mkdir(rolesDir, { recursive: true })
    // force: true (the fs.cp default) overwrites a prior install of the same file.
    await cp(roleFile, join(rolesDir, basename(roleFile)), { force: true })
    installedRoles.push(result.manifest.id)
  }

  for (const skillDir of skillDirs) {
    await mkdir(skillsDir, { recursive: true })
    await cp(skillDir, join(skillsDir, basename(skillDir)), { recursive: true, force: true })
    installedSkills.push(basename(skillDir))
  }

  // Surfacing a rejection-only outcome as not-ok lets the UI lead with the error.
  const ok = installedRoles.length > 0 || installedSkills.length > 0
  return { ok, installedRoles, installedSkills, rejected }
}

// List the role manifests currently installed in the user-global root, with the
// malformed ones surfaced so the user can fix them.
export async function loadUserRoleManifests(root: string): Promise<UserRoleListResult> {
  const rolesDir = join(root, 'roles')
  const roles: UserRoleListResult['roles'] = []
  const rejected: RoleRegistryRejection[] = []

  for (const entry of await readDirSafe(rolesDir)) {
    if (entry.isDirectory() || !isJsonFile(entry.name)) continue
    const path = join(rolesDir, entry.name)
    let source: string
    try {
      source = await readFile(path, 'utf8')
    } catch (error) {
      rejected.push({ path, issues: [{ path: '', message: error instanceof Error ? error.message : 'read failed' }] })
      continue
    }
    const result = parseRoleManifest(source)
    if (!result.ok) {
      rejected.push({ path, issues: result.issues })
      continue
    }
    roles.push({ id: result.manifest.id, label: result.manifest.label, summary: result.manifest.summary })
  }

  return { roles, rejected }
}

// Save (create or overwrite) a single user-authored role: validate the assembled
// manifest through the one validator, then write roles/<id>.json (canonical JSON)
// and skills/<id>/SKILL.md (the authored soul body). Nothing is written when the
// id is unsafe, the manifest is invalid, or the body is empty.
export async function saveUserRole(input: UserRoleSaveInput, root: string): Promise<UserRoleSaveResult> {
  const targets = safeRoleTargets(root, input.id)
  if (!targets) {
    return {
      ok: false,
      issues: [{ path: 'id', message: 'id must be lowercase snake_case and resolve within the registry root.' }],
    }
  }
  const validation = validateRoleManifest(buildAuthoredRoleManifest(input))
  if (!validation.ok) return { ok: false, issues: validation.issues }
  if (typeof input.body !== 'string' || input.body.trim().length === 0) {
    return { ok: false, issues: [{ path: 'body', message: 'soul body (SKILL.md) is required and must be non-empty.' }] }
  }

  await mkdir(dirname(targets.roleFile), { recursive: true })
  await mkdir(targets.skillDir, { recursive: true })
  await writeFile(targets.roleFile, serializeRoleManifest(validation.manifest), 'utf8')
  await writeFile(join(targets.skillDir, 'SKILL.md'), input.body, 'utf8')
  return { ok: true, id: validation.manifest.id }
}

// Remove an authored role's manifest and its skill folder. Idempotent: missing
// targets are not an error (rm force). An unsafe id is rejected without any
// filesystem work.
export async function deleteUserRole(id: string, root: string): Promise<UserRoleDeleteResult> {
  const targets = safeRoleTargets(root, id)
  if (!targets) return { ok: false }
  await rm(targets.roleFile, { force: true })
  await rm(targets.skillDir, { recursive: true, force: true })
  return { ok: true }
}

// Read an authored role's manifest plus its SKILL.md body for edit prefill. A
// missing or malformed manifest is a not-ok result; a missing body reads as empty.
export async function getUserRole(id: string, root: string): Promise<UserRoleGetResult> {
  const targets = safeRoleTargets(root, id)
  if (!targets) return { ok: false }
  let source: string
  try {
    source = await readFile(targets.roleFile, 'utf8')
  } catch (error) {
    return { ok: false, issues: [{ path: '', message: error instanceof Error ? error.message : 'read failed' }] }
  }
  const result = parseRoleManifest(source)
  if (!result.ok) return { ok: false, issues: result.issues }
  let body = ''
  try {
    body = await readFile(join(targets.skillDir, 'SKILL.md'), 'utf8')
  } catch {
    body = ''
  }
  return { ok: true, manifest: result.manifest, body }
}
