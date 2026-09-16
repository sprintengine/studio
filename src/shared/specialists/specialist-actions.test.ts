import assert from 'node:assert/strict'

import {
  buildSpecialistDirectiveStartupPrompt,
  buildSpecialistSoulStartupPrompt,
  getSpecialistAction,
} from './specialist-actions'

function run(name: string, body: () => void): void {
  body()
  console.log(`ok - ${name}`)
}

run('specialist launch prompt names the role skill', () => {
  const prompt = buildSpecialistSoulStartupPrompt(getSpecialistAction('architect'))
  assert.match(prompt, /`architect` role/)
  assert.match(prompt, /`.claude\/skills\/architect\/SKILL\.md`/)
  assert.doesNotMatch(prompt, /souls\s+get/)
  assert.doesNotMatch(prompt, /Fetch your Soul/)
  assert.doesNotMatch(prompt, /Treat the returned text/)
  assert.match(prompt, /wait for the user's task/)
})

run('an automation-launched specialist names the same skill then the directive', () => {
  const interactive = buildSpecialistSoulStartupPrompt(getSpecialistAction('security'))
  const headless = buildSpecialistDirectiveStartupPrompt(getSpecialistAction('security'), 'Audit the auth flow.')
  assert.ok(headless.startsWith(interactive), 'headless opens with the same role assignment as a person')
  assert.match(headless, /autonomous run/)
  assert.match(headless, /Audit the auth flow\./)
  assert.doesNotMatch(headless, /souls\s+get/)
})

console.log('specialist-actions tests passed')
