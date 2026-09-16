import assert from 'node:assert/strict'

import { buildHostContextDocument } from '../host-context/document'
import { buildRoleAssignmentText } from './role-brief'
import {
  AUTONOMOUS_SPECIALIST_DIRECTIVE_LEAD,
  buildSpecialistDirectiveStartupPrompt,
  buildSpecialistSoulStartupPrompt,
  getSpecialistAction,
} from './specialist-actions'

function run(name: string, body: () => void): void {
  body()
  console.log(`ok - ${name}`)
}

run('specialist launch prompt names the role skill', () => {
  // Interactive: role assignment left the first prompt; the host-context
  // document carries it. An empty prompt is the wait-for-task state.
  const prompt = buildSpecialistSoulStartupPrompt(getSpecialistAction('architect'))
  assert.equal(prompt, '')
  const section = buildRoleAssignmentText('architect', '.claude/skills/architect/SKILL.md')
  const doc = buildHostContextDocument({
    role: { id: 'architect', skillPath: '.claude/skills/architect/SKILL.md' },
  })
  assert.ok(doc)
  assert.ok(doc.includes(section))
  assert.doesNotMatch(doc, /souls\s+get/)
  assert.ok(!doc.includes(['Fetch your', 'Soul'].join(' ')))
  assert.ok(!doc.includes(['Treat the returned', 'text'].join(' ')))
})

run('an automation-launched specialist gets the same role directive as a person', () => {
  const interactiveDoc = buildHostContextDocument({
    role: { id: 'security', skillPath: '.claude/skills/security/SKILL.md' },
  })
  const headlessDoc = buildHostContextDocument({
    role: { id: 'security', skillPath: '.claude/skills/security/SKILL.md' },
  })
  assert.equal(interactiveDoc, headlessDoc, 'both paths produce the same document section')
  const headless = buildSpecialistDirectiveStartupPrompt(getSpecialistAction('security'), 'Audit the auth flow.')
  assert.equal(headless.startsWith(AUTONOMOUS_SPECIALIST_DIRECTIVE_LEAD), true)
  assert.match(headless, /Audit the auth flow\./)
  assert.doesNotMatch(headless, /acting as the/)
  assert.doesNotMatch(headless, /souls\s+get/)
})

console.log('specialist-actions tests passed')
