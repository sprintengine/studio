// Sync: the scan that added a source, pointed at a source that already exists.
//
// Two things happen and neither is a merge. The cached scan is replaced by a
// fresh one taken at the repository's current head, and every skill from that
// source the workspace already holds is copied again from it. Installing is a
// file copy, so updating is the same file copy — there are no hunks to choose,
// which is why nothing here computes a diff and nothing above it renders one.
//
// The re-copy is deliberately blind: a skill edited in place is overwritten.
// That trade is recorded in backlog/2026-07-28-skill-source-sync.md, with the
// cheap fix (compare each file's blob SHA before writing) named there for the
// day it bites.

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { SkillHarness } from '../../shared/electron-api'
import { SKILL_HARNESS_DIR, SKILL_PACK_HARNESSES } from '../../shared/skill-harnesses'
import { skillDirName, type ScanResult, type ScannedSkill, type SkillFileRef } from '../../shared/skills'
import { installSkill } from './install'

export type SkillSyncChanges = { added: string[]; removed: string[] }

/**
 * What the refreshed scan holds that the cached one did not, and what it has
 * stopped holding. Skill ids only: this is the whole of what a sync can say
 * about a source without inventing prose about someone else's commits.
 */
export function diffScannedSkills(previous: ScanResult | null, next: ScanResult): SkillSyncChanges {
  const before = new Set((previous?.skills ?? []).map((skill) => skill.id))
  const after = new Set(next.skills.map((skill) => skill.id))
  return {
    added: next.skills.filter((skill) => !before.has(skill.id)).map((skill) => skill.id),
    removed: (previous?.skills ?? []).filter((skill) => !after.has(skill.id)).map((skill) => skill.id),
  }
}

/**
 * Which harness directories already hold a skill of each name, keyed by the
 * directory name an install writes.
 *
 * Read across every harness directory rather than the CLIs detected on this
 * machine: a skill copied into `.claude/skills` is installed whether or not
 * that CLI answers `which` today, and a sync that quietly stopped refreshing it
 * would leave the workspace on bytes nobody chose. Copying back into exactly
 * the directories that hold it also means a sync never creates a copy the user
 * never installed.
 */
export async function installedSkillHarnesses(
  workspaceRoot: string
): Promise<Map<string, SkillHarness[]>> {
  const byDirName = new Map<string, SkillHarness[]>()
  for (const harness of SKILL_PACK_HARNESSES) {
    const skillsDir = join(workspaceRoot, SKILL_HARNESS_DIR[harness], 'skills')
    const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const harnesses = byDirName.get(entry.name)
      if (harnesses) harnesses.push(harness)
      else byDirName.set(entry.name, [harness])
    }
  }
  return byDirName
}

export type SkillSyncCopyFailure = { skillId: string; message: string }
export type SkillSyncCopyResult = { refreshed: string[]; failures: SkillSyncCopyFailure[] }

/**
 * Re-copy the skills this workspace already holds, from the refreshed scan.
 *
 * Only skills the new scan still lists are copied. One that disappeared
 * upstream keeps the copy it already has — dropping out of the source's list is
 * not a reason to take a working skill away from the agents reading it.
 */
export async function refreshInstalledSkills(options: {
  workspaceRoot: string
  scan: ScanResult
  installedHarnesses: ReadonlyMap<string, SkillHarness[]>
  readFile: (skill: ScannedSkill, file: SkillFileRef) => Promise<Buffer>
}): Promise<SkillSyncCopyResult> {
  const refreshed: string[] = []
  const failures: SkillSyncCopyFailure[] = []
  for (const skill of options.scan.skills) {
    const harnesses = options.installedHarnesses.get(skillDirName(skill.id))
    if (!harnesses || harnesses.length === 0) continue
    // Sequential on purpose: each copy fetches every file of its skill, and a
    // fan-out of those reads is what a rate limit is for.
    const result = await installSkill({
      workspaceRoot: options.workspaceRoot,
      skill,
      harnesses,
      readFile: (file) => options.readFile(skill, file),
    }).catch((error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : String(error),
    }))
    if (result.ok) refreshed.push(skill.id)
    else failures.push({ skillId: skill.id, message: result.message })
  }
  return { refreshed, failures }
}
