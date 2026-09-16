/**
 * Read a role's brief from a workspace skill file.
 *
 * Replaces the Python CLI hop the renderer used to take over IPC.
 * Discovery matches the engine: harness skill directories in
 * {@link ROLE_HARNESS_DIRECTORIES} order. First hit on
 * `metadata.sprintengine-role` wins. A missing pack is a named missing-role
 * error, never a bundled substitute (owner ruling 2026-09-08).
 *
 * This module does not spawn a process. The souls CLI stays on PATH for one
 * more phase so an agent launched before this ships can still run the old
 * fetch command.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { parseSkillFrontmatter, SKILL_ENTRY_FILE } from '../shared/skills'
import {
  missingRoleMessage,
  normalizeRoleId,
  ROLE_HARNESS_DIRECTORIES,
  ROLE_METADATA_KEY,
  stripSkillFrontmatter,
} from '../shared/specialists/role-brief'

export type RoleBriefOk = {
  ok: true
  roleId: string
  brief: string
  skillPath: string
  /**
   * Workspace-relative POSIX path when the skill lives under the workspace
   * (what a host-context pointer names). Null if the absolute path is outside
   * the workspace — which must not happen for an installed role skill.
   */
  workspaceRel: string | null
  knownRoles: string[]
}

export type RoleBriefMissing = {
  ok: false
  roleId: string
  message: string
  knownRoles: string[]
}

export type RoleBrief = RoleBriefOk | RoleBriefMissing

type DiscoveredRole = {
  roleId: string
  skillPath: string
  brief: string
}

export function readRoleBrief(workspaceRoot: string, roleId: string): RoleBrief {
  const requested = roleId.trim()
  const discovered = discoverWorkspaceRoleSkills(workspaceRoot)
  const knownRoles = [...discovered.keys()].sort()
  if (!requested) {
    return {
      ok: false,
      roleId,
      message: missingRoleMessage(roleId, knownRoles),
      knownRoles,
    }
  }
  const hit = discovered.get(normalizeRoleId(requested))
  if (!hit) {
    return {
      ok: false,
      roleId: requested,
      message: missingRoleMessage(requested, knownRoles),
      knownRoles,
    }
  }
  return {
    ok: true,
    roleId: hit.roleId,
    brief: hit.brief,
    skillPath: hit.skillPath,
    workspaceRel: workspaceRelativeSkillPath(workspaceRoot, hit.skillPath),
    knownRoles,
  }
}

/**
 * Scan the workspace harness skill directories for role skills. Keyed by
 * normalized role id; first hit wins. The packaged workflow-roles tree is an
 * install source, never a discovery layer.
 */
export function discoverWorkspaceRoleSkills(workspaceRoot: string): Map<string, DiscoveredRole> {
  const roles = new Map<string, DiscoveredRole>()
  const root = resolve(workspaceRoot)
  for (const harness of ROLE_HARNESS_DIRECTORIES) {
    ingestSkillDir(join(root, harness, 'skills'), roles)
  }
  return roles
}

function ingestSkillDir(skillsDir: string, roles: Map<string, DiscoveredRole>): void {
  if (!existsSync(skillsDir)) return
  let entries
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const skillPath = join(skillsDir, entry.name, SKILL_ENTRY_FILE)
    if (!existsSync(skillPath)) continue
    const loaded = loadRoleSkill(skillPath)
    if (!loaded) continue
    const key = normalizeRoleId(loaded.roleId)
    if (!roles.has(key)) roles.set(key, loaded)
  }
}

function loadRoleSkill(skillPath: string): DiscoveredRole | null {
  let raw: string
  try {
    raw = readFileSync(skillPath, 'utf8')
  } catch {
    return null
  }
  if (!raw.trim()) return null
  const body = stripSkillFrontmatter(raw)
  if (body === null || !body.trim()) return null
  const parsed = parseSkillFrontmatter(raw)
  const rawRoleId = parsed.metadata[ROLE_METADATA_KEY]?.trim() ?? ''
  if (!rawRoleId) return null
  return {
    roleId: normalizeRoleId(rawRoleId),
    skillPath: resolve(skillPath),
    brief: body,
  }
}

function workspaceRelativeSkillPath(workspaceRoot: string, skillPath: string): string | null {
  const root = resolve(workspaceRoot)
  const absolute = resolve(skillPath)
  const rel = relative(root, absolute)
  if (!rel || rel.startsWith('..') || rel === absolute) return null
  return rel.split(sep).join('/')
}
