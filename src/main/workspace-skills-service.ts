import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type {
  BuiltinSkill,
  SkillPackCatalogEntry,
  SkillPackHarness,
  WorkspaceSkill,
  WorkspaceSkillsListInput,
  WorkspaceSkillsListResult,
} from '../shared/electron-api'
import { SKILL_HARNESS_DIR, SKILL_PACK_HARNESSES } from '../shared/skill-harnesses'
import { BUILTIN_SKILLS } from './builtin-skills'
import type { SkillPackService } from './skill-pack-service'

// The .multicode-skill.json manifest a builtin install writes next to SKILL.md;
// version drift against BUILTIN_SKILLS marks the entry update-available without
// re-hashing the directory.
const BUILTIN_MANIFEST_FILE = '.multicode-skill.json'

export type WorkspaceSkillsService = {
  listWorkspaceSkills(input: WorkspaceSkillsListInput): Promise<WorkspaceSkillsListResult>
}

type SkillFrontmatter = {
  name?: string
  description?: string
}

export function createWorkspaceSkillsService(options: {
  skillPackService: Pick<SkillPackService, 'listCatalog'>
}): WorkspaceSkillsService {
  return {
    async listWorkspaceSkills(input): Promise<WorkspaceSkillsListResult> {
      const workspaceRoot = input.workspaceRoot?.trim()
      if (!workspaceRoot || !existsSync(workspaceRoot)) {
        return { ok: false, message: 'Workspace root does not exist.' }
      }
      const catalogResult = options.skillPackService.listCatalog()
      const catalog = catalogResult.ok ? catalogResult.packs : []
      return { ok: true, skills: listWorkspaceSkills(workspaceRoot, catalog) }
    },
  }
}

function listWorkspaceSkills(
  workspaceRoot: string,
  catalog: SkillPackCatalogEntry[],
): WorkspaceSkill[] {
  const builtinById = new Map<string, BuiltinSkill>(BUILTIN_SKILLS.map((skill) => [skill.id, skill]))
  const catalogByDirName = new Map<string, SkillPackCatalogEntry>(
    catalog.map((pack) => [pack.installedDirName ?? pack.id, pack]),
  )

  const installed = new Map<string, WorkspaceSkill>()
  for (const harness of SKILL_PACK_HARNESSES) {
    const skillsDir = join(workspaceRoot, SKILL_HARNESS_DIR[harness], 'skills')
    for (const dirName of listSkillDirs(skillsDir)) {
      const existing = installed.get(dirName)
      if (existing) {
        if (!existing.harnesses.includes(harness)) existing.harnesses.push(harness)
        // A later harness copy still refines missing metadata (the first copy
        // may predate frontmatter or be a bare directory).
        if (!existing.description || !existing.name || existing.name === dirName) {
          const frontmatter = readSkillFrontmatter(join(skillsDir, dirName))
          if (!existing.description && frontmatter.description) existing.description = frontmatter.description
          if ((!existing.name || existing.name === dirName) && frontmatter.name) existing.name = frontmatter.name
        }
        continue
      }
      installed.set(
        dirName,
        buildInstalledSkill({
          dirName,
          skillDir: join(skillsDir, dirName),
          harness,
          builtin: builtinById.get(dirName),
          catalogEntry: catalogByDirName.get(dirName),
        }),
      )
    }
  }

  const skills = Array.from(installed.values())

  for (const builtin of BUILTIN_SKILLS) {
    if (installed.has(builtin.id)) continue
    skills.push({
      id: builtin.id,
      name: builtin.name,
      description: builtin.description,
      source: 'builtin',
      harnesses: [],
      installState: 'available',
      version: builtin.version,
    })
  }

  for (const pack of catalog) {
    const dirName = pack.installedDirName ?? pack.id
    if (installed.has(dirName)) continue
    skills.push({
      id: pack.id,
      name: pack.name,
      description: pack.description,
      source: 'pack',
      harnesses: [],
      installState: 'available',
      packSlug: pack.slug,
      version: pack.version,
    })
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

function buildInstalledSkill(input: {
  dirName: string
  skillDir: string
  harness: SkillPackHarness
  builtin?: BuiltinSkill
  catalogEntry?: SkillPackCatalogEntry
}): WorkspaceSkill {
  const { dirName, skillDir, harness, builtin, catalogEntry } = input
  const frontmatter = readSkillFrontmatter(skillDir)
  const name = frontmatter.name ?? builtin?.name ?? catalogEntry?.name ?? dirName
  const description = frontmatter.description ?? builtin?.description ?? catalogEntry?.description

  if (builtin) {
    return {
      id: builtin.id,
      name,
      description,
      source: 'builtin',
      harnesses: [harness],
      installState: builtinInstallState(skillDir, builtin),
      version: builtin.version,
    }
  }
  if (catalogEntry) {
    return {
      id: catalogEntry.id,
      name,
      description,
      source: 'pack',
      harnesses: [harness],
      installState: 'installed',
      packSlug: catalogEntry.slug,
      version: catalogEntry.version,
    }
  }
  return {
    id: dirName,
    name,
    description,
    source: 'custom',
    harnesses: [harness],
    installState: 'installed',
  }
}

function builtinInstallState(skillDir: string, builtin: BuiltinSkill): 'installed' | 'update-available' {
  try {
    const manifest = JSON.parse(readFileSync(join(skillDir, BUILTIN_MANIFEST_FILE), 'utf8')) as {
      version?: unknown
    }
    if (typeof manifest.version === 'string' && manifest.version !== builtin.version) {
      return 'update-available'
    }
  } catch {
    // Unmanaged or unreadable copy: treat as installed; overwrite safety lives
    // in the builtin skill manager, not the inventory.
  }
  return 'installed'
}

function listSkillDirs(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return []
  try {
    return readdirSync(skillsDir).filter((name) => {
      try {
        return statSync(join(skillsDir, name)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

// Minimal SKILL.md frontmatter read: single-line `name:` / `description:`
// scalars from the leading `---` block. Anything fancier (folded blocks,
// multi-line strings) falls back to the catalog/builtin metadata.
function readSkillFrontmatter(skillDir: string): SkillFrontmatter {
  let raw: string
  try {
    raw = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
  } catch {
    return {}
  }
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return {}
  const result: SkillFrontmatter = {}
  for (const line of match[1].split(/\r?\n/)) {
    const keyValue = line.match(/^(name|description):\s*(.+)\s*$/)
    if (!keyValue) continue
    const key = keyValue[1] as keyof SkillFrontmatter
    if (result[key]) continue
    const value = unquoteYamlScalar(keyValue[2])
    if (value) result[key] = value
  }
  return result
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
    || (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}
