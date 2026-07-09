import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SkillPackCatalogEntry, SkillPackCatalogResult } from '../shared/electron-api'
import { BUILTIN_SKILLS } from './builtin-skills'
import { createWorkspaceSkillsService } from './workspace-skills-service'

const CATALOG: SkillPackCatalogEntry[] = [
  {
    id: 'vercel-react-best-practices',
    slug: 'vercel/react-best-practices',
    name: 'React Best Practices',
    description: 'Vercel React and Next.js guidance.',
    installedDirName: 'react-best-practices',
    harnesses: ['claude', 'codex', 'cursor', 'gemini', 'opencode', 'agents'],
  },
  {
    id: 'not-installed-pack',
    slug: 'someone/not-installed-pack',
    name: 'Not Installed Pack',
    description: 'A catalog pack nobody installed.',
    harnesses: ['agents'],
  },
]

function catalogService(packs: SkillPackCatalogEntry[]): { listCatalog(): SkillPackCatalogResult } {
  return { listCatalog: () => ({ ok: true, packs }) }
}

async function writeSkillDir(
  workspaceRoot: string,
  harnessDir: string,
  dirName: string,
  skillMd?: string,
): Promise<string> {
  const dir = join(workspaceRoot, harnessDir, 'skills', dirName)
  await mkdir(dir, { recursive: true })
  if (skillMd !== undefined) await writeFile(join(dir, 'SKILL.md'), skillMd, 'utf-8')
  return dir
}

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'multicode-workspace-skills-'))
  const workspaceRoot = join(temp, 'workspace')
  await mkdir(workspaceRoot, { recursive: true })

  const service = createWorkspaceSkillsService({ skillPackService: catalogService(CATALOG) })

  // Missing workspace root fails, not throws.
  const missing = await service.listWorkspaceSkills({ workspaceRoot: join(temp, 'nope') })
  assert.equal(missing.ok, false)

  // Custom skill dir with frontmatter: name/description come from SKILL.md, not
  // the directory name. Installed under two harness dirs → one deduped entry.
  const customSkillMd = [
    '---',
    'name: my-fancy-skill',
    'description: Does something fancy for this workspace.',
    '---',
    '',
    '# My Fancy Skill',
    '',
  ].join('\n')
  await writeSkillDir(workspaceRoot, '.agents', 'fancy-dir', customSkillMd)
  await writeSkillDir(workspaceRoot, '.claude', 'fancy-dir', customSkillMd)

  // Custom skill dir with no SKILL.md at all: falls back to the dir name.
  await writeSkillDir(workspaceRoot, '.agents', 'bare-dir')

  // Installed catalog pack (no frontmatter → catalog metadata wins).
  await writeSkillDir(workspaceRoot, '.agents', 'react-best-practices')

  // Installed builtin, up to date.
  const backlogDir = await writeSkillDir(workspaceRoot, '.agents', 'backlog')
  const backlogBuiltin = BUILTIN_SKILLS.find((skill) => skill.id === 'backlog')
  assert.ok(backlogBuiltin)
  await writeFile(
    join(backlogDir, '.multicode-skill.json'),
    JSON.stringify({ id: 'backlog', source: 'multicode-builtin', version: backlogBuiltin.version }),
    'utf-8',
  )

  // Installed builtin with a stale manifest version → update-available.
  const debugDir = await writeSkillDir(workspaceRoot, '.claude', 'debug')
  await writeFile(
    join(debugDir, '.multicode-skill.json'),
    JSON.stringify({ id: 'debug', source: 'multicode-builtin', version: '0.0.1' }),
    'utf-8',
  )

  const result = await service.listWorkspaceSkills({ workspaceRoot })
  assert.ok(result.ok)
  const skills = result.skills
  const byId = new Map(skills.map((skill) => [skill.id, skill]))

  const fancy = byId.get('fancy-dir')
  assert.ok(fancy, 'custom skill dir is listed')
  assert.equal(fancy.name, 'my-fancy-skill')
  assert.equal(fancy.description, 'Does something fancy for this workspace.')
  assert.equal(fancy.source, 'custom')
  assert.equal(fancy.installState, 'installed')
  assert.deepEqual([...fancy.harnesses].sort(), ['agents', 'claude'])

  const bare = byId.get('bare-dir')
  assert.ok(bare)
  assert.equal(bare.name, 'bare-dir')
  assert.equal(bare.source, 'custom')

  const pack = byId.get('vercel-react-best-practices')
  assert.ok(pack, 'installed catalog pack resolves to its catalog id')
  assert.equal(pack.name, 'React Best Practices')
  assert.equal(pack.source, 'pack')
  assert.equal(pack.installState, 'installed')
  assert.equal(pack.packSlug, 'vercel/react-best-practices')

  const notInstalled = byId.get('not-installed-pack')
  assert.ok(notInstalled, 'catalog pack not installed is still offered')
  assert.equal(notInstalled.installState, 'available')
  assert.equal(notInstalled.harnesses.length, 0)

  const backlog = byId.get('backlog')
  assert.ok(backlog)
  assert.equal(backlog.source, 'builtin')
  assert.equal(backlog.installState, 'installed')
  // No SKILL.md written → BUILTIN_SKILLS metadata fallback.
  assert.equal(backlog.name, backlogBuiltin.name)

  const debug = byId.get('debug')
  assert.ok(debug)
  assert.equal(debug.installState, 'update-available')

  // Every builtin appears exactly once; uninstalled ones are 'available'.
  for (const builtin of BUILTIN_SKILLS) {
    const entries = skills.filter((skill) => skill.id === builtin.id)
    assert.equal(entries.length, 1, `builtin ${builtin.id} listed once`)
    if (builtin.id !== 'backlog' && builtin.id !== 'debug') {
      assert.equal(entries[0].installState, 'available')
    }
  }

  // Sorted by display name.
  const names = skills.map((skill) => skill.name)
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)))

  console.log('workspace-skills-service tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
