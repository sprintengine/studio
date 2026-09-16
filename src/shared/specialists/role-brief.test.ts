import assert from 'node:assert/strict'

import {
  AUTONOMOUS_SPECIALIST_DIRECTIVE_LEAD,
  buildRoleAssignmentText,
  defaultWorkspaceRoleSkillRel,
  kebabRoleDirectory,
  missingRoleMessage,
  normalizeRoleId,
  stripSkillFrontmatter,
} from './role-brief'

function run(name: string, body: () => void): void {
  body()
  console.log(`ok - ${name}`)
}

run('hyphen and underscore normalize to one id', () => {
  assert.equal(normalizeRoleId('spec-reviewer'), 'spec_reviewer')
  assert.equal(normalizeRoleId('spec_reviewer'), 'spec_reviewer')
  assert.equal(kebabRoleDirectory('spec_reviewer'), 'spec-reviewer')
  assert.equal(defaultWorkspaceRoleSkillRel('architect'), '.claude/skills/architect/SKILL.md')
  assert.equal(
    defaultWorkspaceRoleSkillRel('production_readiness_reviewer'),
    '.claude/skills/production-readiness-reviewer/SKILL.md',
  )
})

run('missing-role copy names the spelling and both remedies', () => {
  const message = missingRoleMessage('qa-test', ['architect', 'tester'])
  assert.equal(
    message,
    "Unknown role 'qa-test': no skill declaring it is installed in this workspace. "
      + 'Install the workflow-roles pack from the SprintEngine Studio skill source, '
      + 'or add a role skill to your skills folder (~/.multicode/skills). '
      + 'Known roles: architect, tester.',
  )
})

run('the assignment text is a pointer at the skill file', () => {
  const text = buildRoleAssignmentText('architect', '.claude/skills/architect/SKILL.md')
  assert.match(text, /`architect` role/)
  assert.match(text, /`.claude\/skills\/architect\/SKILL\.md`/)
  assert.doesNotMatch(text, /souls\s+get/)
  assert.doesNotMatch(text, /Fetch your Soul/)
  assert.equal(AUTONOMOUS_SPECIALIST_DIRECTIVE_LEAD.includes('autonomous run'), true)
})

run('frontmatter strip leaves the body', () => {
  const raw = '---\nname: architect\n---\nPlan first.\n'
  assert.equal(stripSkillFrontmatter(raw), 'Plan first.\n')
  assert.equal(stripSkillFrontmatter('no fence\n'), null)
})

console.log('shared role-brief tests passed')
