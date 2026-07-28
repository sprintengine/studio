// Installing a skill: copy the whole skill directory into the harness skill
// directories under the active workspace root, preserving subdirectory shape,
// so `agents/`, `scripts/` and `reference/` land the way the skill expects to
// find them.
//
// Where skills go is unchanged from before sources existed — the harness dirs
// resolved by src/shared/skill-harnesses.ts. What changed is *what* is copied:
// the whole directory, not the entry document alone.

import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type { SkillPackHarness } from '../../shared/electron-api'
import { SKILL_HARNESS_DIR } from '../../shared/skill-harnesses'
import { skillDirName, type ScannedSkill, type SkillFileRef } from '../../shared/skills'

/** Reads one file's bytes from whichever source the skill came from. */
export type SkillFileReader = (file: SkillFileRef) => Promise<Buffer>

export const DEFAULT_SKILL_INSTALL_MAX_FILES = 1_000
export const DEFAULT_SKILL_INSTALL_MAX_TOTAL_BYTES = 50 * 1024 * 1024

export type SkillInstallTarget = { harness: SkillPackHarness; path: string }

export type SkillInstallPlan = {
  dirName: string
  targets: SkillInstallTarget[]
  files: SkillFileRef[]
}

export type SkillInstallPlanResult =
  | { ok: true; plan: SkillInstallPlan }
  | { ok: false; message: string }

export type SkillInstallResult =
  | { ok: true; dirName: string; harnesses: SkillPackHarness[]; paths: string[]; fileCount: number }
  | { ok: false; message: string }

/**
 * Resolve every destination up front and refuse the whole install if any of
 * them escapes its skill directory. Skills are third-party content: a tree
 * entry named `../../.claude/settings.json` is not a file to sanitise and carry
 * on with, it is a source to stop reading.
 */
export function planSkillInstall(
  workspaceRoot: string,
  skill: ScannedSkill,
  harnesses: readonly SkillPackHarness[]
): SkillInstallPlanResult {
  const root = resolve(workspaceRoot)
  const dirName = skillDirName(skill.id)
  if (dirName.length === 0 || !isSafeSegment(dirName)) {
    return { ok: false, message: `Skill "${skill.id}" does not have a usable directory name.` }
  }
  if (harnesses.length === 0) {
    return { ok: false, message: 'No agent CLI on this machine reads workspace skills.' }
  }
  if (skill.files.length === 0) {
    return { ok: false, message: `Skill "${skill.id}" lists no files to install.` }
  }
  if (skill.files.length > DEFAULT_SKILL_INSTALL_MAX_FILES) {
    return {
      ok: false,
      message: `Skill "${skill.id}" contains more than ${DEFAULT_SKILL_INSTALL_MAX_FILES} files.`,
    }
  }

  const targets: SkillInstallTarget[] = []
  for (const harness of harnesses) {
    const path = resolve(root, SKILL_HARNESS_DIR[harness], 'skills', dirName)
    if (!isInside(root, path)) {
      return { ok: false, message: `Skill "${skill.id}" resolves outside the workspace.` }
    }
    targets.push({ harness, path })
  }

  for (const file of skill.files) {
    // Checked against the first target only because every target shares the
    // same skill-relative layout; a path that stays inside one stays inside all.
    const escape = resolveSkillFilePath(targets[0].path, file.path)
    if (escape === null) {
      return {
        ok: false,
        message: `Skill "${skill.id}" contains a file path that escapes its own directory: ${file.path}`,
      }
    }
  }

  return { ok: true, plan: { dirName, targets, files: [...skill.files] } }
}

/**
 * The absolute destination for a skill-relative path, or null when it does not
 * stay inside the skill directory. Backslashes are rejected outright rather
 * than normalised: a repository path is POSIX, so a backslash is either a
 * literal filename character (which cannot survive a Windows install anyway) or
 * an attempt to smuggle a separator past a POSIX-shaped check.
 */
export function resolveSkillFilePath(targetDir: string, relativePath: string): string | null {
  if (relativePath.length === 0) return null
  if (relativePath.includes('\\') || relativePath.includes('\0')) return null
  if (isAbsolute(relativePath) || relativePath.startsWith('/')) return null
  const segments = relativePath.split('/')
  if (segments.some((segment) => !isSafeSegment(segment))) return null
  const destination = resolve(targetDir, relativePath)
  return isInside(targetDir, destination) ? destination : null
}

function isSafeSegment(segment: string): boolean {
  return segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes('\\')
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export type InstallSkillOptions = {
  workspaceRoot: string
  skill: ScannedSkill
  harnesses: readonly SkillPackHarness[]
  readFile: SkillFileReader
  stagingRoot?: string
  maxTotalBytes?: number
}

/**
 * Stage the whole skill once, then copy the staged directory into each harness
 * target. Staging keeps a failed download from leaving a half-written skill
 * where an agent would read it, and keeps one install to one fetch per file no
 * matter how many harnesses are on this machine.
 */
export async function installSkill(options: InstallSkillOptions): Promise<SkillInstallResult> {
  const planned = planSkillInstall(options.workspaceRoot, options.skill, options.harnesses)
  if (!planned.ok) return planned
  const { plan } = planned
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_SKILL_INSTALL_MAX_TOTAL_BYTES

  const stagingRoot = options.stagingRoot ?? join(tmpdir(), 'multicode-skill-install')
  let stage: string | null = null
  try {
    await mkdir(stagingRoot, { recursive: true })
    stage = await mkdtemp(join(stagingRoot, `${plan.dirName}-`))

    let total = 0
    for (const file of plan.files) {
      const destination = resolveSkillFilePath(stage, file.path)
      if (destination === null) {
        return {
          ok: false,
          message: `Skill "${options.skill.id}" contains a file path that escapes its own directory: ${file.path}`,
        }
      }
      const bytes = await options.readFile(file)
      total += bytes.byteLength
      if (total > maxTotalBytes) {
        return {
          ok: false,
          message: `Skill "${options.skill.id}" is larger than ${maxTotalBytes} bytes.`,
        }
      }
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, bytes)
    }

    for (const target of plan.targets) {
      await rm(target.path, { recursive: true, force: true })
      await mkdir(dirname(target.path), { recursive: true })
      await cp(stage, target.path, { recursive: true })
    }

    return {
      ok: true,
      dirName: plan.dirName,
      harnesses: plan.targets.map((target) => target.harness),
      paths: plan.targets.map((target) => target.path),
      fileCount: plan.files.length,
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Absolute path a skill occupies for one harness, for status and removal. */
export function skillInstallPath(
  workspaceRoot: string,
  harness: SkillPackHarness,
  dirName: string
): string {
  return join(resolve(workspaceRoot), SKILL_HARNESS_DIR[harness], 'skills', dirName)
}
