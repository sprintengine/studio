// Adopting the four skill packs Multicode used to ship a catalogue of.
//
// Installing a pack copied a directory into the workspace's harness skill dirs.
// Those directories are still there and still work — they are just files — but
// with the catalogue gone nothing would say where they came from, and they would
// read as skills the user dropped in by hand. So the repositories they came from
// become sources: the skill is then listed under the source that published it,
// the way every other skill on the surface is.
//
// This runs once, and only adopts a repository whose skill this machine actually
// holds: a user who never installed a pack does not inherit four sources they
// did not ask for.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { SKILL_HARNESS_DIR, SKILL_PACK_HARNESSES } from '../../shared/skill-harnesses'
import { skillSourceMonogram, type SkillSource } from '../../shared/skills'
import type { SkillSourceStore } from './source-store'

/** The retired catalogue: the repository each pack came from, and what it installed as. */
export const LEGACY_SKILL_PACKS: readonly { repo: string; installedDirName: string }[] = [
  { repo: 'pbakaus/impeccable', installedDirName: 'impeccable' },
  { repo: 'leonxlnx/taste-skill', installedDirName: 'taste' },
  { repo: 'nextlevelbuilder/ui-ux-pro-max-skill', installedDirName: 'ui-ux-pro-max' },
  { repo: 'anthropics/skills', installedDirName: 'frontend-design' },
]

export type AdoptLegacySkillPacksOptions = {
  store: SkillSourceStore
  /** Workspace roots to look in — the projects this install has open. */
  workspaceRoots: readonly string[]
  /** Overridden in tests; production checks the real harness skill dirs. */
  isInstalled?: (workspaceRoot: string, dirName: string) => boolean
}

/**
 * Adopt every legacy pack still installed somewhere, exactly once.
 *
 * An adopted source carries no scan: what the repository holds today is a
 * network read, and inventing one here would put skills on screen that nobody
 * verified are still there. The source lists as unread until Sync reads it,
 * which is the same state a source added while offline is in.
 */
export async function adoptLegacySkillPackSources(
  options: AdoptLegacySkillPacksOptions
): Promise<SkillSource[]> {
  if (await options.store.hasAdoptedLegacyPacks()) return []
  // Nowhere to look is not "looked and found nothing": the door opens with no
  // workspace, and marking the migration done there would mean the workspace
  // holding a pack is never checked at all.
  if (options.workspaceRoots.length === 0) return []

  const installed = options.isInstalled ?? isSkillInstalled
  const adopted: SkillSource[] = []
  for (const pack of LEGACY_SKILL_PACKS) {
    const present = options.workspaceRoots.some((root) => installed(root, pack.installedDirName))
    if (!present) continue
    const id = `github:${pack.repo}`
    if (await options.store.getSource(id)) continue
    const source = legacySkillPackSource(id, pack.repo)
    await options.store.putSource(source, null)
    adopted.push(source)
  }
  await options.store.markLegacyPacksAdopted()
  return adopted
}

function legacySkillPackSource(id: string, repo: string): SkillSource {
  const name = repo.split('/')[1] ?? repo
  return {
    id,
    kind: 'github',
    name,
    repo,
    monogram: skillSourceMonogram(repo),
    blurb: 'You installed a skill from this repository before Multicode had sources.',
    commitSha: '',
    scannedAt: '',
  }
}

function isSkillInstalled(workspaceRoot: string, dirName: string): boolean {
  return SKILL_PACK_HARNESSES.some((harness) =>
    existsSync(join(workspaceRoot, SKILL_HARNESS_DIR[harness], 'skills', dirName))
  )
}
