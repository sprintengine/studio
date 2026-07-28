import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ScanResult, ScannedSkill } from '../../shared/skills'
import { SKILL_PROVENANCE_FILE } from './install'
import { diffScannedSkills, installedSkillCopies, refreshInstalledSkills } from './sync'

const SOURCE = 'github:acme/skills'

function skill(id: string, files = ['SKILL.md']): ScannedSkill {
  return {
    id,
    name: id.split('/').slice(-1)[0],
    description: '',
    group: '',
    files: files.map((path) => ({ path, size: 1, blobSha: '', isEntry: path === 'SKILL.md' })),
    allowedTools: [],
    hasExecutables: false,
  }
}

function scanOf(skills: ScannedSkill[], commitSha = 'b81f77a'): ScanResult {
  return {
    skills,
    groups: [],
    groupingSignal: 'none',
    fileCount: skills.reduce((total, entry) => total + entry.files.length, 0),
    commitSha,
  }
}

/**
 * A workspace holding installed copies. Each entry names the harness dirs the
 * copy sits in and the source that installed it; `null` writes no provenance
 * marker, which is what a bundled skill or a hand-made directory looks like.
 */
async function workspaceWith(
  installed: Record<string, { harnessDirs: string[]; sourceId: string | null }>
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'multicode-skill-sync-'))
  for (const [dirName, entry] of Object.entries(installed)) {
    for (const harnessDir of entry.harnessDirs) {
      const dir = join(root, harnessDir, 'skills', dirName)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), 'the copy that was installed\n')
      if (entry.sourceId === null) continue
      await writeFile(
        join(dir, SKILL_PROVENANCE_FILE),
        JSON.stringify({ sourceId: entry.sourceId, skillId: `skills/${dirName}`, commitSha: 'b81f77a' })
      )
    }
  }
  return root
}

function fromSource(...harnessDirs: string[]): { harnessDirs: string[]; sourceId: string } {
  return { harnessDirs, sourceId: SOURCE }
}

async function reportsWhatCameInAndWhatWent(): Promise<void> {
  const previous = scanOf([skill('skills/tdd'), skill('skills/deprecated/jquery')])
  const next = scanOf([skill('skills/tdd'), skill('skills/triage'), skill('skills/teach')], 'c0ffee1')
  const changes = diffScannedSkills(previous, next)
  assert.deepEqual(changes.added, ['skills/triage', 'skills/teach'])
  assert.deepEqual(changes.removed, ['skills/deprecated/jquery'])

  // A source read for the first time has everything to say and nothing to
  // compare against; it must not report its whole list as "removed".
  const first = diffScannedSkills(null, next)
  assert.equal(first.added.length, 3)
  assert.deepEqual(first.removed, [])
  console.log('ok - sync reports what came in and what went')
}

async function reCopiesOnlyTheHarnessesThatHoldTheSkill(): Promise<void> {
  const workspace = await workspaceWith({ tdd: fromSource('.claude', '.agents'), triage: fromSource('.claude') })
  const installed = await installedSkillCopies(workspace)
  assert.deepEqual(installed.get('tdd')?.map((copy) => copy.harness), ['claude', 'agents'])
  assert.deepEqual(installed.get('triage')?.map((copy) => copy.harness), ['claude'])

  const scan = scanOf([skill('skills/tdd', ['SKILL.md', 'reference/deep.md']), skill('skills/unwanted')])
  const result = await refreshInstalledSkills({
    workspaceRoot: workspace,
    sourceId: SOURCE,
    scan,
    installedCopies: installed,
    readFile: async (target, file) => Buffer.from(`${target.id}:${file.path} at head\n`, 'utf8'),
  })

  assert.deepEqual(result.refreshed, ['skills/tdd'])
  assert.deepEqual(result.failures, [])
  for (const harnessDir of ['.claude', '.agents']) {
    const root = join(workspace, harnessDir, 'skills', 'tdd')
    assert.equal(await readFile(join(root, 'SKILL.md'), 'utf8'), 'skills/tdd:SKILL.md at head\n')
    assert.equal(
      await readFile(join(root, 'reference', 'deep.md'), 'utf8'),
      'skills/tdd:reference/deep.md at head\n',
      'the whole directory is re-copied, not the entry alone',
    )
  }
  // A skill the workspace never installed is not installed by a sync, and no
  // copy appears in a harness directory the user never installed into.
  assert.deepEqual((await readdir(join(workspace, '.claude', 'skills'))).sort(), ['tdd', 'triage'])
  assert.deepEqual((await readdir(join(workspace, '.agents', 'skills'))).sort(), ['tdd'])
  console.log('ok - a sync re-copies exactly the copies the workspace already holds')
}

async function keepsASkillThatDisappearedUpstream(): Promise<void> {
  const workspace = await workspaceWith({ tdd: fromSource('.claude'), jquery: fromSource('.claude') })
  const result = await refreshInstalledSkills({
    workspaceRoot: workspace,
    sourceId: SOURCE,
    scan: scanOf([skill('skills/tdd')]),
    installedCopies: await installedSkillCopies(workspace),
    readFile: async () => Buffer.from('at head\n', 'utf8'),
  })

  assert.deepEqual(result.refreshed, ['skills/tdd'])
  // Dropping out of the source's list is not a reason to take a working skill
  // away from the agents reading it.
  assert.equal(
    await readFile(join(workspace, '.claude', 'skills', 'jquery', 'SKILL.md'), 'utf8'),
    'the copy that was installed\n',
  )
  console.log('ok - a skill removed upstream keeps the copy it already has')
}

async function reportsAFailedCopyWithoutStoppingTheRest(): Promise<void> {
  const workspace = await workspaceWith({ tdd: fromSource('.claude'), triage: fromSource('.claude') })
  const result = await refreshInstalledSkills({
    workspaceRoot: workspace,
    sourceId: SOURCE,
    scan: scanOf([skill('skills/tdd'), skill('skills/triage')]),
    installedCopies: await installedSkillCopies(workspace),
    readFile: async (target) => {
      if (target.id === 'skills/tdd') throw new Error('GitHub rate-limited this request.')
      return Buffer.from('at head\n', 'utf8')
    },
  })

  assert.deepEqual(result.refreshed, ['skills/triage'])
  assert.deepEqual(result.failures, [
    { skillId: 'skills/tdd', message: 'GitHub rate-limited this request.' },
  ])
  assert.equal(
    await readFile(join(workspace, '.claude', 'skills', 'tdd', 'SKILL.md'), 'utf8'),
    'the copy that was installed\n',
    'a failed download leaves the skill that was there, never a half-written one',
  )
  console.log('ok - a failed copy is reported and the rest still update')
}

// The reproduction filed as T10-F1: `prototype` is a skill Multicode ships and
// a skill mattpocock/skills ships, and before install recorded provenance the
// second silently replaced the first on a sync the user never asked for.
async function leavesABundledSkillOfTheSameNameAlone(): Promise<void> {
  const workspace = await workspaceWith({ prototype: { harnessDirs: ['.claude'], sourceId: null } })
  const bundled = join(workspace, '.claude', 'skills', 'prototype', 'SKILL.md')

  const result = await refreshInstalledSkills({
    workspaceRoot: workspace,
    sourceId: 'github:mattpocock/skills',
    scan: scanOf([skill('skills/engineering/prototype')]),
    installedCopies: await installedSkillCopies(workspace),
    readFile: async () => Buffer.from("the repository's own prototype\n", 'utf8'),
  })

  assert.deepEqual(result.refreshed, [], 'a skill this source never installed is not reported as refreshed')
  assert.equal(await readFile(bundled, 'utf8'), 'the copy that was installed\n', 'the bundled bytes are intact')
  console.log('ok - a directory with no provenance is never overwritten by a sync')
}

async function leavesACopyInstalledFromAnotherSourceAlone(): Promise<void> {
  const workspace = await workspaceWith({
    prototype: { harnessDirs: ['.claude'], sourceId: 'github:other/skills' },
    tdd: fromSource('.claude'),
  })
  const other = join(workspace, '.claude', 'skills', 'prototype', 'SKILL.md')

  const result = await refreshInstalledSkills({
    workspaceRoot: workspace,
    sourceId: SOURCE,
    scan: scanOf([skill('skills/prototype'), skill('skills/tdd')]),
    installedCopies: await installedSkillCopies(workspace),
    readFile: async () => Buffer.from('at head\n', 'utf8'),
  })

  // Not an error and not a prompt: installing the same-named skill from two
  // repositories is a legitimate state, and the one the user chose stands.
  assert.deepEqual(result.refreshed, ['skills/tdd'])
  assert.equal(await readFile(other, 'utf8'), 'the copy that was installed\n')
  console.log('ok - a sync updates its own installs and leaves other sources alone')
}

async function main(): Promise<void> {
  await reportsWhatCameInAndWhatWent()
  await reCopiesOnlyTheHarnessesThatHoldTheSkill()
  await keepsASkillThatDisappearedUpstream()
  await reportsAFailedCopyWithoutStoppingTheRest()
  await leavesABundledSkillOfTheSameNameAlone()
  await leavesACopyInstalledFromAnotherSourceAlone()
  console.log('skills sync tests passed')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
