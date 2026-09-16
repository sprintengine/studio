import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readRoleBrief } from './role-brief'
import { missingRoleMessage } from '../shared/specialists/role-brief'

function roleSkill(body: string, roleId: string, extra = ''): string {
  return [
    '---',
    `name: ${roleId.replaceAll('_', '-')}`,
    `description: Use when testing ${roleId}.`,
    'metadata:',
    `  sprintengine-role: ${roleId}`,
    '  role-label: Test Role',
    extra,
    '---',
    body,
  ].join('\n')
}

function main(): void {
  testReadsBriefFromWorkspaceSkillWithoutSpawning()
  testHyphenAndUnderscoreAreTheSameName()
  testDroppedAliasIsANamedMissingRole()
  testFirstHarnessWins()
  testSkillWithoutRoleMetadataIsIgnored()
  console.log('role-brief tests passed')
}

function testReadsBriefFromWorkspaceSkillWithoutSpawning(): void {
  const workspace = mkdtempSync(join(tmpdir(), 'role-brief-'))
  const skillDir = join(workspace, '.claude', 'skills', 'architect')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), roleSkill('Plan the work first.\n', 'architect'), 'utf8')

  const source = readFileSync(join(process.cwd(), 'src', 'main', 'role-brief.ts'), 'utf8')
  assert.doesNotMatch(source, /child_process/, 'the reader is a file read, not a CLI hop')

  const result = readRoleBrief(workspace, 'architect')
  assert.equal(result.ok, true, result.ok ? '' : result.message)
  if (!result.ok) return
  assert.equal(result.brief.trim(), 'Plan the work first.')
  assert.equal(result.workspaceRel, '.claude/skills/architect/SKILL.md')
  assert.doesNotMatch(result.brief, /^---/)
}

function testHyphenAndUnderscoreAreTheSameName(): void {
  const workspace = mkdtempSync(join(tmpdir(), 'role-brief-hyphen-'))
  const skillDir = join(workspace, '.claude', 'skills', 'spec-reviewer')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), roleSkill('Review the spec.\n', 'spec_reviewer'), 'utf8')

  const snake = readRoleBrief(workspace, 'spec_reviewer')
  const kebab = readRoleBrief(workspace, 'spec-reviewer')
  assert.equal(snake.ok, true)
  assert.equal(kebab.ok, true)
  if (!snake.ok || !kebab.ok) return
  assert.equal(snake.skillPath, kebab.skillPath)
  assert.equal(snake.roleId, 'spec_reviewer')
}

function testDroppedAliasIsANamedMissingRole(): void {
  const workspace = mkdtempSync(join(tmpdir(), 'role-brief-alias-'))
  const skillDir = join(workspace, '.claude', 'skills', 'tester')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), roleSkill('Test the change.\n', 'tester'), 'utf8')

  const result = readRoleBrief(workspace, 'qa-test')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.message, missingRoleMessage('qa-test', result.knownRoles))
  assert.match(result.message, /qa-test/)
  assert.match(result.message, /no skill declaring it is installed/)
  assert.match(result.message, /workflow-roles/)
  assert.match(result.message, /~\/\.multicode\/skills/)
  assert.ok(result.knownRoles.includes('tester'))
  assert.ok(!result.knownRoles.includes('qa-test'))
}

function testFirstHarnessWins(): void {
  const workspace = mkdtempSync(join(tmpdir(), 'role-brief-first-'))
  const claudeDir = join(workspace, '.claude', 'skills', 'architect')
  const agentsDir = join(workspace, '.agents', 'skills', 'architect')
  mkdirSync(claudeDir, { recursive: true })
  mkdirSync(agentsDir, { recursive: true })
  writeFileSync(join(claudeDir, 'SKILL.md'), roleSkill('From claude.\n', 'architect'), 'utf8')
  writeFileSync(join(agentsDir, 'SKILL.md'), roleSkill('From agents.\n', 'architect'), 'utf8')

  const result = readRoleBrief(workspace, 'architect')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.brief.trim(), 'From claude.')
  assert.equal(result.workspaceRel, '.claude/skills/architect/SKILL.md')
}

function testSkillWithoutRoleMetadataIsIgnored(): void {
  const workspace = mkdtempSync(join(tmpdir(), 'role-brief-plain-'))
  const skillDir = join(workspace, '.claude', 'skills', 'not-a-role')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: not-a-role\ndescription: Use when testing.\n---\nJust a skill.\n',
    'utf8',
  )

  const result = readRoleBrief(workspace, 'not-a-role')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.message, /not-a-role/)
}

main()
