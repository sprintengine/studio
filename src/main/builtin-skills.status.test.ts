import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, test } from 'vitest'

import {
  BUILTIN_SKILLS,
  createBuiltinSkillManager,
  ensureSkillInstalled,
  getSkillStatus,
  registerModuleSkills,
  setDefaultSkillManager,
  unregisterModuleSkills,
} from './builtin-skills'

// `getSkillStatus` is the read half of `ensureSkillInstalled`: the same
// targets and vocabulary, and nothing written. A module's door asks it to show
// "installed in this project" before the person clicks Install.

let temp = ''
let workspaceRoot = ''
let moduleRoot = ''

async function writeSkillSource(root: string, skillId: string, body: string): Promise<void> {
  await mkdir(join(root, skillId), { recursive: true })
  await writeFile(join(root, skillId, 'SKILL.md'), body, 'utf-8')
}

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'sprintengine-skill-status-'))
  workspaceRoot = join(temp, 'workspace')
  moduleRoot = join(temp, 'modules', 'decision-log')
  await mkdir(workspaceRoot, { recursive: true })
  const bundledRoot = join(temp, 'bundled')
  for (const skill of BUILTIN_SKILLS) await writeSkillSource(bundledRoot, skill.id, 'bundled\n')
  await writeSkillSource(join(moduleRoot, 'skills'), 'decision-log', 'version one\n')
  setDefaultSkillManager(createBuiltinSkillManager({ sourceRoot: bundledRoot, listPlugins: () => [] }))
  registerModuleSkills('decision-log', [
    {
      id: 'decision-log',
      sourceDir: join(moduleRoot, 'skills', 'decision-log'),
      targetPolicy: 'agents',
      description: 'Record a decision.',
    },
  ])
})

afterEach(() => {
  unregisterModuleSkills('decision-log')
  setDefaultSkillManager(null)
})

test('an unknown skill answers unknown-skill', async () => {
  assert.deepEqual(await getSkillStatus(workspaceRoot, 'nobody-knows-this'), {
    ok: false,
    status: 'unknown-skill',
    message: 'Unknown skill: nobody-knows-this',
  })
})

test('a skill not yet in the workspace is missing, and asking writes nothing', async () => {
  assert.deepEqual(await getSkillStatus(workspaceRoot, 'decision-log'), { ok: false, status: 'missing' })
  assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'decision-log')), false)
})

test('after ensureSkillInstalled the status reads installed', async () => {
  assert.deepEqual(await ensureSkillInstalled(workspaceRoot, 'decision-log'), { ok: true, status: 'installed' })
  assert.deepEqual(await getSkillStatus(workspaceRoot, 'decision-log'), { ok: true, status: 'installed' })
})

test('a changed source reads update-available until ensure runs again', async () => {
  await ensureSkillInstalled(workspaceRoot, 'decision-log')
  await writeSkillSource(join(moduleRoot, 'skills'), 'decision-log', 'version two\n')
  assert.deepEqual(await getSkillStatus(workspaceRoot, 'decision-log'), { ok: true, status: 'update-available' })
  assert.deepEqual(await ensureSkillInstalled(workspaceRoot, 'decision-log'), { ok: true, status: 'updated' })
  assert.deepEqual(await getSkillStatus(workspaceRoot, 'decision-log'), { ok: true, status: 'installed' })
})

test('a hand-made copy in the way reads local', async () => {
  await writeSkillSource(join(workspaceRoot, '.agents', 'skills'), 'decision-log', 'mine\n')
  const status = await getSkillStatus(workspaceRoot, 'decision-log')
  assert.equal(status.ok, true)
  assert.equal(status.status, 'local')
})
