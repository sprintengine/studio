import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ScannedSkill, SkillFileRef } from '../../shared/skills'
import { installSkill, planSkillInstall, resolveSkillFilePath } from './install'

function file(path: string): SkillFileRef {
  return { path, size: 1, blobSha: '', isEntry: path === 'SKILL.md' }
}

function skill(paths: string[], id = 'skills/prototype'): ScannedSkill {
  return {
    id,
    name: 'prototype',
    description: '',
    group: '',
    files: paths.map(file),
    allowedTools: [],
    hasExecutables: false,
  }
}

const CONTENT = (path: string): Buffer => Buffer.from(`content of ${path}\n`, 'utf8')

async function installsWholeDirectory(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'multicode-skill-install-'))
  const paths = [
    'SKILL.md',
    'agents/openai.yaml',
    'scripts/context.mjs',
    'reference/craft-floor.md',
    'reference/nested/deep.md',
  ]
  const result = await installSkill({
    workspaceRoot: workspace,
    skill: skill(paths),
    harnesses: ['agents', 'claude'],
    readFile: async (target) => CONTENT(target.path),
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.dirName, 'prototype')
  assert.equal(result.fileCount, 5)
  assert.deepEqual(result.harnesses, ['agents', 'claude'])

  for (const harnessDir of ['.agents', '.claude']) {
    const root = join(workspace, harnessDir, 'skills', 'prototype')
    for (const path of paths) {
      const contents = await readFile(join(root, ...path.split('/')), 'utf8')
      assert.equal(contents, `content of ${path}\n`, `${harnessDir}/${path} must land with its bytes`)
    }
    // Subdirectory shape survives — agents/, scripts/ and reference/ are
    // directories at the destination, not flattened filenames.
    for (const dir of ['agents', 'scripts', 'reference', join('reference', 'nested')]) {
      assert.equal((await stat(join(root, dir))).isDirectory(), true, `${harnessDir}/${dir}`)
    }
    assert.deepEqual((await readdir(root)).sort(), ['SKILL.md', 'agents', 'reference', 'scripts'])
  }
}

async function reinstallReplacesRatherThanMerges(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'multicode-skill-reinstall-'))
  const install = (paths: string[]): Promise<unknown> =>
    installSkill({
      workspaceRoot: workspace,
      skill: skill(paths),
      harnesses: ['agents'],
      readFile: async (target) => CONTENT(target.path),
    })
  await install(['SKILL.md', 'reference/old.md'])
  await install(['SKILL.md', 'reference/new.md'])
  const reference = join(workspace, '.agents', 'skills', 'prototype', 'reference')
  assert.deepEqual(
    await readdir(reference),
    ['new.md'],
    'a file the skill no longer ships must not survive a reinstall'
  )
}

async function rejectsEscapingPaths(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'multicode-skill-escape-'))
  const escapes = [
    '../../.claude/settings.json',
    'reference/../../../evil.md',
    '/etc/passwd',
    'agents\\..\\..\\evil.yaml',
    '',
  ]
  for (const path of escapes) {
    const planned = planSkillInstall(workspace, skill(['SKILL.md', path]), ['agents'])
    assert.equal(planned.ok, false, `planning must refuse ${JSON.stringify(path)}`)

    let read = 0
    const result = await installSkill({
      workspaceRoot: workspace,
      skill: skill(['SKILL.md', path]),
      harnesses: ['agents'],
      readFile: async (target) => {
        read += 1
        return CONTENT(target.path)
      },
    })
    assert.equal(result.ok, false, `installing must refuse ${JSON.stringify(path)}`)
    assert.equal(read, 0, 'a refused install must not fetch a single byte')
  }
  // Nothing was written anywhere — the whole install is refused, not sanitised.
  await assert.rejects(() => stat(join(workspace, '.agents')))
}

function resolvesOnlyInsideTheSkill(): void {
  const target = join(tmpdir(), 'skill-target')
  assert.equal(resolveSkillFilePath(target, 'SKILL.md'), join(target, 'SKILL.md'))
  assert.equal(resolveSkillFilePath(target, 'a/b/c.md'), join(target, 'a', 'b', 'c.md'))
  assert.equal(resolveSkillFilePath(target, 'a/./b.md'), null)
  assert.equal(resolveSkillFilePath(target, '../escape.md'), null)
  assert.equal(resolveSkillFilePath(target, 'a/../../escape.md'), null)
  assert.equal(resolveSkillFilePath(target, 'a\\b.md'), null)
  assert.equal(resolveSkillFilePath(target, 'a\0b.md'), null)
  assert.equal(resolveSkillFilePath(target, ''), null)
}

async function refusesWithoutAHarness(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'multicode-skill-noharness-'))
  const result = await installSkill({
    workspaceRoot: workspace,
    skill: skill(['SKILL.md']),
    harnesses: [],
    readFile: async () => Buffer.alloc(0),
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.message, /No agent CLI/)
}

async function main(): Promise<void> {
  await installsWholeDirectory()
  await reinstallReplacesRatherThanMerges()
  await rejectsEscapingPaths()
  resolvesOnlyInsideTheSkill()
  await refusesWithoutAHarness()
  console.log('skills install: ok')
}

void main()
